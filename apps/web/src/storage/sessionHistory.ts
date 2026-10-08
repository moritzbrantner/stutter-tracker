import { analyzerKey, isAnalysisVerified } from "@stutter-tracker/shared";
import type { SavedSession } from "../types";

export type SessionHistoryPoint = {
  id: string;
  startedAt: string;
  durationSeconds: number;
  stutterCount: number;
  stuttersPerMinute: number;
  fluencyPercentage: number | null;
  wordsPerMinute: number | null;
  /** Analyzer behind the report ("unknown" for records that never stored it). */
  analyzerKey: string;
  /** The report is known to analyze exactly the saved transcript. */
  verified: boolean;
  /** Whether captured audio fed the analysis (acoustic events); null when not recorded. */
  usedAudio: boolean | null;
};

export type ProgressComparability = {
  comparable: boolean;
  /** Plain-language reasons the points are not directly comparable. */
  reasons: string[];
};

/**
 * Points are comparable only when one known analyzer version produced every report from the same
 * kind of input (with or without audio) and every report is verified against its transcript.
 * Every point is an automated report; human annotations are not plotted here. Anything else is
 * flagged, not hidden.
 */
export function progressComparability(points: SessionHistoryPoint[]): ProgressComparability {
  const reasons: string[] = [];
  const known = new Set(
    points.map((point) => point.analyzerKey).filter((key) => key !== "unknown"),
  );
  if (known.size > 1) {
    reasons.push(`${known.size} different analyzer versions produced these results`);
  }
  const unknown = points.filter((point) => point.analyzerKey === "unknown").length;
  if (unknown > 0) {
    reasons.push(
      `the analyzer version was not recorded for ${unknown === points.length ? "these sessions" : `${unknown} of them`}`,
    );
  }
  const audioUse = new Set(points.map((point) => point.usedAudio).filter((used) => used !== null));
  if (audioUse.size > 1) {
    reasons.push("some were analyzed with audio and some without");
  }
  // Unknown audio use is not a shared modality: either report may include acoustic analysis.
  const audioUnknown = points.filter((point) => point.usedAudio === null).length;
  if (audioUnknown > 0) {
    reasons.push(
      `whether audio was analyzed was not recorded for ${audioUnknown === points.length ? "these sessions" : `${audioUnknown} of them`}`,
    );
  }
  const unverified = points.filter((point) => !point.verified).length;
  if (unverified > 0) {
    reasons.push(
      `${unverified} session${unverified === 1 ? "'s analysis is" : "s' analyses are"} not verified for the saved transcript`,
    );
  }
  return { comparable: reasons.length === 0, reasons };
}

export function buildSessionHistory(sessions: SavedSession[], limit = 12): SessionHistoryPoint[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 12;
  if (normalizedLimit === 0) {
    return [];
  }

  return sessions
    .map((session, index) => ({
      session,
      index,
      timestamp: Date.parse(session.startedAt),
    }))
    .filter(({ timestamp }) => Number.isFinite(timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
    .slice(-normalizedLimit)
    .map(({ session }) => toHistoryPoint(session));
}

function toHistoryPoint(session: SavedSession): SessionHistoryPoint {
  const durationSeconds = nonNegativeNumber(session.report.totalDurationSeconds);
  const stutterCount = nonNegativeNumber(session.report.stutterCount);
  const reportedRate = finiteNumberOrNull(session.report.stuttersPerMinute);
  const derivedRate = durationSeconds > 0 ? stutterCount / (durationSeconds / 60) : 0;
  const fluencyPercentage = finiteNumberOrNull(session.report.speechStats?.fluencyPercentage);
  const wordsPerMinute = finiteNumberOrNull(session.report.speechStats?.wordsPerMinute);

  return {
    id: session.id,
    startedAt: session.startedAt,
    durationSeconds,
    stutterCount,
    stuttersPerMinute: Math.max(0, reportedRate ?? derivedRate),
    fluencyPercentage:
      fluencyPercentage == null ? null : Math.min(100, Math.max(0, fluencyPercentage)),
    wordsPerMinute: wordsPerMinute == null ? null : Math.max(0, wordsPerMinute),
    analyzerKey: analyzerKey(session),
    verified: isAnalysisVerified(session),
    usedAudio: session.analysis.usedAudio,
  };
}

function nonNegativeNumber(value: number | null | undefined) {
  const finite = finiteNumberOrNull(value);
  return finite == null ? 0 : Math.max(0, finite);
}

function finiteNumberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
