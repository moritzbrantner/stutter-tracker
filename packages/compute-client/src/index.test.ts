import { describe, expect, it } from "bun:test";
import { createComputeClient } from "./index";

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
      serverUrl: "https://compute.example.com",
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
      serverUrl: "https://compute.example.com",
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
      serverUrl: "https://compute.example.com",
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
      serverUrl: "https://compute.example.com",
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

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
