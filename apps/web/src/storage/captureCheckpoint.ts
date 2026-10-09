// Checkpoint of the capture in the workspace that has not been saved yet, so a closed tab, crash
// or reload does not lose its transcript. Audio is not checkpointed (sessions never store it), so
// a recovered capture is the observation only: nothing is invented for the missing audio.
import type { PauseSpan, TranscriptSegment } from "../types";
import { isPauseSpan, isTranscriptSegment, isValidDateString } from "./sessionBackup";

export const CAPTURE_CHECKPOINT_KEY = "stutter-tracker:capture-checkpoint";
export const CAPTURE_CHECKPOINT_VERSION = 1;

export type CaptureCheckpoint = {
  version: typeof CAPTURE_CHECKPOINT_VERSION;
  /** Id the capture is saved under, so a capture saved before the checkpoint was cleared is not recovered twice. */
  id: string;
  startedAt: string;
  updatedAt: string;
  /** Language tag selected when the capture started; null when unknown. */
  language: string | null;
  segments: TranscriptSegment[];
  pauses: PauseSpan[];
};

export type StoredCaptureCheckpoint =
  | { kind: "none" }
  | { kind: "checkpoint"; checkpoint: CaptureCheckpoint }
  /** Present but not readable by this build; kept until the user discards it. */
  | { kind: "unreadable" };

export function readCaptureCheckpoint(storage: Storage = localStorage): StoredCaptureCheckpoint {
  let raw: string | null;
  try {
    raw = storage.getItem(CAPTURE_CHECKPOINT_KEY);
  } catch {
    // Storage unavailable: nothing can be recovered, and nothing is overwritten either.
    return { kind: "none" };
  }
  if (raw === null) {
    return { kind: "none" };
  }
  try {
    const checkpoint = parseCaptureCheckpoint(JSON.parse(raw));
    return checkpoint ? { kind: "checkpoint", checkpoint } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

export function parseCaptureCheckpoint(value: unknown): CaptureCheckpoint | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== CAPTURE_CHECKPOINT_VERSION
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id.trim() ||
    !isValidDateString(record.startedAt) ||
    !isValidDateString(record.updatedAt) ||
    !(record.language === null || typeof record.language === "string") ||
    !Array.isArray(record.segments) ||
    !record.segments.every(isTranscriptSegment) ||
    !Array.isArray(record.pauses) ||
    !record.pauses.every(isPauseSpan)
  ) {
    return null;
  }
  return {
    version: CAPTURE_CHECKPOINT_VERSION,
    id: record.id,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    language: record.language,
    segments: record.segments as TranscriptSegment[],
    pauses: record.pauses as PauseSpan[],
  };
}

/** True when the checkpoint holds any observation worth recovering. */
export function hasCheckpointedObservation(
  checkpoint: Pick<CaptureCheckpoint, "segments" | "pauses">,
) {
  return checkpoint.segments.length > 0 || checkpoint.pauses.length > 0;
}

/**
 * Writes the checkpoint as one value, so a reader sees either the previous or the new state.
 * Throws when storage is full or unavailable; the caller must make that visible.
 */
export function writeCaptureCheckpoint(
  checkpoint: CaptureCheckpoint,
  storage: Storage = localStorage,
) {
  storage.setItem(CAPTURE_CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

/**
 * Removes the checkpoint of capture `id` only, so a late clear from an earlier capture cannot drop
 * a newer one. With `id` null it removes whatever is stored (an explicit discard). Returns false
 * when storage refused the removal.
 */
export function clearCaptureCheckpoint(id: string | null, storage: Storage = localStorage) {
  try {
    if (id !== null) {
      const stored = readCaptureCheckpoint(storage);
      if (stored.kind !== "checkpoint" || stored.checkpoint.id !== id) {
        return true;
      }
    }
    storage.removeItem(CAPTURE_CHECKPOINT_KEY);
    return true;
  } catch {
    return false;
  }
}
