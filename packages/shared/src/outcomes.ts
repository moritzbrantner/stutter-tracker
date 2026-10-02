// Outcome schema for intended-use decision record v0.1 (docs/intended-use.md).
// Outcomes are reported per measure; there is deliberately no combined severity score.

/** Speech-analysis languages in rollout order. None is validated yet. */
export const SPEECH_LANGUAGE_ROLLOUT = [
  { code: "en", stage: "first", validated: false },
  { code: "de", stage: "later", validated: false },
  { code: "es", stage: "later", validated: false },
] as const;

/** BCP-47 primary language subtag of the recorded speech, or "unknown". Never the UI language. */
export type SpokenLanguage = string;
export const UNKNOWN_SPOKEN_LANGUAGE = "unknown";

export type SpeechLanguageSupport = "first" | "later" | "unsupported" | "unknown";

export function speechLanguageSupport(language: SpokenLanguage): SpeechLanguageSupport {
  if (language === UNKNOWN_SPOKEN_LANGUAGE) return "unknown";
  const entry = SPEECH_LANGUAGE_ROLLOUT.find((candidate) => candidate.code === language);
  return entry ? entry.stage : "unsupported";
}

/**
 * The spoken language is recorded explicitly per session. The interface language is
 * accepted only to make the separation visible: it is never used as a fallback.
 */
export function resolveSpokenLanguage(input: {
  declaredSpokenLanguage?: string | null;
  interfaceLanguage?: string | null;
}): SpokenLanguage {
  const declared = input.declaredSpokenLanguage?.trim().toLowerCase();
  return declared ? declared : UNKNOWN_SPOKEN_LANGUAGE;
}

export type BenefitHorizon = "duringAssistance" | "transfer" | "maintenance";

export type OutcomeMeasure =
  | "communicationGoal"
  | "effort"
  | "naturalness"
  | "participation"
  | "eventBurden"
  | "eventDuration";

export type OutcomeSource = "observed" | "selfReported" | "clinicianRated";

export type AssistanceCondition =
  | { kind: "unassisted" }
  | { kind: "assisted"; aidId: string; settings?: Record<string, number | string | boolean> };

export type SpeakingTask = {
  kind: "reading" | "monologue" | "conversation" | "phoneCall" | "presentation" | "other";
  /** Whether this task was practised; untrained tasks measure transfer. */
  trained: boolean;
  description?: string;
};

export type OutcomeScale = {
  min: number;
  max: number;
  /** "lower" for effort/discomfort, event burden and duration. */
  betterDirection: "higher" | "lower";
  unit?: string;
  /** Validated instruments are only referenced by id after licensing review; never by text. */
  instrumentId?: string;
};

export type OutcomeObservation = {
  id: string;
  sessionId?: string;
  recordedAt: string;
  measure: OutcomeMeasure;
  source: OutcomeSource;
  value: number;
  scale: OutcomeScale;
  condition: AssistanceCondition;
  horizon: BenefitHorizon;
  task: SpeakingTask;
  spokenLanguage: SpokenLanguage;
  sampleDurationSeconds: number;
};

export type OutcomeChange = "better" | "worse" | "noClearChange" | "insufficientData";

export type OutcomeComparison = {
  measure: OutcomeMeasure;
  source: OutcomeSource;
  horizon: BenefitHorizon;
  condition: AssistanceCondition;
  spokenLanguage: SpokenLanguage;
  task: SpeakingTask;
  scale: OutcomeScale;
  baseline?: number;
  latest?: number;
  observationCount: number;
  change: OutcomeChange;
  statement: string;
};

export type OutcomeReport = {
  comparisons: OutcomeComparison[];
  limitations: string[];
};

export const OUTCOME_REPORT_LIMITATIONS = [
  "This app has not demonstrated a cure or treatment efficacy.",
  "Changes can come from the task, the day, recording quality or analysis versions, not only from practice or an aid.",
  "Self-ratings are personal observations, not validated clinical measures.",
] as const;

const MEASURE_LABELS: Record<OutcomeMeasure, string> = {
  communicationGoal: "Communication goal",
  effort: "Speaking effort",
  naturalness: "Naturalness",
  participation: "Participation",
  eventBurden: "Event burden",
  eventDuration: "Event duration",
};

/**
 * Compares the earliest and latest observation inside groups that share measure, source,
 * horizon, condition (aid and settings), spoken language, task (kind and trained) and scale.
 * Groups are never mixed, so a different aid, language, task, trained-vs-transfer task or
 * scale cannot masquerade as improvement.
 * `minimumChangeFraction` is the share of the scale range treated as no clear change.
 */
export function summarizeOutcomes(
  observations: OutcomeObservation[],
  options: { minimumChangeFraction?: number } = {},
): OutcomeReport {
  const threshold = options.minimumChangeFraction ?? 0.1;
  const groups = new Map<string, OutcomeObservation[]>();
  for (const observation of observations) {
    const { condition, scale, task } = observation;
    const key = JSON.stringify([
      observation.measure,
      observation.source,
      observation.horizon,
      condition.kind,
      condition.kind === "assisted" ? condition.aidId : null,
      condition.kind === "assisted" ? sortedEntries(condition.settings) : null,
      observation.spokenLanguage,
      task.kind,
      task.trained,
      scale.min,
      scale.max,
      scale.betterDirection,
      scale.unit ?? null,
      scale.instrumentId ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  const comparisons = [...groups.values()].map((group): OutcomeComparison => {
    const ordered = [...group].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const base = {
      measure: first.measure,
      source: first.source,
      horizon: first.horizon,
      condition: first.condition,
      spokenLanguage: first.spokenLanguage,
      task: first.task,
      scale: first.scale,
      observationCount: ordered.length,
    };
    const conditionLabel =
      first.condition.kind === "assisted" ? `assisted: ${first.condition.aidId}` : "unassisted";
    const taskLabel = `${first.task.trained ? "trained" : "untrained"} ${first.task.kind}`;
    const label = `${MEASURE_LABELS[first.measure]} (${first.source}, ${conditionLabel}, ${taskLabel}, ${first.spokenLanguage})`;
    if (ordered.length < 2) {
      return {
        ...base,
        latest: last.value,
        change: "insufficientData",
        statement: `${label}: only one observation, no comparison yet.`,
      };
    }
    const range = Math.max(first.scale.max - first.scale.min, Number.EPSILON);
    const delta = last.value - first.value;
    const improvement = first.scale.betterDirection === "higher" ? delta : -delta;
    const change: OutcomeChange =
      Math.abs(delta) / range < threshold ? "noClearChange" : improvement > 0 ? "better" : "worse";
    const wording = {
      better: "better than",
      worse: "worse than",
      noClearChange: "no clear change from",
      insufficientData: "",
    }[change];
    return {
      ...base,
      baseline: first.value,
      latest: last.value,
      change,
      statement: `${label}: ${last.value} is ${wording} the first observation ${first.value} across ${ordered.length} observations.`,
    };
  });

  return { comparisons, limitations: [...OUTCOME_REPORT_LIMITATIONS] };
}

function sortedEntries(settings: Record<string, unknown> | undefined) {
  return Object.entries(settings ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

/** Plain-language limits and signposting for help/onboarding surfaces. */
export const INTENDED_USE_NOTICE = {
  scope:
    "Stutter Tracker helps you record and review your own speech. It is not a diagnosis, treatment or cure.",
  signposting:
    "For assessment or therapy, talk to a speech-language therapist who specialises in stuttering. Seek prompt professional assessment if stuttering started recently or in a child.",
  stop: "Stop any exercise or feedback that causes discomfort, distress or makes speaking harder.",
} as const;
