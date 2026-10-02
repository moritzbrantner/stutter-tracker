import { describe, expect, test } from "bun:test";

import {
  type OutcomeObservation,
  resolveSpokenLanguage,
  speechLanguageSupport,
  summarizeOutcomes,
} from "./outcomes";

const effortScale = { min: 0, max: 10, betterDirection: "lower" } as const;
const participationScale = { min: 0, max: 10, betterDirection: "higher" } as const;

function observation(overrides: Partial<OutcomeObservation>): OutcomeObservation {
  return {
    id: "obs",
    recordedAt: "2026-10-01T09:00:00Z",
    measure: "effort",
    source: "selfReported",
    value: 5,
    scale: effortScale,
    condition: { kind: "unassisted" },
    horizon: "transfer",
    task: { kind: "phoneCall", trained: false },
    spokenLanguage: "en",
    sampleDurationSeconds: 120,
    ...overrides,
  };
}

// Synthetic English example report: no real participant data.
const syntheticEnglishWeek: OutcomeObservation[] = [
  observation({ id: "e1", recordedAt: "2026-09-01T09:00:00Z", value: 8 }),
  observation({ id: "e2", recordedAt: "2026-09-15T09:00:00Z", value: 6 }),
  observation({
    id: "p1",
    recordedAt: "2026-09-01T09:00:00Z",
    measure: "participation",
    scale: participationScale,
    value: 3,
  }),
  observation({
    id: "p2",
    recordedAt: "2026-09-15T09:00:00Z",
    measure: "participation",
    scale: participationScale,
    value: 6,
  }),
  observation({
    id: "n1",
    recordedAt: "2026-09-01T09:00:00Z",
    measure: "naturalness",
    scale: participationScale,
    value: 7,
  }),
  observation({
    id: "n2",
    recordedAt: "2026-09-15T09:00:00Z",
    measure: "naturalness",
    scale: participationScale,
    value: 5,
  }),
];

describe("summarizeOutcomes", () => {
  test("synthetic English report shows less struggle and better participation without a cure claim", () => {
    const report = summarizeOutcomes(syntheticEnglishWeek);
    const byMeasure = Object.fromEntries(report.comparisons.map((c) => [c.measure, c]));

    expect(byMeasure.effort.change).toBe("better");
    expect(byMeasure.participation.change).toBe("better");
    expect(report.limitations).toContain(
      "This app has not demonstrated a cure or treatment efficacy.",
    );
    const text = [...report.comparisons.map((c) => c.statement), ...report.limitations].join(" ");
    expect(text).not.toMatch(/\bcured\b|\bfixed\b|\bsevere\b|severity/i);
  });

  test("reports worse and unchanged results honestly", () => {
    const report = summarizeOutcomes([
      ...syntheticEnglishWeek,
      observation({ id: "g1", measure: "communicationGoal", scale: participationScale, value: 4 }),
      observation({
        id: "g2",
        recordedAt: "2026-10-02T09:00:00Z",
        measure: "communicationGoal",
        scale: participationScale,
        value: 4,
      }),
    ]);
    const byMeasure = Object.fromEntries(report.comparisons.map((c) => [c.measure, c]));

    expect(byMeasure.naturalness.change).toBe("worse");
    expect(byMeasure.naturalness.statement).toContain("worse than");
    expect(byMeasure.communicationGoal.change).toBe("noClearChange");
  });

  test("never compares across assistance condition, source or spoken language", () => {
    const report = summarizeOutcomes([
      observation({ id: "a", value: 8 }),
      observation({
        id: "b",
        recordedAt: "2026-09-20T09:00:00Z",
        value: 2,
        condition: { kind: "assisted", aidId: "delayedFeedback" },
      }),
      observation({
        id: "c",
        recordedAt: "2026-09-21T09:00:00Z",
        value: 2,
        source: "clinicianRated",
      }),
      observation({ id: "d", recordedAt: "2026-09-22T09:00:00Z", value: 2, spokenLanguage: "de" }),
    ]);

    expect(report.comparisons).toHaveLength(4);
    expect(report.comparisons.every((c) => c.change === "insufficientData")).toBe(true);
  });
});

describe("summarizeOutcomes grouping", () => {
  test("separates aids, aid settings, trained vs untrained tasks and scales", () => {
    const report = summarizeOutcomes([
      observation({ id: "a", value: 8, condition: { kind: "assisted", aidId: "delayedFeedback" } }),
      observation({
        id: "b",
        recordedAt: "2026-09-20T09:00:00Z",
        value: 2,
        condition: { kind: "assisted", aidId: "pacing" },
      }),
      observation({
        id: "c",
        recordedAt: "2026-09-21T09:00:00Z",
        value: 2,
        condition: { kind: "assisted", aidId: "delayedFeedback", settings: { delayMs: 80 } },
      }),
      observation({
        id: "d",
        recordedAt: "2026-09-22T09:00:00Z",
        value: 2,
        task: { kind: "phoneCall", trained: true },
      }),
      observation({
        id: "e",
        recordedAt: "2026-09-23T09:00:00Z",
        value: 2,
        scale: { min: 0, max: 5, betterDirection: "lower" },
      }),
    ]);

    expect(report.comparisons).toHaveLength(5);
    expect(report.comparisons.every((c) => c.change === "insufficientData")).toBe(true);
  });

  test("orders observations by instant, not timestamp text", () => {
    const report = summarizeOutcomes([
      observation({ id: "late", recordedAt: "2026-10-01T08:30:00Z", value: 2 }),
      observation({ id: "early", recordedAt: "2026-10-01T09:00:00+02:00", value: 8 }),
    ]);

    expect(report.comparisons[0]).toMatchObject({ baseline: 8, latest: 2, change: "better" });
  });
});

describe("summarizeOutcomes validity", () => {
  test("compares event counts as rates per minute of sample", () => {
    const events = { min: 0, max: 100, betterDirection: "lower", unit: "events" } as const;
    const report = summarizeOutcomes([
      observation({
        id: "a",
        measure: "eventBurden",
        scale: events,
        value: 5,
        sampleDurationSeconds: 60,
      }),
      observation({
        id: "b",
        recordedAt: "2026-10-02T09:00:00Z",
        measure: "eventBurden",
        scale: events,
        value: 10,
        sampleDurationSeconds: 600,
      }),
    ]);

    expect(report.comparisons[0]).toMatchObject({ baseline: 5, latest: 1, change: "better" });
  });

  test("excludes observations with invalid timestamps", () => {
    const report = summarizeOutcomes([
      observation({ id: "bad", recordedAt: "", value: 1 }),
      observation({ id: "a", value: 8 }),
      observation({ id: "b", recordedAt: "2026-10-02T09:00:00Z", value: 2 }),
    ]);

    expect(report.excludedObservationIds).toEqual(["bad"]);
    expect(report.comparisons[0]).toMatchObject({ baseline: 8, latest: 2, observationCount: 2 });
  });

  test("groups regional tags under the primary language", () => {
    const report = summarizeOutcomes([
      observation({ id: "a", value: 8, spokenLanguage: "en" }),
      observation({
        id: "b",
        recordedAt: "2026-10-02T09:00:00Z",
        value: 2,
        spokenLanguage: "en-US",
      }),
    ]);

    expect(report.comparisons).toHaveLength(1);
    expect(report.comparisons[0].spokenLanguage).toBe("en");
  });
});

describe("spoken language", () => {
  test("is English first, German and Spanish later, and nothing is validated", () => {
    expect(speechLanguageSupport("en")).toBe("first");
    expect(speechLanguageSupport("de")).toBe("later");
    expect(speechLanguageSupport("es")).toBe("later");
    expect(speechLanguageSupport("fr")).toBe("unsupported");
    expect(speechLanguageSupport("unknown")).toBe("unknown");
  });

  test("interface language never fills in the recorded speech language", () => {
    expect(resolveSpokenLanguage({ interfaceLanguage: "de" })).toBe("unknown");
    expect(
      resolveSpokenLanguage({ declaredSpokenLanguage: "es-ES", interfaceLanguage: "en" }),
    ).toBe("es");
    expect(speechLanguageSupport("en-US")).toBe("first");
    expect(resolveSpokenLanguage({ declaredSpokenLanguage: "EN", interfaceLanguage: "de" })).toBe(
      "en",
    );
  });
});
