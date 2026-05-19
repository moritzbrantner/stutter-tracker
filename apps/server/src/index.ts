import {
  type AnalyzeSpeechRequest,
  type SpeakerProfile,
  type TranscribeAudioRequest,
  type TranscriptionEngineId,
  cosine,
  fallbackAnalyze,
  fallbackEmbedding,
  staticModelStatuses,
} from "@stutter-tracker/shared";
import { timingSafeEqual } from "node:crypto";
import { parseServerConfig, type ServerConfig } from "./config";
import { errorResponse, HttpError, jsonResponse, readJson, type ResponseHeaders } from "./http";
import { createNativeWorker, type NativeWorker } from "./native-worker";
import { createSpeakerStore, type SpeakerStore } from "./speakers";
import {
  validateAnalyzeSpeechRequest,
  validateCreateSpeakerProfileRequest,
  validateDownloadModelRequest,
  validateIdentifySpeakerRequest,
  validateSpeakerProfilesBody,
  validateTranscribeAudioRequest,
  validateTranscriptionModelsRequest,
} from "./validation";

export type ComputeServerDeps = {
  config: ServerConfig;
  speakerStore: SpeakerStore;
  nativeWorker: NativeWorker;
};

export function createComputeRequestHandler(deps: ComputeServerDeps) {
  return async function fetch(request: Request): Promise<Response> {
    const cors = corsHeaders(deps.config, request);
    if (cors instanceof Response) {
      return cors;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      authorize(deps.config, request);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(
          deps.config.publicReady ? { ok: true } : { ok: true, service: "stutter-tracker-compute" },
          200,
          cors,
        );
      }

      if (request.method === "POST" && url.pathname === "/analysis") {
        const body = validateAnalyzeSpeechRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse(fallbackAnalyze(body), 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/speakers") {
        return jsonResponse({ speakers: await deps.speakerStore.list() }, 200, cors);
      }

      if (request.method === "PUT" && url.pathname === "/speakers") {
        const speakers = validateSpeakerProfilesBody(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse({ speakers: await deps.speakerStore.upsertMany(speakers) }, 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/speakers/profile") {
        const body = validateCreateSpeakerProfileRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse(createSpeakerProfile(body), 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/speakers/identify") {
        const body = validateIdentifySpeakerRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse(identifySpeaker(body), 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/transcriptions/models") {
        const body = validateTranscriptionModelsRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        if (body.provider === "browser") {
          return jsonResponse(
            { provider: body.provider, models: staticModelStatuses(body.provider) },
            200,
            cors,
          );
        }
        return jsonResponse(await deps.nativeWorker.transcriptionModels(body.provider), 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/transcriptions") {
        const body = validateTranscribeAudioRequest(
          await readJson(request, deps.config.maxBodyBytes),
          Math.floor(deps.config.maxBodyBytes / 4),
        );
        return jsonResponse(await deps.nativeWorker.transcribeAudio(body), 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/transcriptions/models/download") {
        const body = validateDownloadModelRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse(
          await deps.nativeWorker.downloadTranscriptionModel(body.provider, body.model),
          200,
          cors,
        );
      }

      return errorResponse("not_found", "not found", 404, cors);
    } catch (error) {
      return handleError(deps.config, error, cors);
    }
  };
}

export function startComputeServer(config = parseServerConfig()) {
  const speakerStore = createSpeakerStore({
    databaseUrl: config.databaseUrl,
    filePath: config.speakerStorePath,
  });
  const nativeWorker = createNativeWorker(config);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createComputeRequestHandler({ config, speakerStore, nativeWorker }),
  });
  console.log(`stutter-tracker compute server listening on http://${config.host}:${server.port}`);
  if (!config.databaseUrl) {
    console.warn(`DATABASE_URL is not set; speaker profiles use ${config.speakerStorePath}`);
  }
  if (!config.nativeWorker) {
    console.warn("STUTTER_NATIVE_WORKER is not set; using cargo-run native worker fallback.");
  }
  return server;
}

if (import.meta.main) {
  startComputeServer();
}

function createSpeakerProfile(body: {
  id?: string;
  label: string;
  samples: number[];
  sampleRate: number;
}): SpeakerProfile {
  return {
    id: body.id ?? crypto.randomUUID(),
    label: body.label.trim() || "Speaker",
    embeddings: [fallbackEmbedding(body.samples)],
    sampleRate: body.sampleRate,
    sampleCount: body.samples.length,
  };
}

function identifySpeaker(body: {
  samples: number[];
  speakers: SpeakerProfile[];
  threshold?: number;
  maxResults?: number;
}) {
  const current = fallbackEmbedding(body.samples);
  const matches = body.speakers
    .map((speaker) => ({
      speakerId: speaker.id,
      label: speaker.label,
      score: Math.max(...speaker.embeddings.map((embedding) => cosine(current, embedding))),
    }))
    .filter((match) => match.score >= (body.threshold ?? 0.82))
    .sort((left, right) => right.score - left.score)
    .slice(0, body.maxResults ?? 3);
  return { bestMatch: matches[0], matches, isMatch: Boolean(matches[0]) };
}

function corsHeaders(config: ServerConfig, request: Request): ResponseHeaders | Response {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    vary: "Origin",
  };
  if (!origin) {
    return headers;
  }

  const allowed =
    config.allowedOrigins.includes(origin) ||
    (!config.publicReady && config.allowedOrigins.includes("*")) ||
    (!config.publicReady && config.allowedOrigins.length === 0);
  if (!allowed) {
    return errorResponse("forbidden_origin", "origin is not allowed", 403, headers);
  }

  return {
    ...headers,
    "access-control-allow-origin": origin,
  };
}

function authorize(config: ServerConfig, request: Request) {
  const url = new URL(request.url);
  if (!config.publicReady || (request.method === "GET" && url.pathname === "/health")) {
    return;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (
    !authorization.startsWith(prefix) ||
    !tokenEquals(authorization.slice(prefix.length), config.apiToken)
  ) {
    throw new HttpError("unauthorized", "authorization bearer token is invalid", 401);
  }
}

function tokenEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function handleError(config: ServerConfig, error: unknown, headers: ResponseHeaders) {
  if (error instanceof HttpError) {
    return errorResponse(error.code, error.message, error.status, headers);
  }
  const message = config.publicReady
    ? "internal server error"
    : error instanceof Error
      ? error.message
      : String(error);
  return errorResponse("internal_error", message, 500, headers);
}

export type { AnalyzeSpeechRequest, TranscribeAudioRequest, TranscriptionEngineId };
