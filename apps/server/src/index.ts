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
import postgres from "postgres";

const port = Number(process.env.PORT ?? "8787");
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const sql = databaseUrl ? postgres(databaseUrl) : null;
let schemaReady = false;

const server = Bun.serve({
  port,
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return emptyResponse(204);
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "stutter-tracker-compute" });
      }

      if (request.method === "POST" && url.pathname === "/analysis") {
        return json(fallbackAnalyze((await request.json()) as AnalyzeSpeechRequest));
      }

      if (request.method === "GET" && url.pathname === "/speakers") {
        return json({ speakers: await loadSpeakerProfiles() });
      }

      if (request.method === "PUT" && url.pathname === "/speakers") {
        const body = (await request.json()) as { speakers?: SpeakerProfile[] };
        return json({ speakers: await saveSpeakerProfiles(body.speakers ?? []) });
      }

      if (request.method === "POST" && url.pathname === "/speakers/profile") {
        const body = (await request.json()) as {
          id?: string;
          label: string;
          samples: number[];
          sampleRate: number;
        };
        return json({
          id: body.id ?? crypto.randomUUID(),
          label: body.label.trim() || "Speaker",
          embeddings: [fallbackEmbedding(body.samples)],
          sampleRate: body.sampleRate,
          sampleCount: body.samples.length,
        } satisfies SpeakerProfile);
      }

      if (request.method === "POST" && url.pathname === "/speakers/identify") {
        const body = (await request.json()) as {
          samples: number[];
          speakers: SpeakerProfile[];
          threshold?: number;
          maxResults?: number;
        };
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
        return json({ bestMatch: matches[0], matches, isMatch: Boolean(matches[0]) });
      }

      if (request.method === "POST" && url.pathname === "/transcriptions/models") {
        const body = (await request.json()) as { provider: TranscriptionEngineId };
        return json({ provider: body.provider, models: staticModelStatuses(body.provider) });
      }

      if (request.method === "POST" && url.pathname === "/transcriptions") {
        const body = (await request.json()) as TranscribeAudioRequest;
        return json({
          text: null,
          language: body.language,
          segments: [],
          provider: body.provider,
          model: body.model,
          warning:
            "The TypeScript compute server scaffold is reachable. Add a native/Rust worker here for production transcription.",
        });
      }

      if (request.method === "POST" && url.pathname === "/transcriptions/models/download") {
        const body = (await request.json()) as { provider: TranscriptionEngineId; model: string };
        return json({
          id: body.model,
          label: body.model,
          cached: false,
          downloadable: false,
        });
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});

console.log(`stutter-tracker compute server listening on http://127.0.0.1:${server.port}`);
if (!sql) {
  console.warn("DATABASE_URL is not set; speaker profiles will not be persisted by the server.");
}

type SpeakerRow = {
  id: string;
  label: string;
  embeddings: unknown;
  sample_rate: number;
  sample_count: number;
};

async function ensureSchema() {
  if (!sql) {
    throw new Error("DATABASE_URL is required for server speaker persistence");
  }
  if (schemaReady) {
    return sql;
  }
  await sql`
    create table if not exists known_speakers (
      id text primary key,
      label text not null,
      embeddings jsonb not null,
      sample_rate integer not null,
      sample_count integer not null,
      updated_at timestamptz not null default now()
    )
  `;
  schemaReady = true;
  return sql;
}

async function loadSpeakerProfiles() {
  const db = await ensureSchema();
  const rows = await db<SpeakerRow[]>`
    select id, label, embeddings, sample_rate, sample_count
    from known_speakers
    order by label asc
  `;
  return rows.map(rowToSpeakerProfile).filter(isSpeakerProfile);
}

async function saveSpeakerProfiles(speakers: SpeakerProfile[]) {
  const db = await ensureSchema();
  const validSpeakers = speakers.map(normalizeSpeakerProfile).filter(isSpeakerProfile);
  await db.begin(async (tx) => {
    await tx`delete from known_speakers`;
    for (const speaker of validSpeakers) {
      await tx`
        insert into known_speakers (id, label, embeddings, sample_rate, sample_count, updated_at)
        values (
          ${speaker.id},
          ${speaker.label},
          ${tx.json(speaker.embeddings)},
          ${speaker.sampleRate},
          ${speaker.sampleCount},
          now()
        )
      `;
    }
  });
  return validSpeakers;
}

function rowToSpeakerProfile(row: SpeakerRow): SpeakerProfile | null {
  return normalizeSpeakerProfile({
    id: row.id,
    label: row.label,
    embeddings: row.embeddings,
    sampleRate: row.sample_rate,
    sampleCount: row.sample_count,
  });
}

function normalizeSpeakerProfile(value: unknown): SpeakerProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<SpeakerProfile>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  if (!id || !label || !Array.isArray(candidate.embeddings)) {
    return null;
  }
  const embeddings = candidate.embeddings
    .filter((embedding): embedding is number[] => Array.isArray(embedding))
    .map((embedding) =>
      embedding.filter((item) => typeof item === "number" && Number.isFinite(item)),
    );
  if (!embeddings.length) {
    return null;
  }
  return {
    id,
    label,
    embeddings,
    sampleRate: positiveInteger(candidate.sampleRate),
    sampleCount: positiveInteger(candidate.sampleCount),
  };
}

function isSpeakerProfile(value: SpeakerProfile | null): value is SpeakerProfile {
  return value !== null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type",
      "content-type": "application/json",
    },
  });
}

function emptyResponse(status: number) {
  return new Response(null, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
