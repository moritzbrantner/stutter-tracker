import { describe, expect, it } from "vitest";
import {
  calculateMixGains,
  normalizeAuditoryFeedbackSettings,
  semitonesToPlaybackRatio,
} from "./auditoryFeedback";

describe("auditory feedback settings", () => {
  it("clamps unsafe or unsupported values at the browser-audio boundary", () => {
    expect(
      normalizeAuditoryFeedbackSettings({
        delayMs: 800,
        pitchShiftSemitones: -20,
        wetMix: 4,
        outputGain: 2,
      }),
    ).toEqual({
      delayMs: 200,
      pitchShiftSemitones: -6,
      wetMix: 1,
      outputGain: 0.8,
    });
  });

  it("uses equal-power dry and altered gains", () => {
    expect(calculateMixGains(0)).toEqual({ dry: 1, wet: 0 });
    expect(calculateMixGains(1)).toEqual({ dry: 0, wet: 1 });
    expect(calculateMixGains(0.5).dry).toBeCloseTo(Math.SQRT1_2);
    expect(calculateMixGains(0.5).wet).toBeCloseTo(Math.SQRT1_2);
  });

  it("maps semitone offsets to deterministic playback ratios", () => {
    expect(semitonesToPlaybackRatio(0)).toBe(1);
    expect(semitonesToPlaybackRatio(12)).toBe(2);
    expect(semitonesToPlaybackRatio(-12)).toBe(0.5);
  });
});
