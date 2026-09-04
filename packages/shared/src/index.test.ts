import { describe, expect, test } from "bun:test";

import { emptyReport, fallbackAnalyze } from "./index";

describe("emptyReport", () => {
  test("returns the neutral product report", () => {
    const report = emptyReport();

    expect(report).toMatchObject({
      totalDurationSeconds: 0,
      wordCount: 0,
      stutterCount: 0,
      stuttersPerMinute: 0,
      severity: "none",
      chunks: [],
      events: [],
      byKind: {},
    });
    expect(report.speechStats.fluencyPercentage).toBe(100);
    expect(report.blockerStats.blockCount).toBe(0);
  });
});

describe("fallbackAnalyze", () => {
  test("uses finalized transcript segments and pauses only", () => {
    const report = fallbackAnalyze({
      segments: [
        {
          text: "I I speak",
          startSeconds: 0,
          endSeconds: 3,
          isFinal: true,
        },
        {
          text: "ignored ignored",
          startSeconds: 3,
          endSeconds: 8,
          isFinal: false,
        },
      ],
      pauses: [
        {
          startSeconds: 3,
          endSeconds: 4,
          afterText: "speak",
        },
      ],
    });

    expect(report.totalDurationSeconds).toBe(4);
    expect(report.wordCount).toBe(3);
    expect(report.chunks).toHaveLength(1);
    expect(report.byKind.wordRepetition).toBe(1);
    expect(report.byKind.block).toBe(1);
    expect(report.events.some((event) => event.text.includes("ignored"))).toBe(false);
  });
});
