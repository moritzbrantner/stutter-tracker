// Runtime evidence for `audioFingerprint` (benchmark tier, not a CI gate).
//
//   bun scripts/bench-audio-fingerprint.ts
//
// The web app fingerprints the analysed audio once per analysis request, on the UI thread. It is
// compared here with the resampling the same request already performs on the same buffer, at the
// 90-second cap the app sends for analysis.
import { audioFingerprint, resampleSamples } from "../src/index";

const SOURCE_RATE = 48_000;
const TARGET_RATE = 16_000;
const raw = Array.from({ length: SOURCE_RATE * 90 }, (_, index) => 0.3 * Math.sin(index / 50));
const resampled = resampleSamples(raw, SOURCE_RATE, TARGET_RATE);

function averageMs(run: () => unknown, rounds = 10) {
  for (let warmUp = 0; warmUp < 3; warmUp += 1) run();
  const started = performance.now();
  for (let round = 0; round < rounds; round += 1) run();
  return (performance.now() - started) / rounds;
}

console.log(`samples: ${resampled.length} (90 s at ${TARGET_RATE} Hz)`);
console.log(
  `audioFingerprint:         ${averageMs(() => audioFingerprint(resampled, TARGET_RATE)).toFixed(2)} ms`,
);
console.log(
  `resampleSamples (exists): ${averageMs(() => resampleSamples(raw, SOURCE_RATE, TARGET_RATE)).toFixed(2)} ms`,
);
