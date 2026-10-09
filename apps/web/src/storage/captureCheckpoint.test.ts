import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_CHECKPOINT_KEY,
  type CaptureCheckpoint,
  clearCaptureCheckpoint,
  hasCheckpointedObservation,
  readCaptureCheckpoint,
  writeCaptureCheckpoint,
} from "./captureCheckpoint";

function checkpoint(overrides: Partial<CaptureCheckpoint> = {}): CaptureCheckpoint {
  return {
    version: 1,
    id: "capture-1",
    startedAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T10:01:00.000Z",
    language: "en-US",
    segments: [
      { text: "I I want", startSeconds: 0, endSeconds: 1.5, confidence: 0.9, isFinal: true },
    ],
    pauses: [{ startSeconds: 1.5, endSeconds: 2.4, afterText: "want" }],
    ...overrides,
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("capture checkpoint", () => {
  it("round-trips a checkpoint", () => {
    writeCaptureCheckpoint(checkpoint());
    expect(readCaptureCheckpoint()).toEqual({ kind: "checkpoint", checkpoint: checkpoint() });
  });

  it("reports nothing when no checkpoint is stored", () => {
    expect(readCaptureCheckpoint()).toEqual({ kind: "none" });
  });

  it.each([
    ["truncated JSON", '{"version":1,"id":"capture-1"'],
    ["an unsupported version", JSON.stringify({ ...checkpoint(), version: 2 })],
    ["a blank id", JSON.stringify(checkpoint({ id: " " }))],
    ["an invalid date", JSON.stringify(checkpoint({ startedAt: "yesterday" }))],
    ["a malformed segment", JSON.stringify({ ...checkpoint(), segments: [{ text: 1 }] })],
    ["a malformed pause", JSON.stringify({ ...checkpoint(), pauses: [{}] })],
  ])("keeps %s as unreadable instead of dropping it", (_label, raw) => {
    localStorage.setItem(CAPTURE_CHECKPOINT_KEY, raw);
    expect(readCaptureCheckpoint()).toEqual({ kind: "unreadable" });
    expect(localStorage.getItem(CAPTURE_CHECKPOINT_KEY)).toBe(raw);
  });

  it("reports nothing when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readCaptureCheckpoint()).toEqual({ kind: "none" });
  });

  it("surfaces a full storage on write and keeps the previous checkpoint", () => {
    writeCaptureCheckpoint(checkpoint());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => writeCaptureCheckpoint(checkpoint({ segments: [] }))).toThrow("full");
    vi.restoreAllMocks();
    expect(readCaptureCheckpoint()).toEqual({ kind: "checkpoint", checkpoint: checkpoint() });
  });

  it("clears only the checkpoint of the given capture", () => {
    writeCaptureCheckpoint(checkpoint({ id: "newer" }));
    expect(clearCaptureCheckpoint("older")).toBe(true);
    expect(readCaptureCheckpoint()).toMatchObject({ checkpoint: { id: "newer" } });
    expect(clearCaptureCheckpoint("newer")).toBe(true);
    expect(readCaptureCheckpoint()).toEqual({ kind: "none" });
  });

  it("does not clear an unreadable checkpoint by capture id, only by explicit discard", () => {
    localStorage.setItem(CAPTURE_CHECKPOINT_KEY, "{broken");
    expect(clearCaptureCheckpoint("capture-1")).toBe(true);
    expect(localStorage.getItem(CAPTURE_CHECKPOINT_KEY)).toBe("{broken");
    expect(clearCaptureCheckpoint(null)).toBe(true);
    expect(localStorage.getItem(CAPTURE_CHECKPOINT_KEY)).toBeNull();
  });

  it("reports a removal that storage refused", () => {
    writeCaptureCheckpoint(checkpoint());
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(clearCaptureCheckpoint("capture-1")).toBe(false);
  });

  it("counts a capture with segments or pauses as an observation", () => {
    expect(hasCheckpointedObservation({ segments: [], pauses: [] })).toBe(false);
    expect(hasCheckpointedObservation(checkpoint({ segments: [] }))).toBe(true);
    expect(hasCheckpointedObservation(checkpoint({ pauses: [] }))).toBe(true);
  });
});
