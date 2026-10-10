import { describe, expect, it } from "vitest";
import { createGapTracker } from "./captureGaps";

// 0.1 s chunks at 1 kHz arriving on time from t = 10 s (constant latency is ignored).
function feed(
  tracker: ReturnType<typeof createGapTracker>,
  from: number,
  count: number,
  start = 0,
) {
  const gaps = [];
  for (let index = 0; index < count; index += 1) {
    const gap = tracker.observe(100, from + start + (index + 1) * 0.1);
    if (gap) gaps.push(gap);
  }
  return gaps;
}

describe("createGapTracker", () => {
  it("reports nothing for steady delivery with jitter below the threshold", () => {
    const tracker = createGapTracker(1000);
    expect(feed(tracker, 10, 20)).toEqual([]);
    expect(tracker.observe(100, 10 + 2.1 + 0.2)).toBeNull();
    expect(tracker.finish(10 + 2.3)).toBeNull();
  });

  it("records a stall whose samples never arrive, where the samples stopped", () => {
    const tracker = createGapTracker(1000);
    feed(tracker, 10, 10); // stream 0-1 s, wall 10.1-11.0
    // Delivery resumes 2 s late and keeps that lag: the samples of 2 s are lost.
    const gaps = feed(tracker, 10, 15, 3);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.startSeconds).toBeCloseTo(1);
    expect(gaps[0]!.endSeconds).toBeCloseTo(3);
    expect(gaps[0]!.reason).toBe("dropout");
  });

  it("does not count a delayed burst that delivers the buffered samples", () => {
    const tracker = createGapTracker(1000);
    feed(tracker, 10, 10);
    // 0.6 s late, then the buffered chunks arrive at once and delivery is back on time.
    expect(tracker.observe(100, 11.7)).toBeNull();
    for (let index = 0; index < 6; index += 1) expect(tracker.observe(100, 11.71)).toBeNull();
    expect(feed(tracker, 11.7, 20)).toEqual([]);
    expect(tracker.finish(13.8)).toBeNull();
  });

  it("closes a shortfall still open when capture stops", () => {
    const tracker = createGapTracker(1000);
    feed(tracker, 10, 10);
    expect(tracker.finish(12.5)).toEqual({
      startSeconds: 1,
      endSeconds: expect.closeTo(2.5),
      reason: "dropout",
    });
  });

  it("reports a capture that never delivered PCM as one gap from its start", () => {
    expect(createGapTracker(1000, { startedAtSeconds: 10 }).finish(14)).toEqual({
      startSeconds: 0,
      endSeconds: 4,
      reason: "dropout",
    });
    expect(createGapTracker(1000, { startedAtSeconds: 10 }).finish(10.1)).toBeNull();
    expect(createGapTracker(1000).finish(14)).toBeNull();
  });
});
