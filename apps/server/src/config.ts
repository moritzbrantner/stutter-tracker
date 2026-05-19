import { tmpdir } from "node:os";
import { resolve } from "node:path";

export type ServerConfig = {
  host: string;
  port: number;
  publicReady: boolean;
  apiToken: string;
  allowedOrigins: string[];
  maxBodyBytes: number;
  maxAudioBytes: number;
  uploadTmpDir: string;
  ffmpegBin: string;
  nativeWorker?: string;
  databaseUrl?: string;
  speakerStorePath: string;
};

export type EnvLike = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseServerConfig(env: EnvLike = Bun.env): ServerConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = positivePort(env.PORT ?? "8787");
  const forcedPublic = env.STUTTER_PUBLIC_READY === "1";
  const publicReady = forcedPublic || env.NODE_ENV === "production" || !LOOPBACK_HOSTS.has(host);
  const apiToken = env.STUTTER_API_TOKEN?.trim() ?? "";
  const allowedOrigins = parseOrigins(env.STUTTER_ALLOWED_ORIGINS);
  const maxBodyBytes = parseByteSize(env.STUTTER_MAX_BODY_BYTES ?? "25mb");
  const maxAudioBytes = parseByteSize(
    env.STUTTER_MAX_AUDIO_BYTES ?? "50mb",
    "STUTTER_MAX_AUDIO_BYTES",
  );
  const uploadTmpDir = env.STUTTER_UPLOAD_TMP_DIR?.trim() || tmpdir();
  const ffmpegBin = env.STUTTER_FFMPEG_BIN?.trim() || "ffmpeg";
  const nativeWorker = env.STUTTER_NATIVE_WORKER?.trim() || undefined;
  const databaseUrl = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || undefined;
  const speakerStorePath =
    env.STUTTER_SPEAKER_STORE_PATH?.trim() || resolve(".stutter-tracker/server-speakers.json");

  if (publicReady) {
    if (!apiToken) {
      throw new Error("STUTTER_API_TOKEN is required in public-ready mode");
    }
    if (!allowedOrigins.length) {
      throw new Error("STUTTER_ALLOWED_ORIGINS is required in public-ready mode");
    }
    if (allowedOrigins.includes("*")) {
      throw new Error("STUTTER_ALLOWED_ORIGINS cannot include `*` in public-ready mode");
    }
    if (!nativeWorker) {
      throw new Error("STUTTER_NATIVE_WORKER is required in public-ready mode");
    }
  }

  return {
    host,
    port,
    publicReady,
    apiToken,
    allowedOrigins,
    maxBodyBytes,
    maxAudioBytes,
    uploadTmpDir,
    ffmpegBin,
    nativeWorker,
    databaseUrl,
    speakerStorePath,
  };
}

export function isLoopbackHost(host: string) {
  return LOOPBACK_HOSTS.has(host);
}

function positivePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid PORT \`${value}\``);
  }
  return port;
}

function parseOrigins(value?: string) {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseByteSize(value: string, envName = "STUTTER_MAX_BODY_BYTES") {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`invalid ${envName} \`${value}\``);
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "b";
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  const bytes = Math.floor(amount * multiplier);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`${envName} must be greater than zero`);
  }
  return bytes;
}
