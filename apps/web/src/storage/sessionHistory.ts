import type { SavedSession } from "../types";

export type SessionHistoryPoint = {
  id: string;
  startedAt: string;
  durationSeconds: number;
  stutterCount: number;
  stuttersPerMinute: number;
  fluencyPercentage: number | null;
  wordsPerMinute: number | null;
};

export function buildSessionHistory(
  sessions: SavedSession[],
  limit = 12,
): SessionHistoryPoint[] {
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
  };
}

function nonNegativeNumber(value: number | null | undefined) {
  const finite = finiteNumberOrNull(value);
  return finite == null ? 0 : Math.max(0, finite);
}

function finiteNumberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
