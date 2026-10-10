import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { parseSessionBackup } from "../storage/sessionBackup";
import type { SavedSession } from "../types";
import { buttonClass, mutedTextClass } from "./styles";

function sessionsLabel(count: number) {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/** Restore replaces every saved session with the backup (owner decision, vox#86 (a)). */
export function restoreConfirmation(currentCount: number, backupCount: number) {
  const current = `${currentCount} current saved ${currentCount === 1 ? "session" : "sessions"}`;
  return `Replace all ${current} with ${sessionsLabel(backupCount)} from this backup? The ${current.replace(" saved", "")} will be lost.`;
}

export function SessionRestoreButton({
  disabled = false,
  currentSessionCount,
  onRestore,
}: {
  disabled?: boolean;
  currentSessionCount: number;
  onRestore: (sessions: SavedSession[]) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restoreFile(file: File) {
    try {
      const sessions = parseSessionBackup(JSON.parse(await file.text()));
      if (!window.confirm(restoreConfirmation(currentSessionCount, sessions.length))) {
        return;
      }
      await onRestore(sessions);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept=".json,application/json"
        aria-label="Choose session backup"
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            setError(null);
            void restoreFile(file);
          }
        }}
      />
      <button
        className={buttonClass}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title={
          disabled ? "Finish or clear the current session before restoring sessions" : undefined
        }
      >
        <Upload size={17} />
        Restore sessions
      </button>
      {error && (
        <span className={`self-center text-sm ${mutedTextClass}`} role="alert">
          {error}
        </span>
      )}
    </>
  );
}
