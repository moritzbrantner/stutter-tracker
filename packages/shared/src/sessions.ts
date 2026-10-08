// Canonical saved-session record: original observations, the analysis that interpreted them and
// every superseded analysis stay distinct. A rerun appends; it never rewrites an earlier result.
import type { RecordingDescriptor } from "./capture";
import type { AnalysisReport, PauseSpan, TranscriptSegment } from "./index";
import {
  type AssistanceCondition,
  type SpeakingTask,
  type SpokenLanguage,
  UNKNOWN_SPOKEN_LANGUAGE,
} from "./outcomes";

export const SESSION_SCHEMA_VERSION = 2;

/** Bump whenever `fallbackAnalyze` output can change for the same input. */
export const SHARED_ANALYSIS_VERSION = "1";

export type AnalyzerProducer = "onDevice" | "computeServer" | "desktopNative";

export type AnalyzerIdentity = {
  producer: AnalyzerProducer;
  algorithm: string;
  /** null when the producer does not report a version; never guessed. */
  version: string | null;
};

export type AnalysisRunIdentity = {
  id: string;
  /** null for runs migrated from records that never stored a timestamp. */
  createdAt: string | null;
  /** null for runs migrated from records that never stored who produced them. */
  analyzer: AnalyzerIdentity | null;
  /** Fingerprint of the observation the run analyzed (see `observationFingerprint`). */
  inputId: string;
  /** Whether captured audio fed the run; audio is not stored, so such runs cannot be replayed. */
  usedAudio: boolean | null;
  /** Fingerprint of the audio the run analyzed (see `audioFingerprint`); null when none or unknown. */
  audioId: string | null;
};

export type AnalysisRun = AnalysisRunIdentity & { report: AnalysisReport };

export type SessionContext = {
  /** `UNKNOWN_SPOKEN_LANGUAGE` when not recorded. */
  spokenLanguage: SpokenLanguage;
  task: SpeakingTask | null;
  condition: AssistanceCondition | null;
};

export type SessionRecord = {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  startedAt: string;
  /** Original observations; analysis never rewrites them. */
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  context: SessionContext;
  /** Empty for records saved before capture descriptors existed. */
  recordings: RecordingDescriptor[];
  /** Current interpretation, kept at the top level for existing readers (desktop corpus). */
  report: AnalysisReport;
  /** Identity of the run that produced `report`. */
  analysis: AnalysisRunIdentity;
  /** Superseded runs, oldest first. Append-only. */
  priorAnalyses: AnalysisRun[];
};

/** Version-1 records: what the web app stored before this schema. */
export type LegacySessionRecord = {
  id: string;
  startedAt: string;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  report: AnalysisReport;
};

export const UNKNOWN_SESSION_CONTEXT: SessionContext = {
  spokenLanguage: UNKNOWN_SPOKEN_LANGUAGE,
  task: null,
  condition: null,
};

export function createSessionRecord(input: {
  id: string;
  startedAt: string;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
  report: AnalysisReport;
  /**
   * Pass `inputId` when the report was computed from an earlier observation (e.g. a save while a
   * re-analysis is still running); a mismatch with the saved observation then stays visible.
   */
  run: Omit<AnalysisRunIdentity, "inputId"> & { inputId?: string };
  context?: SessionContext;
  recordings?: RecordingDescriptor[];
}): SessionRecord {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: input.id,
    startedAt: input.startedAt,
    segments: input.segments,
    pauses: input.pauses,
    context: input.context ?? UNKNOWN_SESSION_CONTEXT,
    recordings: input.recordings ?? [],
    report: input.report,
    analysis: {
      ...input.run,
      inputId: input.run.inputId ?? observationFingerprint(input.segments, input.pauses),
    },
    priorAnalyses: [],
  };
}

/**
 * Lifts a version-1 record into the current schema. Missing provenance stays visibly unknown
 * (null analyzer/timestamp, unknown language); nothing is inferred.
 */
export function migrateSessionRecord(record: LegacySessionRecord | SessionRecord): SessionRecord {
  if ("schemaVersion" in record) {
    if (record.schemaVersion !== SESSION_SCHEMA_VERSION) {
      throw new Error(`Unsupported session schema version ${String(record.schemaVersion)}.`);
    }
    return record;
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: record.id,
    startedAt: record.startedAt,
    segments: record.segments,
    pauses: record.pauses,
    context: UNKNOWN_SESSION_CONTEXT,
    recordings: [],
    report: record.report,
    analysis: {
      id: `${record.id}:legacy`,
      createdAt: null,
      analyzer: null,
      inputId: observationFingerprint(record.segments, record.pauses),
      usedAudio: null,
      audioId: null,
    },
    priorAnalyses: [],
  };
}

/**
 * Records a new analysis of the stored observation. The previous current run moves to
 * `priorAnalyses`; observations and earlier runs are untouched.
 */
export function reanalyzeSession(
  record: SessionRecord,
  run: Omit<AnalysisRunIdentity, "inputId">,
  report: AnalysisReport,
): SessionRecord {
  if (run.id === record.analysis.id || record.priorAnalyses.some((prior) => prior.id === run.id)) {
    throw new Error(`Analysis run ${run.id} is already recorded for session ${record.id}.`);
  }
  return {
    ...record,
    report,
    analysis: { ...run, inputId: observationFingerprint(record.segments, record.pauses) },
    priorAnalyses: [...record.priorAnalyses, { ...record.analysis, report: record.report }],
  };
}

/** Every run, oldest first, ending with the current one. */
export function sessionAnalysisRuns(record: SessionRecord): AnalysisRun[] {
  return [...record.priorAnalyses, { ...record.analysis, report: record.report }];
}

/**
 * Deterministic identity of the stored observation: every segment and pause field an analyzer
 * can read. Equal fingerprints mean runs analyzed the same transcript evidence.
 */
export function observationFingerprint(segments: TranscriptSegment[], pauses: PauseSpan[]) {
  const canonical = JSON.stringify([
    segments.map((segment) => [
      segment.text,
      segment.startSeconds,
      segment.endSeconds,
      segment.isFinal,
      segment.confidence ?? null,
      segment.speakerId ?? null,
      segment.speakerLabel ?? null,
      segment.speakerScore ?? null,
    ]),
    pauses.map((pause) => [pause.startSeconds, pause.endSeconds, pause.afterText ?? null]),
  ]);
  return `obs-${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x050c5d1f)}`;
}

/** Deterministic identity of analyzed PCM: sample rate plus the exact float32 sample bits. */
export function audioFingerprint(samples: ArrayLike<number>, sampleRate: number) {
  const bits = new Uint32Array(Float32Array.from(samples).buffer);
  let low = Math.imul(0x811c9dc5 ^ sampleRate, 0x01000193) >>> 0;
  let high = Math.imul(0x050c5d1f ^ bits.length, 0x01000193) >>> 0;
  for (let index = 0; index < bits.length; index += 1) {
    low = Math.imul(low ^ bits[index], 0x01000193) >>> 0;
    high = Math.imul(high ^ (bits[index] >>> 7), 0x01000193) >>> 0;
  }
  return `pcm-${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}

function fnv1a(text: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
