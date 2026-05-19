import { describe, expect, it } from "vitest";
import { mobileErrorMessage, recordingFileInfo, transcriptionToAnalysisRequest } from "./recording";

describe("mobile recording helpers", () => {
  it("infers upload filename and MIME type from recording URI", () => {
    expect(recordingFileInfo("file:///cache/audio.m4a")).toEqual({
      filename: "recording.m4a",
      mimeType: "audio/mp4",
    });
    expect(recordingFileInfo("file:///cache/audio.wav?token=1")).toEqual({
      filename: "recording.wav",
      mimeType: "audio/wav",
    });
  });

  it("maps transcription result to analysis request", () => {
    expect(
      transcriptionToAnalysisRequest({
        text: "hello",
        language: "en",
        provider: "whisperCpp",
        model: "base.en",
        segments: [{ text: "hello", startSeconds: 0, endSeconds: 1, isFinal: true }],
      }),
    ).toEqual({
      segments: [{ text: "hello", startSeconds: 0, endSeconds: 1, isFinal: true }],
      pauses: [],
    });
  });

  it("maps server errors to mobile messages", () => {
    expect(mobileErrorMessage(new Error("unauthorized: bad token"))).toBe(
      "Compute server rejected the API token",
    );
    expect(mobileErrorMessage(new Error("native_worker_unavailable: missing"))).toBe(
      "Compute server has no native transcription worker configured",
    );
  });
});
