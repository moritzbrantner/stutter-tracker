#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <scenario-name> <output-directory>\n' "$0" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
scenario="$root/.runtime-profiler/scenarios/$1.yaml"
output="$2"
profiler_root="${RUNTIME_PROFILER_ROOT:-$root/../runtime-profiler}"

if [[ ! -f "$scenario" ]]; then
  printf 'unknown runtime-profiler scenario: %s\n' "$scenario" >&2
  exit 2
fi
if [[ ! -f "$profiler_root/Cargo.toml" ]]; then
  printf 'runtime-profiler checkout not found at %s; set RUNTIME_PROFILER_ROOT\n' "$profiler_root" >&2
  exit 2
fi

cargo build \
  --manifest-path "$root/apps/desktop/src-tauri/Cargo.toml" \
  --release \
  --bin profile-speech-analysis

cargo run \
  --manifest-path "$profiler_root/Cargo.toml" \
  -- capture \
  --scenario "$scenario" \
  --output "$output"

cargo run \
  --manifest-path "$profiler_root/Cargo.toml" \
  -- validate \
  --bundle "$output"

cargo run \
  --manifest-path "$profiler_root/Cargo.toml" \
  -- summarize \
  --bundle "$output"
