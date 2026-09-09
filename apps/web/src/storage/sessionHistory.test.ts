import { describe, expect, it } from "vitest";
import type { AnalysisReport, SavedSession } from "../types";
import { buildSessionHistory } from "./sessionHistory";

describe("buildSessionHistory", () => {
  it("returns the newest requested sessions in chronological order", () => {
    const sessions = [
      savedSession("newest", "2026-09-08T12:00:00.000Z", 96, 1.5, 132),
      savedSession("oldest", "2026-09-01T12:00:00.000Z", 88, 4.5, 118),
      savedSession("middle", "2026-09-05T12:00:00.000Z", 92, 3, 124),
    ];

    expect(buildSessionHistory(sessions, 2).map((session) => session.id)).toEqual([
      "middle",
      "newest",
    ]);
  });

  it("excludes invalid timestamps and handles an empty limit", () => {
    const sessions = [
      savedSession("valid", "2026-09-08T12:00:00.000Z", 90, 2, 120),
      savedSession("invalid", "not-a-date", 90, 2, 120),
    ];

    expect(buildSessionHistory(sessions).map((session) => session.id)).toEqual(["valid"]);
    expect(buildSessionHistory(sessions, 0)).toEqual([]);
  });

  it("normalizes legacy or malformed metrics without inventing fluency data", () => {
    const session = savedSession("legacy", "2026-09-08T12:00:00.000Z", 90, 2, 120);
    session.report.totalDurationSeconds = 120;
    session.report.stutterCount = 4;
    session.report.stuttersPerMinute = Number.NaN;
    (session.report as Partial<AnalysisReport>).speechStats = undefined;

    expect(buildSessionHistory([session])).toEqual([
      {
        id: "legacy",
        startedAt: "2026-09-08T12:00:00.000Z",
        durationSeconds: 120,
        stutterCount: 4,
        stuttersPerMinute: 2,
        fluencyPercentage: null,
        wordsPerMinute: null,
      },
    ]);
  });

  it("clamps persisted percentages and negative rates to display-safe values", () => {
    const session = savedSession("bounded", "2026-09-08T12:00:00.000Z", 130, -4, -20);

    expect(buildSessionHistory([session])[0]).toMatchObject({
      fluencyPercentage: 100,
      stuttersPerMinute: 0,
      wordsPerMinute: 0,
    });
  });
});

function savedSession(
  id: string,
  startedAt: string,
  fluencyPercentage: number,
  stuttersPerMinute: number,
  wordsPerMinute: number,
): SavedSession {
  return {
    id,
    startedAt,
    segments: [],
    pauses: [],
    report: {
      totalDurationSeconds: 60,
      wordCount: 100,
      stutterCount: 2,
      stuttersPerMinute,
      severity: "mild",
      speechStats: {
        speakingDurationSeconds: 50,
        pauseDurationSeconds: 10,
        wordsPerMinute,
        articulationRateWpm: wordsPerMinute,
        meanChunkWords: 10,
        meanChunkDurationSeconds: 5,
        eventDensityPer100Words: 2,
        fluencyPercentage,
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
}
