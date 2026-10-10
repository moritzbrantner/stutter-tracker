import {
  assessRunCaptureQuality,
  type RecordingDescriptor,
  resampledDescriptor,
} from "@stutter-tracker/shared";
import type { AnalysisReport } from "../types";

/**
 * Applies the capture-quality gate to a report of the live capture described by `descriptor`,
 * whose audio was sent for analysis at `analyzedSampleRate`. Without a descriptor (no audio was
 * analyzed) the report is returned unchanged.
 */
export function withCaptureQuality(
  report: AnalysisReport,
  descriptor: RecordingDescriptor | null,
  analyzedSampleRate: number,
): AnalysisReport {
  if (!descriptor) return report;
  return {
    ...report,
    captureQuality: assessRunCaptureQuality(
      resampledDescriptor(descriptor, analyzedSampleRate),
      report.captureMetrics,
    ),
  };
}

/** True when the report's numbers must be shown as unknown instead of as a score. */
export function isScoreWithheld(report: AnalysisReport) {
  return report.captureQuality?.state === "unknown";
}
