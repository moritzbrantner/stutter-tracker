// Runtime evidence for the pitch-shift worklet's render loop (benchmark tier, not a CI gate).
//
//   bun scripts/bench-pitch-worklet.ts [path/to/pitchShiftProcessor.js]
//
// Reports per-128-sample-block cost for steady passthrough, steady shifting and repeated
// transitions, against the 2.67 ms real-time budget of a block at 48 kHz. Numbers come from this
// machine's JS engine; low-power devices and browser audio threads have less headroom.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 48_000;
const BLOCK = 128;
const BUDGET_MS = (BLOCK / SAMPLE_RATE) * 1000;
const BLOCKS = 20_000;

type Processor = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: object): boolean;
};

const sourcePath =
  process.argv[2] ?? fileURLToPath(new URL("../src/audio/pitchShiftProcessor.js", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

function createProcessor(): Processor {
  let registered: (new () => Processor) | undefined;
  new Function("AudioWorkletProcessor", "registerProcessor", source)(
    class {},
    (_name: string, processor: new () => Processor) => {
      registered = processor;
    },
  );
  if (!registered) throw new Error("processor was not registered");
  return new registered();
}

function measure(name: string, semitonesAt: (block: number) => number) {
  const processor = createProcessor();
  const input = Float32Array.from(
    { length: BLOCK },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE),
  );
  const output = new Float32Array(BLOCK);
  const params = Array.from({ length: 32 }, (_, block) => ({
    semitones: Float32Array.of(semitonesAt(block)),
  }));
  // Warm up the JIT before timing.
  for (let block = 0; block < 2_000; block += 1) {
    processor.process([[input]], [[output]], params[block % params.length]);
  }
  const samples: number[] = [];
  for (let block = 0; block < BLOCKS; block += 1) {
    const started = performance.now();
    processor.process([[input]], [[output]], params[block % params.length]);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p99 = samples[Math.floor(samples.length * 0.99)];
  console.log(
    `${name.padEnd(28)} mean ${(mean * 1000).toFixed(1).padStart(6)} µs  p99 ${(p99 * 1000)
      .toFixed(1)
      .padStart(6)} µs  (${((mean / BUDGET_MS) * 100).toFixed(2)}% of ${BUDGET_MS.toFixed(2)} ms)`,
  );
}

console.log(`worklet: ${sourcePath}`);
measure("passthrough (0 st)", () => 0);
measure("steady shift (+4 st)", () => 4);
measure("on/off every 16 blocks", (block) => (block < 16 ? 4 : 0));
measure("direction flip every 16 blocks", (block) => (block < 16 ? 4 : -4));
