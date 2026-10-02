import type { ProcessingDestination } from "@stutter-tracker/compute-client";
import { Mic, MicOff } from "lucide-react";
import type { TranscriptionEngine, TranscriptionEngineId, TranscriptionSettings } from "../types";
import { controlClass, cx, dangerButtonClass, eyebrowClass, primaryButtonClass } from "./styles";

type DashboardHeaderProps = {
  engines: TranscriptionEngine[];
  languages: string[];
  transcription: TranscriptionSettings;
  selectedModels: string[];
  language: string;
  isNative: boolean;
  isRecording: boolean;
  processingDestination: ProcessingDestination;
  onRemoteConsentChange: (granted: boolean) => void;
  onEngineChange: (engine: TranscriptionEngineId) => void;
  onModelChange: (model: string) => void;
  onLanguageChange: (language: string) => void;
  onRecordingToggle: () => void;
};

export function DashboardHeader({
  engines,
  languages,
  transcription,
  selectedModels,
  language,
  isNative,
  isRecording,
  processingDestination,
  onRemoteConsentChange,
  onEngineChange,
  onModelChange,
  onLanguageChange,
  onRecordingToggle,
}: DashboardHeaderProps) {
  return (
    <section className="mb-4 flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
      <div>
        <p className={eyebrowClass}>Stutter Tracker</p>
        <h1 className="m-0 text-5xl leading-none text-[#17201b] max-sm:text-4xl">Speech Log</h1>
        <ProcessingDestinationNotice
          destination={processingDestination}
          disabled={isRecording}
          onRemoteConsentChange={onRemoteConsentChange}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 max-sm:flex-col max-sm:items-stretch">
        <select
          className={controlClass}
          value={transcription.engine}
          onChange={(event) => onEngineChange(event.target.value as TranscriptionEngineId)}
          disabled={isRecording}
          aria-label="Transcription engine"
        >
          {engines.map((engine) => (
            <option
              key={engine.id}
              value={engine.id}
              disabled={engine.nativeOnly && !isNative && processingDestination.kind !== "server"}
            >
              {engine.label}
            </option>
          ))}
        </select>
        <select
          className={controlClass}
          value={transcription.model}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={isRecording || selectedModels.length < 2}
          aria-label="Transcription model"
        >
          {selectedModels.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          className={controlClass}
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
          disabled={isRecording}
          aria-label="Recognition language"
        >
          {languages.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          className={cx(isRecording ? dangerButtonClass : primaryButtonClass)}
          onClick={onRecordingToggle}
        >
          {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
          {isRecording ? "Stop" : "Record"}
        </button>
      </div>
    </section>
  );
}

function ProcessingDestinationNotice({
  destination,
  disabled,
  onRemoteConsentChange,
}: {
  destination: ProcessingDestination;
  disabled: boolean;
  onRemoteConsentChange: (granted: boolean) => void;
}) {
  const remote =
    (destination.kind === "server" && destination.mode === "remote") ||
    (destination.kind === "blocked" && destination.needsRemoteConsent);
  return (
    <div className="mt-2 text-sm text-[#536158]" role="status" aria-label="Processing destination">
      <p className="m-0">
        Processing: <strong>{destination.label}</strong>
      </p>
      {destination.kind === "blocked" ? <p className="m-0">{destination.reason}</p> : null}
      {remote ? (
        <label className="mt-1 flex items-center gap-2">
          <input
            type="checkbox"
            checked={destination.kind === "server"}
            disabled={disabled}
            onChange={(event) => onRemoteConsentChange(event.target.checked)}
          />
          Send recordings, transcripts and speaker profiles (voiceprints) to this remote server for
          analysis and storage
        </label>
      ) : null}
    </div>
  );
}
