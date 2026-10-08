import {
  annotateSession,
  type LegacySessionRecord,
  migrateSessionRecord,
  reanalyzeSession,
  SHARED_ANALYSIS_VERSION,
} from "@stutter-tracker/shared";
import { describe, expect, test } from "vitest";
import {
  createSessionBackup,
  MAX_RESTORED_SESSIONS,
  parseSessionBackup,
  SESSION_BACKUP_VERSION,
} from "./sessionBackup";

// Exactly what version-1 backups and pre-migration storage contain.
const legacySession: LegacySessionRecord = {
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

const session = migrateSessionRecord(legacySession);

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
    expect(parseSessionBackup({ sessions: [legacySession], speakers: [], corpus: {} })).toEqual([
      session,
    ]);
  });

  test("migrates a version-1 backup with visibly unknown provenance", () => {
    const [migrated] = parseSessionBackup({
      version: 1,
      exportedAt: "2026-09-09T07:00:00.000Z",
      sessions: [legacySession],
    });

    expect(migrated).toMatchObject({ ...legacySession, schemaVersion: 2 });
    expect(migrated.context).toEqual({ spokenLanguage: "unknown", task: null, condition: null });
    expect(migrated.analysis).toMatchObject({ createdAt: null, analyzer: null, usedAudio: null });
    expect(migrated.recordings).toEqual([]);
  });

  test("roundtrips reanalysis history without losing earlier results", () => {
    const rerun = reanalyzeSession(
      session,
      {
        id: "run-2",
        createdAt: "2026-10-01T00:00:00.000Z",
        analyzer: {
          producer: "onDevice",
          algorithm: "shared-fallback",
          version: SHARED_ANALYSIS_VERSION,
        },
        usedAudio: false,
        audioId: null,
      },
      { ...session.report, stutterCount: 1 },
    );

    const [restored] = parseSessionBackup(JSON.parse(JSON.stringify(createSessionBackup([rerun]))));

    expect(restored).toEqual(rerun);
    expect(restored.priorAnalyses).toEqual([{ ...session.analysis, report: session.report }]);
  });

  test("accepts complete recording descriptors and rejects partial ones", () => {
    const recording = {
      sessionId: "session-1",
      runId: "run-1",
      origin: "browser",
      role: "appInput",
      sampleRate: 48_000,
      channelCount: 1,
      startOffsetSeconds: 0,
      preprocessing: {
        echoCancellation: { requested: true },
        noiseSuppression: { requested: true, applied: true },
        autoGainControl: { requested: false, applied: false },
      },
      discontinuities: [{ startSeconds: 1, endSeconds: 1.5, reason: "dropout" }],
      speakerAssessment: "unknown",
    };
    expect(
      parseSessionBackup({ sessions: [{ ...session, recordings: [recording] }] }),
    ).toHaveLength(1);
    expect(() =>
      parseSessionBackup({
        sessions: [{ ...session, recordings: [{ ...recording, sessionId: "other-session" }] }],
      }),
    ).toThrow("Backup session 1 is invalid.");
    for (const broken of [{ sampleRate: 0 }, { channelCount: 0 }, { channelCount: 1.5 }]) {
      expect(() =>
        parseSessionBackup({
          sessions: [{ ...session, recordings: [{ ...recording, ...broken }] }],
        }),
      ).toThrow("Backup session 1 is invalid.");
    }
    const { discontinuities: _dropped, ...partial } = recording;
    expect(() => parseSessionBackup({ sessions: [{ ...session, recordings: [partial] }] })).toThrow(
      "Backup session 1 is invalid.",
    );
  });

  test("rejects recordings from another session and repeated run ids", () => {
    const rerun = reanalyzeSession(
      session,
      { id: "run-2", createdAt: null, analyzer: null, usedAudio: null, audioId: null },
      session.report,
    );
    expect(() =>
      parseSessionBackup({
        sessions: [{ ...rerun, analysis: { ...rerun.analysis, id: session.analysis.id } }],
      }),
    ).toThrow("Backup session 1 is invalid.");
    expect(() =>
      parseSessionBackup({
        sessions: [{ ...rerun, priorAnalyses: [rerun.priorAnalyses[0], rerun.priorAnalyses[0]] }],
      }),
    ).toThrow("Backup session 1 is invalid.");
  });

  test("accepts only declared speaking-task kinds", () => {
    const withTask = (kind: string) => ({
      ...session,
      context: { ...session.context, task: { kind, trained: false } },
    });
    expect(parseSessionBackup({ sessions: [withTask("phoneCall")] })).toHaveLength(1);
    expect(() => parseSessionBackup({ sessions: [withTask("interview")] })).toThrow(
      "Backup session 1 is invalid.",
    );
    const described = (description: unknown) => ({
      ...session,
      context: { ...session.context, task: { kind: "reading", trained: false, description } },
    });
    expect(parseSessionBackup({ sessions: [described("Rainbow passage")] })).toHaveLength(1);
    expect(() => parseSessionBackup({ sessions: [described([])] })).toThrow(
      "Backup session 1 is invalid.",
    );
  });

  test("validates assisted-condition settings", () => {
    const withSettings = (settings: unknown) => ({
      ...session,
      context: { ...session.context, condition: { kind: "assisted", aidId: "daf", settings } },
    });
    expect(
      parseSessionBackup({ sessions: [withSettings({ delayMs: 100, on: true })] }),
    ).toHaveLength(1);
    expect(parseSessionBackup({ sessions: [withSettings(undefined)] })).toHaveLength(1);
    for (const bad of [{ delayMs: [] }, "fast", { delayMs: Number.NaN }]) {
      expect(() => parseSessionBackup({ sessions: [withSettings(bad)] })).toThrow(
        "Backup session 1 is invalid.",
      );
    }
  });

  test("roundtrips annotation revisions and completes older records without them", () => {
    const annotated = annotateSession(session, {
      id: "ann-1",
      createdAt: "2026-10-08T10:00:00.000Z",
      author: { role: "self" },
      basedOnRunId: session.analysis.id,
      events: [{ kind: "block", startSeconds: 1.2, endSeconds: 2, certainty: "possible" }],
      status: "accepted",
      supersedes: null,
    });
    const [restored] = parseSessionBackup(
      JSON.parse(JSON.stringify(createSessionBackup([annotated]))),
    );
    expect(restored.annotations).toEqual(annotated.annotations);

    const { annotations: _none, ...older } = session;
    expect(parseSessionBackup({ sessions: [older] })[0].annotations).toEqual([]);
  });

  test("rejects malformed or dangling annotation revisions", () => {
    const valid = {
      id: "ann-1",
      createdAt: "2026-10-08T10:00:00.000Z",
      author: { role: "clinician" },
      basedOnRunId: null,
      inputId: "obs",
      events: [],
      status: "accepted",
      supersedes: null,
    };
    for (const annotations of [
      [{ ...valid, author: { role: "robot" } }],
      [
        {
          ...valid,
          events: [{ kind: "block", startSeconds: 2, endSeconds: 1, certainty: "certain" }],
        },
      ],
      [{ ...valid, supersedes: "missing" }],
      [{ ...valid, basedOnRunId: "run-x" }],
      [valid, valid],
      "not a list",
    ]) {
      expect(() => parseSessionBackup({ sessions: [{ ...session, annotations }] })).toThrow(
        "Backup session 1 is invalid.",
      );
    }
  });

  test("imports nothing when any session is unreadable", () => {
    expect(() =>
      parseSessionBackup({
        sessions: [legacySession, { ...session, id: "session-2", schemaVersion: 3 }],
      }),
    ).toThrow("Unsupported session schema version 3.");
    expect(() =>
      parseSessionBackup({
        sessions: [session, { ...session, id: "session-2", analysis: { id: "" } }],
      }),
    ).toThrow("Backup session 2 is invalid.");
    expect(() =>
      parseSessionBackup({
        sessions: [{ ...session, priorAnalyses: [{ ...session.analysis, report: {} }] }],
      }),
    ).toThrow("Backup session 1 is invalid.");
  });

  test("fails closed for malformed session data", () => {
    expect(() =>
      parseSessionBackup({ sessions: [{ ...session, startedAt: "not-a-date" }] }),
    ).toThrow("Backup session 1 is invalid.");
    expect(() => parseSessionBackup({ sessions: "bad" })).toThrow(
      "Backup must contain a sessions array.",
    );
  });

  test("rejects malformed optional report structures when they are present", () => {
    expect(() =>
      parseSessionBackup({
        sessions: [
          {
            ...session,
            report: { ...session.report, speechStats: {} },
          },
        ],
      }),
    ).toThrow("Backup session 1 is invalid.");
    expect(() =>
      parseSessionBackup({
        sessions: [
          {
            ...session,
            report: { ...session.report, chunks: {} },
          },
        ],
      }),
    ).toThrow("Backup session 1 is invalid.");
  });

  test("rejects unsupported versions and invalid export timestamps", () => {
    expect(() => parseSessionBackup({ version: 3, sessions: [session] })).toThrow(
      "Unsupported backup version 3.",
    );
    expect(() => parseSessionBackup({ exportedAt: "not-a-date", sessions: [session] })).toThrow(
      "Backup export timestamp is invalid.",
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
