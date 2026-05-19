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
