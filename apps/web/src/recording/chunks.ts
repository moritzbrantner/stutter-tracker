import type {
  TranscriptSegment,
  TranscriptionChunkRecord,
  TranscriptionChunkSummary,
} from "../types";

export function planAvailableChunks(args: {
  totalSamples: number;
  nextStartSample: number;
  sampleRate: number;
  chunkSeconds: number;
  forceFinal: boolean;
}): Array<{ startSample: number; endSample: number }> {
  const chunkSamples = Math.floor(args.sampleRate * args.chunkSeconds);
  const minSamples = Math.floor(args.sampleRate * (args.forceFinal ? 0.5 : args.chunkSeconds));
  const chunks: Array<{ startSample: number; endSample: number }> = [];
  let nextStartSample = args.nextStartSample;

  while (args.totalSamples - nextStartSample >= minSamples) {
    const startSample = nextStartSample;
    const endSample = args.forceFinal
      ? args.totalSamples
      : Math.min(args.totalSamples, startSample + chunkSamples);
    if (!args.forceFinal && endSample - startSample < chunkSamples) {
      break;
    }
    chunks.push({ startSample, endSample });
    nextStartSample = endSample;
    if (args.forceFinal) {
      break;
    }
  }

  return chunks;
}

export function offsetTranscriptSegments(
  segments: TranscriptSegment[],
  offsetSeconds: number,
): TranscriptSegment[] {
  return segments.map((segment) => ({
    ...segment,
    startSeconds: segment.startSeconds + offsetSeconds,
    endSeconds: segment.endSeconds + offsetSeconds,
  }));
}

export function mergeTranscriptSegments(
  current: TranscriptSegment[],
  incoming: TranscriptSegment[],
): TranscriptSegment[] {
  if (!incoming.length) {
    return current;
  }
  return [...current, ...incoming].sort((left, right) => left.startSeconds - right.startSeconds);
}

export function updateTranscriptionChunk(
  chunks: TranscriptionChunkRecord[],
  id: number,
  patch: Partial<TranscriptionChunkRecord>,
) {
  return chunks.map((chunk) => (chunk.id === id ? { ...chunk, ...patch } : chunk));
}

export function summarizeTranscriptionChunks(
  chunks: Pick<TranscriptionChunkRecord, "status">[],
): TranscriptionChunkSummary {
  return chunks.reduce<TranscriptionChunkSummary>(
    (summary, chunk) => {
      summary.total += 1;
      summary[chunk.status] += 1;
      return summary;
    },
    {
      total: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    },
  );
}
