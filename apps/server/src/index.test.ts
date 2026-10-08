import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SHARED_ANALYSIS_VERSION,
  type SpeakerProfile,
  type TranscribeAudioRequest,
} from "@stutter-tracker/shared";
import { parseServerConfig, type ServerConfig } from "./config";
import { HttpError } from "./http";
import { createComputeRequestHandler, withWorkerTimeouts } from "./index";
import { createNativeWorker, killWorker, type NativeWorker } from "./native-worker";
import { createSpeakerStore, PostgresSpeakerStore, type SpeakerStore } from "./speakers";

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

  it("parses STUTTER_MAX_AUDIO_BYTES", () => {
    expect(
      parseServerConfig({
        HOST: "127.0.0.1",
        STUTTER_MAX_AUDIO_BYTES: "1kb",
      }).maxAudioBytes,
    ).toBe(1024);
  });

  it("parses STUTTER_MAX_CONCURRENT_JOBS and rejects non-positive values", () => {
    expect(parseServerConfig({ HOST: "127.0.0.1" }).maxConcurrentJobs).toBe(2);
    expect(
      parseServerConfig({ HOST: "127.0.0.1", STUTTER_MAX_CONCURRENT_JOBS: "4" }).maxConcurrentJobs,
    ).toBe(4);
    expect(() =>
      parseServerConfig({ HOST: "127.0.0.1", STUTTER_MAX_CONCURRENT_JOBS: "0" }),
    ).toThrow("STUTTER_MAX_CONCURRENT_JOBS");
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

  it("protects file transcription with public-ready authorization and CORS", async () => {
    const form = new FormData();
    form.append("audio", new File(["audio"], "input.wav", { type: "audio/wav" }));
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    const response = await publicHandler()(
      new Request("http://server/transcriptions/file", {
        method: "POST",
        headers: { origin: "https://app.example.com" },
        body: form,
      }),
    );

    expect(response.status).toBe(401);
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

describe("streamed body limits", () => {
  it("stops reading an endless chunked JSON body once it exceeds the limit", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig({ maxBodyBytes: 1024 }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const response = await handler(
      new Request("http://server/analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunkedBody(Number.POSITIVE_INFINITY, 512),
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
  });

  it("bounds the whole multipart body, not just the audio part", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig({ maxAudioBytes: 1024 }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const form = new FormData();
    form.append("audio", new File(["audio"], "input.wav", { type: "audio/wav" }));
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    form.append("padding", "x".repeat(256 * 1024));
    const multipart = new Response(form);
    const response = await handler(
      new Request("http://server/transcriptions/file", {
        method: "POST",
        headers: { "content-type": multipart.headers.get("content-type") ?? "" },
        body: multipart.body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
  });
});

describe("worker route timeouts", () => {
  it("lifts the idle timeout only once a worker starts, after the body was read", async () => {
    const events: string[] = [];
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: memorySpeakerStore(),
      nativeWorker: {
        ...fakeWorker(),
        async transcribeAudio(request) {
          events.push("worker");
          return fakeWorker().transcribeAudio(request);
        },
      },
    });
    const workerStarting = () => events.push("timeout lifted");
    const post = (path: string, body: unknown) =>
      handler(
        new Request(`http://server${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { workerStarting },
      );

    await post("/transcriptions", transcribeBody());
    await post("/transcriptions", { provider: "whisperCpp" });
    await post("/transcriptions/models", { provider: "browser" });
    await post("/analysis", { segments: [], pauses: [] });

    expect(events).toEqual(["timeout lifted", "worker"]);
  });

  it("wires the lift to Bun's per-request timeout", async () => {
    const timeout = mock((_request: Request, _seconds: number) => undefined);
    const request = new Request("http://server/transcriptions", { method: "POST" });
    await withWorkerTimeouts(async (_request, hooks) => {
      hooks.workerStarting?.();
      return new Response("ok");
    })(request, { timeout });

    expect(timeout.mock.calls).toEqual([[request, 0]]);
  });

  it("rejects a busy worker route before reading its body", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = createComputeRequestHandler({
      config: localConfig({ maxConcurrentJobs: 1 }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: {
        ...fakeWorker(),
        async transcribeAudio(request) {
          await blocked;
          return fakeWorker().transcribeAudio(request);
        },
      },
    });
    const first = postJson(handler, "/transcriptions", transcribeBody());

    const busy = await handler(
      new Request("http://server/transcriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunkedBody(Number.POSITIVE_INFINITY, 512),
        duplex: "half",
      } as RequestInit),
    );

    expect(busy.status).toBe(503);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("speaker deletion", () => {
  it("deletes one and then all voiceprints from the file store", async () => {
    const dir = await tempDir();
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: createSpeakerStore({ filePath: join(dir, "speakers.json") }),
      nativeWorker: fakeWorker(),
    });
    await putSpeakers(handler, [
      speaker("a", "Alpha"),
      speaker("b", "Beta"),
      speaker("c", "Gamma"),
    ]);

    const one = await handler(new Request("http://server/speakers/b", { method: "DELETE" }));
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ deleted: 1 });
    const missing = await handler(new Request("http://server/speakers/b", { method: "DELETE" }));
    expect(missing.status).toBe(404);

    const listed = await handler(new Request("http://server/speakers"));
    expect(
      (await responseJson<{ speakers: SpeakerProfile[] }>(listed)).speakers.map((item) => item.id),
    ).toEqual(["a", "c"]);

    const all = await handler(new Request("http://server/speakers", { method: "DELETE" }));
    expect(await all.json()).toEqual({ deleted: 2 });
    const empty = await handler(new Request("http://server/speakers"));
    expect((await responseJson<{ speakers: SpeakerProfile[] }>(empty)).speakers).toEqual([]);
  });

  it("requires authorization to delete in public-ready mode and allows DELETE in CORS", async () => {
    const response = await publicHandler()(
      new Request("http://server/speakers/a", {
        method: "DELETE",
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(response.status).toBe(401);
    const preflight = await publicHandler()(
      new Request("http://server/speakers/a", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("issues parameterized deletes in the Postgres store", async () => {
    const queries: { text: string; values: unknown[] }[] = [];
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      queries.push({ text, values });
      return Promise.resolve(text.startsWith("delete") ? [{ id: "a" }] : []);
    }) as unknown as ConstructorParameters<typeof PostgresSpeakerStore>[0];
    const store = new PostgresSpeakerStore(fakeSql);

    expect(await store.delete("a")).toBe(true);
    expect(await store.deleteAll()).toBe(1);
    expect(queries.filter((query) => query.text.startsWith("delete"))).toEqual([
      { text: "delete from known_speakers where id = ? returning id", values: ["a"] },
      { text: "delete from known_speakers returning id", values: [] },
    ]);
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

  it("reports the analyzer that produced an analysis and exposes it to browsers", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig({ allowedOrigins: ["https://app.example.com"] }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const response = await handler(
      new Request("http://server/analysis", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.com" },
        body: JSON.stringify({ segments: [], pauses: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-analyzer-algorithm")).toBe("shared-fallback");
    expect(response.headers.get("x-analyzer-version")).toBe(SHARED_ANALYSIS_VERSION);
    expect(response.headers.get("access-control-expose-headers")).toContain("x-analyzer-version");
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

  it("returns invalid_request when multipart upload has no audio file", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig(),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const form = new FormData();
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    const response = await postForm(handler, "/transcriptions/file", form);

    expect(response.status).toBe(400);
    expect((await responseJson<{ error: { code: string } }>(response)).error.code).toBe(
      "invalid_request",
    );
  });

  it("rejects oversized multipart uploads", async () => {
    const handler = createComputeRequestHandler({
      config: localConfig({ maxAudioBytes: 4 }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: fakeWorker(),
    });
    const form = new FormData();
    form.append("audio", new File(["too-large"], "input.wav", { type: "audio/wav" }));
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    const response = await postForm(handler, "/transcriptions/file", form);

    expect(response.status).toBe(413);
    expect((await responseJson<{ error: { code: string } }>(response)).error.code).toBe(
      "request_too_large",
    );
  });

  it("calls the worker for multipart upload and cleans temp files after success", async () => {
    const uploadTmpDir = await tempDir();
    let workerPath = "";
    const worker: NativeWorker = {
      ...fakeWorker(),
      async transcribeAudioFile(request) {
        workerPath = request.path;
        return {
          text: "uploaded",
          language: request.language,
          provider: request.provider,
          model: request.model,
          segments: [{ text: "uploaded", startSeconds: 0, endSeconds: 0.5, isFinal: true }],
        };
      },
    };
    const handler = createComputeRequestHandler({
      config: localConfig({ uploadTmpDir }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: worker,
    });
    const form = new FormData();
    form.append("audio", new File(["audio"], "input.m4a", { type: "audio/mp4" }));
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    form.append("language", "en-US");
    const response = await postForm(handler, "/transcriptions/file", form);

    expect(response.status).toBe(200);
    expect(workerPath).toContain(uploadTmpDir);
    expect((await responseJson<{ segments: unknown[] }>(response)).segments).toEqual([
      { text: "uploaded", startSeconds: 0, endSeconds: 0.5, isFinal: true },
    ]);
    expect(await readdir(uploadTmpDir)).toEqual([]);
  });

  it("cleans temp files after upload worker failure", async () => {
    const uploadTmpDir = await tempDir();
    const handler = createComputeRequestHandler({
      config: localConfig({ uploadTmpDir }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: {
        ...fakeWorker(),
        async transcribeAudioFile() {
          throw new HttpError("transcription_failed", "bad audio", 422);
        },
      },
    });
    const form = new FormData();
    form.append("audio", new File(["audio"], "input.wav", { type: "audio/wav" }));
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    const response = await postForm(handler, "/transcriptions/file", form);

    expect(response.status).toBe(422);
    expect(await readdir(uploadTmpDir)).toEqual([]);
  });

  it("rejects worker jobs beyond the concurrency limit and frees the slot afterwards", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = createComputeRequestHandler({
      config: localConfig({ maxConcurrentJobs: 1 }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: {
        ...fakeWorker(),
        async transcribeAudio(request) {
          await blocked;
          return fakeWorker().transcribeAudio(request);
        },
      },
    });
    const body = {
      provider: "whisperCpp",
      model: "tiny.en",
      samples: [0, 0],
      sampleRate: 16_000,
    } satisfies TranscribeAudioRequest;

    const first = postJson(handler, "/transcriptions", body);
    const busy = await postJson(handler, "/transcriptions/models", { provider: "whisperCpp" });
    expect(busy.status).toBe(503);
    expect((await responseJson<{ error: { code: string } }>(busy)).error.code).toBe("server_busy");

    release();
    expect((await first).status).toBe(200);
    const after = await postJson(handler, "/transcriptions/models", { provider: "whisperCpp" });
    expect(after.status).toBe(200);
  });

  it("passes cancellation to the worker and cleans temp files", async () => {
    const uploadTmpDir = await tempDir();
    const controller = new AbortController();
    let workerSignal: AbortSignal | undefined;
    const handler = createComputeRequestHandler({
      config: localConfig({ uploadTmpDir }),
      speakerStore: memorySpeakerStore(),
      nativeWorker: {
        ...fakeWorker(),
        transcribeAudioFile(_request, signal) {
          workerSignal = signal;
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new HttpError("request_cancelled", "request was cancelled", 499)),
            );
            controller.abort();
          });
        },
      },
    });
    const form = new FormData();
    form.append("audio", new File(["audio"], "input.wav", { type: "audio/wav" }));
    form.append("provider", "whisperCpp");
    form.append("model", "tiny.en");
    const response = await handler(
      new Request("http://server/transcriptions/file", {
        method: "POST",
        body: form,
        signal: controller.signal,
      }),
    );

    expect(workerSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
    expect(await readdir(uploadTmpDir)).toEqual([]);
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

describe("native worker process", () => {
  it("kills the worker process when the request is cancelled", async () => {
    const dir = await tempDir();
    const marker = join(dir, "finished");
    const worker = createNativeWorker(
      localConfig({ nativeWorker: await workerScript(dir, `sleep 5; touch ${marker}`) }),
    );
    const controller = new AbortController();
    const pending = worker.transcriptionModels("whisperCpp", controller.signal);
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "request_cancelled" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readdir(dir)).not.toContain("finished");
  });

  it("holds a cancelled job until a worker that ignores SIGTERM has been killed", async () => {
    const dir = await tempDir();
    const worker = createNativeWorker(
      localConfig({
        nativeWorker: await workerScript(dir, `trap '' TERM; while :; do sleep 0.1; done`),
      }),
    );
    const controller = new AbortController();
    const pending = worker.transcriptionModels("whisperCpp", controller.signal);
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "request_cancelled" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });

  it("kills worker descendants when the job is cancelled", async () => {
    const dir = await tempDir();
    const childPid = join(dir, "child.pid");
    const worker = createNativeWorker(
      localConfig({
        nativeWorker: await workerScript(dir, `sleep 30 & echo $! > ${childPid}; wait`),
      }),
    );
    const controller = new AbortController();
    const pending = worker.transcriptionModels("whisperCpp", controller.signal);
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt += 1) {
      await Bun.sleep(20);
      pid = Number(
        (
          await Bun.file(childPid)
            .text()
            .catch(() => "")
        ).trim(),
      );
    }
    expect(pid).toBeGreaterThan(0);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "request_cancelled" });

    // Gone, or a zombie awaiting its reaper: either way it no longer runs.
    await Bun.sleep(100);
    const state = await Bun.file(`/proc/${pid}/stat`)
      .text()
      .then((stat) => stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3))
      .catch(() => "gone");
    expect(["gone", "Z"]).toContain(state);
  });

  it("signals the direct worker when its process group cannot be signalled", () => {
    const kill = mock((_signal?: NodeJS.Signals) => undefined);
    // No such group: the group kill throws, so the direct worker must still be signalled.
    killWorker({ pid: 2 ** 22 + 12_345, kill }, "SIGTERM");
    expect(kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("does not echo worker stderr to public-ready clients", async () => {
    const dir = await tempDir();
    const script = await workerScript(
      dir,
      "echo 'failed on transcript: private words' >&2; exit 1",
    );

    await expect(
      createNativeWorker(localConfig({ nativeWorker: script })).transcribeAudio(transcribeBody()),
    ).rejects.toMatchObject({ message: "failed on transcript: private words" });
    await expect(
      createNativeWorker(localConfig({ nativeWorker: script, publicReady: true })).transcribeAudio(
        transcribeBody(),
      ),
    ).rejects.toMatchObject({ message: "native transcription worker failed" });
  });
});

function chunkedBody(chunks: number, size: number) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new TextEncoder().encode(" ".repeat(size)));
    },
  });
}

async function workerScript(dir: string, body: string) {
  const path = join(dir, "worker.sh");
  await writeFile(path, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function transcribeBody(): TranscribeAudioRequest {
  return { provider: "whisperCpp", model: "tiny.en", samples: [0, 0], sampleRate: 16_000 };
}

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
    maxAudioBytes: 50 * 1024 * 1024,
    maxConcurrentJobs: 2,
    uploadTmpDir: tmpdir(),
    ffmpegBin: "ffmpeg",
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
    async transcribeAudioFile(request) {
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
    async delete(id) {
      const before = speakers.length;
      speakers = speakers.filter((item) => item.id !== id);
      return speakers.length < before;
    },
    async deleteAll() {
      const count = speakers.length;
      speakers = [];
      return count;
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
  const response = await putJson(handler, "/speakers", { speakers });
  expect(response.status).toBe(200);
}

function postJson(
  handler: ReturnType<typeof createComputeRequestHandler>,
  path: string,
  body: unknown,
) {
  return handler(
    new Request(`http://server${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function putJson(
  handler: ReturnType<typeof createComputeRequestHandler>,
  path: string,
  body: unknown,
) {
  return handler(
    new Request(`http://server${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function postForm(
  handler: ReturnType<typeof createComputeRequestHandler>,
  path: string,
  body: FormData,
) {
  return handler(
    new Request(`http://server${path}`, {
      method: "POST",
      body,
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
