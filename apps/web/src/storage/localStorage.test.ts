import { describe, expect, it } from "vitest";
import {
  loadRemoteConsent,
  loadSessionsFromStorage,
  normalizeSpeakerProfiles,
  saveRemoteConsent,
} from "./localStorage";

describe("local storage helpers", () => {
  it("binds remote-analysis consent to one server URL and supports revocation", () => {
    const storage = memoryStorage({});
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
    saveRemoteConsent("https://a.example.com", true, storage);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(true);
    expect(loadRemoteConsent("https://b.example.com", storage)).toBe(false);
    saveRemoteConsent("https://a.example.com", false, storage);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
  });

  it("falls back safely on invalid JSON", () => {
    const storage = memoryStorage({ "stutter-tracker:sessions": "{" });
    expect(loadSessionsFromStorage(storage)).toEqual([]);
  });

  it("filters invalid speaker profile records", () => {
    expect(
      normalizeSpeakerProfiles([
        {
          id: "speaker-1",
          label: "Speaker 1",
          embeddings: [[1, 0]],
          sampleRate: 16_000,
          sampleCount: 16_000,
        },
        {
          id: "",
          label: "Missing id",
          embeddings: [[1]],
          sampleRate: 16_000,
          sampleCount: 16_000,
        },
        {
          id: "speaker-2",
          label: "No embedding",
          embeddings: [],
          sampleRate: 16_000,
          sampleCount: 16_000,
        },
      ]),
    ).toHaveLength(1);
  });
});

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
