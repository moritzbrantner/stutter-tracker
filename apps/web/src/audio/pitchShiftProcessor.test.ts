import { describe, expect, it } from "vitest";
import processorSource from "./pitchShiftProcessor.js?raw";

// Deterministic fixtures for the pitch-shift worklet, run outside the browser. Physical hearing
// safety and end-to-end latency are not inferred from these tests (latency is #30).

const SAMPLE_RATE = 48_000;
const BLOCK = 128;

type Processor = {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: { semitones: Float32Array },
  ): boolean;
};

function createProcessor(): Processor {
  let registered: (new () => Processor) | null = null;
  new Function("AudioWorkletProcessor", "registerProcessor", processorSource)(
    class {},
    (_name: string, processor: new () => Processor) => {
      registered = processor;
    },
  );
  if (!registered) {
    throw new Error("pitch-shift processor was not registered");
  }
  return new (registered as new () => Processor)();
}

/** Runs `input` through the processor block by block; `semitonesAt` gives each block's setting. */
function run(input: Float32Array, semitonesAt: (block: number) => number) {
  const processor = createProcessor();
  const output = new Float32Array(input.length);
  for (let start = 0, block = 0; start < input.length; start += BLOCK, block += 1) {
    const inBlock = input.slice(start, start + BLOCK);
    const outBlock = new Float32Array(inBlock.length);
    processor.process([[inBlock]], [[outBlock]], {
      semitones: Float32Array.of(semitonesAt(block)),
    });
    output.set(outBlock, start);
  }
  return output;
}

function sine(hz: number, seconds: number, amplitude = 0.5) {
  return Float32Array.from(
    { length: Math.round(seconds * SAMPLE_RATE) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
  );
}

/** Mean frequency from upward zero crossings; robust enough for steady single tones. */
function estimatedFrequency(signal: Float32Array) {
  const crossings: number[] = [];
  for (let index = 1; index < signal.length; index += 1) {
    if (signal[index - 1] < 0 && signal[index] >= 0) {
      crossings.push(index);
    }
  }
  const periods = crossings.length - 1;
  return (periods * SAMPLE_RATE) / (crossings[periods] - crossings[0]);
}

function maxAbs(signal: Float32Array) {
  return signal.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function maxStep(signal: Float32Array) {
  let max = 0;
  for (let index = 1; index < signal.length; index += 1) {
    max = Math.max(max, Math.abs(signal[index] - signal[index - 1]));
  }
  return max;
}

describe("pitch-shift worklet", () => {
  it("passes audio through unchanged at 0 semitones", () => {
    const input = sine(220, 0.25);
    expect(run(input, () => 0)).toEqual(input);
  });

  it.each([4, -4, 6, -6])("shifts a 220 Hz tone by %i semitones within 3%%", (semitones) => {
    const output = run(sine(220, 2), () => semitones);
    // Skip the first half second while the delay lines fill.
    const measured = estimatedFrequency(output.slice(SAMPLE_RATE / 2));
    const expected = 220 * 2 ** (semitones / 12);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.03);
  });

  it.each([-6, -4, 0, 4, 6])("keeps full-scale output bounded at %i semitones", (semitones) => {
    const input = sine(997, 1, 1);
    expect(maxAbs(run(input, () => semitones))).toBeLessThanOrEqual(1 + 1e-6);
  });

  it("keeps silence silent", () => {
    const output = run(new Float32Array(SAMPLE_RATE / 2), (block) => (block % 2 ? 4 : -4));
    expect(maxAbs(output)).toBe(0);
  });

  it("never emits non-finite samples and recovers after non-finite input", () => {
    const input = sine(220, 1);
    input[1000] = Number.NaN;
    input[2000] = Number.POSITIVE_INFINITY;
    input[3000] = Number.NEGATIVE_INFINITY;
    for (const semitones of [0, 4, -4]) {
      const output = run(input, () => semitones);
      expect(output.every(Number.isFinite)).toBe(true);
      expect(maxAbs(output.slice(SAMPLE_RATE / 2))).toBeGreaterThan(0.1);
    }
  });

  it("treats a non-finite semitone setting as no shift", () => {
    const input = sine(220, 0.25);
    const output = run(input, () => Number.NaN);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(output).toEqual(input);
  });

  it("does not click when pitch shifting is switched on or off", () => {
    const input = sine(220, 1);
    const blocksPerQuarterSecond = SAMPLE_RATE / 4 / BLOCK;
    const output = run(input, (block) =>
      Math.floor(block / blocksPerQuarterSecond) % 2 === 1 ? 4 : 0,
    );
    // A 220 Hz, 0.5-amplitude sine moves at most ~0.0144 per sample; the grain crossfade at the
    // shifted pitch moves somewhat faster. Hard switches between dry and delayed audio jump far
    // more than this.
    expect(maxStep(output)).toBeLessThan(0.05);
  });

  it("does not click when the shift direction changes", () => {
    const input = sine(220, 1);
    const blocksPerQuarterSecond = SAMPLE_RATE / 4 / BLOCK;
    const output = run(input, (block) =>
      Math.floor(block / blocksPerQuarterSecond) % 2 === 1 ? -4 : 4,
    );
    expect(maxStep(output.slice(SAMPLE_RATE / 8))).toBeLessThan(0.05);
  });
});
