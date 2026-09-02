import { describe, expect, test } from "bun:test";

import { evaluateClips, normalizeSep28kRow, shouldEvaluateSep28k, speakerSafeSplit } from "./index";

describe("normalizeSep28kRow", () => {
  test("maps majority-vote SEP-28k labels to product kinds", () => {
    const entry = normalizeSep28kRow({
      Show: "HeStutters",
      EpId: 7,
      ClipId: 12,
      Start: 48_000,
      Stop: 192_000,
      WordRep: 2,
      SoundRep: 1,
      Prolongation: 3,
      Block: 0,
      Interjection: 2,
      Unsure: 0,
      PoorAudioQuality: 0,
      DifficultToUnderstand: 0,
      NaturalPause: 0,
      Music: 0,
      NoSpeech: 0,
    });

    expect(entry.id).toBe("HeStutters:7:12");
    expect(entry.referenceKinds).toEqual(["wordRepetition", "prolongation", "filler"]);
    expect(entry.annotationVotes.soundRepetition).toBe(1);
    expect(shouldEvaluateSep28k(entry)).toBe(true);
  });

  test("excludes clips with majority-vote quality flags", () => {
    const entry = normalizeSep28kRow({ Show: "show", EpId: 1, ClipId: 2, PoorAudioQuality: 2 });
    expect(shouldEvaluateSep28k(entry)).toBe(false);
  });
});

describe("evaluateClips", () => {
  test("computes per-kind, micro, macro, false-positive, and calibration metrics", () => {
    const report = evaluateClips([
      {
        id: "a",
        speakerId: "speaker-a",
        durationSeconds: 3,
        referenceKinds: ["wordRepetition"],
        predictedKinds: ["wordRepetition"],
        predictedProbabilities: { wordRepetition: 0.9 },
      },
      {
        id: "b",
        speakerId: "speaker-b",
        durationSeconds: 3,
        referenceKinds: ["block"],
        predictedKinds: ["filler"],
        predictedProbabilities: { block: 0.2, filler: 0.8 },
      },
      {
        id: "c",
        speakerId: "speaker-c",
        durationSeconds: 3,
        referenceKinds: [],
        predictedKinds: ["filler"],
      },
    ]);

    expect(report.clipCount).toBe(3);
    expect(report.speakerCount).toBe(3);
    expect(report.byKind.wordRepetition.f1).toBe(1);
    expect(report.byKind.block.falseNegative).toBe(1);
    expect(report.byKind.filler.falsePositive).toBe(2);
    expect(report.falsePositiveClipRate).toBeCloseTo(1 / 3);
    expect(report.brierScore).toBeDefined();
  });
});

describe("speakerSafeSplit", () => {
  test("never puts one speaker in both partitions", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      speakerId: `speaker-${Math.floor(index / 2)}`,
      clip: index,
    }));
    const split = speakerSafeSplit(items, { evaluationFraction: 0.35, seed: "fixture" });
    const trainSpeakers = new Set(split.train.map((item) => item.speakerId));
    const evaluationSpeakers = new Set(split.evaluation.map((item) => item.speakerId));

    for (const speaker of trainSpeakers) expect(evaluationSpeakers.has(speaker)).toBe(false);
    expect(split.train.length + split.evaluation.length).toBe(items.length);
  });
});
