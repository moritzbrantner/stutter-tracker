# Agent instructions

- Treat `apps/desktop/src-tauri` as the Rust application boundary; keep product-specific speech and fluency behavior here.
- Ordinary cross-repository implementation is source-first. Run `bash scripts/source-deps activate` when work needs current audio, NLP, or foundation source.
- Exact revisions in `.coding-tooling.source-deps.json` are implementation evidence. Do not publish crates, bump versions, or start a release train merely to unblock feature work.
- The committed Cargo package coordinates remain the distribution contract. Deactivate source mode and verify registry-only resolution only for an explicitly assigned release/distribution task.
- The local `text_analysis_features`, `text_analysis_transcription`, and `video_analysis_core` compatibility modules exist only to bridge historical monolith call sites onto extracted owners. Do not turn them into new published packages.
- Prefer current capability owners: `audio-analysis` for audio/transcription runtime, `nlp-stack` for text analysis/transcript contracts, and `moenarch-foundation` for neutral media/error contracts.
- Update exact source pins when a reviewed upstream source head changes; never replace them with moving branches or permanent sibling paths.
- Keep the migration bounded to this application plus immediate capability owners. If a task needs a wider dependency closure, treat that as an architecture boundary problem rather than a reason to publish everything.
