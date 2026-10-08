import { fallbackAnalyze, migrateSessionRecord } from "@stutter-tracker/shared";
import { describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_KEY,
  loadConsentLedger,
  loadRemoteConsent,
  REMOTE_CONSENT_KEY,
  UNREADABLE_CONSENT_LEDGER_KEY,
  loadSessionsFromStorage,
  replaceStoredSessions,
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

  it("keeps an append-only ledger of remote-analysis decisions", () => {
    const storage = memoryStorage({});
    saveRemoteConsent("https://a.example.com", true, storage);
    saveRemoteConsent("https://a.example.com", false, storage);

    expect(loadConsentLedger(storage).map((entry) => [entry.scope, entry.granted])).toEqual([
      ["https://a.example.com", true],
      ["https://a.example.com", false],
    ]);
  });

  it("withdraws the previous server's grant when another server is granted", () => {
    const storage = memoryStorage({});
    saveRemoteConsent("https://a.example.com", true, storage);
    saveRemoteConsent("https://b.example.com", true, storage);

    expect(loadRemoteConsent("https://b.example.com", storage)).toBe(true);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
  });

  it("does not revive a legacy grant when the ledger is unreadable", () => {
    const storage = memoryStorage({
      [CONSENT_LEDGER_KEY]: "{",
      [REMOTE_CONSENT_KEY]: "https://a.example.com",
    });

    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
    expect(storage.getItem(CONSENT_LEDGER_KEY)).toBe("{");

    // Granting another server replaces the corrupt ledger; the old legacy grant stays retired.
    saveRemoteConsent("https://b.example.com", true, storage);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
    expect(loadRemoteConsent("https://b.example.com", storage)).toBe(true);
  });

  it("lets an existing ledger decision win over a legacy grant for another server", () => {
    const storage = memoryStorage({});
    saveRemoteConsent("https://a.example.com", true, storage);
    storage.setItem(REMOTE_CONSENT_KEY, "https://b.example.com");

    expect(loadRemoteConsent("https://b.example.com", storage)).toBe(false);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(true);
    expect(storage.getItem(REMOTE_CONSENT_KEY)).toBeNull();
  });

  it("drops a legacy grant whose URL is not http(s)", () => {
    const storage = memoryStorage({ [REMOTE_CONSENT_KEY]: "not a url" });
    expect(loadConsentLedger(storage)).toEqual([]);
    expect(storage.getItem(REMOTE_CONSENT_KEY)).toBeNull();
  });

  it("migrates a legacy remote-analysis grant into the ledger once", () => {
    const storage = memoryStorage({ [REMOTE_CONSENT_KEY]: "https://a.example.com" });

    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(true);
    expect(storage.getItem(REMOTE_CONSENT_KEY)).toBeNull();
    expect(loadConsentLedger(storage)).toHaveLength(1);

    saveRemoteConsent("https://a.example.com", false, storage);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
  });

  it("still withdraws consent when storage is full", () => {
    const storage = memoryStorage({});
    saveRemoteConsent("https://a.example.com", true, storage);
    const full: Storage = {
      ...storage,
      getItem: (key) => storage.getItem(key),
      removeItem: (key) => storage.removeItem(key),
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };

    expect(() => saveRemoteConsent("https://a.example.com", false, full)).not.toThrow();
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
    // Switching to B while full must not leave A granted either.
    saveRemoteConsent("https://a.example.com", true, storage);
    expect(() => saveRemoteConsent("https://b.example.com", true, full)).not.toThrow();
    expect(loadRemoteConsent("https://b.example.com", storage)).toBe(false);
    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
  });

  it("treats a corrupt ledger as no consent and keeps the corrupt copy", () => {
    const corrupt = JSON.stringify([
      {
        purpose: "remoteAnalysis",
        granted: true,
        at: "2026-10-01T00:00:00.000Z",
        scope: "https://a.example.com",
      },
      { purpose: "remoteAnalysis", granted: false, at: "garbled", scope: "https://a.example.com" },
    ]);
    const storage = memoryStorage({ [CONSENT_LEDGER_KEY]: corrupt });

    expect(loadRemoteConsent("https://a.example.com", storage)).toBe(false);
    expect(storage.getItem(UNREADABLE_CONSENT_LEDGER_KEY)).toBe(corrupt);
    expect(
      loadRemoteConsent("https://a.example.com", memoryStorage({ [CONSENT_LEDGER_KEY]: "{" })),
    ).toBe(false);
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

  it("restores quarantined sessions once readable, drops readable duplicates, keeps the rest aside", () => {
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
    // The readable duplicate is dropped so it cannot come back after the visible copy is deleted.
    expect(JSON.parse(storage.getItem(UNREADABLE_SESSIONS_KEY) ?? "[]")).toEqual([stillUnreadable]);
  });

  it("clears quarantined sessions when a restore replaces all sessions", () => {
    const storage = memoryStorage({ [UNREADABLE_SESSIONS_KEY]: JSON.stringify([{ id: "old" }]) });
    replaceStoredSessions([migrateSessionRecord(legacySession)], storage);
    expect(storage.getItem(UNREADABLE_SESSIONS_KEY)).toBeNull();
    expect(loadSessionsFromStorage(storage).map((session) => session.id)).toEqual(["legacy-1"]);
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
