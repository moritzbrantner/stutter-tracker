# Speech-analysis runtime evidence

These scenarios profile the product-owned analysis path with deterministic synthetic input. They are not correctness benchmarks; stuttering correctness belongs to `packages/stutter-bench`.

## Scenarios

- `analyze-30s`: 30 seconds of transcript + synthetic 16 kHz audio.
- `analyze-90s`: the current maximum acoustic-analysis window (the analyzer truncates audio after 90 seconds).
- `analyze-transcript-5m`: five minutes of transcript/pause interpretation without audio, isolating long-session text/event processing.

`runtime-profiler` owns process duration distributions, success/timeout state, and supported resident-memory evidence. Its v1 command collector intentionally discards workload stdout, so product-domain metrics are captured separately rather than pretending they are part of the native profiler bundle.

`scripts/profile-domain-metrics.py` repeats the same declared workload and writes a sibling `*.domain.json` sidecar with distributions for analysis elapsed time, real-time factor, event count, word count, and analyzed-audio duration. The sidecar records the source revision and scenario target, while the profiler bundle remains the authoritative environment/process artifact.

There is intentionally no scenario called `streaming`: the current Rust API is session/batch analysis. A streaming scenario should only be added after a real incremental audio-analysis interface exists rather than benchmarking a fake loop and calling it realtime evidence.

## Capture

Activate the exact source dependency graph first, then run:

```bash
bash scripts/source-deps activate
bash scripts/profile-runtime.sh analyze-30s .artifacts/runtime-profiler/analyze-30s-<revision>
```

The command produces:

```text
.artifacts/runtime-profiler/analyze-30s-<revision>/
.artifacts/runtime-profiler/analyze-30s-<revision>.domain.json
```

Set `RUNTIME_PROFILER_ROOT` when the profiler checkout is not the usual sibling repository. Runtime-profiler bundle directories are immutable; use a new path for each capture. The domain sidecar is deliberately outside the bundle so it cannot invalidate the profiler manifest.

Compare baseline/candidate evidence in the evaluator layer. Do not turn a single profiler capture into a performance verdict.
