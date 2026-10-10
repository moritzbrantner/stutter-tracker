import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// vox#89, owner decision 2026-10-10: the browser measures capture quality with the
// audio-analysis WASM kernel, consumed as a commit-pinned git package. It is not re-implemented here.
const PACKAGE = "@moritzbrantner/audio-analysis-core-wasm";
// Vitest runs the web package from its own directory (jsdom rewrites import.meta.url).
const webRoot = process.cwd();
const repoRoot = resolve(webRoot, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("browser capture kernel contract", () => {
  it("pins the WASM kernel package to an exact commit of its own repository", () => {
    const web = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));
    expect(web.dependencies?.[PACKAGE]).toMatch(
      /^github:moritzbrantner\/audio-analysis-core-wasm#[0-9a-f]{40}$/,
    );
  });

  it("trusts the package so its prepare build runs on install", () => {
    const trusted = [webRoot, repoRoot].flatMap(
      (dir) =>
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).trustedDependencies ?? [],
    );
    expect(trusted).toContain(PACKAGE);
  });

  it("measures through the package instead of a local re-implementation", () => {
    const files = sourceFiles(join(webRoot, "src"));
    const importers = files.filter((file) => readFileSync(file, "utf8").includes(`"${PACKAGE}"`));
    expect(importers.length).toBeGreaterThan(0);
    // Building the metrics record field by field would be a second owner of the observation.
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/clippedSampleCount\s*[:=]/);
    }
  });
});
