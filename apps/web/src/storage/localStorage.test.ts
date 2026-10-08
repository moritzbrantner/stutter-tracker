import { fallbackAnalyze, migrateSessionRecord } from "@stutter-tracker/shared";
import { describe, expect, it } from "vitest";
import {
  loadRemoteConsent,
  loadSessionsFromStorage,
  normalizeSpeakerProfiles,
  saveRemoteConsent,
  STORE_KEY,
  UNREADABLE_SESSIONS_KEY,
} from "./localStorage";

const legacySession = {
  id: "legacy-1",
  startedAt: "2026-09-01T08:00:00.000Z",
  segments: [{ text: "hello", startSeconds: 0, endSeconds: 0.5, isFinal: true }],
  pauses: [],
  report: fallbackAnalyze({
    segments: [{ text: "hello", startSeconds: 0, endSeconds: 0.5, isFinal: true }],
    pauses: [],
  }),
};

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

  it("migrates legacy stored sessions to the canonical schema", () => {
    const storage = memoryStorage({ [STORE_KEY]: JSON.stringify([legacySession]) });

    expect(loadSessionsFromStorage(storage)).toEqual([migrateSessionRecord(legacySession)]);
    expect(storage.getItem(UNREADABLE_SESSIONS_KEY)).toBeNull();
  });

  it("keeps unreadable stored sessions aside instead of dropping them", () => {
    const fromNewerBuild = { ...migrateSessionRecord(legacySession), id: "new", schemaVersion: 3 };
    const malformed = { id: "broken" };
    const storage = memoryStorage({
      [STORE_KEY]: JSON.stringify([legacySession, fromNewerBuild, malformed]),
    });

    expect(loadSessionsFromStorage(storage).map((session) => session.id)).toEqual(["legacy-1"]);
    loadSessionsFromStorage(storage);
    expect(JSON.parse(storage.getItem(UNREADABLE_SESSIONS_KEY) ?? "[]")).toEqual([
      fromNewerBuild,
      malformed,
    ]);
  });

  it("restores quarantined sessions once they can be read, keeping the rest aside", () => {
    const recoverable = { ...legacySession, id: "recoverable" };
    const stillUnreadable = { id: "broken" };
    const clash = { ...legacySession };
    const storage = memoryStorage({
      [STORE_KEY]: JSON.stringify([legacySession]),
      [UNREADABLE_SESSIONS_KEY]: JSON.stringify([recoverable, stillUnreadable, clash]),
    });

    expect(loadSessionsFromStorage(storage).map((session) => session.id)).toEqual([
      "legacy-1",
      "recoverable",
    ]);
    expect(
      (JSON.parse(storage.getItem(STORE_KEY) ?? "[]") as { id: string }[]).map((s) => s.id),
    ).toEqual(["legacy-1", "recoverable"]);
    expect(JSON.parse(storage.getItem(UNREADABLE_SESSIONS_KEY) ?? "[]")).toEqual([
      stillUnreadable,
      clash,
    ]);
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
