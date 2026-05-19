import {
  type AnalysisReport,
  type AnalyzeSpeechRequest,
  type SpeakerIdentification,
  type SpeakerProfile,
  type TranscribeAudioRequest,
  type TranscribeAudioResult,
  type TranscriptionEngineId,
  type TranscriptionModelStatus,
  cosine,
  fallbackAnalyze,
  fallbackEmbedding,
  staticModelStatuses,
} from "@stutter-tracker/shared";

type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter(): Promise<{
      requestDevice(): Promise<{
        destroy(): void;
      }>;
    } | null>;
  };
};

export type ComputeClientOptions = {
  serverUrl?: string;
  fetchImpl?: typeof fetch;
};

export type ComputeClient = {
  analyzeSpeechSession(request: AnalyzeSpeechRequest): Promise<AnalysisReport>;
  listSpeakerProfiles(): Promise<SpeakerProfile[]>;
  saveSpeakerProfiles(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]>;
  createSpeakerProfile(request: {
    id?: string;
    label: string;
    samples: number[];
    sampleRate: number;
  }): Promise<SpeakerProfile>;
  identifySpeaker(request: {
    samples: number[];
    sampleRate: number;
    speakers: SpeakerProfile[];
    threshold?: number;
    maxResults?: number;
  }): Promise<SpeakerIdentification>;
  transcriptionModels(provider: TranscriptionEngineId): Promise<TranscriptionModelStatus[]>;
  transcribeAudio(request: TranscribeAudioRequest): Promise<TranscribeAudioResult>;
  downloadTranscriptionModel(
    provider: TranscriptionEngineId,
    model: string,
  ): Promise<TranscriptionModelStatus>;
};

export function createComputeClient(options: ComputeClientOptions = {}): ComputeClient {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.serverUrl);

  return {
    async analyzeSpeechSession(request) {
      if (baseUrl) {
        try {
          return await post<AnalysisReport>(fetcher, baseUrl, "/analysis", request);
        } catch {
          return analyzeWithLocalGpuFallback(request);
        }
      }
      return analyzeWithLocalGpuFallback(request);
    },
    async listSpeakerProfiles() {
      if (!baseUrl) {
        return [];
      }
      const result = await get<{ speakers: SpeakerProfile[] }>(fetcher, baseUrl, "/speakers");
      return result.speakers;
    },
    async saveSpeakerProfiles(speakers) {
      if (!baseUrl) {
        return speakers;
      }
      const result = await put<{ speakers: SpeakerProfile[] }>(fetcher, baseUrl, "/speakers", {
        speakers,
      });
      return result.speakers;
    },
    async createSpeakerProfile(request) {
      if (baseUrl) {
        try {
          return await post<SpeakerProfile>(fetcher, baseUrl, "/speakers/profile", request);
        } catch {
          return localSpeakerProfile(request);
        }
      }
      return localSpeakerProfile(request);
    },
    async identifySpeaker(request) {
      if (!request.speakers.length) {
        return { matches: [], isMatch: false };
      }
      if (baseUrl) {
        try {
          return await post<SpeakerIdentification>(fetcher, baseUrl, "/speakers/identify", request);
        } catch {
          return localSpeakerIdentification(request);
        }
      }
      return localSpeakerIdentification(request);
    },
    async transcriptionModels(provider) {
      if (baseUrl) {
        try {
          const result = await post<{ models: TranscriptionModelStatus[] }>(
            fetcher,
            baseUrl,
            "/transcriptions/models",
            { provider },
          );
          return result.models;
        } catch {
          return staticModelStatuses(provider);
        }
      }
      return staticModelStatuses(provider);
    },
    async transcribeAudio(request) {
      if (!baseUrl) {
        throw new Error("external compute server is required for web and mobile transcription");
      }
      return post<TranscribeAudioResult>(fetcher, baseUrl, "/transcriptions", request);
    },
    async downloadTranscriptionModel(provider, model) {
      if (!baseUrl) {
        throw new Error("external compute server is required for model downloads");
      }
      return post<TranscriptionModelStatus>(fetcher, baseUrl, "/transcriptions/models/download", {
        provider,
        model,
      });
    },
  };
}

async function get<T>(fetcher: typeof fetch, baseUrl: string, path: string): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function post<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function put<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function analyzeWithLocalGpuFallback(request: AnalyzeSpeechRequest) {
  await tryWarmWebGpu();
  return fallbackAnalyze(request);
}

async function tryWarmWebGpu() {
  const maybeNavigator = globalThis.navigator as NavigatorWithGpu | undefined;
  if (!maybeNavigator?.gpu) {
    return;
  }
  const adapter = await maybeNavigator.gpu.requestAdapter().catch(() => null);
  const device = await adapter?.requestDevice().catch(() => null);
  device?.destroy();
}

function localSpeakerProfile(request: {
  id?: string;
  label: string;
  samples: number[];
  sampleRate: number;
}): SpeakerProfile {
  return {
    id: request.id ?? crypto.randomUUID(),
    label: request.label,
    embeddings: [fallbackEmbedding(request.samples)],
    sampleRate: request.sampleRate,
    sampleCount: request.samples.length,
  };
}

function localSpeakerIdentification(request: {
  samples: number[];
  speakers: SpeakerProfile[];
  threshold?: number;
  maxResults?: number;
}): SpeakerIdentification {
  const current = fallbackEmbedding(request.samples);
  const threshold = request.threshold ?? 0.82;
  const matches = request.speakers
    .map((speaker) => ({
      speakerId: speaker.id,
      label: speaker.label,
      score: Math.max(...speaker.embeddings.map((embedding) => cosine(current, embedding))),
    }))
    .filter((match) => match.score >= threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, request.maxResults ?? 3);
  return { bestMatch: matches[0], matches, isMatch: Boolean(matches[0]) };
}

function normalizeBaseUrl(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}
