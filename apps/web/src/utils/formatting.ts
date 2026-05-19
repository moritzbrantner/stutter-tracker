import type {
  AcousticEvidence,
  StutterEvent,
  StutterKind,
  TranscriptionChunkStatus,
  TranscriptionModelStatus,
} from "../types";

export function chunkStatusLabel(status: TranscriptionChunkStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
  }
}

export function chunkPlaceholder(status: TranscriptionChunkStatus) {
  switch (status) {
    case "queued":
      return "Waiting to be processed.";
    case "processing":
      return "Transcription is running.";
    case "completed":
      return "No transcript text returned.";
    case "failed":
      return "Transcription failed.";
  }
}

export function kindLabel(kind: StutterKind) {
  return {
    wordRepetition: "Word",
    soundRepetition: "Sound",
    prolongation: "Long",
    block: "Block",
    filler: "Filler",
  }[kind];
}

export function eventSourceLabel(source: NonNullable<StutterEvent["source"]>) {
  return {
    transcript: "Text",
    acoustic: "Audio",
    fused: "Text + Audio",
  }[source];
}

export function eventDetail(event: StutterEvent) {
  const evidence = acousticEvidenceSummary(event.acousticEvidence);
  return evidence ? `${event.detail} · ${evidence}` : event.detail;
}

function acousticEvidenceSummary(evidence: AcousticEvidence | undefined) {
  if (!evidence) {
    return "";
  }
  if (evidence.silenceSeconds != null) {
    return `${evidence.silenceSeconds.toFixed(1)}s silence`;
  }
  if (evidence.onsetCount != null && evidence.onsetCount > 1) {
    return `${evidence.onsetCount} onset bursts`;
  }
  if (evidence.pitchStability != null) {
    return `${Math.round(evidence.pitchStability * 100)}% stability`;
  }
  if (evidence.energyRms != null) {
    return `RMS ${evidence.energyRms.toFixed(3)}`;
  }
  return "";
}

export function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

export function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function formatPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value * 100)}%`;
}

export function modelStatusLabel(model?: TranscriptionModelStatus) {
  if (!model) {
    return "Not checked";
  }
  if (model.cached) {
    return "Ready";
  }
  if (model.downloadable) {
    return "Not downloaded";
  }
  return "External CLI";
}
