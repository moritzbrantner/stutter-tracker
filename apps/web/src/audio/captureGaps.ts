import type { CaptureInterval } from "@stutter-tracker/shared";

/**
 * Detects capture intervals without samples from the arrival of PCM chunks against a wall clock.
 * The first chunk fixes the latency baseline; afterwards the delivered sample count must keep up
 * with elapsed time. A shortfall counts as a gap only once it has lasted `settleSeconds`, so a
 * delayed burst that later delivers the buffered samples is not mistaken for lost audio.
 *
 * Gap times are session seconds relative to the first sample (startOffsetSeconds = 0), placed
 * where the samples stopped, as `RecordingDescriptor.discontinuities` defines them.
 */
export function createGapTracker(
  sampleRate: number,
  { thresholdSeconds = 0.25, settleSeconds = 1 } = {},
) {
  let samples = 0;
  let base: number | null = null;
  let missing = 0;
  let pending: { startSeconds: number; since: number } | null = null;

  const deficitAt = (now: number, streamSeconds: number) => now - (base ?? now) - streamSeconds;

  function commit(deficit: number): CaptureInterval | null {
    if (!pending) return null;
    const gap: CaptureInterval = {
      startSeconds: pending.startSeconds,
      endSeconds: pending.startSeconds + (deficit - missing),
      reason: "dropout",
    };
    missing = deficit;
    pending = null;
    return gap;
  }

  return {
    /** Call when a chunk of `length` samples arrives at wall-clock `nowSeconds`. */
    observe(length: number, nowSeconds: number): CaptureInterval | null {
      const before = samples / sampleRate;
      samples += length;
      const streamSeconds = samples / sampleRate;
      if (base === null) {
        base = nowSeconds - streamSeconds;
        return null;
      }
      const deficit = deficitAt(nowSeconds, streamSeconds);
      if (deficit - missing <= thresholdSeconds) {
        pending = null;
        return null;
      }
      if (!pending) {
        pending = { startSeconds: before + missing, since: nowSeconds };
        return null;
      }
      return nowSeconds - pending.since >= settleSeconds ? commit(deficit) : null;
    },
    /** Call when capture stops: a shortfall still open then is a gap at the end. */
    finish(nowSeconds: number): CaptureInterval | null {
      if (base === null) return null;
      const deficit = deficitAt(nowSeconds, samples / sampleRate);
      if (deficit - missing <= thresholdSeconds) return null;
      pending ??= { startSeconds: samples / sampleRate + missing, since: nowSeconds };
      return commit(deficit);
    },
  };
}
