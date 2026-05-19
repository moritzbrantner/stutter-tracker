import { describe, expect, it } from "vitest";
import { fallbackAnalyze, formatTime, resampleSamples, staticModelStatuses } from "./App";

describe("fallbackAnalyze", () => {
  it("detects repetitions, fillers, prolongations, and blocking pauses", () => {
    const report = fallbackAnalyze({
      segments: [
        {
          text: "I I um sssstart now",
          startSeconds: 0,
          endSeconds: 5,
          isFinal: true,
        },
      ],
      pauses: [{ startSeconds: 5.2, endSeconds: 6.1, afterText: "now" }],
      sessionStartedAt: "2026-05-19T10:00:00.000Z",
    });

    expect(report.sessionStartedAt).toBe("2026-05-19T10:00:00.000Z");
    expect(report.wordCount).toBe(4);
    expect(report.stutterCount).toBe(4);
    expect(report.severity).toBe("high");
    expect(report.byKind).toMatchObject({
      wordRepetition: 1,
      filler: 1,
      prolongation: 1,
      block: 1,
    });
    expect(report.events.map((event) => event.kind)).toEqual([
      "wordRepetition",
      "filler",
      "prolongation",
      "block",
    ]);
  });

  it("ignores non-final transcript segments", () => {
    const report = fallbackAnalyze({
      segments: [
        {
          text: "I I I",
          startSeconds: 0,
          endSeconds: 2,
          isFinal: false,
        },
      ],
      pauses: [],
    });

    expect(report.wordCount).toBe(0);
    expect(report.stutterCount).toBe(0);
    expect(report.severity).toBe("none");
  });
});

describe("frontend helpers", () => {
  it("resamples audio with linear interpolation", () => {
    expect(resampleSamples([0, 10, 20, 30], 4, 2)).toEqual([0, 20]);
    expect(resampleSamples([1, 2, 3], 8_000, 8_000)).toEqual([1, 2, 3]);
  });

  it("formats model status and time defaults", () => {
    expect(staticModelStatuses("browser")).toEqual([
      { id: "default", label: "default", cached: true, downloadable: false },
    ]);
    expect(formatTime(65.8)).toBe("1:05");
  });
});
