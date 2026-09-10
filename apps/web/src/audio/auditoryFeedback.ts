export type AuditoryFeedbackSettings = {
  delayMs: number;
  pitchShiftSemitones: number;
  wetMix: number;
  outputGain: number;
};

export type AuditoryFeedbackRecording = {
  raw: Blob | null;
  processed: Blob | null;
};

export type AuditoryFeedbackCapabilities = {
  pitchShift: boolean;
  localCapture: boolean;
};

export type AuditoryFeedbackSession = {
  capabilities: AuditoryFeedbackCapabilities;
  update: (settings: AuditoryFeedbackSettings) => void;
  stop: () => Promise<AuditoryFeedbackRecording>;
};

export const DEFAULT_AUDITORY_FEEDBACK_SETTINGS: AuditoryFeedbackSettings = {
  delayMs: 100,
  pitchShiftSemitones: 0,
  wetMix: 1,
  outputGain: 0.5,
};

const MAX_DELAY_MS = 200;
const MAX_PITCH_SHIFT_SEMITONES = 6;
const MAX_OUTPUT_GAIN = 0.8;
const PITCH_SHIFT_PROCESSOR_NAME = "stutter-tracker-pitch-shift";

export function normalizeAuditoryFeedbackSettings(
  settings: AuditoryFeedbackSettings,
): AuditoryFeedbackSettings {
  return {
    delayMs: clamp(settings.delayMs, 0, MAX_DELAY_MS),
    pitchShiftSemitones: clamp(
      settings.pitchShiftSemitones,
      -MAX_PITCH_SHIFT_SEMITONES,
      MAX_PITCH_SHIFT_SEMITONES,
    ),
    wetMix: clamp(settings.wetMix, 0, 1),
    outputGain: clamp(settings.outputGain, 0, MAX_OUTPUT_GAIN),
  };
}

export function calculateMixGains(wetMix: number) {
  const wet = clamp(wetMix, 0, 1);
  return {
    dry: Math.sqrt(1 - wet),
    wet: Math.sqrt(wet),
  };
}

export function semitonesToPlaybackRatio(semitones: number) {
  return 2 ** (semitones / 12);
}

export async function startAuditoryFeedbackSession(
  initialSettings: AuditoryFeedbackSettings,
): Promise<AuditoryFeedbackSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this browser");
  }
  if (!window.AudioContext) {
    throw new Error("Live audio feedback is unavailable in this browser");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });

  let context: AudioContext;
  try {
    context = new AudioContext({ latencyHint: "interactive" });
  } catch (error) {
    stopStream(stream);
    throw error;
  }
  try {
    await context.resume();
  } catch (error) {
    stopStream(stream);
    await context.close().catch(() => undefined);
    throw error;
  }

  const source = context.createMediaStreamSource(stream);
  const dryGain = context.createGain();
  const delay = context.createDelay(MAX_DELAY_MS / 1000 + 0.05);
  const wetGain = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const outputGain = context.createGain();
  const captureDestination = context.createMediaStreamDestination();

  limiter.threshold.value = -16;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.08;

  let pitchShiftNode: AudioWorkletNode | null = null;
  try {
    if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      const processorUrl = new URL("./pitchShiftProcessor.js", import.meta.url);
      await context.audioWorklet.addModule(processorUrl);
      pitchShiftNode = new AudioWorkletNode(context, PITCH_SHIFT_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
    }
  } catch {
    pitchShiftNode = null;
  }

  source.connect(dryGain);
  source.connect(delay);
  dryGain.connect(limiter);
  if (pitchShiftNode) {
    delay.connect(pitchShiftNode);
    pitchShiftNode.connect(wetGain);
  } else {
    delay.connect(wetGain);
  }
  wetGain.connect(limiter);
  limiter.connect(outputGain);
  outputGain.connect(context.destination);
  outputGain.connect(captureDestination);

  const rawCapture = createRecorderCapture(stream);
  const processedCapture = createRecorderCapture(captureDestination.stream);
  rawCapture?.recorder.start(250);
  processedCapture?.recorder.start(250);

  let stopped = false;
  let stopPromise: Promise<AuditoryFeedbackRecording> | null = null;

  const applySettings = (settings: AuditoryFeedbackSettings) => {
    if (stopped) {
      return;
    }
    const normalized = normalizeAuditoryFeedbackSettings(settings);
    const mix = calculateMixGains(normalized.wetMix);
    const now = context.currentTime;
    delay.delayTime.setTargetAtTime(normalized.delayMs / 1000, now, 0.01);
    dryGain.gain.setTargetAtTime(mix.dry, now, 0.01);
    wetGain.gain.setTargetAtTime(mix.wet, now, 0.01);
    outputGain.gain.setTargetAtTime(normalized.outputGain, now, 0.01);
    pitchShiftNode?.parameters
      .get("semitones")
      ?.setTargetAtTime(normalized.pitchShiftSemitones, now, 0.01);
  };

  applySettings(initialSettings);

  return {
    capabilities: {
      pitchShift: pitchShiftNode !== null,
      localCapture: rawCapture !== null && processedCapture !== null,
    },
    update: applySettings,
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      stopPromise = Promise.all([
        stopRecorderCapture(rawCapture),
        stopRecorderCapture(processedCapture),
      ])
        .then(async ([raw, processed]) => {
          source.disconnect();
          dryGain.disconnect();
          delay.disconnect();
          pitchShiftNode?.disconnect();
          wetGain.disconnect();
          limiter.disconnect();
          outputGain.disconnect();
          stopStream(stream);
          if (context.state !== "closed") {
            await context.close();
          }
          return { raw, processed };
        })
        .catch(async (error) => {
          stopStream(stream);
          if (context.state !== "closed") {
            await context.close().catch(() => undefined);
          }
          throw error;
        });
      return stopPromise;
    },
  };
}

type RecorderCapture = {
  recorder: MediaRecorder;
  chunks: Blob[];
};

function createRecorderCapture(stream: MediaStream): RecorderCapture | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
  try {
    const mimeType = preferredRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    return { recorder, chunks };
  } catch {
    return null;
  }
}

function stopRecorderCapture(capture: RecorderCapture | null): Promise<Blob | null> {
  if (!capture) {
    return Promise.resolve(null);
  }
  const { recorder, chunks } = capture;
  if (recorder.state === "inactive") {
    return Promise.resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
  }
  return new Promise((resolve) => {
    recorder.addEventListener(
      "stop",
      () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      },
      { once: true },
    );
    recorder.stop();
  });
}

function preferredRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
