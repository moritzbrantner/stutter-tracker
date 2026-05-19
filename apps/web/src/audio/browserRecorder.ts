export type BrowserRecorder = {
  sampleRate: number;
  stop(): Promise<void>;
};

export type BrowserRecorderOptions = {
  onSamples(samples: Float32Array): void;
  onLevel(level: number): void;
};

export class BrowserRecorderError extends Error {
  constructor(
    readonly code: "unavailable" | "denied" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export async function createBrowserRecorder(
  options: BrowserRecorderOptions,
): Promise<BrowserRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new BrowserRecorderError("unavailable", "Microphone recording is unavailable");
  }

  const resources: Array<() => void | Promise<void>> = [];
  try {
    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      })
      .catch((error: unknown) => {
        if (isPermissionDenied(error)) {
          throw new BrowserRecorderError("denied", "Microphone permission was denied");
        }
        throw error;
      });
    resources.push(() => stream.getTracks().forEach((track) => track.stop()));

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new BrowserRecorderError("unavailable", "AudioContext is unavailable");
    }

    const audioContext = new AudioContextConstructor();
    resources.push(() => audioContext.close());

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;
    const mutedOutput = audioContext.createGain();
    mutedOutput.gain.value = 0;
    source.connect(analyser);
    resources.push(() => source.disconnect());
    resources.push(() => analyser.disconnect());
    resources.push(() => mutedOutput.disconnect());

    const updateLevel = (samples: Float32Array) => {
      let energy = 0;
      for (const sample of samples) {
        energy += sample * sample;
      }
      options.onLevel(Math.min(1, Math.sqrt(energy / Math.max(1, samples.length)) * 12));
    };

    if (audioContext.audioWorklet) {
      await audioContext.audioWorklet.addModule("/pcm-recorder-worklet.js");
      const worklet = new AudioWorkletNode(audioContext, "pcm-recorder");
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const samples = event.data;
        options.onSamples(samples);
        updateLevel(samples);
      };
      analyser.connect(worklet);
      worklet.connect(mutedOutput);
      mutedOutput.connect(audioContext.destination);
      resources.push(() => {
        worklet.port.onmessage = null;
        worklet.disconnect();
      });
    } else {
      const recorder = audioContext.createScriptProcessor(4096, 1, 1);
      recorder.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const output = event.outputBuffer;
        for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
          output.getChannelData(channel).fill(0);
        }
        const channels = Array.from({ length: input.numberOfChannels }, (_, channel) =>
          input.getChannelData(channel),
        );
        const samples = new Float32Array(input.length);
        for (let index = 0; index < input.length; index += 1) {
          let sample = 0;
          for (const channel of channels) {
            sample += channel[index];
          }
          samples[index] = sample / Math.max(1, channels.length);
        }
        options.onSamples(samples);
        updateLevel(samples);
      };
      analyser.connect(recorder);
      recorder.connect(mutedOutput);
      mutedOutput.connect(audioContext.destination);
      resources.push(() => {
        recorder.onaudioprocess = null;
        recorder.disconnect();
      });
    }

    let stopped = false;
    return {
      sampleRate: audioContext.sampleRate,
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        await cleanup(resources);
        options.onLevel(0);
      },
    };
  } catch (error) {
    await cleanup(resources);
    if (error instanceof BrowserRecorderError) {
      throw error;
    }
    throw new BrowserRecorderError(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function cleanup(resources: Array<() => void | Promise<void>>) {
  for (const dispose of resources.reverse()) {
    await Promise.resolve(dispose()).catch(() => undefined);
  }
}

function isPermissionDenied(error: unknown) {
  return error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
