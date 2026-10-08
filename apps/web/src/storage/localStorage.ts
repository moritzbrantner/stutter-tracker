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

/**
 * Loads saved sessions, migrating legacy records to the canonical schema. Entries this build
 * cannot read are kept under UNREADABLE_SESSIONS_KEY and retried on every load, so a later build
 * that can read them restores them.
 */
export function loadSessionsFromStorage(storage: Storage = localStorage): SavedSession[] {
  const stored = readJsonArray(storage, STORE_KEY);
  const quarantined = readJsonArray(storage, UNREADABLE_SESSIONS_KEY);
  if (!stored) {
    return [];
  }
  const sessions: SavedSession[] = [];
  const ids = new Set<string>();
  const unreadable: unknown[] = [];
  let recovered = false;
  for (const [candidate, fromQuarantine] of [
    ...stored.map((entry) => [entry, false] as const),
    ...(quarantined ?? []).map((entry) => [entry, true] as const),
  ]) {
    let session: SavedSession | null;
    try {
      session = parseStoredSession(candidate);
    } catch {
      session = null;
    }
    if (!session) {
      unreadable.push(candidate);
    } else if (!ids.has(session.id)) {
      ids.add(session.id);
      sessions.push(session);
      recovered ||= fromQuarantine;
    } else {
      // A readable duplicate of a visible session is dropped; kept, it would reappear after that
      // session is deleted.
      recovered = true;
    }
  }
  if (unreadable.length || recovered) {
    try {
      if (recovered) {
        storage.setItem(STORE_KEY, JSON.stringify(sessions));
      }
      storage.setItem(UNREADABLE_SESSIONS_KEY, JSON.stringify(dedupe(unreadable)));
    } catch {
      // Storage full or unavailable: entries stay where they are until the next load.
    }
  }
  return sessions;
}

function readJsonArray(storage: Storage, key: string): unknown[] | null {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dedupe(entries: unknown[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify(entry);
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

/** A restore replaces everything, including quarantined entries it was meant to remove. */
export function replaceStoredSessions(sessions: SavedSession[], storage: Storage = localStorage) {
  storage.setItem(STORE_KEY, JSON.stringify(sessions));
  storage.removeItem(UNREADABLE_SESSIONS_KEY);
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
