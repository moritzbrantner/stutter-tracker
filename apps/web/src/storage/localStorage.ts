import type {
  SavedSession,
  SpeakerProfile,
  TranscriptionEngine,
  TranscriptionSettings,
  Voiceprint,
} from "../types";
import { parseStoredSession } from "./sessionBackup";

export const STORE_KEY = "stutter-tracker:sessions";
/** Stored sessions this build cannot read; kept so a later save does not drop them. */
export const UNREADABLE_SESSIONS_KEY = "stutter-tracker:sessions:unreadable";
export const VOICE_KEY = "stutter-tracker:voiceprint";
export const SPEAKERS_KEY = "stutter-tracker:speakers";
export const TRANSCRIPTION_KEY = "stutter-tracker:transcription";
export const REMOTE_CONSENT_KEY = "stutter-tracker:remote-analysis-consent";

/** Remote-analysis consent is bound to one server URL; another URL needs consent again. */
export function loadRemoteConsent(serverUrl: string, storage: Storage = localStorage) {
  try {
    return Boolean(serverUrl) && storage.getItem(REMOTE_CONSENT_KEY) === serverUrl;
  } catch {
    return false;
  }
}

export function saveRemoteConsent(
  serverUrl: string,
  granted: boolean,
  storage: Storage = localStorage,
) {
  if (granted) {
    storage.setItem(REMOTE_CONSENT_KEY, serverUrl);
  } else {
    storage.removeItem(REMOTE_CONSENT_KEY);
  }
}

/** Loads saved sessions, migrating legacy records to the canonical schema. */
export function loadSessionsFromStorage(storage: Storage = localStorage): SavedSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const sessions: SavedSession[] = [];
  const unreadable: unknown[] = [];
  for (const candidate of parsed) {
    let session: SavedSession | null;
    try {
      session = parseStoredSession(candidate);
    } catch {
      session = null;
    }
    if (session) {
      sessions.push(session);
    } else {
      unreadable.push(candidate);
    }
  }
  if (unreadable.length) {
    preserveUnreadableSessions(unreadable, storage);
  }
  return sessions;
}

function preserveUnreadableSessions(entries: unknown[], storage: Storage) {
  try {
    const existing = JSON.parse(storage.getItem(UNREADABLE_SESSIONS_KEY) ?? "[]") as unknown;
    const kept = Array.isArray(existing) ? existing : [];
    const seen = new Set(kept.map((entry) => JSON.stringify(entry)));
    const added = entries.filter((entry) => !seen.has(JSON.stringify(entry)));
    if (added.length) {
      storage.setItem(UNREADABLE_SESSIONS_KEY, JSON.stringify([...kept, ...added]));
    }
  } catch {
    // Storage full or unavailable: the entries stay in STORE_KEY until the next save.
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
