import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { STORE_KEY } from "../storage/localStorage";
import { parseSessionBackup } from "../storage/sessionBackup";
import { buttonClass, mutedTextClass } from "./styles";

export function SessionRestoreButton({ disabled = false }: { disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restoreFile(file: File) {
    try {
      const sessions = parseSessionBackup(JSON.parse(await file.text()));
      const confirmed = window.confirm(
        `Replace the currently saved sessions with ${sessions.length} session${sessions.length === 1 ? "" : "s"} from this backup?`,
      );
      if (!confirmed) {
        return;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
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
        title={disabled ? "Finish or clear the current session before restoring sessions" : undefined}
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
