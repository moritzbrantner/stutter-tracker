import { describe, expect, it } from "bun:test";
import { fallbackAnalyze } from "@stutter-tracker/shared";
import {
  COMPUTE_SERVER_ANALYZER,
  type ComputeClient,
  createComputeClient,
  isLoopbackUrl,
  ON_DEVICE_ANALYZER,
  type ProcessingPolicy,
  processingPolicyForServerUrl,
} from "./index";

const remoteWithConsent: ProcessingPolicy = {
  mode: "remote",
  serverUrl: "https://compute.example.com",
  remoteAnalysisConsent: true,
};

describe("createComputeClient", () => {
  it("attaches bearer auth to GET, POST, and PUT requests", async () => {
    const calls: Request[] = [];
    const fetchImpl = (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.endsWith("/speakers") && request.method === "GET") {
        return json({ speakers: [] });
      }
      if (request.url.endsWith("/speakers") && request.method === "PUT") {
        return json({ speakers: [] });
      }
      return json({
        id: "speaker-1",
        label: "Speaker",
        embeddings: [[1]],
        sampleRate: 16_000,
        sampleCount: 16_000,
      });
    }) as typeof fetch;
    const client = createComputeClient({
      processingPolicy: remoteWithConsent,
      apiToken: "secret",
      fetchImpl,
    });

    await client.listSpeakerProfiles();
    await client.saveSpeakerProfiles([]);
    await client.createSpeakerProfile({
      label: "Speaker",
      samples: [0, 1],
      sampleRate: 16_000,
    });

    expect(calls.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer secret",
      "Bearer secret",
      "Bearer secret",
    ]);
  });

  it("preserves no-token behavior", async () => {
    let authorization: string | null = "unset";
    const fetchImpl = (async (input, init) => {
      authorization = new Request(input, init).headers.get("authorization");
      return json({ speakers: [] });
    }) as typeof fetch;
    const client = createComputeClient({
      processingPolicy: remoteWithConsent,
      fetchImpl,
    });

    await client.listSpeakerProfiles();

    expect(authorization).toBeNull();
  });

  it("surfaces structured server errors", async () => {
    const fetchImpl = (async () =>
      json(
        {
          error: {
            code: "unauthorized",
            message: "authorization bearer token is invalid",
          },
        },
        401,
      )) as unknown as typeof fetch;
    const client = createComputeClient({
      processingPolicy: remoteWithConsent,
      fetchImpl,
    });

    await expect(client.listSpeakerProfiles()).rejects.toThrow(
      "unauthorized: authorization bearer token is invalid",
    );
  });

  it("uploads transcription files as multipart form data", async () => {
    const requests: Request[] = [];
    const fetchImpl = (async (input, init) => {
      requests.push(new Request(input, init));
      return json({
        provider: "whisperCpp",
        model: "base.en",
        segments: [],
      });
    }) as typeof fetch;
    const client = createComputeClient({
      processingPolicy: remoteWithConsent,
      apiToken: "secret",
      fetchImpl,
    });

    await client.transcribeAudioFile({
      file: new Blob(["audio"], { type: "audio/mp4" }),
      filename: "recording.m4a",
      mimeType: "audio/mp4",
      provider: "whisperCpp",
      model: "base.en",
      language: "en-US",
    });

    const request = requests[0];
    expect(request?.url).toBe("https://compute.example.com/transcriptions/file");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(request?.headers.get("content-type")).toContain("multipart/form-data");
  });
});

const samples = [0, 0.2, -0.1, 0.4];
const analysisRequest = {
  segments: [{ text: "I I speak", startSeconds: 0, endSeconds: 1, isFinal: true }],
  pauses: [],
};
const speaker = { id: "s", label: "S", embeddings: [[1]], sampleRate: 16_000, sampleCount: 4 };

/** Exercises every speech-content entry point, swallowing the expected local errors. */
async function exerciseAllEntryPoints(client: ComputeClient) {
  const settle = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
  return Promise.all([
    settle(client.analyzeSpeechSession(analysisRequest)),
    settle(client.listSpeakerProfiles()),
    settle(client.saveSpeakerProfiles([speaker])),
    settle(client.createSpeakerProfile({ label: "S", samples, sampleRate: 16_000 })),
    settle(client.identifySpeaker({ samples, sampleRate: 16_000, speakers: [speaker] })),
    settle(client.transcriptionModels("whisperCpp")),
    settle(
      client.transcribeAudio({
        samples,
        sampleRate: 16_000,
        provider: "whisperCpp",
        model: "base.en",
      }),
    ),
    settle(
      client.transcribeAudioFile({
        file: new Blob(["audio"]),
        filename: "a.m4a",
        mimeType: "audio/mp4",
        provider: "whisperCpp",
        model: "base.en",
      }),
    ),
    settle(client.downloadTranscriptionModel("whisperCpp", "base.en")),
  ]);
}

function countingFetch(respond: () => Response | Promise<Response> = () => json({}, 503)) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("processing policy", () => {
  const blockedPolicies: Array<[string, ProcessingPolicy | undefined]> = [
    ["default (no policy)", undefined],
    ["on-device", { mode: "onDevice" }],
    [
      "remote without consent",
      { mode: "remote", serverUrl: "https://compute.example.com", remoteAnalysisConsent: false },
    ],
    [
      "local companion on a non-loopback host",
      { mode: "localCompanion", serverUrl: "https://compute.example.com" },
    ],
    ["invalid URL", { mode: "remote", serverUrl: "not a url", remoteAnalysisConsent: true }],
  ];

  for (const [name, processingPolicy] of blockedPolicies) {
    it(`sends zero requests: ${name}`, async () => {
      const { calls, fetchImpl } = countingFetch();
      const client = createComputeClient({ processingPolicy, apiToken: "secret", fetchImpl });

      const results = await exerciseAllEntryPoints(client);

      expect(calls).toEqual([]);
      expect(client.destination.kind).not.toBe("server");
      expect(String(results[6])).toContain("Transcription needs");
    });
  }

  it("falls back to on-device analysis, not another destination, when the server fails", async () => {
    const { calls, fetchImpl } = countingFetch(() => {
      throw new TypeError("network down");
    });
    const client = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl,
    });

    const report = await client.analyzeSpeechSession(analysisRequest);

    expect(report).toBeDefined();
    expect(calls).toEqual(["http://127.0.0.1:8787/analysis"]);
  });

  it("deletes a voiceprint on the permitted server only", async () => {
    const { calls, fetchImpl } = countingFetch(() => json({ deleted: 1 }, 200));
    const client = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl,
    });
    expect(await client.deleteSpeakerProfile("speaker 1")).toBe("deleted");
    expect(calls).toEqual(["http://127.0.0.1:8787/speakers/speaker%201"]);

    const gone = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl: countingFetch(() => json({ error: { code: "speaker_not_found" } }, 404)).fetchImpl,
    });
    expect(await gone.deleteSpeakerProfile("a")).toBe("notFound");

    // An older server without the route answers its generic 404: the voiceprint is still there.
    const older = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl: countingFetch(() => json({ error: { code: "not_found" } }, 404)).fetchImpl,
    });
    await expect(older.deleteSpeakerProfile("a")).rejects.toThrow();

    const onDevice = countingFetch();
    const local = createComputeClient({ fetchImpl: onDevice.fetchImpl });
    expect(await local.deleteSpeakerProfile("a")).toBe("noServer");
    expect(onDevice.calls).toEqual([]);
  });

  it("reports which analyzer produced the report", async () => {
    const failing = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl: countingFetch(() => {
        throw new TypeError("network down");
      }).fetchImpl,
    });
    expect((await failing.analyzeSpeechSessionRun(analysisRequest)).analyzer).toEqual(
      ON_DEVICE_ANALYZER,
    );

    const serverReport = fallbackAnalyze(analysisRequest);
    const serving = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl: countingFetch(() => json(serverReport, 200)).fetchImpl,
    });
    expect(await serving.analyzeSpeechSessionRun(analysisRequest)).toEqual({
      report: serverReport,
      analyzer: COMPUTE_SERVER_ANALYZER,
    });

    const reporting = createComputeClient({
      processingPolicy: { mode: "localCompanion", serverUrl: "http://127.0.0.1:8787/" },
      fetchImpl: countingFetch(
        () =>
          new Response(JSON.stringify(serverReport), {
            headers: {
              "content-type": "application/json",
              "x-analyzer-algorithm": "shared-fallback",
              "x-analyzer-version": "1",
            },
          }),
      ).fetchImpl,
    });
    expect((await reporting.analyzeSpeechSessionRun(analysisRequest)).analyzer).toEqual({
      producer: "computeServer",
      algorithm: "shared-fallback",
      version: "1",
    });
  });

  it("keeps the destination fixed for the client's lifetime", async () => {
    const { calls, fetchImpl } = countingFetch(() => json({ speakers: [] }));
    const policy = {
      mode: "remote",
      serverUrl: "https://a.example.com",
      remoteAnalysisConsent: true,
    };
    const client = createComputeClient({ processingPolicy: policy as ProcessingPolicy, fetchImpl });

    policy.serverUrl = "https://b.example.com";
    policy.remoteAnalysisConsent = false;
    await client.listSpeakerProfiles();

    expect(calls).toEqual(["https://a.example.com/speakers"]);
    expect(client.destination).toMatchObject({
      kind: "server",
      mode: "remote",
      url: "https://a.example.com",
    });
  });

  it("refuses to follow redirects away from the selected destination", async () => {
    const modes: Array<RequestRedirect | undefined> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      modes.push(init?.redirect);
      return json({ speakers: [], models: [], segments: [] });
    }) as typeof fetch;
    const client = createComputeClient({ processingPolicy: remoteWithConsent, fetchImpl });

    await exerciseAllEntryPoints(client);

    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((mode) => mode === "error")).toBe(true);
  });

  it("treats only loopback URLs as a local companion", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8787")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.10:8787")).toBe(false);
    expect(isLoopbackUrl("http://localhost.example.com")).toBe(false);
    expect(processingPolicyForServerUrl("http://10.0.2.2:8787", false)).toEqual({
      mode: "remote",
      serverUrl: "http://10.0.2.2:8787",
      remoteAnalysisConsent: false,
    });
    expect(processingPolicyForServerUrl("  ", true)).toEqual({ mode: "onDevice" });
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
