export const stutterKinds = [
  "wordRepetition",
  "soundRepetition",
  "prolongation",
  "block",
  "filler",
] as const;

export type StutterKind = (typeof stutterKinds)[number];

export type BenchmarkEvent = {
  kind: StutterKind;
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
};

export type BenchmarkClip = {
  id: string;
  speakerId: string;
  durationSeconds: number;
  referenceKinds: StutterKind[];
  predictedKinds: StutterKind[];
  predictedProbabilities?: Partial<Record<StutterKind, number>>;
  events?: BenchmarkEvent[];
  source?: "sep28k" | "fluencybank" | "fixture" | string;
};

export type KindMetrics = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  f1: number;
};

export type BenchmarkReport = {
  clipCount: number;
  speakerCount: number;
  microPrecision: number;
  microRecall: number;
  microF1: number;
  macroF1: number;
  falsePositiveClipRate: number;
  brierScore?: number;
  byKind: Record<StutterKind, KindMetrics>;
};

export type Sep28kRow = Record<string, string | number | undefined>;

export type Sep28kManifestEntry = {
  id: string;
  show: string;
  episodeId: string;
  clipId: string;
  startSample?: number;
  stopSample?: number;
  speakerId: string | null;
  referenceKinds: StutterKind[];
  annotationVotes: Record<StutterKind, number>;
  flags: {
    noStutter: boolean;
    unsure: boolean;
    poorAudioQuality: boolean;
    difficultToUnderstand: boolean;
    naturalPause: boolean;
    music: boolean;
    noSpeech: boolean;
  };
};

const sep28kColumns: Record<StutterKind, string[]> = {
  wordRepetition: ["WordRep", "WordRepetition"],
  soundRepetition: ["SoundRep", "SoundRepetition"],
  prolongation: ["Prolongation"],
  block: ["Block"],
  filler: ["Interjection", "Filler"],
};

function finiteNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function first(row: Sep28kRow, keys: string[]): string | number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function votes(row: Sep28kRow, columns: string[]): number {
  return finiteNumber(first(row, columns)) ?? 0;
}

function selected(row: Sep28kRow, columns: string[], threshold = 1): boolean {
  return votes(row, columns) >= threshold;
}

export function normalizeSep28kRow(
  row: Sep28kRow,
  options: { voteThreshold?: number; speakerId?: string } = {},
): Sep28kManifestEntry {
  const voteThreshold = options.voteThreshold ?? 2;
  if (!Number.isInteger(voteThreshold) || voteThreshold < 1 || voteThreshold > 3) {
    throw new Error("voteThreshold must be an integer between 1 and 3");
  }

  const show = String(first(row, ["Show", "show"]) ?? "unknown-show");
  const episodeId = String(first(row, ["EpId", "episodeId", "episode_id"]) ?? "unknown-episode");
  const clipId = String(first(row, ["ClipId", "clipId", "clip_id"]) ?? "unknown-clip");
  const speakerFromRow = first(row, ["speaker", "Speaker", "speakerId", "speaker_id"]);
  const speakerId = options.speakerId ?? (speakerFromRow === undefined ? null : String(speakerFromRow));

  const annotationVotes = Object.fromEntries(
    stutterKinds.map((kind) => [kind, votes(row, sep28kColumns[kind])]),
  ) as Record<StutterKind, number>;
  const referenceKinds = stutterKinds.filter((kind) => annotationVotes[kind] >= voteThreshold);

  return {
    id: `${show}:${episodeId}:${clipId}`,
    show,
    episodeId,
    clipId,
    startSample: finiteNumber(first(row, ["Start", "start"])),
    stopSample: finiteNumber(first(row, ["Stop", "stop"])),
    speakerId,
    referenceKinds,
    annotationVotes,
    flags: {
      noStutter: selected(row, ["NoStutter", "No Stuttered Words"], voteThreshold),
      unsure: selected(row, ["Unsure"], voteThreshold),
      poorAudioQuality: selected(row, ["PoorAudioQuality", "Poor Audio Quality"], voteThreshold),
      difficultToUnderstand: selected(
        row,
        ["DifficultToUnderstand", "Difficult To Understand"],
        voteThreshold,
      ),
      naturalPause: selected(row, ["NaturalPause", "Natural Pause"], voteThreshold),
      music: selected(row, ["Music"], voteThreshold),
      noSpeech: selected(row, ["NoSpeech", "No Speech"], voteThreshold),
    },
  };
}

export function shouldEvaluateSep28k(entry: Sep28kManifestEntry): boolean {
  return !(
    entry.flags.unsure ||
    entry.flags.poorAudioQuality ||
    entry.flags.difficultToUnderstand ||
    entry.flags.music ||
    entry.flags.noSpeech
  );
}

export function evaluateClips(clips: readonly BenchmarkClip[]): BenchmarkReport {
  const byKind = Object.fromEntries(
    stutterKinds.map((kind) => [
      kind,
      {
        truePositive: 0,
        falsePositive: 0,
        falseNegative: 0,
        trueNegative: 0,
        precision: 0,
        recall: 0,
        f1: 0,
      },
    ]),
  ) as Record<StutterKind, KindMetrics>;

  let falsePositiveClips = 0;
  let brierSum = 0;
  let brierCount = 0;

  for (const clip of clips) {
    const references = new Set(clip.referenceKinds);
    const predictions = new Set(clip.predictedKinds);
    if (references.size === 0 && predictions.size > 0) falsePositiveClips += 1;

    for (const kind of stutterKinds) {
      const expected = references.has(kind);
      const predicted = predictions.has(kind);
      const metrics = byKind[kind];
      if (expected && predicted) metrics.truePositive += 1;
      else if (!expected && predicted) metrics.falsePositive += 1;
      else if (expected && !predicted) metrics.falseNegative += 1;
      else metrics.trueNegative += 1;

      const probability = clip.predictedProbabilities?.[kind];
      if (probability !== undefined) {
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
          throw new Error(`probability for ${kind} must be between 0 and 1`);
        }
        brierSum += (probability - (expected ? 1 : 0)) ** 2;
        brierCount += 1;
      }
    }
  }

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const kind of stutterKinds) {
    const metrics = byKind[kind];
    metrics.precision = ratio(metrics.truePositive, metrics.truePositive + metrics.falsePositive);
    metrics.recall = ratio(metrics.truePositive, metrics.truePositive + metrics.falseNegative);
    metrics.f1 = f1(metrics.precision, metrics.recall);
    truePositive += metrics.truePositive;
    falsePositive += metrics.falsePositive;
    falseNegative += metrics.falseNegative;
  }

  const microPrecision = ratio(truePositive, truePositive + falsePositive);
  const microRecall = ratio(truePositive, truePositive + falseNegative);

  return {
    clipCount: clips.length,
    speakerCount: new Set(clips.map((clip) => clip.speakerId)).size,
    microPrecision,
    microRecall,
    microF1: f1(microPrecision, microRecall),
    macroF1: average(stutterKinds.map((kind) => byKind[kind].f1)),
    falsePositiveClipRate: ratio(falsePositiveClips, clips.length),
    ...(brierCount > 0 ? { brierScore: brierSum / brierCount } : {}),
    byKind,
  };
}

export function speakerSafeSplit<T extends { speakerId: string | null | undefined }>(
  items: readonly T[],
  options: { evaluationFraction?: number; seed?: string } = {},
): { train: T[]; evaluation: T[] } {
  const evaluationFraction = options.evaluationFraction ?? 0.2;
  if (!(evaluationFraction > 0 && evaluationFraction < 1)) {
    throw new Error("evaluationFraction must be between 0 and 1");
  }
  const seed = options.seed ?? "stutter-bench-v1";
  const train: T[] = [];
  const evaluation: T[] = [];

  for (const item of items) {
    const speakerId = item.speakerId?.trim();
    if (!speakerId) {
      throw new Error("speakerSafeSplit requires explicit speaker metadata for every item");
    }
    const bucket = stableHash(`${seed}:${speakerId}`) / 0xffffffff;
    (bucket < evaluationFraction ? evaluation : train).push(item);
  }

  return { train, evaluation };
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
