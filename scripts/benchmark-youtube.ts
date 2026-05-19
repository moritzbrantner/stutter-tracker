#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { fallbackAnalyze } from "../packages/shared/src/index.ts";

const defaultUrl = "https://www.youtube.com/watch?v=2Jk3AtlfWKQ";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkDir = resolve(rootDir, ".benchmarks", "youtube");
const sampleRate = 16_000;
const url = Bun.argv[2] ?? defaultUrl;
const iterations = positiveInteger(Bun.env.BENCHMARK_ITERATIONS, 5);

mkdirSync(benchmarkDir, { recursive: true });

const metadata = youtubeMetadata(url);
const videoPath = existingMediaPath(metadata.id) ?? downloadVideo(url);
const rawAudioPath = resolve(benchmarkDir, `${metadata.id}.f32le`);
extractMonoAudio(videoPath, rawAudioPath);

const samples = readFloat32Samples(rawAudioPath);
const durationSeconds = samples.length / sampleRate;
const request = {
  segments: [],
  pauses: [],
  samples,
  sampleRate,
};

const warmup = fallbackAnalyze(request);
const measurements: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  fallbackAnalyze(request);
  measurements.push(performance.now() - started);
}

const result = {
  source: {
    url,
    id: metadata.id,
    title: metadata.title,
    durationSeconds: metadata.duration,
    videoPath,
    audioPath: rawAudioPath,
  },
  benchmark: {
    analyzer: "packages/shared fallbackAnalyze acoustic path",
    sampleRate,
    sampleCount: samples.length,
    audioDurationSeconds: durationSeconds,
    iterations,
    meanMs: mean(measurements),
    minMs: Math.min(...measurements),
    maxMs: Math.max(...measurements),
    p50Ms: percentile(measurements, 0.5),
    p95Ms: percentile(measurements, 0.95),
    measurementsMs: measurements,
  },
  report: {
    totalDurationSeconds: warmup.totalDurationSeconds,
    stutterCount: warmup.stutterCount,
    severity: warmup.severity,
    acousticStats: warmup.acousticStats,
  },
};

const resultPath = resolve(benchmarkDir, `${metadata.id}.benchmark.json`);
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

console.log(`Benchmark source: ${metadata.title} (${metadata.id})`);
console.log(`Video: ${videoPath}`);
console.log(`Audio: ${durationSeconds.toFixed(2)}s mono @ ${sampleRate} Hz`);
console.log(
  `fallbackAnalyze: mean ${result.benchmark.meanMs.toFixed(2)}ms, p95 ${result.benchmark.p95Ms.toFixed(2)}ms over ${iterations} runs`,
);
console.log(`Result: ${resultPath}`);

type YoutubeMetadata = {
  id: string;
  title: string;
  duration: number | null;
};

function youtubeMetadata(targetUrl: string): YoutubeMetadata {
  const stdout = runOutput("yt-dlp", [
    "--simulate",
    "--skip-download",
    "--dump-single-json",
    targetUrl,
  ]);
  const value = JSON.parse(stdout) as {
    id?: string;
    title?: string;
    duration?: number;
  };
  if (!value.id) {
    throw new Error("yt-dlp metadata did not include a video id");
  }
  return {
    id: value.id,
    title: value.title ?? value.id,
    duration: Number.isFinite(value.duration) ? (value.duration ?? null) : null,
  };
}

function downloadVideo(targetUrl: string) {
  const outputTemplate = resolve(benchmarkDir, "%(id)s.%(ext)s");
  const stdout = runOutput("yt-dlp", [
    "--no-playlist",
    "--format",
    "bv*[height<=720]+ba/b[height<=720]/best",
    "--merge-output-format",
    "mp4",
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate,
    targetUrl,
  ]);

  for (const line of stdout.split(/\r?\n/).reverse()) {
    const path = line.trim();
    if (path && existsSync(path)) {
      return path;
    }
  }

  throw new Error("yt-dlp finished without reporting a downloaded file path");
}

function extractMonoAudio(videoPath: string, outputPath: string) {
  runOutput("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    outputPath,
  ]);
}

function readFloat32Samples(path: string) {
  const data = readFileSync(path);
  const samples: number[] = new Array(Math.floor(data.length / 4));
  for (let offset = 0, index = 0; offset + 4 <= data.length; offset += 4, index += 1) {
    samples[index] = data.readFloatLE(offset);
  }
  return samples;
}

function existingMediaPath(videoId: string) {
  const mediaExtensions = new Set([".mp4", ".webm", ".mkv", ".mov"]);
  for (const entry of readdirSync(benchmarkDir)) {
    const path = resolve(benchmarkDir, entry);
    if (entry.startsWith(`${videoId}.`) && mediaExtensions.has(extname(entry))) {
      console.log(`Using cached video ${basename(path)}`);
      return path;
    }
  }
  return null;
}

function runOutput(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values: number[], fraction: number) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}
