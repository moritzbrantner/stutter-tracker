import {
  type AnalysisReport,
  type AnalyzerIdentity,
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
  SHARED_ANALYSIS_VERSION,
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

/**
 * Where speech content (audio, transcripts, voiceprints) may be processed.
 * - onDevice: never contacts a server.
 * - localCompanion: a server on this device's loopback address only.
 * - remote: any other server, and only with explicit consent for remote analysis.
 * There is no automatic escalation between modes; server failures fall back to on-device.
 */
export type ProcessingPolicy =
  | { mode: "onDevice" }
  | { mode: "localCompanion"; serverUrl: string }
  | { mode: "remote"; serverUrl: string; remoteAnalysisConsent: boolean };

export type ProcessingDestination =
  | { kind: "onDevice"; label: string }
  | { kind: "server"; mode: "localCompanion" | "remote"; url: string; label: string }
  | { kind: "blocked"; label: string; reason: string; needsRemoteConsent?: boolean };

export const ON_DEVICE_POLICY: ProcessingPolicy = { mode: "onDevice" };

export function resolveProcessingDestination(policy: ProcessingPolicy): ProcessingDestination {
  if (policy.mode === "onDevice") {
    return { kind: "onDevice", label: "On this device only" };
  }
  const url = normalizeBaseUrl(policy.serverUrl);
  if (!url || !parseHttpUrl(url)) {
    return {
      kind: "blocked",
      label: "No valid server",
      reason: "The server URL is not a valid http(s) URL.",
    };
  }
  if (policy.mode === "localCompanion") {
    if (!isLoopbackUrl(url)) {
      return {
        kind: "blocked",
        label: `Blocked: ${url} is not on this device`,
        reason:
          "A local companion must use a loopback address. Choose remote processing and consent to use another server.",
      };
    }
    return { kind: "server", mode: "localCompanion", url, label: `Local companion at ${url}` };
  }
  if (!policy.remoteAnalysisConsent) {
    return {
      kind: "blocked",
      label: `Remote server ${url} needs your consent`,
      reason: "Recordings and transcripts are only sent to a remote server after you consent.",
      needsRemoteConsent: true,
    };
  }
  return { kind: "server", mode: "remote", url, label: `Remote server at ${url}` };
}

/** Proposes a policy for a user-entered URL: loopback is a local companion, anything else is remote. */
export function processingPolicyForServerUrl(
  serverUrl: string,
  remoteAnalysisConsent: boolean,
): ProcessingPolicy {
  const url = normalizeBaseUrl(serverUrl);
  if (!url) {
    return ON_DEVICE_POLICY;
  }
  return isLoopbackUrl(url)
    ? { mode: "localCompanion", serverUrl: url }
    : { mode: "remote", serverUrl: url, remoteAnalysisConsent };
}

export function isLoopbackUrl(value: string) {
  const url = parseHttpUrl(value);
  if (!url) {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export type ComputeClientOptions = {
  /** Defaults to on-device processing. */
  processingPolicy?: ProcessingPolicy;
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
  /** Fixed for the client's lifetime; a new destination requires a new client. */
  readonly destination: ProcessingDestination;
  analyzeSpeechSession(request: AnalyzeSpeechRequest): Promise<AnalysisReport>;
  /** Like `analyzeSpeechSession`, and also says which analyzer produced the report. */
  analyzeSpeechSessionRun(request: AnalyzeSpeechRequest): Promise<AnalyzedSpeech>;
  listSpeakerProfiles(): Promise<SpeakerProfile[]>;
  saveSpeakerProfiles(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]>;
  /**
   * Deletes a voiceprint on the server. Resolves "deleted", "notFound" (already gone), or
   * "noServer" when no server is currently permitted. A server used under earlier
   * consent may still hold a copy; this result makes no claim about past uploads.
   */
  deleteSpeakerProfile(id: string): Promise<"deleted" | "notFound" | "noServer">;
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
  const destination = resolveProcessingDestination(options.processingPolicy ?? ON_DEVICE_POLICY);
  const baseUrl = destination.kind === "server" ? destination.url : "";
  const headers = requestHeaders(options.apiToken);
  const serverRequired = (what: string) =>
    new Error(
      destination.kind === "blocked"
        ? `${what} needs a server: ${destination.reason}`
        : `${what} needs a configured compute server; processing is set to this device only`,
    );

  const analyzeSpeechSessionRun = async (request: AnalyzeSpeechRequest) => {
    if (baseUrl) {
      try {
        const response = await postResponse(fetcher, baseUrl, "/analysis", request, headers);
        return {
          report: (await response.json()) as AnalysisReport,
          analyzer: serverAnalyzer(response.headers),
        };
      } catch {
        return analyzeWithLocalGpuFallback(request);
      }
    }
    return analyzeWithLocalGpuFallback(request);
  };

  return {
    destination,
    async analyzeSpeechSession(request) {
      return (await analyzeSpeechSessionRun(request)).report;
    },
    analyzeSpeechSessionRun,
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
    async deleteSpeakerProfile(id) {
      if (!baseUrl) {
        return "noServer";
      }
      const path = `/speakers?id=${encodeURIComponent(id)}`;
      const response = await fetcher(`${baseUrl}${path}`, {
        redirect: "error",
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) {
        // Only the endpoint's own answer means "already gone"; an older server without the route
        // also returns 404, and then the voiceprint is still there.
        const code = await response
          .clone()
          .json()
          .then((body: { error?: { code?: string } }) => body.error?.code)
          .catch(() => undefined);
        if (code === "speaker_not_found") {
          return "notFound";
        }
      }
      await assertOk(response, path);
      return "deleted";
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
        throw serverRequired("Transcription");
      }
      return post<TranscribeAudioResult>(fetcher, baseUrl, "/transcriptions", request, headers);
    },
    async transcribeAudioFile(request) {
      if (!baseUrl) {
        throw serverRequired("Transcription");
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
        throw serverRequired("Model download");
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
  const response = await fetcher(`${baseUrl}${path}`, { headers, redirect: "error" });
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
  const response = await postResponse(fetcher, baseUrl, path, body, extraHeaders);
  return (await response.json()) as T;
}

async function postResponse(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown,
  extraHeaders: HeadersInit,
): Promise<Response> {
  // Redirects could move speech content to a destination the policy did not approve.
  const response = await fetcher(`${baseUrl}${path}`, {
    redirect: "error",
    method: "POST",
    headers: {
      ...extraHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await assertOk(response, path);
  return response;
}

async function postForm<T>(
  fetcher: typeof fetch,
  baseUrl: string,
  path: string,
  body: FormData,
  extraHeaders: HeadersInit,
): Promise<T> {
  // Redirects could move speech content to a destination the policy did not approve.
  const response = await fetcher(`${baseUrl}${path}`, {
    redirect: "error",
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
  // Redirects could move speech content to a destination the policy did not approve.
  const response = await fetcher(`${baseUrl}${path}`, {
    redirect: "error",
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

export type AnalyzedSpeech = { report: AnalysisReport; analyzer: AnalyzerIdentity };

export const ON_DEVICE_ANALYZER: AnalyzerIdentity = {
  producer: "onDevice",
  algorithm: "shared-fallback",
  version: SHARED_ANALYSIS_VERSION,
};

/** Used when a server does not report its analyzer (older servers); the version stays unknown. */
export const COMPUTE_SERVER_ANALYZER: AnalyzerIdentity = {
  producer: "computeServer",
  algorithm: "compute-server",
  version: null,
};

function serverAnalyzer(headers: Headers): AnalyzerIdentity {
  return {
    producer: "computeServer",
    algorithm: headers.get("x-analyzer-algorithm") ?? COMPUTE_SERVER_ANALYZER.algorithm,
    version: headers.get("x-analyzer-version"),
  };
}

async function analyzeWithLocalGpuFallback(request: AnalyzeSpeechRequest): Promise<AnalyzedSpeech> {
  await tryWarmWebGpu();
  return { report: fallbackAnalyze(request), analyzer: ON_DEVICE_ANALYZER };
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
