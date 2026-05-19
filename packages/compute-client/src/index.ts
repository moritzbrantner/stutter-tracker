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
  apiToken?: string;
  fetchImpl?: typeof fetch;
};

export type TranscribeAudioSamplesRequest = TranscribeAudioRequest;

export type TranscribeAudioFileRequest = {
  file: Blob;
  filename: string;
  mimeType: string;
  provider: Exclude<TranscriptionEngineId, "browser">;
  model: string;
  language?: string;
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
  transcribeAudio(request: TranscribeAudioSamplesRequest): Promise<TranscribeAudioResult>;
  transcribeAudioFile(request: TranscribeAudioFileRequest): Promise<TranscribeAudioResult>;
  downloadTranscriptionModel(
    provider: TranscriptionEngineId,
    model: string,
  ): Promise<TranscriptionModelStatus>;
};

export function createComputeClient(options: ComputeClientOptions = {}): ComputeClient {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.serverUrl);
  const headers = requestHeaders(options.apiToken);

  return {
    async analyzeSpeechSession(request) {
      if (baseUrl) {
        try {
          return await post<AnalysisReport>(fetcher, baseUrl, "/analysis", request, headers);
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
      const result = await get<{ speakers: SpeakerProfile[] }>(
        fetcher,
        baseUrl,
        "/speakers",
        headers,
      );
      return result.speakers;
    },
    async saveSpeakerProfiles(speakers) {
      if (!baseUrl) {
        return speakers;
      }
      const result = await put<{ speakers: SpeakerProfile[] }>(
        fetcher,
        baseUrl,
        "/speakers",
        {
          speakers,
        },
        headers,
      );
      return result.speakers;
    },
    async createSpeakerProfile(request) {
      if (baseUrl) {
        try {
          return await post<SpeakerProfile>(
            fetcher,
            baseUrl,
            "/speakers/profile",
            request,
            headers,
          );
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
          return await post<SpeakerIdentification>(
            fetcher,
            baseUrl,
            "/speakers/identify",
            request,
            headers,
          );
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
            headers,
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
      return post<TranscribeAudioResult>(fetcher, baseUrl, "/transcriptions", request, headers);
    },
    async transcribeAudioFile(request) {
      if (!baseUrl) {
        throw new Error("external compute server is required for mobile transcription");
      }
      const formData = new FormData();
      const file =
        request.file.type === request.mimeType
          ? request.file
          : request.file.slice(0, request.file.size, request.mimeType);
      formData.append("audio", file, request.filename);
      formData.append("provider", request.provider);
      formData.append("model", request.model);
      if (request.language) {
        formData.append("language", request.language);
      }
      return postForm<TranscribeAudioResult>(
        fetcher,
        baseUrl,
        "/transcriptions/file",
        formData,
        headers,
      );
    },
    async downloadTranscriptionModel(provider, model) {
      if (!baseUrl) {
        throw new Error("external compute server is required for model downloads");
      }
      return post<TranscriptionModelStatus>(
        fetcher,
        baseUrl,
        "/transcriptions/models/download",
        {
          provider,
          model,
        },
        headers,
      );
    },
  };
}

async function get<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  headers: HeadersInit,
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, { headers });
  await assertOk(response, path);
  return (await response.json()) as T;
}

async function post<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown,
  extraHeaders: HeadersInit,
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...extraHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await assertOk(response, path);
  return (await response.json()) as T;
}

async function postForm<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: FormData,
  extraHeaders: HeadersInit,
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    method: "POST",
    headers: extraHeaders,
    body,
  });
  await assertOk(response, path);
  return (await response.json()) as T;
}

async function put<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown,
  extraHeaders: HeadersInit,
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    method: "PUT",
    headers: {
      ...extraHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await assertOk(response, path);
  return (await response.json()) as T;
}

async function assertOk(response: Response, path: string) {
  if (response.ok) {
    return;
  }
  const fallback = `${path} failed with ${response.status}`;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    const code = payload.error?.code;
    const message = payload.error?.message;
    throw new Error(code && message ? `${code}: ${message}` : message || fallback);
  } catch (error) {
    if (error instanceof Error && error.message !== "Unexpected end of JSON input") {
      throw error;
    }
    throw new Error(fallback);
  }
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

function requestHeaders(apiToken?: string): HeadersInit {
  const token = apiToken?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}
