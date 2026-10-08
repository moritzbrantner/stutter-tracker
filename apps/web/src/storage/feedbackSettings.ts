import {
  type AuditoryFeedbackSettings,
  DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
} from "../audio/auditoryFeedback";
import { clampLabSettings } from "../audio/feedbackControls";

export const FEEDBACK_SETTINGS_KEY = "stutter-tracker:auditory-feedback-settings";

/** Restores the last lab settings exactly, clamped to the lab ranges; defaults when absent. */
export function loadFeedbackSettings(storage: Storage = localStorage): AuditoryFeedbackSettings {
  try {
    const parsed = JSON.parse(storage.getItem(FEEDBACK_SETTINGS_KEY) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_AUDITORY_FEEDBACK_SETTINGS;
    }
    return clampLabSettings({
      ...DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
      ...pickNumbers(parsed as Record<string, unknown>),
    });
  } catch {
    return DEFAULT_AUDITORY_FEEDBACK_SETTINGS;
  }
}

export function saveFeedbackSettings(
  settings: AuditoryFeedbackSettings,
  storage: Storage = localStorage,
) {
  try {
    storage.setItem(FEEDBACK_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last for this page only.
  }
}

function pickNumbers(value: Record<string, unknown>): Partial<AuditoryFeedbackSettings> {
  const keys = Object.keys(
    DEFAULT_AUDITORY_FEEDBACK_SETTINGS,
  ) as (keyof AuditoryFeedbackSettings)[];
  return Object.fromEntries(
    keys.filter((key) => typeof value[key] === "number").map((key) => [key, value[key]]),
  );
}
