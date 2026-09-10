# Stuttering benchmark boundary

The stuttering benchmark is product evaluation code and therefore lives at the desktop Rust product boundary next to the detector it evaluates. `speech_analysis::StutterKind` is the canonical event taxonomy; the benchmark must reuse it rather than maintain a second TypeScript copy.

## Initial corpus contract

SEP-28k is the primary baseline. Its clip-level majority-vote labels map to the existing product event kinds:

- `WordRep` → `WordRepetition`
- `SoundRep` → `SoundRepetition`
- `Prolongation` → `Prolongation`
- `Block` → `Block`
- `Interjection` → `Filler`

The default normalizer requires a 2-of-3 vote. Uncertain, poor-quality, difficult-to-understand, music, and no-speech clips are excluded from evaluation. The real `NoStutteredWords` field is retained for auditing rather than silently discarded.

SEP-28k is clip-level multi-label data, so this slice evaluates clip classification. It does not invent event timestamps. Timestamp/onset error belongs to a corpus or curated fixture that actually provides temporal labels.

Speaker-safe evaluation fails closed. The original SEP-28k table is not treated as a trustworthy speaker-identity source; an explicit verified speaker mapping such as SEP-28k-E is required before train/evaluation partitioning can be called speaker-exclusive.

## Metrics

The harness reports per-kind precision/recall/F1, micro precision/recall/F1, macro F1, and false-positive rate on fluent clips. The fluent false-positive denominator is the number of fluent reference clips, not the total corpus size.

Calibration uses Brier score only when a predictor supplies a complete probability vector for every evaluated clip and every canonical event kind. Partial vectors are rejected so candidates cannot obtain incomparable calibration scores by omitting difficult classes.

The existing deterministic detector is the first baseline adapter. Substantially smarter classifiers should be compared against that baseline only after this benchmark contract and the runtime-evidence slice are integrated.

## Execution boundary

Normal installs and hosted CI do not download corpus audio. Run the semantic harness in the verified source-development workspace:

```bash
bash scripts/source-deps activate
bun run benchmark:stutter
```

The hosted `Stutter benchmark contract` only checks formatting, ownership, and the benchmark entry point because the Rust application intentionally depends on the local-only capability graph. `coding-tooling pr integrate 3` remains the authoritative source-aware merge gate.

Runtime profiling is separate. `runtime-profiler` owns process/runtime evidence; this benchmark owns correctness semantics.
