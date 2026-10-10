import { describe, expect, it } from "vitest";
import { fallbackAnalyze, type RecordingDescriptor } from "@stutter-tracker/shared";
import { isScoreWithheld, withCaptureQuality } from "./captureQuality";

const descriptor: RecordingDescriptor = {
  sessionId: "capture-1",
  runId: "run-1",
  origin: "browser",
  role: "appInput",
  sampleRate: 48_000,
  channelCount: 1,
  startOffsetSeconds: 0,
  preprocessing: {
    echoCancellation: { requested: true },
    noiseSuppression: { requested: true },
    autoGainControl: { requested: false },
  },
  discontinuities: [],
  speakerAssessment: "singleSpeakerDeclared",
};
const report = fallbackAnalyze({ segments: [], pauses: [] });

describe("withCaptureQuality", () => {
  it("leaves reports without analyzed audio unchanged", () => {
    expect(withCaptureQuality(report, null, 16_000)).toBe(report);
  });

  it("marks reports without native measurements as unmeasured", () => {
    const gated = withCaptureQuality(report, descriptor, 16_000);
    expect(gated.captureQuality).toEqual({ state: "unmeasured", issues: [] });
    expect(isScoreWithheld(gated)).toBe(false);
  });

  it("withholds the score of a clipping capture", () => {
    const gated = withCaptureQuality(
      {
        ...report,
        captureMetrics: {
          sampleRate: 16_000,
          channels: 1,
          samplesPerChannel: 96_000,
          durationSeconds: 6,
          clippedSampleCount: 960,
          clippedSampleRatio: 0.01,
          frameSamples: 320,
          frameCount: 300,
          noInputSeconds: 0,
          longestNoInputSeconds: 0,
          activitySeconds: 6,
          config: { frameSeconds: 0.02, clipLevel: 0.999, noInputRms: 1e-4, activityRms: 0.01 },
        },
      },
      descriptor,
      16_000,
    );
    expect(gated.captureQuality).toMatchObject({ state: "unknown", issues: ["clipping"] });
    expect(isScoreWithheld(gated)).toBe(true);
  });
});
