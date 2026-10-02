import { describe, expect, test } from "bun:test";

import {
  assessCaptureQuality,
  isUnprocessedInput,
  measureCapture,
  type RecordingDescriptor,
  resampledDescriptor,
  sampleIndexToSessionSeconds,
  sessionSecondsToSampleIndex,
  streamSecondsToSessionSeconds,
} from "./capture";
import { resampleSamples } from "./index";

function descriptor(overrides: Partial<RecordingDescriptor> = {}): RecordingDescriptor {
  return {
    sessionId: "session-1",
    runId: "run-1",
    origin: "browser",
    role: "appInput",
    sampleRate: 48_000,
    channelCount: 1,
    startOffsetSeconds: 0.25,
    preprocessing: {
      echoCancellation: { requested: true },
      noiseSuppression: { requested: true },
      autoGainControl: { requested: false },
    },
    discontinuities: [],
    speakerAssessment: "singleSpeakerDeclared",
    ...overrides,
  };
}

/** Speech-like synthetic tone bursts: 0.3 s on, 0.1 s off. */
function speechLike(seconds: number, sampleRate: number, amplitude = 0.3) {
  return Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) => {
    const t = index / sampleRate;
    return t % 0.4 < 0.3 ? amplitude * Math.sin(2 * Math.PI * 180 * t) : 0;
  });
}

describe("common session time base", () => {
  test("an impulse keeps its session time through 48 kHz -> 16 kHz resampling", () => {
    const source = descriptor();
    const samples = Array.from({ length: 48_000 * 2 }, () => 0);
    const impulseIndex = 48_000 + 12_345;
    samples[impulseIndex] = 1;
    const impulseSeconds = sampleIndexToSessionSeconds(source, impulseIndex);

    const resampled = resampleSamples(samples, 48_000, 16_000);
    const target = resampledDescriptor(source, 16_000);
    const peakIndex = resampled.reduce(
      (best, value, index) => (value > resampled[best] ? index : best),
      0,
    );

    // Tolerance: one output sample period.
    expect(
      Math.abs(sampleIndexToSessionSeconds(target, peakIndex) - impulseSeconds),
    ).toBeLessThanOrEqual(1 / 16_000);
    expect(resampled.length / 16_000).toBeCloseTo(samples.length / 48_000, 6);
  });

  test("stream-relative transcript times and sample indices map to the same session clock", () => {
    const source = descriptor({
      discontinuities: [{ startSeconds: 1.25, endSeconds: 1.5, reason: "dropout" }],
    });

    expect(streamSecondsToSessionSeconds(source, 1)).toBeCloseTo(1.25, 9);
    expect(sessionSecondsToSampleIndex(source, 1.0, 96_000)).toBe(36_000);
    expect(sessionSecondsToSampleIndex(source, 1.3, 96_000)).toBeNull();
    expect(sessionSecondsToSampleIndex(source, 0.1, 96_000)).toBeNull();
    expect(sessionSecondsToSampleIndex(source, 99, 96_000)).toBeNull();
  });
});

describe("provenance", () => {
  test("browser input with requested echo cancellation is not labelled unprocessed", () => {
    expect(isUnprocessedInput(descriptor())).toBe(false);
  });

  test("input with all preprocessing reported off is unprocessed; intervention output never is", () => {
    const off = { requested: false, applied: false };
    const preprocessing = { echoCancellation: off, noiseSuppression: off, autoGainControl: off };
    expect(isUnprocessedInput(descriptor({ preprocessing }))).toBe(true);
    expect(isUnprocessedInput(descriptor({ preprocessing, role: "interventionOutput" }))).toBe(
      false,
    );
  });
});

describe("assessCaptureQuality", () => {
  const rate = 16_000;
  const ok = descriptor({ sampleRate: rate });

  test("clean single-speaker speech is usable", () => {
    expect(assessCaptureQuality(ok, measureCapture(speechLike(6, rate), rate))).toEqual({
      state: "usable",
      issues: [],
    });
  });

  const fixtures: Array<[string, RecordingDescriptor, number[], number, string]> = [
    ["silence", ok, Array.from({ length: rate * 6 }, () => 0), 1, "noInput"],
    [
      "clipping",
      ok,
      speechLike(6, rate, 1.5).map((v) => Math.max(-1, Math.min(1, v))),
      1,
      "clipping",
    ],
    ["truncated recording", ok, speechLike(1, rate), 1, "tooShort"],
    [
      "missing channels",
      descriptor({ sampleRate: rate, channelCount: 0 }),
      speechLike(6, rate),
      0,
      "noChannels",
    ],
    [
      "background speech",
      descriptor({ sampleRate: rate, speakerAssessment: "overlapDetected" }),
      speechLike(6, rate),
      1,
      "speakerOverlap",
    ],
    [
      "unknown speaker",
      descriptor({ sampleRate: rate, speakerAssessment: "unknown" }),
      speechLike(6, rate),
      1,
      "speakerUnknown",
    ],
    [
      "large dropout",
      descriptor({
        sampleRate: rate,
        discontinuities: [{ startSeconds: 1, endSeconds: 2, reason: "dropout" }],
      }),
      speechLike(6, rate),
      1,
      "discontinuous",
    ],
    [
      "near-silent hum",
      ok,
      Array.from({ length: rate * 6 }, (_, i) => 0.002 * Math.sin(i)),
      1,
      "insufficientSpeech",
    ],
  ];

  for (const [name, desc, samples, channels, issue] of fixtures) {
    test(`${name} is an unknown result with an explanation, not a score`, () => {
      const quality = assessCaptureQuality(desc, measureCapture(samples, rate, channels));
      expect(quality.state).toBe("unknown");
      expect(quality.issues).toContain(issue as never);
      expect(quality.state === "unknown" && quality.explanation).toMatch(/^Result unknown: /);
    });
  }

  test("a sample-rate change is measured on the actual stream rate", () => {
    const at48k = speechLike(6, 48_000);
    const metrics = measureCapture(resampleSamples(at48k, 48_000, rate), rate);
    expect(metrics.durationSeconds).toBeCloseTo(6, 3);
    expect(assessCaptureQuality(resampledDescriptor(descriptor(), rate), metrics).state).toBe(
      "usable",
    );
  });
});
