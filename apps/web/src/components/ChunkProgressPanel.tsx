import type { TranscriptionChunkRecord, TranscriptionChunkSummary } from "../types";
import { chunkPlaceholder, chunkStatusLabel, formatTime } from "../utils/formatting";
import { cx, mutedTextClass } from "./styles";

type ChunkProgressPanelProps = {
  chunks: TranscriptionChunkRecord[];
  progress: TranscriptionChunkSummary;
};

export function ChunkProgressPanel({ chunks, progress }: ChunkProgressPanelProps) {
  return (
    <section
      className="mb-4 overflow-hidden rounded-lg border border-[#dbe4df]"
      aria-label="Transcription chunks"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[#edf1ee] bg-[#fbfcfb] p-3 max-sm:flex-col max-sm:items-start">
        <div>
          <strong className="block">Transcription chunks</strong>
          <span className={`block text-sm ${mutedTextClass}`}>
            {progress.total
              ? `${progress.completed} finished, ${progress.processing} processing, ${progress.queued} queued`
              : "Chunks will appear while recording"}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 max-sm:justify-start">
          <span className="rounded-full bg-[#f1f5f2] px-2 py-1 text-sm">
            {progress.total} total
          </span>
          <span className="rounded-full bg-[#f1f5f2] px-2 py-1 text-sm">
            {progress.failed} failed
          </span>
        </div>
      </div>
      {chunks.length > 0 && (
        <div className="grid max-h-60 overflow-auto">
          {chunks.map((chunk) => (
            <article
              className="grid grid-cols-[minmax(8.5rem,0.7fr)_minmax(0,1.4fr)_minmax(5.5rem,auto)] gap-3 border-b border-[#edf1ee] p-3 last:border-b-0 max-lg:grid-cols-1"
              key={chunk.id}
            >
              <div className="grid min-w-0 grid-cols-[auto_auto] items-center justify-start gap-x-2 gap-y-1">
                <strong className="col-span-2">Chunk {chunk.id}</strong>
                <span
                  className={cx(
                    "rounded-full px-2 py-0.5 text-xs font-bold text-white",
                    chunkBadgeClass(chunk.status),
                  )}
                >
                  {chunkStatusLabel(chunk.status)}
                </span>
                <time className={`text-sm ${mutedTextClass}`}>
                  {formatTime(chunk.startSeconds)}-{formatTime(chunk.endSeconds)}
                </time>
              </div>
              <p
                className={cx(
                  "m-0 min-w-0 break-words",
                  chunk.status === "failed" && "text-[#8a2f2f]",
                )}
              >
                {chunk.status === "failed"
                  ? (chunk.error ?? "Transcription failed")
                  : chunk.transcript || chunkPlaceholder(chunk.status)}
              </p>
              <small className={mutedTextClass}>
                {chunk.segmentCount
                  ? `${chunk.segmentCount} segment${chunk.segmentCount === 1 ? "" : "s"}`
                  : `${chunk.durationSeconds.toFixed(1)}s audio`}
              </small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function chunkBadgeClass(status: TranscriptionChunkRecord["status"]) {
  return {
    queued: "bg-[#69746d]",
    processing: "bg-[#236f8e]",
    completed: "bg-[#2f8f68]",
    failed: "bg-[#a33b3b]",
  }[status];
}
