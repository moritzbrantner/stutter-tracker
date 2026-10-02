// Recording descriptor, common session time base and capture-quality state.
// Platform adapters fill the descriptor with what they can actually observe; unknown stays unknown.

export type CaptureOrigin = "browser" | "mobile" | "desktop" | "import";

/**
 * - appInput: the stream the app received. On browsers with echo cancellation / noise
 *   suppression requested this is already processed and is NOT raw hardware PCM.
 * - interventionOutput: audio the app produced or altered (e.g. delayed/pitch-shifted feedback).
 */
export type CaptureStreamRole = "appInput" | "interventionOutput";

export type PreprocessingSetting = {
  requested?: boolean;
  /** What the platform reports as applied; undefined when it cannot tell. */
  applied?: boolean;
};

export type CaptureInterval = {
  /** Session-clock seconds. */
  startSeconds: number;
  endSeconds: number;
  reason: "dropout" | "interrupted" | "routeChange" | "paused";
};

export type RecordingDescriptor = {
  sessionId: string;
  runId: string;
  origin: CaptureOrigin;
  role: CaptureStreamRole;
  /** Actual stream sample rate and channel count, not the requested ones. */
  sampleRate: number;
  channelCount: number;
  /** Platform route/device label only when exposed; never guessed. */
  deviceRoute?: string;
  /** Session-clock seconds at which sample 0 of this stream was captured. */
  startOffsetSeconds: number;
  preprocessing: {
    echoCancellation: PreprocessingSetting;
    noiseSuppression: PreprocessingSetting;
    autoGainControl: PreprocessingSetting;
  };
  discontinuities: CaptureInterval[];
  /** Mixed speakers are never attributed to the user by default. */
  speakerAssessment: "singleSpeakerDeclared" | "unknown" | "overlapDetected";
};

/** True only when nothing is known to have altered the stream before the app saw it. */
export function isUnprocessedInput(descriptor: RecordingDescriptor) {
  if (descriptor.role !== "appInput") return false;
  return Object.values(descriptor.preprocessing).every(
    (setting) => setting.applied === false || (setting.applied === undefined && !setting.requested),
  );
}

/** Session-clock seconds of a sample index in the descriptor's stream. */
export function sampleIndexToSessionSeconds(descriptor: RecordingDescriptor, sampleIndex: number) {
  return descriptor.startOffsetSeconds + sampleIndex / descriptor.sampleRate;
}

/** Nearest sample index for session-clock seconds; null outside the stream or inside a gap. */
export function sessionSecondsToSampleIndex(
  descriptor: RecordingDescriptor,
  sessionSeconds: number,
  sampleCount: number,
): number | null {
  const index = Math.round(
    (sessionSeconds - descriptor.startOffsetSeconds) * descriptor.sampleRate,
  );
  if (index < 0 || index >= sampleCount) return null;
  const inGap = descriptor.discontinuities.some(
    (gap) => sessionSeconds >= gap.startSeconds && sessionSeconds < gap.endSeconds,
  );
  return inGap ? null : index;
}

/**
 * Descriptor of the same stream after resampling with `resampleSamples`, which aligns the first
 * output sample with the first input sample; the session offset is therefore unchanged.
 */
export function resampledDescriptor(
  descriptor: RecordingDescriptor,
  targetSampleRate: number,
): RecordingDescriptor {
  return { ...descriptor, sampleRate: targetSampleRate };
}

/** Converts a time relative to the start of a stream (e.g. a transcript segment) to session time. */
export function streamSecondsToSessionSeconds(
  descriptor: RecordingDescriptor,
  streamSeconds: number,
) {
  return descriptor.startOffsetSeconds + streamSeconds;
}

export type CaptureMetrics = {
  durationSeconds: number;
  channelCount: number;
  clippedSampleRatio: number;
  /** Seconds of frames whose RMS is below the no-input floor. */
  silentSeconds: number;
  /** Seconds of frames above the speech-activity floor. */
  activeSeconds: number;
  /** Longest continuous run of silent frames. */
  longestSilenceSeconds: number;
};

const FRAME_SECONDS = 0.02;
const CLIP_LEVEL = 0.999;
const NO_INPUT_RMS = 1e-4;
const ACTIVITY_RMS = 0.01;

/** Simple frame scan of mono PCM in [-1, 1]. Generic kernels belong in audio-analysis for native paths. */
export function measureCapture(
  samples: ArrayLike<number>,
  sampleRate: number,
  channelCount = 1,
): CaptureMetrics {
  const frameLength = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  let clipped = 0;
  let silentFrames = 0;
  let activeFrames = 0;
  let silentRun = 0;
  let longestSilentRun = 0;
  for (let start = 0; start < samples.length; start += frameLength) {
    const end = Math.min(samples.length, start + frameLength);
    let energy = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index];
      if (Math.abs(value) >= CLIP_LEVEL) clipped += 1;
      energy += value * value;
    }
    const rms = Math.sqrt(energy / (end - start));
    if (rms < NO_INPUT_RMS) {
      silentFrames += 1;
      silentRun += 1;
      longestSilentRun = Math.max(longestSilentRun, silentRun);
    } else {
      silentRun = 0;
    }
    if (rms >= ACTIVITY_RMS) activeFrames += 1;
  }
  const frameSeconds = frameLength / sampleRate;
  return {
    durationSeconds: samples.length / sampleRate,
    channelCount,
    clippedSampleRatio: samples.length ? clipped / samples.length : 0,
    silentSeconds: silentFrames * frameSeconds,
    activeSeconds: activeFrames * frameSeconds,
    longestSilenceSeconds: longestSilentRun * frameSeconds,
  };
}

export type CaptureQualityIssue =
  | "noChannels"
  | "tooShort"
  | "noInput"
  | "insufficientSpeech"
  | "clipping"
  | "discontinuous"
  | "speakerUnknown"
  | "speakerOverlap";

export type CaptureQuality =
  | { state: "usable"; issues: [] }
  | { state: "unknown"; issues: CaptureQualityIssue[]; explanation: string };

export const CAPTURE_QUALITY_LIMITS = {
  minimumDurationSeconds: 3,
  minimumActiveSeconds: 2,
  maximumClippedSampleRatio: 0.001,
  maximumDiscontinuityRatio: 0.05,
} as const;

const ISSUE_TEXT: Record<CaptureQualityIssue, string> = {
  noChannels: "the recording has no audio channels",
  tooShort: "the recording is too short",
  noInput: "the microphone delivered no input",
  insufficientSpeech: "there is too little speech",
  clipping: "the input is clipping (too loud)",
  discontinuous: "parts of the recording are missing",
  speakerUnknown: "it is not confirmed that only you are speaking",
  speakerOverlap: "other voices overlap with yours",
};

/**
 * Quality gate before scoring. Anything other than "usable" must be reported as an unknown
 * result with the explanation, never as fluent speech or a high event rate.
 */
export function assessCaptureQuality(
  descriptor: RecordingDescriptor,
  metrics: CaptureMetrics,
): CaptureQuality {
  const limits = CAPTURE_QUALITY_LIMITS;
  const issues: CaptureQualityIssue[] = [];
  if (metrics.channelCount < 1 || descriptor.channelCount < 1) issues.push("noChannels");
  if (metrics.durationSeconds < limits.minimumDurationSeconds) issues.push("tooShort");
  if (metrics.durationSeconds > 0 && metrics.silentSeconds >= metrics.durationSeconds * 0.98) {
    issues.push("noInput");
  } else if (metrics.activeSeconds < limits.minimumActiveSeconds) {
    issues.push("insufficientSpeech");
  }
  if (metrics.clippedSampleRatio > limits.maximumClippedSampleRatio) issues.push("clipping");
  const missingSeconds = descriptor.discontinuities.reduce(
    (sum, gap) => sum + Math.max(0, gap.endSeconds - gap.startSeconds),
    0,
  );
  if (
    metrics.durationSeconds > 0 &&
    missingSeconds / metrics.durationSeconds > limits.maximumDiscontinuityRatio
  ) {
    issues.push("discontinuous");
  }
  if (descriptor.speakerAssessment === "unknown") issues.push("speakerUnknown");
  if (descriptor.speakerAssessment === "overlapDetected") issues.push("speakerOverlap");

  if (!issues.length) return { state: "usable", issues: [] };
  return {
    state: "unknown",
    issues,
    explanation: `Result unknown: ${issues.map((issue) => ISSUE_TEXT[issue]).join("; ")}.`,
  };
}
