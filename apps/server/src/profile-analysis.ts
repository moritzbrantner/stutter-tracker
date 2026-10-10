// Runtime evidence for the compute server's audio-backed /analysis path: the shared analyzer
// plus the native worker's capture measurement (process launch, sample transfer, measurement).
//
//   STUTTER_NATIVE_WORKER=<release compute-worker> \
//     bun apps/server/src/profile-analysis.ts --duration-seconds 90 --iterations 10 [--no-measure]
//
// --no-measure replaces the worker with one that always fails, which is the server's behavior
// without a native worker (the report stays unmeasured): the baseline for the measurement cost.
// Prints one JSON object with per-request wall times; synthetic input is deterministic.
import { tmpdir } from "node:os";
import { createComputeRequestHandler } from "./index";
import { parseServerConfig } from "./config";
import { createNativeWorker, type NativeWorker } from "./native-worker";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const durationSeconds = option("--duration-seconds", 90);
const iterations = option("--iterations", 10);
const measure = !args.includes("--no-measure");
const sampleRate = 16_000;

const config = { ...parseServerConfig(), uploadTmpDir: tmpdir() };
const realWorker = createNativeWorker(config);
const nativeWorker: NativeWorker = measure
  ? realWorker
  : {
      ...realWorker,
      captureMetrics: async () => {
        throw new Error("measurement disabled for the baseline");
      },
    };
const handler = createComputeRequestHandler({
  config,
  nativeWorker,
  speakerStore: {
    deleteMissing: false,
    list: async () => [],
    upsertMany: async (speakers) => speakers,
    delete: async () => false,
    deleteAll: async () => 0,
  },
});

// A 220 Hz tone with a pause every few seconds, plus one word per second of transcript.
const samples = Array.from({ length: durationSeconds * sampleRate }, (_, index) => {
  const seconds = index / sampleRate;
  return seconds % 4 < 3 ? Math.round(0.3 * Math.sin(2 * Math.PI * 220 * seconds) * 1e4) / 1e4 : 0;
});
const segments = Array.from({ length: durationSeconds }, (_, second) => ({
  text: second % 7 === 0 ? "I I want" : "want",
  startSeconds: second,
  endSeconds: second + 0.8,
  isFinal: true,
}));
const body = JSON.stringify({ segments, pauses: [], samples, sampleRate });

const timesMs: number[] = [];
let measured = 0;
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const started = performance.now();
  const response = await handler(
    new Request("http://profile/analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  const report = (await response.json()) as { captureMetrics?: unknown };
  timesMs.push(performance.now() - started);
  if (!response.ok) throw new Error(`analysis failed with ${response.status}`);
  if (report.captureMetrics) measured += 1;
}

const sorted = [...timesMs].sort((a, b) => a - b);
const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(
  JSON.stringify({
    scenario: `server-analysis-${durationSeconds}s${measure ? "" : "-unmeasured"}`,
    durationSeconds,
    requestBytes: body.length,
    iterations,
    measuredReports: measured,
    msPerRequest: timesMs.map((ms) => Math.round(ms * 10) / 10),
    p50Ms: Math.round(quantile(0.5) * 10) / 10,
    maxMs: Math.round(sorted.at(-1)! * 10) / 10,
  }),
);
