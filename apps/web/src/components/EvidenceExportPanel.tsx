import {
  buildEvidenceExport,
  renderEvidenceReport,
  transcriptSpeakersOf,
} from "@stutter-tracker/shared";
import { FileDown } from "lucide-react";
import { useMemo, useState } from "react";
import type { SavedSession } from "../types";
import { buttonClass, mutedTextClass, panelClass } from "./styles";

/**
 * User-directed export for a therapist: choose sessions and what to include, see exactly what
 * will be exported, then download. Nothing is sent anywhere; the file is built in memory.
 */
export function EvidenceExportPanel({ sessions }: { sessions: SavedSession[] }) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [includeTranscripts, setIncludeTranscripts] = useState(false);
  const [includeSpeakerNames, setIncludeSpeakerNames] = useState(false);
  const [excludedSpeakers, setExcludedSpeakers] = useState<string[]>([]);

  const selected = sessions.filter((session) => selectedIds.includes(session.id));
  const speakers = useMemo(() => transcriptSpeakersOf(selected), [selected]);
  const evidence = useMemo(
    () =>
      buildEvidenceExport(sessions, {
        sessionIds: selectedIds,
        includeTranscripts,
        transcriptSpeakers: excludedSpeakers.length
          ? speakers.map((speaker) => speaker.id).filter((id) => !excludedSpeakers.includes(id))
          : "all",
        includeSpeakerNames,
        exportedAt: new Date(),
      }),
    [sessions, selectedIds, includeTranscripts, includeSpeakerNames, excludedSpeakers, speakers],
  );
  const report = renderEvidenceReport(evidence);

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  return (
    <section className={`${panelClass} mt-4 p-4`} aria-label="Export for review">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-xl font-semibold">Export for review</h2>
          <p className={`m-0 mt-1 text-sm ${mutedTextClass}`}>
            Choose sessions to share with a therapist. Nothing is uploaded; you get a file to pass
            on yourself, and copies you share cannot be recalled.
          </p>
        </div>
        <button type="button" className={buttonClass} onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Choose sessions"}
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-3">
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-2 font-semibold">Sessions</legend>
              {sessions.length === 0 ? (
                <p className={`m-0 ${mutedTextClass}`}>No saved sessions yet.</p>
              ) : (
                sessions.map((session) => (
                  <label key={session.id} className="flex items-center gap-2 py-1">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(session.id)}
                      onChange={() => setSelectedIds((ids) => toggle(ids, session.id))}
                    />
                    {new Date(session.startedAt).toLocaleString()} · {session.report.stutterCount}{" "}
                    events
                  </label>
                ))
              )}
            </fieldset>
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-2 font-semibold">Include</legend>
              <label className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={includeTranscripts}
                  onChange={(event) => setIncludeTranscripts(event.target.checked)}
                />
                Transcripts
              </label>
              {includeTranscripts && (
                <>
                  <label className="flex items-center gap-2 py-1">
                    <input
                      type="checkbox"
                      checked={includeSpeakerNames}
                      onChange={(event) => setIncludeSpeakerNames(event.target.checked)}
                    />
                    Speaker names (otherwise "Speaker 1", "Speaker 2")
                  </label>
                  {speakers.length > 1 && (
                    <div className="mt-1 pl-6">
                      <p className={`m-0 text-sm ${mutedTextClass}`}>
                        Words of these speakers are included:
                      </p>
                      {speakers.map((speaker) => (
                        <label key={speaker.id} className="flex items-center gap-2 py-1">
                          <input
                            type="checkbox"
                            checked={!excludedSpeakers.includes(speaker.id)}
                            onChange={() => setExcludedSpeakers((ids) => toggle(ids, speaker.id))}
                          />
                          {speaker.label}
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </fieldset>
            <p className={`m-0 text-sm ${mutedTextClass}`}>
              Never included: audio, voiceprints, device details and the app's severity label.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={selectedIds.length === 0}
                onClick={() => downloadFile("speaking-evidence.txt", report, "text/plain")}
              >
                <FileDown size={16} />
                Download report
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={selectedIds.length === 0}
                onClick={() =>
                  downloadFile(
                    "speaking-evidence.json",
                    JSON.stringify(evidence, null, 2),
                    "application/json",
                  )
                }
              >
                <FileDown size={16} />
                Download data
              </button>
            </div>
          </div>
          <div>
            <h3 className="m-0 mb-2 font-semibold">Preview: exactly what will be exported</h3>
            <pre
              aria-label="Export preview"
              className="m-0 max-h-96 overflow-auto rounded-lg bg-[#f5f7f5] p-3 text-xs whitespace-pre-wrap"
            >
              {selectedIds.length ? report : "Select at least one session."}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}

// Built in memory and handed to the browser's download; no temporary file is written.
function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
