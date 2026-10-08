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
    task: string;
    condition: string;
  };
  sample: {
    /** The denominator behind per-minute rates. */
    durationMinutes: number;
    wordCount: number;
  };
  /** Model estimate from the app's automated analysis; not a clinical judgment. */
  automatedEstimate: {
    eventCount: number;
    eventsPerMinute: number;
    eventsByKind: Partial<Record<StutterKind, number>>;
    analyzer: string;
    analysisRuns: number;
    verifiedForTranscript: boolean;
    usedAudio: boolean | null;
  };
  /** Accepted human annotation, attributed to its role; null when none exists. */
  humanReference: {
    authorRole: string;
    annotatedAt: string;
    eventCount: number;
    possibleEventCount: number;
  } | null;
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
    transcriptSpeakers: "all" | number;
  };
  sessions: EvidenceSession[];
};

export const EVIDENCE_EXPORT_NOTICE =
  "Exported by the user for review. Counts are automated estimates unless marked as a human reference; they are not a diagnosis, a severity rating or evidence of treatment effect. Once shared, copies cannot be recalled.";

/** Speakers that appear in the selected sessions' transcripts, for the export preview. */
export function transcriptSpeakersOf(sessions: SessionRecord[]) {
  const speakers = new Map<string, string>();
  for (const session of sessions) {
    for (const segment of session.segments) {
      const id = segment.speakerId ?? UNATTRIBUTED_SPEAKER;
      if (!speakers.has(id)) {
        speakers.set(
          id,
          segment.speakerLabel ?? (segment.speakerId ? segment.speakerId : "Unattributed"),
        );
      }
    }
  }
  return [...speakers].map(([id, label]) => ({ id, label }));
}

export function buildEvidenceExport(
  sessions: SessionRecord[],
  options: EvidenceExportOptions,
): EvidencePackage {
  const selected = sessions
    .filter((session) => options.sessionIds.includes(session.id))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const pseudonyms = new Map<string, string>();
  const speakerName = (id: string, label: string | undefined) => {
    if (options.includeSpeakerNames) {
      return label ?? (id === UNATTRIBUTED_SPEAKER ? "Unattributed" : "Speaker");
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
      transcriptSpeakers:
        options.transcriptSpeakers === "all" ? "all" : options.transcriptSpeakers.length,
    },
    sessions: selected.map((session, index) => {
      const minutes = Math.max(0, session.report.totalDurationSeconds) / 60;
      const reference = acceptedAnnotation(session);
      const evidence: EvidenceSession = {
        ref: `S${index + 1}`,
        startedAt: session.startedAt,
        context: {
          spokenLanguage: session.context.spokenLanguage,
          task: session.context.task?.kind ?? "not recorded",
          condition: session.context.condition
            ? session.context.condition.kind === "assisted"
              ? `assisted (${session.context.condition.aidId})`
              : "unassisted"
            : "not recorded",
        },
        sample: { durationMinutes: round(minutes), wordCount: session.report.wordCount },
        automatedEstimate: {
          eventCount: session.report.stutterCount,
          eventsPerMinute: minutes > 0 ? round(session.report.stutterCount / minutes) : 0,
          eventsByKind: { ...session.report.byKind },
          analyzer: analyzerKey(session),
          analysisRuns: sessionAnalysisRuns(session).length,
          verifiedForTranscript: isAnalysisVerified(session),
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
        evidence.transcript = session.segments
          .filter((segment) => segment.isFinal && segment.text.trim())
          .filter(
            (segment) =>
              options.transcriptSpeakers === "all" ||
              options.transcriptSpeakers.includes(segment.speakerId ?? UNATTRIBUTED_SPEAKER),
          )
          .map((segment) => ({
            speaker: speakerName(segment.speakerId ?? UNATTRIBUTED_SPEAKER, segment.speakerLabel),
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
      `  Context: language ${session.context.spokenLanguage}; task ${session.context.task}; condition ${session.context.condition}`,
      `  Sample: ${session.sample.durationMinutes} min, ${session.sample.wordCount} words`,
      `  Automated estimate (model, not a judgment): ${estimate.eventCount} events, ${estimate.eventsPerMinute} per minute over ${session.sample.durationMinutes} min`,
      `  Analysis: ${estimate.analyzer}; ${estimate.analysisRuns} run${estimate.analysisRuns === 1 ? "" : "s"}; ${estimate.verifiedForTranscript ? "verified for this transcript" : "NOT verified for this transcript"}; audio ${estimate.usedAudio === null ? "unknown" : estimate.usedAudio ? "used" : "not used"}`,
      session.humanReference
        ? `  Human reference (${session.humanReference.authorRole}, ${session.humanReference.annotatedAt}): ${session.humanReference.eventCount} events, ${session.humanReference.possibleEventCount} possible`
        : "  Human reference: none",
    );
    if (session.transcript) {
      lines.push("  Transcript:");
      for (const segment of session.transcript) {
        lines.push(`    [${segment.startSeconds.toFixed(1)}s] ${segment.speaker}: ${segment.text}`);
      }
    }
  }
  lines.push(
    "",
    "Differences between sessions can come from the task, language, condition, recording or analyzer; a single change is not evidence of improvement.",
  );
  return lines.join("\n");
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
