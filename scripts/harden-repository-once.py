from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    content = file.read_text()
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"expected exactly one match in {path}, found {count}")
    file.write_text(content.replace(old, new, 1))


replace_once(
    "apps/web/src/app/TrackerApp.tsx",
    'import { fallbackAnalyze as sharedFallbackAnalyze } from "@stutter-tracker/shared";',
    'import {\n  fallbackAnalyze as sharedFallbackAnalyze,\n  resampleSamples as sharedResampleSamples,\n} from "@stutter-tracker/shared";',
)

replace_once(
    "apps/web/src/app/TrackerApp.tsx",
    '''export function resampleSamples(samples: number[], sampleRate: number, targetSampleRate: number) {
  if (sampleRate === targetSampleRate) {
    return samples;
  }
  const resultLength = Math.max(1, Math.round((samples.length * targetSampleRate) / sampleRate));
  const result = new Array<number>(resultLength);
  const ratio = sampleRate / targetSampleRate;
  for (let index = 0; index < resultLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourceIndex - left;
    result[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return result;
}
''',
    "export const resampleSamples = sharedResampleSamples;\n",
)

replace_once(
    "packages/shared/src/index.ts",
    "const result = new Array<number>(resultLength);",
    "const result = Array.from({ length: resultLength }, () => 0);",
)

replace_once(
    "apps/server/src/index.test.ts",
    'const response = await postJson(handler, "/speakers", { speakers }, "PUT");',
    'const response = await putJson(handler, "/speakers", { speakers });',
)

replace_once(
    "apps/server/src/index.test.ts",
    '''function postJson(
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
''',
    '''function postJson(
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
''',
)

web_validate = Path(".github/workflows/web-validate.yml")
old_web_validate = web_validate.read_text()
if "bun-version: 1.3.14" not in old_web_validate:
    raise RuntimeError("Web Validate no longer has the expected stale Bun runtime")
web_validate.write_text('''name: Web Validate

on:
  pull_request:
    paths:
      - .github/workflows/web-validate.yml
      - apps/web/**
      - packages/compute-client/**
      - packages/shared/**
      - package.json
      - bun.lock
      - turbo.json
  push:
    branches:
      - main
    paths:
      - .github/workflows/web-validate.yml
      - apps/web/**
      - packages/compute-client/**
      - packages/shared/**
      - package.json
      - bun.lock
      - turbo.json
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    permissions:
      contents: read
    uses: moritzbrantner/reusable-workflows/.github/workflows/coding-tooling-validation.yml@8da6ad737d4746159414bde686d5c7422e0a9232
    with:
      tier: standard
      component: apps/web
      strict: true
      install_mode: auto
      report_path: .artifacts/coding-tooling/web-standard.json
      timeout_minutes: 30
''')

Path(".github/workflows/hardening-codemod.yml").unlink(missing_ok=True)
Path(__file__).unlink()
