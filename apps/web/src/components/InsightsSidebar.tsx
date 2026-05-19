import { CheckCircle2, Cpu, Download, LoaderCircle, ShieldCheck } from "lucide-react";
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
import { modelStatusLabel } from "../utils/formatting";
import { buttonClass, controlClass, cx, mutedTextClass, panelClass } from "./styles";

type TodayStats = {
  count: number;
  totalEvents: number;
  totalMinutes: number;
};

type InsightsSidebarProps = {
  todayStats: TodayStats;
  report: AnalysisReport;
  speechStats: AnalysisReport["speechStats"];
  blockerStats: BlockerStats;
  selectedEngine: TranscriptionEngine;
  selectedModel: string;
  selectedModelStatus?: TranscriptionModelStatus;
  modelStatuses: TranscriptionModelStatus[];
  corpusAnalysis: SpeechCorpusAnalysis;
  speakers: SpeakerProfile[];
  speakerLabel: string;
  canEnroll: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  downloadingModel: string | null;
  isDownloadPending: boolean;
  onModelSelect: (model: string) => void;
  onModelDownload: (model: string) => void;
  onSpeakerLabelChange: (label: string) => void;
  onEnroll: () => void;
};

export function InsightsSidebar({
  todayStats,
  report,
  speechStats,
  blockerStats,
  selectedEngine,
  selectedModel,
  selectedModelStatus,
  modelStatuses,
  corpusAnalysis,
  speakers,
  speakerLabel,
  canEnroll,
  isRecording,
  isTranscribing,
  downloadingModel,
  isDownloadPending,
  onModelSelect,
  onModelDownload,
  onSpeakerLabelChange,
  onEnroll,
}: InsightsSidebarProps) {
  return (
    <aside className={`${panelClass} w-[22rem] shrink-0 p-4 max-lg:w-full`}>
      <PanelBlock title="Today">
        <div className="mt-3 flex flex-wrap gap-2">
          <MiniStat>{todayStats.count} sessions</MiniStat>
          <MiniStat>{todayStats.totalEvents} events</MiniStat>
          <MiniStat>{todayStats.totalMinutes.toFixed(1)} min</MiniStat>
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
          <StatLine label="Fluency" value={`${speechStats.fluencyPercentage.toFixed(0)}%`} />
          <StatLine
            label="Density"
            value={`${speechStats.eventDensityPer100Words.toFixed(1)}/100 words`}
          />
          {report.acousticStats && <AcousticStatsLines stats={report.acousticStats} />}
        </StatsList>
      </PanelBlock>

      <PanelBlock title="Blockers">
        <StatsList>
          <StatLine label="Count" value={blockerStats.blockCount.toString()} />
          <StatLine label="Total" value={`${blockerStats.totalBlockSeconds.toFixed(1)}s`} />
          <StatLine label="Average" value={`${blockerStats.averageBlockSeconds.toFixed(1)}s`} />
          <StatLine label="Longest" value={`${blockerStats.longestBlockSeconds.toFixed(1)}s`} />
          <StatLine
            label="Time blocked"
            value={`${blockerStats.blockedTimePercentage.toFixed(1)}%`}
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
                <span className={`shrink-0 text-sm ${mutedTextClass}`}>
                  {speaker.embeddings.length} sample{speaker.embeddings.length === 1 ? "" : "s"}
                </span>
              </div>
            ))
          )}
        </div>
      </PanelBlock>

      <PanelBlock title="Scope">
        <p className={`m-0 ${mutedTextClass}`}>
          This tracks speech patterns for review. It is not a medical diagnosis.
        </p>
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
