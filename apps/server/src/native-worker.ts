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

export type NativeWorker = {
  transcriptionModels(provider: TranscriptionEngineId): Promise<{
    provider: TranscriptionEngineId;
    models: TranscriptionModelStatus[];
  }>;
  downloadTranscriptionModel(
    provider: TranscriptionEngineId,
    model: string,
  ): Promise<TranscriptionModelStatus>;
  transcribeAudio(request: TranscribeAudioRequest): Promise<TranscribeAudioResult>;
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
    };

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function createNativeWorker(config: ServerConfig): NativeWorker {
  return {
    transcriptionModels(provider) {
      return runWorker(config, {
        command: "transcription-models",
        request: { provider },
      });
    },
    downloadTranscriptionModel(provider, model) {
      return runWorker(config, {
        command: "download-transcription-model",
        request: { provider, model },
      });
    },
    transcribeAudio(request) {
      return runWorker(config, {
        command: "transcribe-audio",
        request,
      });
    },
  };
}

async function runWorker<T>(config: ServerConfig, command: WorkerCommand): Promise<T> {
  const cmd = workerCommand(config);
  const process = Bun.spawn({
    cmd,
    cwd: rootDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(JSON.stringify(command));
  process.stdin.end();

  const timeoutMs =
    command.command === "transcribe-audio"
      ? 10 * 60 * 1000
      : command.command === "download-transcription-model"
        ? 60 * 60 * 1000
        : 10 * 1000;
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      process.kill();
      reject(
        new HttpError("native_worker_unavailable", "native transcription worker timed out", 503),
      );
    }, timeoutMs);
    process.exited.finally(() => clearTimeout(timer));
  });

  const result = await Promise.race([
    Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]),
    timeout,
  ]);
  const [stdout, stderr, exitCode] = result;
  if (exitCode !== 0) {
    throw new HttpError(
      command.command === "transcribe-audio" ? "transcription_failed" : "native_worker_unavailable",
      publicWorkerMessage(stderr),
      command.command === "transcribe-audio" ? 422 : 503,
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

function publicWorkerMessage(stderr: string) {
  const message = stderr.trim().split("\n").at(-1)?.trim();
  return message || "native transcription worker failed";
}
