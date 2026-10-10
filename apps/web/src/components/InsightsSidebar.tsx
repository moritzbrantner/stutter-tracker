import { CheckCircle2, Cpu, Download, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { INTENDED_USE_NOTICE } from "@stutter-tracker/shared";
import type { ReactNode } from "react";
import type {
  AcousticStats,
  AnalysisReport,
  BlockerStats,
  SpeakerProfile,
  SpeechCorpusAnalysis,
  TranscriptionEngine,
  TranscriptionModelStatus,
} from "../types";
import { isScoreWithheld } from "../audio/captureQuality";
import { modelStatusLabel } from "../utils/formatting";
import { buttonClass, controlClass, cx, mutedTextClass, panelClass } from "./styles";

type TodayStats = {
  count: number;
  totalEvents: number;
  totalMinutes: number;
  /** Sessions whose saved analysis is not verified for their transcript; counted, but flagged. */
  unverified: number;
};

type InsightsSidebarProps = {
  todayStats: TodayStats;
  /** Saved sessions whose analysis is not verified for their transcript; flagged at the corpus. */
  unverifiedSessionCount?: number;
  report: AnalysisReport;
  speechStats: AnalysisReport["speechStats"];
  blockerStats: BlockerStats;
  selectedEngine: TranscriptionEngine;
  selectedModel: string;
  selectedModelStatus?: TranscriptionModelStatus;
  modelStatuses: TranscriptionModelStatus[];
  corpusAnalysis: SpeechCorpusAnalysis;
  speakers: SpeakerProfile[];
  failedSpeakerDeletions?: SpeakerProfile[];
  pendingSpeakerDeletionIds?: ReadonlySet<string>;
  onSpeakerDeletionRetry?: (speaker: SpeakerProfile) => void;
  speakerLabel: string;
  canEnroll: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  downloadingModel: string | null;
  isDownloadPending: boolean;
  onModelSelect: (model: string) => void;
  onModelDownload: (model: string) => void;
  onSpeakerLabelChange: (label: string) => void;
  /** Removes a voiceprint here and, when a server holds it, on that server too. */
  onSpeakerRemove?: (speaker: SpeakerProfile) => void;
  onEnroll: () => void;
  onCorpusExport: () => void;
};

export function InsightsSidebar({
  todayStats,
  unverifiedSessionCount = 0,
  report,
  speechStats,
  blockerStats,
  selectedEngine,
  selectedModel,
  selectedModelStatus,
  modelStatuses,
  corpusAnalysis,
  speakers,
  failedSpeakerDeletions = [],
  pendingSpeakerDeletionIds,
  onSpeakerDeletionRetry,
  speakerLabel,
  canEnroll,
  isRecording,
  isTranscribing,
  downloadingModel,
  isDownloadPending,
  onModelSelect,
  onModelDownload,
  onSpeakerLabelChange,
  onSpeakerRemove,
  onEnroll,
  onCorpusExport,
}: InsightsSidebarProps) {
  // A capture that failed the quality gate has no score: neither fluent nor blocked.
  const withheld = isScoreWithheld(report);
  const score = (value: string) => (withheld ? "Unknown" : value);
  return (
    <aside className={`${panelClass} w-[22rem] shrink-0 p-4 max-lg:w-full`}>
      <PanelBlock title="Today">
        <div className="mt-3 flex flex-wrap gap-2">
          <MiniStat>{todayStats.count} sessions</MiniStat>
          <MiniStat>{todayStats.totalEvents} events</MiniStat>
          <MiniStat>{todayStats.totalMinutes.toFixed(1)} min</MiniStat>
          {todayStats.unverified > 0 && (
            <MiniStat>{todayStats.unverified} with unverified analysis</MiniStat>
          )}
        </div>
      </PanelBlock>

      <PanelBlock title="Speech Stats">
        <StatsList>
          <StatLine label="Words" value={report.wordCount.toString()} />
          <StatLine label="Speaking" value={`${speechStats.speakingDurationSeconds.toFixed(1)}s`} />
          <StatLine label="Pauses" value={`${speechStats.pauseDurationSeconds.toFixed(1)}s`} />
          <StatLine
            label="Articulation"
            value={`${speechStats.articulationRateWpm.toFixed(0)} wpm`}
          />
          <StatLine
            label="Fluency"
            value={withheld ? "Unknown" : `${speechStats.fluencyPercentage.toFixed(0)}%`}
          />
          <StatLine
            label="Density"
            value={
              withheld ? "Unknown" : `${speechStats.eventDensityPer100Words.toFixed(1)}/100 words`
            }
          />
          {report.acousticStats && <AcousticStatsLines stats={report.acousticStats} />}
        </StatsList>
      </PanelBlock>

      <PanelBlock title="Blockers">
        <StatsList>
          <StatLine label="Count" value={score(blockerStats.blockCount.toString())} />
          <StatLine label="Total" value={score(`${blockerStats.totalBlockSeconds.toFixed(1)}s`)} />
          <StatLine
            label="Average"
            value={score(`${blockerStats.averageBlockSeconds.toFixed(1)}s`)}
          />
          <StatLine
            label="Longest"
            value={score(`${blockerStats.longestBlockSeconds.toFixed(1)}s`)}
          />
          <StatLine
            label="Time blocked"
            value={score(`${blockerStats.blockedTimePercentage.toFixed(1)}%`)}
          />
        </StatsList>
      </PanelBlock>

      <PanelBlock title="Corpus">
        <StatsList>
          <StatLine label="Sessions" value={corpusAnalysis.stats.sessions.toString()} />
          <StatLine label="Utterances" value={corpusAnalysis.stats.documents.toString()} />
          <StatLine label="Speakers" value={corpusAnalysis.stats.speakers.toString()} />
          <StatLine label="Words" value={corpusAnalysis.stats.wordCount.toString()} />
          <StatLine
            label="Lexical diversity"
            value={`${(corpusAnalysis.stats.lexicalDiversity * 100).toFixed(0)}%`}
          />
        </StatsList>
        <button className={`${buttonClass} mt-3 w-full`} onClick={onCorpusExport}>
          <Download size={16} />
          Download JSON
        </button>
        {corpusAnalysis.stats.withheldSessions > 0 && (
          <p role="note" className={`mt-3 mb-0 text-sm ${mutedTextClass}`}>
            {corpusAnalysis.stats.withheldSessions} corpus session
            {corpusAnalysis.stats.withheldSessions === 1 ? " has" : "s have"} unknown capture
            quality; {corpusAnalysis.stats.withheldSessions === 1 ? "its" : "their"} events are left
            out of the totals.
          </p>
        )}
        {unverifiedSessionCount > 0 && (
          <p
            role="note"
            className="mt-3 mb-0 rounded-lg bg-[#fdf8ec] px-3 py-2 text-sm text-[#6b5520]"
          >
            {unverifiedSessionCount} corpus session
            {unverifiedSessionCount === 1 ? " has" : "s have"} an analysis that is not verified for
            its transcript; the totals include {unverifiedSessionCount === 1 ? "it" : "them"}.
            Sessions still in your saved list can be reanalyzed there.
          </p>
        )}
        {corpusAnalysis.topTerms.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {corpusAnalysis.topTerms.slice(0, 6).map((term) => (
              <MiniStat key={term.term}>{term.term}</MiniStat>
            ))}
          </div>
        )}
        {corpusAnalysis.speakers.length > 0 && (
          <div className="mt-3 grid gap-2">
            {corpusAnalysis.speakers.slice(0, 3).map((speaker) => (
              <div
                className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[#dae2dd] px-3 py-2"
                key={speaker.speakerId ?? speaker.speakerLabel}
              >
                <strong className="break-words">{speaker.speakerLabel}</strong>
                <span className={`shrink-0 text-sm ${mutedTextClass}`}>
                  {speaker.wordCount} words
                </span>
              </div>
            ))}
          </div>
        )}
      </PanelBlock>

      <PanelBlock title="Transcription">
        <div className="mt-3 flex items-center gap-3">
          <Cpu className="shrink-0 text-[#1c6b5a]" size={18} />
          <div>
            <strong className="block">{selectedEngine.label}</strong>
            <span className={`block text-sm ${mutedTextClass}`}>
              {selectedEngine.mode} · {selectedModel} · {modelStatusLabel(selectedModelStatus)}
            </span>
          </div>
        </div>
      </PanelBlock>

      <PanelBlock title="Models">
        <div className="mt-3 grid gap-2">
          {modelStatuses.map((model) => (
            <div
              key={model.id}
              className={cx(
                "grid min-h-12 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border border-[#dae2dd] px-3 py-2",
                model.id === selectedModel && "border-[#1c6b5a] bg-[#f2f8f5]",
              )}
              onClick={() => {
                if (!isRecording && !isTranscribing) {
                  onModelSelect(model.id);
                }
              }}
              onKeyDown={(event) => {
                if (
                  (event.key === "Enter" || event.key === " ") &&
                  !isRecording &&
                  !isTranscribing
                ) {
                  onModelSelect(model.id);
                }
              }}
              role="button"
              tabIndex={isRecording || isTranscribing ? -1 : 0}
            >
              <span
                className={cx("size-2.5 rounded-full bg-[#c4cdc7]", model.cached && "bg-[#2d8f68]")}
              />
              <span className="min-w-0">
                <strong className="block break-words">{model.label}</strong>
                <small className={`block break-words ${mutedTextClass}`}>
                  {modelStatusLabel(model)}
                </small>
              </span>
              {model.id === selectedModel && <CheckCircle2 size={17} />}
              {model.downloadable && !model.cached && (
                <button
                  className={`${buttonClass} min-h-8 px-2`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onModelDownload(model.id);
                  }}
                  disabled={Boolean(downloadingModel) || isDownloadPending}
                  aria-label={`Download ${model.label}`}
                >
                  {downloadingModel === model.id ? (
                    <LoaderCircle size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      </PanelBlock>

      <PanelBlock title="Profile">
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 max-sm:grid-cols-1">
          <input
            className={controlClass}
            value={speakerLabel}
            onChange={(event) => onSpeakerLabelChange(event.target.value)}
            placeholder={`Speaker ${speakers.length + 1}`}
            aria-label="Speaker label"
          />
          <button className={buttonClass} onClick={onEnroll} disabled={!canEnroll}>
            <ShieldCheck size={16} />
            Enroll
          </button>
        </div>
        <div className="mt-3 grid gap-2">
          {speakers.length === 0 ? (
            <span className={mutedTextClass}>No enrolled speakers.</span>
          ) : (
            speakers.map((speaker) => (
              <div
                className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[#dae2dd] px-3 py-2"
                key={speaker.id}
              >
                <strong className="break-words">{speaker.label}</strong>
                <span className={`ml-auto shrink-0 text-sm ${mutedTextClass}`}>
                  {speaker.embeddings.length} sample{speaker.embeddings.length === 1 ? "" : "s"}
                </span>
                {onSpeakerRemove && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md px-2 py-1 text-sm text-[#a33b3b] hover:bg-[#fff4f4]"
                    aria-label={`Remove speaker ${speaker.label}`}
                    title="Remove this voiceprint"
                    onClick={() => onSpeakerRemove(speaker)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))
          )}
          {failedSpeakerDeletions.map((speaker) => (
            <div className="flex items-center justify-between gap-3" key={speaker.id}>
              <span className={mutedTextClass}>
                Deleting {speaker.label} from the server could not be confirmed.
              </span>
              <button
                type="button"
                className={buttonClass}
                aria-label={`Retry deleting speaker ${speaker.label} from compute server`}
                disabled={pendingSpeakerDeletionIds?.has(speaker.id)}
                onClick={() => onSpeakerDeletionRetry?.(speaker)}
              >
                Retry deletion
              </button>
            </div>
          ))}
        </div>
      </PanelBlock>

      <PanelBlock title="Scope">
        <p className={`m-0 ${mutedTextClass}`}>{INTENDED_USE_NOTICE.scope}</p>
        <p className={`mt-2 mb-0 ${mutedTextClass}`}>{INTENDED_USE_NOTICE.signposting}</p>
        <p className={`mt-2 mb-0 ${mutedTextClass}`}>{INTENDED_USE_NOTICE.stop}</p>
      </PanelBlock>
    </aside>
  );
}

function AcousticStatsLines({ stats }: { stats: AcousticStats }) {
  return (
    <>
      <StatLine label="Voice activity" value={`${(stats.voiceActivityRatio * 100).toFixed(0)}%`} />
      <StatLine label="Onsets" value={stats.onsetCount.toString()} />
    </>
  );
}

function PanelBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-[#edf1ee] py-4 first:pt-1 last:border-b-0 last:pb-0">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function StatsList({ children }: { children: ReactNode }) {
  return <div className="mt-3 grid gap-2">{children}</div>;
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-b border-[#edf1ee] last:border-b-0">
      <span className={mutedTextClass}>{label}</span>
      <strong className="text-right">{value}</strong>
    </div>
  );
}

function MiniStat({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-[#f1f5f2] px-3 py-1">{children}</span>;
}
