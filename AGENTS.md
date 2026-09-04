# Agent instructions

## Three-layer delivery model

Every non-trivial change should be evaluated at three levels:

1. **Engineering system** — repository environment, coding-tooling tiers, deterministic tests, agent conventions, dependency/source contracts, and reproducible evidence.
2. **Speech capability** — reuse `audio-analysis` and `nlp-stack` for generic audio/NLP observations; keep stuttering-specific interpretation, fusion, personalization, and product policy in this repository.
3. **Product and performance** — preserve a useful speaking workflow and collect latency/runtime evidence for work that can affect realtime or post-session analysis.

A feature is not complete merely because it compiles. Prefer changes whose correctness and performance can be measured by deterministic tests, corpus benchmarks, or profiler scenarios.

## Repository boundaries

- Treat `apps/desktop/src-tauri` as the Rust application boundary; keep product-specific speech and fluency behavior here.
- Ordinary cross-repository implementation is source-first. Run `bash scripts/source-deps activate` when work needs current audio, NLP, or foundation source.
- Exact revisions in `.coding-tooling.source-deps.json` are implementation evidence. Do not publish crates, bump versions, or start a release train merely to unblock feature work.
- The committed Cargo package coordinates remain the distribution contract. Deactivate source mode and verify registry-only resolution only for an explicitly assigned release/distribution task.
- While any declared capability coordinate is not yet published, the committed `Cargo.lock` is only the last distribution snapshot and is allowed to lag the source graph. Do not publish packages or hand-edit the lock to make feature development look registry-complete; regenerate and verify it during the explicit release cutover once every required coordinate exists.
- The local `text_analysis_features`, `text_analysis_transcription`, and `video_analysis_core` compatibility modules exist only to bridge historical monolith call sites onto extracted owners. Do not turn them into new published packages.
- Prefer current capability owners: `audio-analysis` for audio/transcription runtime, `nlp-stack` for text analysis/transcript contracts, and `moenarch-foundation` for neutral media/error contracts.
- Update exact source pins when a reviewed upstream source head changes; never replace them with moving branches or permanent sibling paths.
- Keep the migration bounded to this application plus immediate capability owners. If a task needs a wider dependency closure, treat that as an architecture boundary problem rather than a reason to publish everything.

## Validation

- Use `.repository-environment.toml` and `scripts/codex-environment.sh` as the environment-v1 contract.
- Use `.coding-tooling.json` as the semantic validation-tier contract. Hosted workflows are adapters; they do not own validation semantics.
- For Rust changes that cross capability repositories, run `bash scripts/verify-source-workspace`; it composes exact source activation, the `source-development` environment fingerprint, and the application fmt/check/clippy/test gate while preserving distribution-state files.
- Keep fast checks deterministic and cheap. Put corpus evaluation and runtime profiling in explicit benchmark/performance tiers rather than making every edit pay the full cost.
