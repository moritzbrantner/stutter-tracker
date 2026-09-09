import { describe, expect, test } from "vitest";
import type { SavedSession } from "../types";
import {
  createSessionBackup,
  MAX_RESTORED_SESSIONS,
  parseSessionBackup,
  SESSION_BACKUP_VERSION,
} from "./sessionBackup";

const session: SavedSession = {
  id: "session-1",
  startedAt: "2026-09-09T06:00:00.000Z",
  segments: [
    {
      text: "hello world",
      startSeconds: 0,
      endSeconds: 1.2,
      isFinal: true,
    },
  ],
  pauses: [{ startSeconds: 1.2, endSeconds: 2 }],
  report: {
    totalDurationSeconds: 2,
    wordCount: 2,
    stutterCount: 0,
    stuttersPerMinute: 0,
    severity: "none",
    speechStats: {
      speakingDurationSeconds: 1.2,
      pauseDurationSeconds: 0.8,
      wordsPerMinute: 100,
      articulationRateWpm: 100,
      meanChunkWords: 2,
      meanChunkDurationSeconds: 1.2,
      eventDensityPer100Words: 0,
      fluencyPercentage: 100,
    },
    blockerStats: {
      blockCount: 0,
      totalBlockSeconds: 0,
      averageBlockSeconds: 0,
      longestBlockSeconds: 0,
      blocksPerMinute: 0,
      blockedTimePercentage: 0,
    },
    chunks: [],
    events: [],
    byKind: {},
  },
};

describe("session backup", () => {
  test("creates a versioned deterministic envelope for a supplied export time", () => {
    const backup = createSessionBackup([session], new Date("2026-09-09T07:00:00.000Z"));

    expect(backup).toEqual({
      version: SESSION_BACKUP_VERSION,
      exportedAt: "2026-09-09T07:00:00.000Z",
      sessions: [session],
    });
  });

  test("accepts current and legacy exports that contain valid sessions", () => {
    expect(parseSessionBackup(createSessionBackup([session]))).toEqual([session]);
    expect(parseSessionBackup({ sessions: [session], speakers: [], corpus: {} })).toEqual([
      session,
    ]);
  });

  test("fails closed for malformed session data", () => {
    expect(() =>
      parseSessionBackup({ sessions: [{ ...session, startedAt: "not-a-date" }] }),
    ).toThrow("Backup session 1 is invalid.");
    expect(() => parseSessionBackup({ sessions: "bad" })).toThrow(
      "Backup must contain a sessions array.",
    );
  });

  test("rejects duplicate ids and backups outside the product retention boundary", () => {
    expect(() => parseSessionBackup({ sessions: [session, session] })).toThrow(
      "Backup contains duplicate session id session-1.",
    );
    expect(() =>
      parseSessionBackup({
        sessions: Array.from({ length: MAX_RESTORED_SESSIONS + 1 }, (_, index) => ({
          ...session,
          id: `session-${index}`,
        })),
      }),
    ).toThrow(`Backup contains more than ${MAX_RESTORED_SESSIONS} sessions.`);
  });
});
