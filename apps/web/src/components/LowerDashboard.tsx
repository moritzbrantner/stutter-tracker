import { BarChart3, BrainCircuit, ListChecks, PlayCircle, Waves } from "lucide-react";
import type { ReactNode } from "react";
import type {
  AnalysisReport,
  BlockerStats,
  ChunkAnalysis,
  SavedSession,
  SpeakerIntentPrediction,
  TranscriptSegment,
} from "../types";
import {
  eventDetail,
  eventSourceLabel,
  formatPercent,
  formatTime,
  kindLabel,
} from "../utils/formatting";
import { buttonClass, cx, mutedTextClass, panelClass, panelHeaderClass } from "./styles";

type LowerDashboardProps = {
  report: AnalysisReport;
  segments: TranscriptSegment[];
  intentPredictions: SpeakerIntentPrediction[];
  analyzedChunks: ChunkAnalysis[];
  blockerStats: BlockerStats;
  sessions: SavedSession[];
  onSessionLoad: (session: SavedSession) => void;
};

export function LowerDashboard({
  report,
  segments,
  intentPredictions,
  analyzedChunks,
  blockerStats,
  sessions,
  onSessionLoad,
}: LowerDashboardProps) {
  return (
    <section className="flex items-start gap-4 max-lg:flex-col">
      <EventsPanel report={report} />
      <IntentPanel predictions={intentPredictions} />
      <SpeechLogPanel segments={segments} />
      <ChunkAnalysisPanel chunks={analyzedChunks} report={report} blockerStats={blockerStats} />
      <SessionsPanel sessions={sessions} onSessionLoad={onSessionLoad} />
    </section>
  );
}

function IntentPanel({ predictions }: { predictions: SpeakerIntentPrediction[] }) {
  return (
    <div className={`${panelClass} min-w-0 flex-[1.1_1_22rem] max-lg:w-full`}>
      <PanelHeader title="Intent" count={predictions.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {predictions.length === 0 ? (
          <EmptyState
            icon={<BrainCircuit size={24} />}
            label="Intent predictions will appear when transcript context is available."
          />
        ) : (
          predictions.map((prediction) => (
            <article
              className="grid gap-2 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={prediction.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-words">{intentReasonLabel(prediction.reason)}</strong>
                {prediction.startSeconds != null && (
                  <time className={`text-sm ${mutedTextClass}`}>
                    At {formatTime(prediction.startSeconds)}
                  </time>
                )}
              </div>
              <p className={`m-0 break-words text-sm ${mutedTextClass}`}>
                {prediction.speakerLabel ? `${prediction.speakerLabel}: ` : ""}
                {prediction.contextText}
                {prediction.triggerText ? ` · ${prediction.triggerText}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {prediction.suggestions.map((suggestion) => (
                  <span
                    className="min-w-0 rounded-full border border-[#cfe0d8] bg-[#f1f7f4] px-2 py-1 text-sm text-[#25493d]"
                    key={`${prediction.id}-${suggestion.phrase || suggestion.token}`}
                    title={`${Math.round(suggestion.probability * 100)}%`}
                  >
                    {suggestion.phrase || suggestion.token}
                  </span>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function EventsPanel({ report }: { report: AnalysisReport }) {
  return (
    <div className={`${panelClass} min-w-0 flex-[1.2_1_22rem] max-lg:w-full`}>
      <PanelHeader title="Events" count={report.events.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {report.events.length === 0 ? (
          <EmptyState icon={<Waves size={24} />} label="No events in the current session." />
        ) : (
          report.events.map((event, index) => (
            <div
              className="flex items-center gap-3 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={`${event.kind}-${event.startSeconds}-${index}`}
            >
              <div
                className={cx(
                  "w-16 shrink-0 rounded-full px-2 py-1 text-center text-xs font-bold text-white",
                  eventKindClass(event.kind),
                )}
              >
                {kindLabel(event.kind)}
              </div>
              <div className="min-w-0">
                <strong className="flex flex-wrap items-center gap-2 break-words">
                  {event.text}
                  {event.source && (
                    <small className={`text-xs font-bold ${mutedTextClass}`}>
                      {eventSourceLabel(event.source)}
                    </small>
                  )}
                </strong>
                <span className={`block break-words ${mutedTextClass}`}>{eventDetail(event)}</span>
              </div>
              <time className={`ml-auto ${mutedTextClass}`}>{formatTime(event.startSeconds)}</time>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SpeechLogPanel({ segments }: { segments: TranscriptSegment[] }) {
  return (
    <div className={`${panelClass} min-w-0 flex-[1_1_22rem] max-lg:w-full`}>
      <PanelHeader title="Speech Log" count={segments.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {segments.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={24} />}
            label="Spoken segments will be logged here."
          />
        ) : (
          segments.map((segment, index) => (
            <div
              className="grid grid-cols-[3.2rem_minmax(0,1fr)_minmax(4.2rem,auto)] gap-3 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={`${segment.startSeconds}-${index}`}
            >
              <time className={`break-words ${mutedTextClass}`}>
                {formatTime(segment.startSeconds)}
              </time>
              <p className="m-0 break-words">{segment.text}</p>
              <span className={`break-words ${mutedTextClass}`}>
                {segment.speakerLabel
                  ? `${segment.speakerLabel} ${formatPercent(segment.speakerScore ?? null)}`
                  : formatPercent(segment.confidence ?? null)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ChunkAnalysisPanel({
  chunks,
  report,
  blockerStats,
}: {
  chunks: ChunkAnalysis[];
  report: AnalysisReport;
  blockerStats: BlockerStats;
}) {
  return (
    <div className={`${panelClass} min-w-0 flex-[1.1_1_24rem] max-lg:w-full`}>
      <PanelHeader title="Chunk Analysis" count={chunks.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {chunks.length === 0 ? (
          <EmptyState
            icon={<BarChart3 size={24} />}
            label="Chunk statistics will appear after speech is transcribed."
          />
        ) : (
          chunks.map((chunk) => (
            <article
              className="grid gap-3 border-b border-[#edf1ee] px-4 py-3 last:border-b-0"
              key={`${chunk.index}-${chunk.startSeconds}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <strong>Chunk {chunk.index + 1}</strong>
                <time className={`text-sm ${mutedTextClass}`}>
                  {formatTime(chunk.startSeconds)}-{formatTime(chunk.endSeconds)}
                </time>
              </div>
              <div className="grid gap-2">
                <AnalysisBar
                  label="Words"
                  value={chunk.wordCount}
                  max={Math.max(1, report.wordCount)}
                />
                <AnalysisBar
                  label="Events"
                  value={chunk.stutterCount}
                  max={Math.max(1, report.stutterCount)}
                />
                <AnalysisBar
                  label="Blocks"
                  value={chunk.blockCount}
                  max={Math.max(1, blockerStats.blockCount)}
                />
              </div>
              <div
                className={`flex flex-wrap items-center justify-between gap-3 text-sm ${mutedTextClass}`}
              >
                <span>{chunk.wordsPerMinute.toFixed(0)} wpm</span>
                <span>{chunk.silentPauseSeconds.toFixed(1)}s pause</span>
                <span>{formatPercent(chunk.averageConfidence ?? null)}</span>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function SessionsPanel({
  sessions,
  onSessionLoad,
}: {
  sessions: SavedSession[];
  onSessionLoad: (session: SavedSession) => void;
}) {
  return (
    <div className={`${panelClass} w-96 shrink-0 max-lg:w-full`}>
      <PanelHeader title="Sessions" count={sessions.length} />
      <div className="max-h-88 overflow-auto border-t border-[#edf1ee]">
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`session-row ${buttonClass} w-full justify-start rounded-none border-0 border-b border-[#edf1ee] px-4 py-3 last:border-b-0`}
            onClick={() => onSessionLoad(session)}
          >
            <PlayCircle size={18} />
            <span>{new Date(session.startedAt).toLocaleString()}</span>
            <strong className="ml-auto">{session.report.stutterCount}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function PanelHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className={`${panelHeaderClass} p-4`}>
      <h2 className="m-0 text-xl font-semibold">{title}</h2>
      <span>{count}</span>
    </div>
  );
}

function AnalysisBar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.min(100, Math.max(4, (value / max) * 100))}%`;
  return (
    <div className="grid grid-cols-[4.4rem_minmax(0,1fr)_2.4rem] items-center gap-2">
      <span className={`text-sm ${mutedTextClass}`}>{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-[#edf2ef]">
        <i className="block h-full rounded-full bg-[#1c6b5a]" style={{ width }} />
      </div>
      <strong className={`text-right text-sm ${mutedTextClass}`}>{value}</strong>
    </div>
  );
}

function EmptyState({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className={`flex items-center gap-3 p-4 ${mutedTextClass}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function eventKindClass(kind: AnalysisReport["events"][number]["kind"]) {
  return {
    wordRepetition: "bg-[#236f8e]",
    soundRepetition: "bg-[#236f8e]",
    prolongation: "bg-[#7f5d1f]",
    block: "bg-[#7d3c68]",
    filler: "bg-[#51605a]",
  }[kind];
}

function intentReasonLabel(reason: SpeakerIntentPrediction["reason"]) {
  return {
    currentContext: "Current context",
    block: "After block",
    filler: "After filler",
    repetition: "After repetition",
    prolongation: "After prolongation",
  }[reason];
}
