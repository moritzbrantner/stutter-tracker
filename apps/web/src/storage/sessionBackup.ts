import type { SavedSession } from "../types";

export const SESSION_BACKUP_VERSION = 1;
export const MAX_RESTORED_SESSIONS = 50;

export type SessionBackup = {
  version: typeof SESSION_BACKUP_VERSION;
  exportedAt: string;
  sessions: SavedSession[];
};

export function createSessionBackup(
  sessions: SavedSession[],
  exportedAt = new Date(),
): SessionBackup {
  return {
    version: SESSION_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    sessions,
  };
}

export function parseSessionBackup(value: unknown): SavedSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error("Backup must contain a sessions array.");
  }
  if (value.version != null && value.version !== SESSION_BACKUP_VERSION) {
    throw new Error(`Unsupported backup version ${String(value.version)}.`);
  }
  if (value.exportedAt != null && !isValidDateString(value.exportedAt)) {
    throw new Error("Backup export timestamp is invalid.");
  }
  if (value.sessions.length > MAX_RESTORED_SESSIONS) {
    throw new Error(`Backup contains more than ${MAX_RESTORED_SESSIONS} sessions.`);
  }

  const ids = new Set<string>();
  return value.sessions.map((candidate, index) => {
    if (!isSavedSession(candidate)) {
      throw new Error(`Backup session ${index + 1} is invalid.`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`Backup contains duplicate session id ${candidate.id}.`);
    }
    ids.add(candidate.id);
    return candidate;
  });
}

function isSavedSession(value: unknown): value is SavedSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    isValidDateString(value.startedAt) &&
    Array.isArray(value.segments) &&
    value.segments.every(isTranscriptSegment) &&
    Array.isArray(value.pauses) &&
    value.pauses.every(isPauseSpan) &&
    isAnalysisReport(value.report)
  );
}

function isTranscriptSegment(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    typeof value.isFinal === "boolean" &&
    isOptionalFiniteNumber(value.confidence) &&
    isOptionalString(value.speakerId) &&
    isOptionalString(value.speakerLabel) &&
    isOptionalFiniteNumber(value.speakerScore)
  );
}

function isPauseSpan(value: unknown) {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    isOptionalString(value.afterText)
  );
}

function isAnalysisReport(value: unknown) {
  return (
    isRecord(value) &&
    isOptionalDateString(value.sessionStartedAt) &&
    isNonNegativeNumber(value.totalDurationSeconds) &&
    isNonNegativeNumber(value.wordCount) &&
    isNonNegativeNumber(value.stutterCount) &&
    isNonNegativeNumber(value.stuttersPerMinute) &&
    isSeverity(value.severity) &&
    isOptionalObject(value.speechStats, isSpeechStats) &&
    isOptionalObject(value.blockerStats, isBlockerStats) &&
    isOptionalArray(value.chunks, isChunkAnalysis) &&
    Array.isArray(value.events) &&
    value.events.every(isStutterEvent) &&
    isByKind(value.byKind) &&
    isOptionalObject(value.acousticStats, isAcousticStats)
  );
}

function isSpeechStats(value: Record<string, unknown>) {
  return (
    isNonNegativeNumber(value.speakingDurationSeconds) &&
    isNonNegativeNumber(value.pauseDurationSeconds) &&
    isNonNegativeNumber(value.wordsPerMinute) &&
    isNonNegativeNumber(value.articulationRateWpm) &&
    isNonNegativeNumber(value.meanChunkWords) &&
    isNonNegativeNumber(value.meanChunkDurationSeconds) &&
    isNonNegativeNumber(value.eventDensityPer100Words) &&
    isPercentage(value.fluencyPercentage)
  );
}

function isBlockerStats(value: Record<string, unknown>) {
  return (
    isNonNegativeNumber(value.blockCount) &&
    isNonNegativeNumber(value.totalBlockSeconds) &&
    isNonNegativeNumber(value.averageBlockSeconds) &&
    isNonNegativeNumber(value.longestBlockSeconds) &&
    isNonNegativeNumber(value.blocksPerMinute) &&
    isPercentage(value.blockedTimePercentage)
  );
}

function isChunkAnalysis(value: unknown) {
  return (
    isRecord(value) &&
    Number.isInteger(value.index) &&
    isNonNegativeNumber(value.index) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    isNonNegativeNumber(value.durationSeconds) &&
    typeof value.text === "string" &&
    isNonNegativeNumber(value.wordCount) &&
    isNonNegativeNumber(value.stutterCount) &&
    isNonNegativeNumber(value.blockCount) &&
    isNonNegativeNumber(value.fillerCount) &&
    isNonNegativeNumber(value.wordsPerMinute) &&
    isNonNegativeNumber(value.silentPauseSeconds) &&
    isOptionalNullableFiniteNumber(value.averageConfidence)
  );
}

function isStutterEvent(value: unknown) {
  return (
    isRecord(value) &&
    isStutterKind(value.kind) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    typeof value.text === "string" &&
    typeof value.detail === "string" &&
    isFiniteNumber(value.confidence) &&
    isEventSource(value.source) &&
    isOptionalObject(value.acousticEvidence, isAcousticEvidence)
  );
}

function isAcousticEvidence(value: Record<string, unknown>) {
  return (
    isOptionalFiniteNumber(value.energyRms) &&
    isOptionalFiniteNumber(value.silenceSeconds) &&
    isOptionalFiniteNumber(value.onsetCount) &&
    isOptionalFiniteNumber(value.onsetRate) &&
    isOptionalNullableFiniteNumber(value.pitchMeanHz) &&
    isOptionalNullableFiniteNumber(value.pitchStability) &&
    isOptionalFiniteNumber(value.spectralCentroidHz) &&
    isOptionalFiniteNumber(value.zeroCrossingRate)
  );
}

function isAcousticStats(value: Record<string, unknown>) {
  return (
    isNonNegativeNumber(value.analyzedDurationSeconds) &&
    isNonNegativeNumber(value.speechDurationSeconds) &&
    isNonNegativeNumber(value.silenceDurationSeconds) &&
    isNonNegativeNumber(value.voiceActivityRatio) &&
    isNonNegativeNumber(value.onsetCount) &&
    isNonNegativeNumber(value.meanOnsetRate) &&
    isNonNegativeNumber(value.meanRms) &&
    isNonNegativeNumber(value.noiseFloorRms)
  );
}

function isByKind(value: unknown) {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([kind, count]) => isStutterKind(kind) && isNonNegativeNumber(count),
    )
  );
}

function isSeverity(value: unknown) {
  return value === "none" || value === "mild" || value === "moderate" || value === "high";
}

function isStutterKind(value: unknown) {
  return (
    value === "wordRepetition" ||
    value === "soundRepetition" ||
    value === "prolongation" ||
    value === "block" ||
    value === "filler"
  );
}

function isEventSource(value: unknown) {
  return value == null || value === "transcript" || value === "acoustic" || value === "fused";
}

function isOptionalArray(value: unknown, predicate: (item: unknown) => boolean) {
  return value == null || (Array.isArray(value) && value.every(predicate));
}

function isOptionalObject(
  value: unknown,
  predicate: (item: Record<string, unknown>) => boolean,
) {
  return value == null || (isRecord(value) && predicate(value));
}

function isOptionalString(value: unknown) {
  return value == null || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown) {
  return value == null || isFiniteNumber(value);
}

function isOptionalNullableFiniteNumber(value: unknown) {
  return value == null || isFiniteNumber(value);
}

function isOptionalDateString(value: unknown) {
  return value == null || isValidDateString(value);
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPercentage(value: unknown) {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
