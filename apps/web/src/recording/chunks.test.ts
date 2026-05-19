import { describe, expect, it } from "vitest";
import { planAvailableChunks } from "./chunks";

describe("planAvailableChunks", () => {
  it("does not emit premature chunks", () => {
    expect(
      planAvailableChunks({
        totalSamples: 16_000 * 7,
        nextStartSample: 0,
        sampleRate: 16_000,
        chunkSeconds: 8,
        forceFinal: false,
      }),
    ).toEqual([]);
  });

  it("emits an exact chunk", () => {
    expect(
      planAvailableChunks({
        totalSamples: 16_000 * 8,
        nextStartSample: 0,
        sampleRate: 16_000,
        chunkSeconds: 8,
        forceFinal: false,
      }),
    ).toEqual([{ startSample: 0, endSample: 128_000 }]);
  });

  it("emits final partial chunks at the 0.5 second minimum", () => {
    expect(
      planAvailableChunks({
        totalSamples: 8_000,
        nextStartSample: 0,
        sampleRate: 16_000,
        chunkSeconds: 8,
        forceFinal: true,
      }),
    ).toEqual([{ startSample: 0, endSample: 8_000 }]);
  });

  it("does not duplicate a final flush after all samples are consumed", () => {
    expect(
      planAvailableChunks({
        totalSamples: 128_000,
        nextStartSample: 128_000,
        sampleRate: 16_000,
        chunkSeconds: 8,
        forceFinal: true,
      }),
    ).toEqual([]);
  });
});
