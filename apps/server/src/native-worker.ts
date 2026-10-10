import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TranscribeAudioRequest,
  TranscribeAudioResult,
  TranscriptionEngineId,
  TranscriptionModelStatus,
} from "@stutter-tracker/shared";
import type { ServerConfig } from "./config";
import { HttpError } from "./http";

// `signal` aborts the job: the worker process is killed and the call rejects.
export type NativeWorker = {
  transcriptionModels(
    provider: TranscriptionEngineId,
    signal?: AbortSignal,
  ): Promise<{
    provider: TranscriptionEngineId;
    models: TranscriptionModelStatus[];
  }>;
  downloadTranscriptionModel(
    provider: TranscriptionEngineId,
    model: string,
    signal?: AbortSignal,
  ): Promise<TranscriptionModelStatus>;
  transcribeAudio(
    request: TranscribeAudioRequest,
    signal?: AbortSignal,
  ): Promise<TranscribeAudioResult>;
  transcribeAudioFile(
    request: TranscribeAudioFileRequest,
    signal?: AbortSignal,
  ): Promise<TranscribeAudioResult>;
  /** audio-analysis capture observations of analysis audio, as native analysis reports them. */
  captureMetrics(request: CaptureMetricsRequest, signal?: AbortSignal): Promise<unknown>;
};

export type CaptureMetricsRequest = { samples: number[]; sampleRate: number };

export type TranscribeAudioFileRequest = {
  path: string;
  provider: Exclude<TranscriptionEngineId, "browser">;
  model: string;
  language?: string;
  ffmpegBin?: string;
};

type WorkerCommand =
  | {
      command: "transcription-models";
      request: { provider: TranscriptionEngineId };
    }
  | {
      command: "download-transcription-model";
      request: { provider: TranscriptionEngineId; model: string };
    }
  | {
      command: "transcribe-audio";
      request: TranscribeAudioRequest;
    }
  | {
      command: "transcribe-audio-file";
      request: TranscribeAudioFileRequest;
    }
  | {
      command: "capture-metrics";
      request: CaptureMetricsRequest;
    };

const WORKER_KILL_GRACE_MS = 2_000;

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function createNativeWorker(config: ServerConfig): NativeWorker {
  return {
    transcriptionModels(provider, signal) {
      return runWorker(config, { command: "transcription-models", request: { provider } }, signal);
    },
    downloadTranscriptionModel(provider, model, signal) {
      return runWorker(
        config,
        { command: "download-transcription-model", request: { provider, model } },
        signal,
      );
    },
    transcribeAudio(request, signal) {
      return runWorker(config, { command: "transcribe-audio", request }, signal);
    },
    transcribeAudioFile(request, signal) {
      return runWorker(config, { command: "transcribe-audio-file", request }, signal);
    },
    captureMetrics(request, signal) {
      return runWorker(config, { command: "capture-metrics", request }, signal);
    },
  };
}

async function runWorker<T>(
  config: ServerConfig,
  command: WorkerCommand,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw cancelledError();
  }
  const cmd = workerCommand(config);
  const process = Bun.spawn({
    cmd,
    cwd: rootDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so termination reaches ffmpeg/whisper children as well.
    detached: true,
  });
  process.stdin.write(JSON.stringify(command));
  process.stdin.end();

  const timeoutMs =
    command.command === "transcribe-audio" || command.command === "transcribe-audio-file"
      ? 10 * 60 * 1000
      : command.command === "download-transcription-model"
        ? 60 * 60 * 1000
        : 10 * 1000;
  // A terminated job settles only once the process has exited, so the caller's job slot stays
  // held until then; SIGKILL follows if the worker ignores SIGTERM.
  let terminationError: HttpError | null = null;
  const terminate = (error: HttpError) => {
    if (terminationError) {
      return;
    }
    terminationError = error;
    killWorker(process, "SIGTERM");
    const forceKill = setTimeout(() => killWorker(process, "SIGKILL"), WORKER_KILL_GRACE_MS);
    void process.exited.finally(() => clearTimeout(forceKill));
  };
  const timer = setTimeout(
    () =>
      terminate(
        new HttpError("native_worker_unavailable", "native transcription worker timed out", 503),
      ),
    timeoutMs,
  );
  const onAbort = () => terminate(cancelledError());
  signal?.addEventListener("abort", onAbort, { once: true });
  void process.exited.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
  // Once the worker has exited, any descendant still in its group is killed before settling.
  const terminated = process.exited.then(() => {
    if (!terminationError) {
      return new Promise<never>(() => undefined);
    }
    killWorker(process, "SIGKILL");
    return Promise.reject(terminationError);
  });

  const result = await Promise.race([
    Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]),
    terminated,
  ]);
  if (terminationError) {
    throw terminationError;
  }
  const [stdout, stderr, exitCode] = result;
  if (exitCode !== 0) {
    const isTranscription =
      command.command === "transcribe-audio" || command.command === "transcribe-audio-file";
    throw new HttpError(
      isTranscription ? "transcription_failed" : "native_worker_unavailable",
      workerFailureMessage(config, stderr),
      isTranscription ? 422 : 503,
    );
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new HttpError(
      "native_worker_unavailable",
      "native transcription worker returned invalid JSON",
      503,
    );
  }
}

function workerCommand(config: ServerConfig) {
  if (config.nativeWorker) {
    return [config.nativeWorker];
  }
  return [
    "cargo",
    "run",
    "--quiet",
    "--manifest-path",
    resolve(rootDir, "apps/desktop/src-tauri/Cargo.toml"),
    "--bin",
    "compute-worker",
    "--",
  ];
}

// Worker stderr can echo request details, so public-ready clients only get a generic message.
function workerFailureMessage(config: ServerConfig, stderr: string) {
  const message = config.publicReady ? undefined : stderr.trim().split("\n").at(-1)?.trim();
  return message || "native transcription worker failed";
}

// Signals the worker's process group so ffmpeg/whisper children die too. Where group signalling
// is unavailable (Windows) or fails, the direct worker is still signalled.
export function killWorker(
  worker: { pid: number; kill(signal?: NodeJS.Signals): void },
  signal: NodeJS.Signals,
) {
  if (globalThis.process.platform !== "win32") {
    try {
      globalThis.process.kill(-worker.pid, signal);
      return;
    } catch {
      // Fall through to the direct worker.
    }
  }
  try {
    worker.kill(signal);
  } catch {
    // Already exited.
  }
}

function cancelledError() {
  return new HttpError("request_cancelled", "request was cancelled", 499);
}
