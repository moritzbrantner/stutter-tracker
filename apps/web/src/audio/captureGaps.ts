import type { CaptureInterval } from "@stutter-tracker/shared";

/**
 * Detects capture intervals without samples from the arrival of PCM chunks against a wall clock.
 * The recorder start (or, without it, the first chunk) fixes the baseline; afterwards the delivered sample count must keep up
 * with elapsed time. A shortfall counts as a gap only once it has lasted `settleSeconds`, so a
 * delayed burst that later delivers the buffered samples is not mistaken for lost audio.
 *
 * Gap times are session seconds relative to the first sample (startOffsetSeconds = 0), placed
 * where the samples stopped, as `RecordingDescriptor.discontinuities` defines them.
 */
export function createGapTracker(
  sampleRate: number,
  {
    thresholdSeconds = 0.25,
    settleSeconds = 1,
    startedAtSeconds,
  }: { thresholdSeconds?: number; settleSeconds?: number; startedAtSeconds?: number } = {},
) {
  let samples = 0;
  // Anchored at the recorder start when known, so audio missing before the first chunk counts.
  let base: number | null = startedAtSeconds ?? null;
  let delivered = false;
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
      delivered = true;
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
      if (!delivered) {
        // No PCM arrived at all: the whole capture since the recorder started has no samples.
        if (startedAtSeconds === undefined || nowSeconds - startedAtSeconds <= thresholdSeconds) {
          return null;
        }
        return { startSeconds: 0, endSeconds: nowSeconds - startedAtSeconds, reason: "dropout" };
      }
      const deficit = deficitAt(nowSeconds, samples / sampleRate);
      if (deficit - missing <= thresholdSeconds) return null;
      pending ??= { startSeconds: samples / sampleRate + missing, since: nowSeconds };
      return commit(deficit);
    },
  };
}
