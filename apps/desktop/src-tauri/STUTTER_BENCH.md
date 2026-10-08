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

## Corpus evaluation

`bun run benchmark:stutter` runs the fast contract tests, including a synthetic end-to-end corpus fixture. Real evaluation is a separate command that reads corpus files you already have locally:

```bash
bash scripts/source-deps activate
bun run benchmark:stutter:corpus -- \
  --labels /path/to/SEP-28k_labels.csv \
  --clips /path/to/clips \
  [--speakers /path/to/verified-speakers.csv] \
  [--vote-threshold 2] [--limit N] [--out report.json]
```

- `--clips` uses the layout written by the dataset's download script: `<clips>/<Show>/<EpId>/<Show>_<EpId>_<ClipId>.wav`.
- `--speakers` is a verified mapping with the columns `clipId,speakerId`, where clip ids are `Show:EpId:ClipId` (for example from SEP-28k-E). The held-out metrics are speaker-exclusive only when every scored clip has a verified speaker; otherwise the report says why they are not.
- Every required SEP-28k column must be present and every vote cell must be an integer 0–3; otherwise the run fails rather than reading damaged labels as negatives. A clip counts as fluent only with an affirmative `NoStutteredWords` vote; clips with neither a stuttering kind nor that vote are excluded as `noAffirmativeLabel`. Exclusions are counted per flag (a clip can have several) and as rows. Empty `Show`/`EpId`/`ClipId` values and a missing clips directory fail the run. Clips whose decoded duration differs from the labelled `Start`–`Stop` interval by more than 5% (truncated extractions), or that the detector rejects as input (shorter than 250 ms, non-finite samples), count as unreadable.
- Every row needs numeric `Start`/`Stop` offsets with `Stop > Start`. With fewer than two verified speakers there is no held-out set; otherwise the lowest-ranked `ceil(20%)` of speakers by a seeded hash are held out (at least one, never all).
- The report records the detector revision (repository commit, whether tracked files other than the source-mode `Cargo.lock` had changes, and the SHA-256 of the source pins), the label-file, mapping and scored-audio SHA-256 (over each scored clip's id and WAV file hash), the detector configuration, row, processed-row and exclusion counts, missing and unreadable clips, per-kind prevalence, metrics over all scored clips and the held-out partition, and its limitations. Duplicate clip ids or mapping entries fail the run.
- The detector receives clip audio only. SEP-28k has no transcripts, so transcript-based detections cannot fire in this configuration; a transcript-assisted configuration is a separate experiment.
- Nothing is downloaded. Corpus audio and reports derived from it are never committed.

## Dataset card: SEP-28k

| Field | Value |
| --- | --- |
| Source | [apple/ml-stuttering-events-dataset](https://github.com/apple/ml-stuttering-events-dataset) ([paper](https://arxiv.org/abs/2102.12394)) |
| Annotation license | CC BY-NC 4.0 (per the dataset owner) |
| Audio rights | Podcast audio copyright stays with its owners; access to clips is not a licence for redistribution, commercial use or every training use |
| Permitted use here | Personal, non-commercial research evaluation of this project's detector. Any commercial, redistribution or training use needs its own rights review first |
| Labels | Clip-level (3 s) votes by three trained non-clinician annotators; a research annotation, not a clinician-adjudicated reference |
| Language and context | English podcast speech |
| Speaker identity | Not reliable in the original table; use a verified mapping such as SEP-28k-E for speaker-exclusive results ([speaker partitioning study](https://arxiv.org/abs/2206.03400)) |
| Limitations | No event timing; noisy and ambiguous clips are excluded by flag and counted in the report |

Runtime profiling is separate. `runtime-profiler` owns process/runtime evidence; this benchmark owns correctness semantics.
