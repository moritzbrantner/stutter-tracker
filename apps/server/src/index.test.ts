import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpeakerProfile, TranscribeAudioRequest } from "@stutter-tracker/shared";
import { parseServerConfig, type ServerConfig } from "./config";
import { HttpError } from "./http";
import { createComputeRequestHandler } from "./index";
import type { NativeWorker } from "./native-worker";
import { createSpeakerStore, type SpeakerStore } from "./speakers";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("config", () => {
  it("allows local loopback mode without a token", () => {
    expect(parseServerConfig({ HOST: "127.0.0.1" }).publicReady).toBe(false);
  });

  it("requires an API token in public-ready mode", () => {
    expect(() =>
      parseServerConfig({
        HOST: "0.0.0.0",
        STUTTER_ALLOWED_ORIGINS: "https://app.example.com",
        STUTTER_NATIVE_WORKER: "/bin/worker",
      }),
    ).toThrow("STUTTER_API_TOKEN");
  });

  it("requires allowed origins in public-ready mode", () => {
    expect(() =>
      parseServerConfig({
        HOST: "0.0.0.0",
        STUTTER_API_TOKEN: "secret",
        STUTTER_NATIVE_WORKER: "/bin/worker",
      }),
    ).toThrow("STUTTER_ALLOWED_ORIGINS");
  });
});

describe("request gates", () => {
  it("rejects public-ready requests without authorization", async () => {
    const response = await publicHandler()(
      new Request("http://server/speakers", {
        headers: { origin: "https://app.example.com" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "authorization bearer token is invalid",
      },
    });
  });

  it("rejects disallowed origins", async () => {
    const response = await publicHandler()(
      new Request("http://server/speakers", {
        headers: {
          authorization: "Bearer secret",
          origin: "https://evil.example.com",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect((await responseJson<{ error: { code: string } }>(response)).error.code).toBe(
      "forbidden_origin",
    );
  });

  it("uses the concrete allowed origin instead of wildcard CORS", async () => {
    const response = await publicHandler()(
      new Request("http://server/speakers", {
        headers: {
          authorization: "Bearer secret",
          origin: "https://app.example.com",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("rejects oversized bodies before route handling", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig({ maxBodyBytes: 8 }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const response = await handler(
      new Request("http://server/analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: [], pauses: [] }),
      }),
    );

    expect(response.status).toBe(413);
    expect((await responseJson<{ error: { code: string } }>(response)).error.code).toBe(
      "request_too_large",
    );
  });
});

describe("speaker persistence", () => {
  it("persists speakers without Postgres using a non-destructive file store", async () => {
    const dir = await tempDir();
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: createSpeakerStore({ filePath: join(dir, "speakers.json") }),
      nativeWorker: fakeWorker(),
    });

    await putSpeakers(handler, [speaker("a", "Alpha")]);
    await putSpeakers(handler, [speaker("b", "Beta")]);
    const response = await handler(new Request("http://server/speakers"));

    expect(response.status).toBe(200);
    expect(
      (await responseJson<{ speakers: SpeakerProfile[] }>(response)).speakers.map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("transcription worker routes", () => {
  it("returns invalid_request for malformed transcription requests", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const response = await postJson(handler, "/transcriptions", {
      provider: "browser",
      model: "default",
      samples: [0, 1],
      sampleRate: 16_000,
    });

    expect(response.status).toBe(400);
    expect((await responseJson<{ error: { code: string } }>(response)).error.code).toBe(
      "invalid_request",
    );
  });

  it("calls the worker for model statuses", async () => {
    const worker = fakeWorker();
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: memorySpeakerStore(),
      nativeWorker: worker,
    });
    const response = await postJson(handler, "/transcriptions/models", {
      provider: "whisperCpp",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "whisperCpp",
      models: [{ id: "tiny.en", label: "tiny.en", cached: true, downloadable: true }],
    });
  });

  it("returns worker transcription segments", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const response = await postJson(handler, "/transcriptions", {
      provider: "whisperCpp",
      model: "tiny.en",
      samples: Array.from({ length: 8_000 }, () => 0),
      sampleRate: 16_000,
    } satisfies TranscribeAudioRequest);

    expect(response.status).toBe(200);
    expect((await responseJson<{ segments: unknown[] }>(response)).segments).toEqual([
      { text: "hello", startSeconds: 0, endSeconds: 0.5, isFinal: true },
    ]);
  });

  it("maps worker failures to structured errors", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: memorySpeakerStore(),
      nativeWorker: {
        ...fakeWorker(),
        async transcriptionModels() {
          throw new HttpError("native_worker_unavailable", "worker missing", 503);
        },
      },
    });
    const response = await postJson(handler, "/transcriptions/models", {
      provider: "whisperCpp",
    });

    expect(response.status).toBe(503);
    expect((await responseJson<{ error: { code: string } }>(response)).error.code).toBe(
      "native_worker_unavailable",
    );
  });
});

function publicHandler() {
  return createComputeRequestHandler({
    config: localConfig({
      publicReady: true,
      apiToken: "secret",
      allowedOrigins: ["https://app.example.com"],
      nativeWorker: "/bin/worker",
    }),
    speakerStore: memorySpeakerStore(),
    nativeWorker: fakeWorker(),
  });
}

function localConfig(patch: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    publicReady: false,
    apiToken: "",
    allowedOrigins: [],
    maxBodyBytes: 25 * 1024 * 1024,
    speakerStorePath: ".stutter-tracker/server-speakers.json",
    ...patch,
  };
}

function fakeWorker(): NativeWorker {
  return {
    async transcriptionModels(provider) {
      return {
        provider,
        models: [{ id: "tiny.en", label: "tiny.en", cached: true, downloadable: true }],
      };
    },
    async downloadTranscriptionModel(_provider, model) {
      return { id: model, label: model, cached: true, downloadable: true };
    },
    async transcribeAudio(request) {
      return {
        text: "hello",
        language: request.language,
        provider: request.provider,
        model: request.model,
        segments: [{ text: "hello", startSeconds: 0, endSeconds: 0.5, isFinal: true }],
      };
    },
  };
}

function memorySpeakerStore(): SpeakerStore {
  let speakers: SpeakerProfile[] = [];
  return {
    deleteMissing: false,
    async list() {
      return speakers;
    },
    async upsertMany(next) {
      const byId = new Map(speakers.map((item) => [item.id, item]));
      for (const item of next) {
        byId.set(item.id, item);
      }
      speakers = [...byId.values()];
      return speakers;
    },
  };
}

function speaker(id: string, label: string): SpeakerProfile {
  return {
    id,
    label,
    embeddings: [[1, 0, 0]],
    sampleRate: 16_000,
    sampleCount: 16_000,
  };
}

async function putSpeakers(
  handler: ReturnType<typeof createComputeRequestHandler>,
  speakers: SpeakerProfile[],
) {
  const response = await postJson(handler, "/speakers", { speakers }, "PUT");
  expect(response.status).toBe(200);
}

function postJson(
  handler: ReturnType<typeof createComputeRequestHandler>,
  path: string,
  body: unknown,
  method = "POST",
) {
  return handler(
    new Request(`http://server${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "stutter-server-test-"));
  tempDirs.push(dir);
  return dir;
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
