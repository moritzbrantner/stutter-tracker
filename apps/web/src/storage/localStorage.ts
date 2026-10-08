import {
  type ConsentLedger,
  currentConsent,
  EMPTY_CONSENT_LEDGER,
  hasConsent,
  parseConsentLedger,
  recordConsent,
  withdrawOtherScopes,
} from "@stutter-tracker/shared";
import type {
  SavedSession,
  SpeakerProfile,
  TranscriptionEngine,
  TranscriptionSettings,
  Voiceprint,
} from "../types";

export const STORE_KEY = "stutter-tracker:sessions";
export const VOICE_KEY = "stutter-tracker:voiceprint";
export const SPEAKERS_KEY = "stutter-tracker:speakers";
export const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
/** Pre-ledger storage: the one server URL that had remote-analysis consent. Migrated on read. */
export const REMOTE_CONSENT_KEY = "stutter-tracker:remote-analysis-consent";
export const CONSENT_LEDGER_KEY = "stutter-tracker:consent-ledger";
export const UNREADABLE_CONSENT_LEDGER_KEY = "stutter-tracker:consent-ledger:unreadable";

/** Loads the consent ledger, folding in a legacy remote-analysis grant once. */
export function loadConsentLedger(storage: Storage = localStorage): ConsentLedger {
  let ledger: ConsentLedger | null;
  const raw = storage.getItem(CONSENT_LEDGER_KEY);
  try {
    ledger = parseConsentLedger(JSON.parse(raw ?? "[]"));
  } catch {
    ledger = null;
  }
  if (!ledger) {
    // Unreadable means no consent. Keep the raw value so the next write cannot erase it.
    try {
      if (raw && !storage.getItem(UNREADABLE_CONSENT_LEDGER_KEY)) {
        storage.setItem(UNREADABLE_CONSENT_LEDGER_KEY, raw);
      }
    } catch {
      // Storage unavailable.
    }
    // A legacy grant must not be revived on top of a ledger whose later decisions are unknown,
    // now or after the next write replaces the corrupt ledger, so it is retired here.
    try {
      storage.removeItem(REMOTE_CONSENT_KEY);
    } catch {
      // Storage unavailable.
    }
    return EMPTY_CONSENT_LEDGER;
  }
  try {
    const legacyUrl = storage.getItem(REMOTE_CONSENT_KEY);
    if (legacyUrl) {
      if (!currentConsent(ledger, "remoteAnalysis", legacyUrl)) {
        ledger = recordConsent(ledger, {
          purpose: "remoteAnalysis",
          granted: true,
          scope: legacyUrl,
        });
        storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
      }
      storage.removeItem(REMOTE_CONSENT_KEY);
    }
  } catch {
    // Storage unavailable: the legacy grant stays where it was and is retried next load.
  }
  return ledger;
}

export function recordConsentDecision(
  decision: Parameters<typeof recordConsent>[1],
  storage: Storage = localStorage,
) {
  const ledger = recordConsent(loadConsentLedger(storage), decision);
  storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
  return ledger;
}

/** Remote-analysis consent is bound to one server URL; another URL needs consent again. */
export function loadRemoteConsent(serverUrl: string, storage: Storage = localStorage) {
  try {
    return (
      Boolean(serverUrl) && hasConsent(loadConsentLedger(storage), "remoteAnalysis", serverUrl)
    );
  } catch {
    return false;
  }
}

export function saveRemoteConsent(
  serverUrl: string,
  granted: boolean,
  storage: Storage = localStorage,
) {
  let ledger = loadConsentLedger(storage);
  if (granted) {
    // Consent covers one server at a time; returning to an earlier server needs consent again.
    ledger = withdrawOtherScopes(ledger, "remoteAnalysis", serverUrl);
  }
  ledger = recordConsent(ledger, { purpose: "remoteAnalysis", granted, scope: serverUrl });
  storage.setItem(CONSENT_LEDGER_KEY, JSON.stringify(ledger));
}

export function loadSessionsFromStorage(storage: Storage = localStorage): SavedSession[] {
  try {
    const parsed = JSON.parse(storage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as SavedSession[]) : [];
  } catch {
    return [];
  }
}

export function saveSessionsToStorage(sessions: SavedSession[], storage: Storage = localStorage) {
  storage.setItem(STORE_KEY, JSON.stringify(sessions));
}

export function loadSpeakerProfilesFromStorage(storage: Storage = localStorage): SpeakerProfile[] {
  try {
    const speakers = JSON.parse(storage.getItem(SPEAKERS_KEY) ?? "[]") as SpeakerProfile[];
    if (Array.isArray(speakers) && speakers.length > 0) {
      return normalizeSpeakerProfiles(speakers);
    }
    const legacy = JSON.parse(storage.getItem(VOICE_KEY) ?? "null") as Voiceprint | null;
    if (legacy?.embedding?.length) {
      return [
        {
          id: "legacy-speaker",
          label: "Enrolled speaker",
          embeddings: [legacy.embedding],
          sampleRate: legacy.sampleRate,
          sampleCount: legacy.sampleCount,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

export function saveSpeakerProfilesToStorage(
  speakers: SpeakerProfile[],
  storage: Storage = localStorage,
) {
  const normalized = normalizeSpeakerProfiles(speakers);
  storage.setItem(SPEAKERS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function loadTranscriptionSettingsFromStorage(
  engines: TranscriptionEngine[],
  storage: Storage = localStorage,
): TranscriptionSettings {
  try {
    const parsed = JSON.parse(
      storage.getItem(TRANSCRIPTION_KEY) ?? "null",
    ) as Partial<TranscriptionSettings> | null;
    const engine = engines.find((item) => item.id === parsed?.engine) ?? engines[0];
    const model = engine.models.includes(parsed?.model ?? "")
      ? (parsed?.model ?? engine.models[0])
      : engine.models[0];
    return { engine: engine.id, model };
  } catch {
    return { engine: engines[0].id, model: engines[0].models[0] };
  }
}

export function saveTranscriptionSettingsToStorage(
  settings: TranscriptionSettings,
  storage: Storage = localStorage,
) {
  storage.setItem(TRANSCRIPTION_KEY, JSON.stringify(settings));
}

export function normalizeSpeakerProfiles(speakers: SpeakerProfile[]) {
  return speakers.filter(
    (speaker) =>
      typeof speaker.id === "string" &&
      speaker.id.trim().length > 0 &&
      typeof speaker.label === "string" &&
      speaker.label.trim().length > 0 &&
      Array.isArray(speaker.embeddings) &&
      speaker.embeddings.length > 0,
  );
}
