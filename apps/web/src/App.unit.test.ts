import { describe, expect, it } from "vitest";
import {
  fallbackAnalyze,
  formatTime,
  offsetTranscriptSegments,
  resampleSamples,
  staticModelStatuses,
  summarizeTranscriptionChunks,
} from "./App";

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
    expect(report.speechStats.wordsPerMinute).toBeCloseTo(39.3, 1);
    expect(report.speechStats.eventDensityPer100Words).toBe(100);
    expect(report.blockerStats.blockCount).toBe(1);
    expect(report.blockerStats.totalBlockSeconds).toBeCloseTo(0.9, 5);
    expect(report.blockerStats.longestBlockSeconds).toBeCloseTo(0.9, 5);
    expect(report.chunks).toHaveLength(1);
    expect(report.chunks[0]).toMatchObject({
      wordCount: 4,
      stutterCount: 3,
      fillerCount: 1,
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

  it("detects acoustic silent blocks from samples", () => {
    const sampleRate = 16_000;
    const report = fallbackAnalyze({
      segments: [
        {
          text: "then",
          startSeconds: 1.3,
          endSeconds: 1.9,
          isFinal: true,
        },
      ],
      pauses: [],
      samples: [
        ...sineWave(220, sampleRate, 0.6),
        ...Array.from({ length: Math.floor(sampleRate * 0.7) }, () => 0),
        ...sineWave(220, sampleRate, 0.6),
      ],
      sampleRate,
    });

    expect(report.acousticStats?.onsetCount).toBeGreaterThanOrEqual(0);
    expect(
      report.events.some((event) => event.kind === "block" && event.source === "acoustic"),
    ).toBe(true);
    expect(report.byKind.block).toBeGreaterThanOrEqual(1);
  });

  it("detects repeated acoustic onset bursts", () => {
    const sampleRate = 16_000;
    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      samples.push(...sineWave(440, sampleRate, 0.08));
      samples.push(...Array.from({ length: Math.floor(sampleRate * 0.12) }, () => 0));
    }
    const report = fallbackAnalyze({
      segments: [{ text: "start", startSeconds: 0, endSeconds: 0.6, isFinal: true }],
      pauses: [],
      samples,
      sampleRate,
    });

    expect(
      report.events.some(
        (event) => event.kind === "soundRepetition" && event.source === "acoustic",
      ),
    ).toBe(true);
  });

  it("filters quiet acoustic-only candidates", () => {
    const sampleRate = 16_000;
    const report = fallbackAnalyze({
      segments: [],
      pauses: [],
      samples: Array.from({ length: sampleRate }, () => 0.0005),
      sampleRate,
    });

    expect(report.stutterCount).toBe(0);
    expect(report.events).toHaveLength(0);
  });

  it("fuses transcript and acoustic prolongations into chunk stats", () => {
    const sampleRate = 16_000;
    const report = fallbackAnalyze({
      segments: [{ text: "ssssstart", startSeconds: 0, endSeconds: 0.9, isFinal: true }],
      pauses: [],
      samples: sineWave(180, sampleRate, 0.9),
      sampleRate,
    });

    const prolongations = report.events.filter((event) => event.kind === "prolongation");
    expect(prolongations).toHaveLength(1);
    expect(prolongations[0].source).toBe("fused");
    expect(prolongations[0].acousticEvidence).toBeDefined();
    expect(report.chunks[0].stutterCount).toBe(1);
    expect(report.byKind.prolongation).toBe(1);
  });
});

describe("frontend helpers", () => {
  it("resamples audio with linear interpolation", () => {
    expect(resampleSamples([0, 10, 20, 30], 4, 2)).toEqual([0, 20]);
    expect(resampleSamples([1, 2, 3], 8_000, 8_000)).toEqual([1, 2, 3]);
  });

  it("offsets chunk transcript timings", () => {
    expect(
      offsetTranscriptSegments(
        [{ text: "hello", startSeconds: 0.5, endSeconds: 1.25, isFinal: true }],
        8,
      ),
    ).toEqual([{ text: "hello", startSeconds: 8.5, endSeconds: 9.25, isFinal: true }]);
  });

  it("summarizes per-chunk transcription states", () => {
    expect(
      summarizeTranscriptionChunks([
        { status: "completed" },
        { status: "processing" },
        { status: "queued" },
        { status: "failed" },
        { status: "completed" },
      ]),
    ).toEqual({
      total: 5,
      queued: 1,
      processing: 1,
      completed: 2,
      failed: 1,
    });
  });

  it("formats model status and time defaults", () => {
    expect(staticModelStatuses("browser")).toEqual([
      { id: "default", label: "default", cached: true, downloadable: false },
    ]);
    expect(formatTime(65.8)).toBe("1:05");
  });
});

function sineWave(frequency: number, sampleRate: number, seconds: number) {
  const count = Math.floor(sampleRate * seconds);
  return Array.from({ length: count }, (_, index) => {
    const phase = (index * frequency * Math.PI * 2) / sampleRate;
    return Math.sin(phase) * 0.4;
  });
}
