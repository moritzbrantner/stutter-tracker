import { describe, expect, test } from "bun:test";

import { fallbackAnalyze } from "./index";
import {
  audioFingerprint,
  createSessionRecord,
  type LegacySessionRecord,
  migrateSessionRecord,
  observationFingerprint,
  reanalyzeSession,
  SESSION_SCHEMA_VERSION,
  SHARED_ANALYSIS_VERSION,
  sessionAnalysisRuns,
} from "./sessions";

const segments = [{ text: "hello hello world", startSeconds: 0, endSeconds: 1.5, isFinal: true }];
const pauses = [{ startSeconds: 1.5, endSeconds: 2.25 }];
const report = fallbackAnalyze({ segments, pauses });

const legacy: LegacySessionRecord = {
  id: "session-1",
  startedAt: "2026-09-09T06:00:00.000Z",
  segments,
  pauses,
  report,
};

const onDevice = {
  producer: "onDevice" as const,
  algorithm: "shared-fallback",
  version: SHARED_ANALYSIS_VERSION,
};

describe("session records", () => {
  test("migrates a legacy record with visibly unknown provenance", () => {
    const migrated = migrateSessionRecord(legacy);

    expect(migrated).toEqual({
      schemaVersion: SESSION_SCHEMA_VERSION,
      ...legacy,
      context: { spokenLanguage: "unknown", task: null, condition: null },
      recordings: [],
      analysis: {
        id: "session-1:legacy",
        createdAt: null,
        analyzer: null,
        inputId: observationFingerprint(segments, pauses),
        usedAudio: null,
        audioId: null,
      },
      priorAnalyses: [],
    });
  });

  test("keeps current records and rejects unknown schema versions", () => {
    const current = migrateSessionRecord(legacy);
    expect(migrateSessionRecord(current)).toBe(current);
    expect(() => migrateSessionRecord({ ...current, schemaVersion: 3 as 2 })).toThrow(
      "Unsupported session schema version 3",
    );
  });

  test("stores analyzer identity, timestamp and input identity once per run", () => {
    const record = createSessionRecord({
      ...legacy,
      run: {
        id: "run-1",
        createdAt: "2026-09-09T06:01:00.000Z",
        analyzer: onDevice,
        usedAudio: true,
        audioId: null,
      },
    });

    expect(record.analysis).toEqual({
      id: "run-1",
      createdAt: "2026-09-09T06:01:00.000Z",
      analyzer: onDevice,
      inputId: observationFingerprint(segments, pauses),
      usedAudio: true,
      audioId: null,
    });
    expect(record.priorAnalyses).toEqual([]);
  });

  test("keeps the analyzed input identity when the report predates the saved observation", () => {
    const staleInput = observationFingerprint([], []);
    const record = createSessionRecord({
      ...legacy,
      run: {
        id: "run-1",
        createdAt: null,
        analyzer: onDevice,
        usedAudio: false,
        audioId: null,
        inputId: staleInput,
      },
    });

    expect(record.analysis.inputId).toBe(staleInput);
    expect(record.analysis.inputId).not.toBe(observationFingerprint(segments, pauses));
  });

  test("reanalysis appends a run and preserves the observation and earlier results", () => {
    const original = migrateSessionRecord(legacy);
    const nextReport = { ...report, stutterCount: report.stutterCount + 1 };

    const rerun = reanalyzeSession(
      original,
      {
        id: "run-2",
        createdAt: "2026-10-01T00:00:00.000Z",
        analyzer: onDevice,
        usedAudio: false,
        audioId: null,
      },
      nextReport,
    );

    expect(rerun.segments).toBe(original.segments);
    expect(rerun.pauses).toBe(original.pauses);
    expect(rerun.report).toBe(nextReport);
    expect(rerun.analysis.id).toBe("run-2");
    expect(rerun.analysis.inputId).toBe(original.analysis.inputId);
    expect(sessionAnalysisRuns(rerun).map((run) => [run.id, run.report])).toEqual([
      ["session-1:legacy", report],
      ["run-2", nextReport],
    ]);
    expect(original.priorAnalyses).toEqual([]);
    expect(original.report).toBe(report);
  });

  test("rejects recording the same run twice", () => {
    const original = migrateSessionRecord(legacy);
    expect(() => reanalyzeSession(original, { ...original.analysis }, report)).toThrow(
      "already recorded",
    );
  });

  test("fingerprints analyzed audio by sample rate and exact samples", () => {
    const samples = [0, 0.25, -0.5, 1];
    expect(audioFingerprint(samples, 16_000)).toBe(audioFingerprint(samples, 16_000));
    expect(audioFingerprint(samples, 16_000)).toMatch(/^pcm-[0-9a-f]{16}$/);
    expect(audioFingerprint(samples, 48_000)).not.toBe(audioFingerprint(samples, 16_000));
    expect(audioFingerprint([0, 0.25, -0.5, 0.9], 16_000)).not.toBe(
      audioFingerprint(samples, 16_000),
    );
    expect(audioFingerprint([...samples, 0], 16_000)).not.toBe(audioFingerprint(samples, 16_000));
  });

  test("fingerprints the observation deterministically", () => {
    expect(observationFingerprint(segments, pauses)).toBe(observationFingerprint(segments, pauses));
    expect(observationFingerprint(segments, pauses)).toMatch(/^obs-[0-9a-f]{16}$/);
    expect(observationFingerprint([{ ...segments[0], text: "hello world" }], pauses)).not.toBe(
      observationFingerprint(segments, pauses),
    );
    expect(observationFingerprint(segments, [])).not.toBe(observationFingerprint(segments, pauses));
    for (const changed of [
      { ...segments[0], confidence: 0.4 },
      { ...segments[0], speakerScore: 0.9 },
      { ...segments[0], speakerLabel: "Guest" },
    ]) {
      expect(observationFingerprint([changed], pauses)).not.toBe(
        observationFingerprint(segments, pauses),
      );
    }
    expect(observationFingerprint(segments, [{ ...pauses[0], afterText: "world" }])).not.toBe(
      observationFingerprint(segments, pauses),
    );
  });
});
