import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SpeakerProfile } from "@stutter-tracker/shared";
import postgres from "postgres";
import { validateSpeakerProfile } from "./validation";

export type SpeakerStore = {
  list(): Promise<SpeakerProfile[]>;
  upsertMany(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]>;
  deleteMissing?: false;
};

type SpeakerRow = {
  id: string;
  label: string;
  embeddings: unknown;
  sample_rate: number;
  sample_count: number;
};

export function createSpeakerStore(options: {
  databaseUrl?: string;
  filePath: string;
}): SpeakerStore {
  if (options.databaseUrl) {
    return new PostgresSpeakerStore(options.databaseUrl);
  }
  return new FileSpeakerStore(options.filePath);
}

class PostgresSpeakerStore implements SpeakerStore {
  deleteMissing = false as const;
  private sql: ReturnType<typeof postgres>;
  private schemaReady = false;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl);
  }

  async list(): Promise<SpeakerProfile[]> {
    const db = await this.ensureSchema();
    const rows = await db<SpeakerRow[]>`
      select id, label, embeddings, sample_rate, sample_count
      from known_speakers
      order by label asc
    `;
    return rows.map(rowToSpeakerProfile).filter(isSpeakerProfile);
  }

  async upsertMany(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]> {
    const db = await this.ensureSchema();
    const validSpeakers = normalizeSpeakerProfiles(speakers);
    await db.begin(async (tx) => {
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
          on conflict (id) do update set
            label = excluded.label,
            embeddings = excluded.embeddings,
            sample_rate = excluded.sample_rate,
            sample_count = excluded.sample_count,
            updated_at = now()
        `;
      }
    });
    return this.list();
  }

  private async ensureSchema() {
    if (this.schemaReady) {
      return this.sql;
    }
    await this.sql`
      create table if not exists known_speakers (
        id text primary key,
        label text not null,
        embeddings jsonb not null,
        sample_rate integer not null,
        sample_count integer not null,
        updated_at timestamptz not null default now()
      )
    `;
    this.schemaReady = true;
    return this.sql;
  }
}

class FileSpeakerStore implements SpeakerStore {
  deleteMissing = false as const;

  constructor(private readonly filePath: string) {}

  async list(): Promise<SpeakerProfile[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      return normalizeSpeakerProfiles(Array.isArray(parsed) ? parsed : []);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async upsertMany(speakers: SpeakerProfile[]): Promise<SpeakerProfile[]> {
    const existing = await this.list();
    const byId = new Map(existing.map((speaker) => [speaker.id, speaker]));
    for (const speaker of normalizeSpeakerProfiles(speakers)) {
      byId.set(speaker.id, speaker);
    }
    const next = [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
    await rename(tempPath, this.filePath);
    return next;
  }
}

function rowToSpeakerProfile(row: SpeakerRow): SpeakerProfile | null {
  return validateSpeakerProfile({
    id: row.id,
    label: row.label,
    embeddings: row.embeddings,
    sampleRate: row.sample_rate,
    sampleCount: row.sample_count,
  });
}

function normalizeSpeakerProfiles(values: unknown[]): SpeakerProfile[] {
  return values.map(validateSpeakerProfile).filter(isSpeakerProfile);
}

function isSpeakerProfile(value: SpeakerProfile | null): value is SpeakerProfile {
  return value !== null;
}
