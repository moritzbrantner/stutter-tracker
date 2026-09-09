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
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Array.isArray(value.segments) ||
    !value.segments.every(isTranscriptSegment) ||
    !Array.isArray(value.pauses) ||
    !value.pauses.every(isPauseSpan) ||
    !isAnalysisReport(value.report)
  ) {
    return false;
  }
  return true;
}

function isTranscriptSegment(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds &&
    typeof value.isFinal === "boolean"
  );
}

function isPauseSpan(value: unknown) {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startSeconds) &&
    isFiniteNumber(value.endSeconds) &&
    value.endSeconds >= value.startSeconds
  );
}

function isAnalysisReport(value: unknown) {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.totalDurationSeconds) &&
    isNonNegativeNumber(value.wordCount) &&
    isNonNegativeNumber(value.stutterCount) &&
    isNonNegativeNumber(value.stuttersPerMinute) &&
    isSeverity(value.severity) &&
    Array.isArray(value.events) &&
    value.events.every(isStutterEvent) &&
    isRecord(value.byKind)
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
    isFiniteNumber(value.confidence)
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
