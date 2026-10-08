import {
  type AuditoryFeedbackSettings,
  DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
} from "./auditoryFeedback";

// Lab control ranges. They are the existing UI ranges and stay within the engine's own bounds
// (`normalizeAuditoryFeedbackSettings`); widening them needs an engineering/clinical reason.

export type FeedbackControlKey = keyof AuditoryFeedbackSettings;

export type FeedbackControlSpec = {
  /** Bounds and steps in display units (ms, st, %). */
  min: number;
  max: number;
  /** Arrow keys and the number field's spinner. */
  fineStep: number;
  /** Shift + arrow keys. */
  coarseStep: number;
  unit: string;
  /** Display units per engine unit (percent fields store 0..1). */
  scale: number;
};

export const FEEDBACK_CONTROL_SPECS: Record<FeedbackControlKey, FeedbackControlSpec> = {
  delayMs: { min: 0, max: 200, fineStep: 1, coarseStep: 10, unit: "ms", scale: 1 },
  pitchShiftSemitones: { min: -4, max: 4, fineStep: 0.5, coarseStep: 1, unit: "st", scale: 1 },
  wetMix: { min: 0, max: 100, fineStep: 1, coarseStep: 10, unit: "%", scale: 100 },
  outputGain: { min: 15, max: 80, fineStep: 1, coarseStep: 10, unit: "%", scale: 100 },
};

export function toDisplayValue(key: FeedbackControlKey, value: number) {
  return roundToStep(value * FEEDBACK_CONTROL_SPECS[key].scale, key);
}

export function fromDisplayValue(key: FeedbackControlKey, displayValue: number) {
  return clampDisplayValue(key, displayValue) / FEEDBACK_CONTROL_SPECS[key].scale;
}

/** Clamps to the lab range and snaps to the fine step. */
export function clampDisplayValue(key: FeedbackControlKey, displayValue: number) {
  const spec = FEEDBACK_CONTROL_SPECS[key];
  return roundToStep(Math.min(spec.max, Math.max(spec.min, displayValue)), key);
}

/** Parses what the user typed; returns null for anything that is not a finite number. */
export function parseDisplayValue(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function stepDisplayValue(
  key: FeedbackControlKey,
  displayValue: number,
  direction: 1 | -1,
  coarse: boolean,
) {
  const spec = FEEDBACK_CONTROL_SPECS[key];
  return clampDisplayValue(
    key,
    displayValue + direction * (coarse ? spec.coarseStep : spec.fineStep),
  );
}

/** Brings any stored or requested settings into the lab ranges. */
export function clampLabSettings(settings: AuditoryFeedbackSettings): AuditoryFeedbackSettings {
  const keys = Object.keys(FEEDBACK_CONTROL_SPECS) as FeedbackControlKey[];
  return Object.fromEntries(
    keys.map((key) => {
      const value = settings[key];
      return [
        key,
        Number.isFinite(value)
          ? fromDisplayValue(key, value * FEEDBACK_CONTROL_SPECS[key].scale)
          : DEFAULT_AUDITORY_FEEDBACK_SETTINGS[key],
      ];
    }),
  ) as AuditoryFeedbackSettings;
}

function roundToStep(displayValue: number, key: FeedbackControlKey) {
  const step = FEEDBACK_CONTROL_SPECS[key].fineStep;
  // Round to the step, then strip floating-point noise (e.g. 0.1 + 0.2).
  return Number((Math.round(displayValue / step) * step).toFixed(6));
}
