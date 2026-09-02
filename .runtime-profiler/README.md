# Speech-analysis runtime evidence

These scenarios profile the product-owned analysis path with deterministic synthetic input. They are not correctness benchmarks; stuttering correctness belongs to `packages/stutter-bench`.

## Scenarios

- `analyze-30s`: 30 seconds of transcript + synthetic 16 kHz audio.
- `analyze-90s`: the current maximum acoustic-analysis window (the analyzer truncates audio after 90 seconds).
- `analyze-transcript-5m`: five minutes of transcript/pause interpretation without audio, isolating long-session text/event processing.

The workload binary prints a compact domain record containing analysis elapsed time, real-time factor, event count, word count, and analyzed-audio duration. `runtime-profiler` independently owns process duration distributions, success/timeout state, and supported resident-memory evidence.

There is intentionally no scenario called `streaming`: the current Rust API is session/batch analysis. A streaming scenario should only be added after a real incremental audio-analysis interface exists rather than benchmarking a fake loop and calling it realtime evidence.

## Capture

Activate the exact source dependency graph first, then run:

```bash
bash scripts/source-deps activate
bash scripts/profile-runtime.sh analyze-30s .artifacts/runtime-profiler/analyze-30s-<revision>
```

Set `RUNTIME_PROFILER_ROOT` when the profiler checkout is not the usual sibling repository. Output directories are immutable runtime-profiler evidence bundles; use a new path for each capture.

Compare baseline/candidate evidence in the evaluator layer. Do not turn a single profiler capture into a performance verdict.
