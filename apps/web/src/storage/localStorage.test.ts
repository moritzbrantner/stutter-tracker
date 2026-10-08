import { describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_KEY,
  loadConsentLedger,
  loadRemoteConsent,
  REMOTE_CONSENT_KEY,
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

  it("keeps an append-only ledger of remote-analysis decisions", () => {
    const storage = memoryStorage({});
    saveRemoteConsent("https://a.example.com", true, storage);
    saveRemoteConsent("https://a.example.com", false, storage);

    expect(loadConsentLedger(storage).map((entry) => [entry.scope, entry.granted])).toEqual([
      ["https://a.example.com", true],
      ["https://a.example.com", false],
    ]);
  });

  it("migrates a legacy remote-analysis grant into the ledger once", () => {
    const storage = memoryStorage({ [REMOTE_CONSENT_KEY]: "https://a.example.com" });

    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(true);
    expect(storage.getItem(REMOTE_CONSENT_KEY)).toBeNull();
    expect(loadConsentLedger(storage)).toHaveLength(1);

    saveRemoteConsent("https://a.example.com", false, storage);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
  });

  it("treats a corrupt ledger as no consent", () => {
    const storage = memoryStorage({ [CONSENT_LEDGER_KEY]: "{" });
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
