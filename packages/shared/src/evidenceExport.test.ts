import { describe, expect, test } from "bun:test";

import {
  buildEvidenceExport,
  EVIDENCE_EXPORT_VERSION,
  renderEvidenceReport,
  transcriptSpeakersOf,
} from "./evidenceExport";
import { fallbackAnalyze } from "./index";
import { annotateSession, createSessionRecord, type SessionRecord } from "./sessions";

function session(id: string, startedAt: string, texts: [string, string, string][]): SessionRecord {
  const segments = texts.map(([text, speakerId, speakerLabel], index) => ({
    text,
    startSeconds: index * 2,
    endSeconds: index * 2 + 1.5,
    isFinal: true,
    speakerId,
    speakerLabel,
  }));
  return createSessionRecord({
    id,
    startedAt,
    segments,
    pauses: [],
    report: fallbackAnalyze({ segments, pauses: [] }),
    run: {
      id: `${id}-run`,
      createdAt: startedAt,
      analyzer: { producer: "onDevice", algorithm: "shared-fallback", version: "1" },
      usedAudio: false,
      audioId: null,
    },
    context: { spokenLanguage: "en", task: { kind: "reading", trained: false }, condition: null },
    recordings: [
      {
        sessionId: id,
        runId: `${id}-capture`,
        origin: "browser",
        role: "appInput",
        sampleRate: 48_000,
        channelCount: 1,
        deviceRoute: "Secret Headset Model",
        startOffsetSeconds: 0,
        preprocessing: {
          echoCancellation: { requested: true },
          noiseSuppression: { requested: true },
          autoGainControl: { requested: false },
        },
        discontinuities: [],
        speakerAssessment: "unknown",
      },
    ],
  });
}

const chosen = session("internal-chosen-id", "2026-10-01T09:00:00.000Z", [
  ["I I want to order", "me", "Robin Private"],
  ["What would you like", "barista", "Cafe Staffer"],
]);
const excluded = session("internal-excluded-id", "2026-10-02T09:00:00.000Z", [
  ["Excluded secret sentence", "me", "Robin Private"],
]);
const all = [chosen, excluded];
const exportedAt = new Date("2026-10-08T12:00:00.000Z");

describe("evidence export", () => {
  test("includes only the selected sessions and never internal ids, voiceprints or devices", () => {
    const evidence = buildEvidenceExport(all, {
      sessionIds: [chosen.id],
      includeTranscripts: true,
      transcriptSpeakers: "all",
      includeSpeakerNames: true,
      exportedAt,
    });
    const json = JSON.stringify(evidence);

    expect(evidence.version).toBe(EVIDENCE_EXPORT_VERSION);
    expect(evidence.sessions.map((item) => item.ref)).toEqual(["S1"]);
    for (const leaked of [
      "internal-chosen-id",
      "internal-excluded-id",
      "Excluded secret sentence",
      "Secret Headset Model",
      '"embeddings"',
      '"severity"',
      '"audioId"',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  test("redacts transcripts, speaker names and unselected speakers on request", () => {
    const noTranscript = JSON.stringify(
      buildEvidenceExport(all, {
        sessionIds: [chosen.id],
        includeTranscripts: false,
        transcriptSpeakers: "all",
        includeSpeakerNames: true,
        exportedAt,
      }),
    );
    expect(noTranscript).not.toContain("I I want to order");
    expect(noTranscript).not.toContain("Robin Private");

    const pseudonymous = buildEvidenceExport(all, {
      sessionIds: [chosen.id],
      includeTranscripts: true,
      transcriptSpeakers: ["me"],
      includeSpeakerNames: false,
      exportedAt,
    });
    const json = JSON.stringify(pseudonymous);
    expect(pseudonymous.sessions[0].transcript).toEqual([
      { speaker: "Speaker 1", startSeconds: 0, endSeconds: 1.5, text: "I I want to order" },
    ]);
    expect(json).not.toContain("Robin Private");
    expect(json).not.toContain("Cafe Staffer");
    expect(json).not.toContain("What would you like");
  });

  test("lists the speakers present in the selection for the preview", () => {
    expect(transcriptSpeakersOf([chosen])).toEqual([
      { id: "me", label: "Robin Private" },
      { id: "barista", label: "Cafe Staffer" },
    ]);
  });

  test("keeps automated estimates, denominators and human references distinct", () => {
    const reviewed = annotateSession(chosen, {
      id: "ann-1",
      createdAt: "2026-10-03T10:00:00.000Z",
      author: { role: "clinician" },
      basedOnRunId: null,
      events: [
        { kind: "wordRepetition", startSeconds: 0, endSeconds: 0.5, certainty: "certain" },
        { kind: "block", startSeconds: 1, endSeconds: 1.4, certainty: "possible" },
      ],
      status: "accepted",
      supersedes: null,
    });
    const [item] = buildEvidenceExport([reviewed], {
      sessionIds: [reviewed.id],
      includeTranscripts: false,
      transcriptSpeakers: "all",
      includeSpeakerNames: false,
      exportedAt,
    }).sessions;

    expect(item.sample.durationMinutes).toBeGreaterThan(0);
    expect(item.automatedEstimate.verifiedForTranscript).toBe(true);
    expect(item.automatedEstimate.analyzer).toBe("onDevice:shared-fallback:1");
    expect(item.humanReference).toEqual({
      authorRole: "clinician",
      annotatedAt: "2026-10-03T10:00:00.000Z",
      eventCount: 1,
      possibleEventCount: 1,
    });
  });

  test("renders a readable report without diagnostic or improvement claims", () => {
    const report = renderEvidenceReport(
      buildEvidenceExport(all, {
        sessionIds: [chosen.id, excluded.id],
        includeTranscripts: false,
        transcriptSpeakers: "all",
        includeSpeakerNames: false,
        exportedAt,
      }),
    );
    expect(report).toContain("Automated estimate (model, not a judgment)");
    expect(report).toContain("Human reference: none");
    expect(report).toContain("not a diagnosis");
    expect(report).toContain("a single change is not evidence of improvement");
    expect(report.toLowerCase()).not.toMatch(/severity: |cured|improved by/);
  });
});
