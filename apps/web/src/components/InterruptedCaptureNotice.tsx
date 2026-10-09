import { History, Trash2 } from "lucide-react";
import type { CaptureCheckpoint, StoredCaptureCheckpoint } from "../storage/captureCheckpoint";
import { buttonClass, mutedTextClass, panelClass, primaryButtonClass } from "./styles";

type InterruptedCaptureNoticeProps = {
  capture: Exclude<StoredCaptureCheckpoint, { kind: "none" }>;
  recoverDisabled?: boolean;
  onRecover: (checkpoint: CaptureCheckpoint) => void;
  onDiscard: () => void;
};

/** Offers an unsaved capture for recovery; nothing is recovered or dropped without a choice. */
export function InterruptedCaptureNotice({
  capture,
  recoverDisabled = false,
  onRecover,
  onDiscard,
}: InterruptedCaptureNoticeProps) {
  const checkpoint = capture.kind === "checkpoint" ? capture.checkpoint : null;
  return (
    <section
      className={`${panelClass} mb-4 border-[#e3c9a8] bg-[#fbf3e8] p-4`}
      aria-label="Interrupted recording"
    >
      <h2 className="m-0 text-lg font-semibold">Unsaved recording found</h2>
      {checkpoint ? (
        <p className={`mt-1 mb-3 text-sm ${mutedTextClass}`}>
          A recording started {new Date(checkpoint.startedAt).toLocaleString()} was not saved (
          {checkpoint.segments.length} transcript segment
          {checkpoint.segments.length === 1 ? "" : "s"}, last kept{" "}
          {new Date(checkpoint.updatedAt).toLocaleTimeString()}). Recovering restores its transcript
          and pauses; the audio was not kept, so analysis uses the transcript only.
        </p>
      ) : (
        <p className={`mt-1 mb-3 text-sm ${mutedTextClass}`}>
          An unsaved recording was kept in a format this version cannot read. It stays stored until
          you discard it.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {checkpoint && (
          <button
            className={primaryButtonClass}
            onClick={() => onRecover(checkpoint)}
            disabled={recoverDisabled}
          >
            <History size={17} />
            Recover recording
          </button>
        )}
        <button className={buttonClass} onClick={onDiscard}>
          <Trash2 size={17} />
          Discard recording
        </button>
      </div>
    </section>
  );
}
