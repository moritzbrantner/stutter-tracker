import { describe, expect, it } from "vitest";
import { DEFAULT_AUDITORY_FEEDBACK_SETTINGS } from "../audio/auditoryFeedback";
import {
  FEEDBACK_SETTINGS_KEY,
  loadFeedbackSettings,
  saveFeedbackSettings,
} from "./feedbackSettings";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("feedback settings storage", () => {
  it("roundtrips exact settings", () => {
    const storage = memoryStorage();
    const settings = { delayMs: 137, pitchShiftSemitones: -2.5, wetMix: 0.35, outputGain: 0.42 };
    saveFeedbackSettings(settings, storage);
    expect(loadFeedbackSettings(storage)).toEqual(settings);
  });

  it("falls back to defaults for missing or corrupt values and clamps the rest", () => {
    expect(loadFeedbackSettings(memoryStorage())).toEqual(DEFAULT_AUDITORY_FEEDBACK_SETTINGS);
    expect(loadFeedbackSettings(memoryStorage({ [FEEDBACK_SETTINGS_KEY]: "{" }))).toEqual(
      DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
    );
    expect(
      loadFeedbackSettings(
        memoryStorage({ [FEEDBACK_SETTINGS_KEY]: JSON.stringify({ delayMs: 900, wetMix: "x" }) }),
      ),
    ).toEqual({ ...DEFAULT_AUDITORY_FEEDBACK_SETTINGS, delayMs: 200 });
  });
});
