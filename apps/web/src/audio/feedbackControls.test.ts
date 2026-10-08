import { describe, expect, it } from "vitest";
import { DEFAULT_AUDITORY_FEEDBACK_SETTINGS } from "./auditoryFeedback";
import {
  clampDisplayValue,
  clampLabSettings,
  fromDisplayValue,
  parseDisplayValue,
  stepDisplayValue,
  toDisplayValue,
} from "./feedbackControls";

describe("feedback control values", () => {
  it("parses exact numbers and rejects anything else", () => {
    expect(parseDisplayValue(" 137 ")).toBe(137);
    expect(parseDisplayValue("-2.5")).toBe(-2.5);
    expect(parseDisplayValue("0,5")).toBe(0.5);
    for (const text of ["", "abc", "12ms", "1e3", "Infinity", "--1"]) {
      expect(parseDisplayValue(text)).toBeNull();
    }
  });

  it("clamps to the lab ranges and snaps to the fine step", () => {
    expect(clampDisplayValue("delayMs", 999)).toBe(200);
    expect(clampDisplayValue("delayMs", -5)).toBe(0);
    expect(clampDisplayValue("delayMs", 137.4)).toBe(137);
    expect(clampDisplayValue("pitchShiftSemitones", 2.3)).toBe(2.5);
    expect(clampDisplayValue("pitchShiftSemitones", -9)).toBe(-4);
    expect(clampDisplayValue("outputGain", 5)).toBe(15);
  });

  it("converts percent fields between display and engine units exactly", () => {
    expect(fromDisplayValue("wetMix", 35)).toBe(0.35);
    expect(toDisplayValue("wetMix", 0.35)).toBe(35);
    expect(fromDisplayValue("outputGain", 95)).toBe(0.8);
  });

  it("steps by the fine step and by the coarse step with Shift, within bounds", () => {
    expect(stepDisplayValue("delayMs", 100, 1, false)).toBe(101);
    expect(stepDisplayValue("delayMs", 100, -1, true)).toBe(90);
    expect(stepDisplayValue("delayMs", 195, 1, true)).toBe(200);
    expect(stepDisplayValue("pitchShiftSemitones", 0, -1, false)).toBe(-0.5);
  });

  it("brings stored settings into range and replaces non-finite values with defaults", () => {
    expect(
      clampLabSettings({ delayMs: 500, pitchShiftSemitones: Number.NaN, wetMix: 2, outputGain: 0 }),
    ).toEqual({
      delayMs: 200,
      pitchShiftSemitones: DEFAULT_AUDITORY_FEEDBACK_SETTINGS.pitchShiftSemitones,
      wetMix: 1,
      outputGain: 0.15,
    });
  });
});
