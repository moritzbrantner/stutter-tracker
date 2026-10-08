// User-directed evidence export for a therapist's review. Only what the user selects leaves the
// app: chosen sessions, with transcripts, speaker names and other speakers' words under their
// control. Voiceprints, audio, device routes and the app's severity label are never exported.
import type { StutterKind } from "./index";
import {
  acceptedAnnotation,
  analyzerKey,
  isAnalysisVerified,
  type SessionRecord,
  sessionAnalysisRuns,
} from "./sessions";

export const EVIDENCE_EXPORT_SCHEMA = "vox-evidence-export";
export const EVIDENCE_EXPORT_VERSION = 1;

/** Segments without a speaker id are grouped under this key in speaker selections. */
export const UNATTRIBUTED_SPEAKER = "unattributed";

export type EvidenceExportOptions = {
  sessionIds: string[];
  includeTranscripts: boolean;
  /** Speaker ids whose words are included; "all" includes everyone. Ignored without transcripts. */
  transcriptSpeakers: "all" | string[];
  /** Keep speaker labels; otherwise speakers become "Speaker 1", "Speaker 2", … */
  includeSpeakerNames: boolean;
  exportedAt: Date;
};

export type EvidenceSession = {
  /** Position in this export, not the app's internal id. */
  ref: string;
  startedAt: string;
  context: {
    spokenLanguage: string;
    /** Task kind, or "not recorded". */
    task: string;
    /** Whether the task was practised; untrained tasks measure transfer. Null when not recorded. */
    trainedTask: boolean | null;
    /** The recorded task description, if any (e.g. what "other" means). */
    taskDescription: string | null;
    /** "unassisted", "assisted", or "not recorded". */
    condition: string;
    aid: string | null;
    /** Aid settings as recorded (e.g. delay), so different settings stay distinguishable. */
    aidSettings: Record<string, number | string | boolean> | null;
  };
  sample: {
    /** The denominator behind per-minute rates, in seconds. */
    durationSeconds: number;
    wordCount: number;
  };
  /** Model estimate from the app's automated analysis; not a clinical judgment. */
  automatedEstimate: {
    eventCount: number;
    eventsPerMinute: number;
    eventsByKind: Partial<Record<StutterKind, number>>;
    analyzer: string;
    analysisRuns: number;
    /**
     * The estimate is verified against the full saved session (all speakers). It is not
     * recalculated for an exported transcript that omits speakers or is left out.
     */
    verifiedForSavedSession: boolean;
    usedAudio: boolean | null;
  };
  /** Accepted human annotation, attributed to its role; null when none exists. */
  humanReference: {
    authorRole: string;
    annotatedAt: string;
    eventCount: number;
    possibleEventCount: number;
  } | null;
  /** Whether exportable words were removed from this session. */
  transcriptFiltered?: boolean;
  transcript?: { speaker: string; startSeconds: number; endSeconds: number; text: string }[];
};

export type EvidencePackage = {
  schema: typeof EVIDENCE_EXPORT_SCHEMA;
  version: typeof EVIDENCE_EXPORT_VERSION;
  exportedAt: string;
  notice: string;
  included: {
    transcripts: boolean;
    speakerNames: boolean;
    /** "all", "selected" (some speakers' words removed), or null without transcripts. */
    transcriptSpeakers: "all" | "selected" | null;
  };
  sessions: EvidenceSession[];
};

export const EVIDENCE_EXPORT_NOTICE =
  "Exported by the user for review. Counts are automated estimates unless marked as a human reference; they are not a diagnosis, a severity rating or evidence of treatment effect. Once shared, copies cannot be recalled.";

/**
 * Selection key for a segment's speaker. Speaker ids (enrolled voiceprints) identify a person
 * across sessions; a bare label or no attribution does not, so those are scoped to their session
 * (two sessions' "Guest" may be different people). Each kind has its own prefix, so keys of
 * different kinds never collide.
 */
export function speakerKey(
  segment: { speakerId?: string; speakerLabel?: string },
  sessionId: string,
) {
  if (segment.speakerId) {
    return `id:${segment.speakerId}`;
  }
  return segment.speakerLabel
    ? `label:${speakerKeyPart(sessionId)}:${speakerKeyPart(segment.speakerLabel)}`
    : `${UNATTRIBUTED_SPEAKER}:${sessionId}`;
}

function speakerKeyPart(value: string) {
  return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

/** Segments that can appear in an exported transcript. */
function isExportable(segment: { isFinal: boolean; text: string }) {
  return segment.isFinal && segment.text.trim().length > 0;
}

/**
 * Speakers whose words could be exported from the selected sessions, for the selection
 * controls. Session-scoped speakers carry their session's date when several sessions are listed.
 */
export function transcriptSpeakersOf(sessions: SessionRecord[]) {
  const labels = speakerLabels(sessions);
  const speakers = new Map<string, string>();
  for (const session of sessions) {
    for (const segment of session.segments.filter(isExportable)) {
      const id = speakerKey(segment, session.id);
      if (!speakers.has(id)) {
        const label = labels.get(id) ?? (segment.speakerId ? segment.speakerId : "Unattributed");
        speakers.set(
          id,
          segment.speakerId || sessions.length === 1 ? label : `${label} (${session.startedAt})`,
        );
      }
    }
  }
  return [...speakers].map(([id, label]) => ({ id, label }));
}

function speakerLabels(sessions: SessionRecord[]) {
  const labels = new Map<string, string>();
  const ordered = [...sessions].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  for (const session of ordered) {
    for (const segment of session.segments) {
      const key = speakerKey(segment, session.id);
      if (segment.speakerLabel && !labels.has(key)) {
        labels.set(key, segment.speakerLabel);
      }
    }
  }
  return labels;
}

export function buildEvidenceExport(
  sessions: SessionRecord[],
  options: EvidenceExportOptions,
): EvidencePackage {
  const selected = sessions
    .filter((session) => options.sessionIds.includes(session.id))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  // One display name per speaker, resolved before mapping, so a speaker whose label appears on
  // only some segments is not split into two.
  const labels = speakerLabels(selected);
  const pseudonyms = new Map<string, string>();
  const speakerName = (id: string) => {
    // A missing label still needs a distinct name, or separate speakers would merge.
    const label = labels.get(id);
    if (options.includeSpeakerNames && label) {
      return label;
    }
    if (!pseudonyms.has(id)) {
      pseudonyms.set(id, `Speaker ${pseudonyms.size + 1}`);
    }
    return pseudonyms.get(id) as string;
  };
  return {
    schema: EVIDENCE_EXPORT_SCHEMA,
    version: EVIDENCE_EXPORT_VERSION,
    exportedAt: options.exportedAt.toISOString(),
    notice: EVIDENCE_EXPORT_NOTICE,
    included: {
      transcripts: options.includeTranscripts,
      speakerNames: options.includeTranscripts && options.includeSpeakerNames,
      transcriptSpeakers: !options.includeTranscripts
        ? null
        : options.transcriptSpeakers === "all"
          ? "all"
          : "selected",
    },
    sessions: selected.map((session, index) => {
      // The exported denominator and the rate derived from it stay consistent.
      const seconds = round(Math.max(0, session.report.totalDurationSeconds));
      const condition = session.context.condition;
      const reference = acceptedAnnotation(session);
      const evidence: EvidenceSession = {
        ref: `S${index + 1}`,
        startedAt: session.startedAt,
        context: {
          spokenLanguage: session.context.spokenLanguage,
          task: session.context.task?.kind ?? "not recorded",
          trainedTask: session.context.task?.trained ?? null,
          taskDescription: session.context.task?.description ?? null,
          condition: condition?.kind ?? "not recorded",
          aid: condition?.kind === "assisted" ? condition.aidId : null,
          aidSettings: condition?.kind === "assisted" ? { ...(condition.settings ?? {}) } : null,
        },
        sample: { durationSeconds: seconds, wordCount: session.report.wordCount },
        automatedEstimate: {
          eventCount: session.report.stutterCount,
          eventsPerMinute: seconds > 0 ? round((session.report.stutterCount * 60) / seconds) : 0,
          eventsByKind: { ...session.report.byKind },
          analyzer: analyzerKey(session),
          analysisRuns: sessionAnalysisRuns(session).length,
          verifiedForSavedSession: isAnalysisVerified(session),
          usedAudio: session.analysis.usedAudio,
        },
        humanReference: reference
          ? {
              authorRole: reference.author.role,
              annotatedAt: reference.createdAt,
              eventCount: reference.events.filter((event) => event.certainty === "certain").length,
              possibleEventCount: reference.events.filter((event) => event.certainty === "possible")
                .length,
            }
          : null,
      };
      if (options.includeTranscripts) {
        const exportable = session.segments.filter(isExportable);
        evidence.transcriptFiltered =
          options.transcriptSpeakers !== "all" &&
          exportable.some(
            (segment) =>
              options.transcriptSpeakers !== "all" &&
              !options.transcriptSpeakers.includes(speakerKey(segment, session.id)),
          );
        evidence.transcript = exportable
          .filter(
            (segment) =>
              options.transcriptSpeakers === "all" ||
              options.transcriptSpeakers.includes(speakerKey(segment, session.id)),
          )
          .map((segment) => ({
            speaker: speakerName(speakerKey(segment, session.id)),
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            text: segment.text.trim(),
          }));
      }
      return evidence;
    }),
  };
}

/** Plain-text report for a reader who does not want the JSON package. */
export function renderEvidenceReport(evidence: EvidencePackage): string {
  const lines = [
    "Speaking evidence for review",
    `Exported ${evidence.exportedAt}`,
    "",
    evidence.notice,
    "",
    `Sessions: ${evidence.sessions.length}`,
  ];
  for (const session of evidence.sessions) {
    const estimate = session.automatedEstimate;
    lines.push(
      "",
      `${session.ref} · ${session.startedAt}`,
      `  Context: language ${oneLine(session.context.spokenLanguage)}; task ${oneLine(describeTask(session.context))}; condition ${oneLine(describeCondition(session.context))}`,
      `  Sample: ${session.sample.durationSeconds} s, ${session.sample.wordCount} words`,
      `  Automated estimate (model, not a judgment): ${estimate.eventCount} events, ${estimate.eventsPerMinute} per minute over ${session.sample.durationSeconds} s`,
      `  Analysis: ${oneLine(estimate.analyzer)}; ${estimate.analysisRuns} run${estimate.analysisRuns === 1 ? "" : "s"}; ${estimate.verifiedForSavedSession ? "verified for the full saved session (all speakers)" : "NOT verified for the saved session"}; audio ${estimate.usedAudio === null ? "unknown" : estimate.usedAudio ? "used" : "not used"}`,
      session.humanReference
        ? `  Human reference (${session.humanReference.authorRole}, ${session.humanReference.annotatedAt}): ${session.humanReference.eventCount} events, ${session.humanReference.possibleEventCount} possible`
        : "  Human reference: none",
    );
    if (session.transcript) {
      lines.push(
        session.transcriptFiltered
          ? "  Transcript (only the selected speakers' words; other speakers removed; the counts above still cover all speakers):"
          : "  Transcript:",
      );
      for (const segment of session.transcript) {
        // Embedded line breaks stay indented, so transcript text cannot pass for report lines.
        lines.push(
          `    [${segment.startSeconds.toFixed(1)}s] ${oneLine(segment.speaker)}: ${segment.text
            .split(LINE_BREAK)
            .join("\n      ")}`,
        );
      }
    }
  }
  lines.push(
    "",
    "Differences between sessions can come from the task, language, condition, recording or analyzer; a single change is not evidence of improvement.",
  );
  return lines.join("\n");
}

function describeTask(context: EvidenceSession["context"]) {
  const details = [
    context.taskDescription ? `"${oneLine(context.taskDescription)}"` : null,
    context.trainedTask === null ? null : context.trainedTask ? "practised" : "not practised",
  ].filter(Boolean);
  return details.length ? `${context.task} (${details.join(", ")})` : context.task;
}

function describeCondition(context: EvidenceSession["context"]) {
  if (context.condition !== "assisted") {
    return context.condition;
  }
  const settings = Object.entries(context.aidSettings ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return `assisted (${context.aid}${settings ? `; ${settings}` : ""})`;
}

/** LF, CRLF, lone CR and the Unicode line and paragraph separators. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

function oneLine(value: string) {
  return value.replace(/\s*(?:\r\n|[\n\r\u2028\u2029])\s*/g, " ");
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
