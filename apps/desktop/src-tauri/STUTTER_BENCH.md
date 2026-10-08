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
bun run benchmark:stutter:corpus \
  --labels /path/to/SEP-28k_labels.csv \
  --clips /path/to/clips \
  [--speakers /path/to/verified-speakers.csv] \
  [--vote-threshold 2] [--limit N] [--out report.json]
```

- `--clips` uses the layout written by the dataset's download script: `<clips>/<Show>/<EpId>/<Show>_<EpId>_<ClipId>.wav`.
- `--speakers` is a verified mapping with the columns `clipId,speakerId`, where clip ids are `Show:EpId:ClipId` (for example from SEP-28k-E). The held-out metrics are speaker-exclusive only when every scored clip has a verified speaker; otherwise the report says why they are not.
- Every required SEP-28k column must be present and every vote cell must be an integer 0–3; otherwise the run fails rather than reading damaged labels as negatives. A clip counts as fluent only with an affirmative `NoStutteredWords` vote; clips with neither a stuttering kind nor that vote are excluded as `noAffirmativeLabel`. Exclusions are counted per flag (a clip can have several) and as rows. Empty `Show`/`EpId`/`ClipId` values and a missing clips directory fail the run. Clips whose decoded duration differs from the labelled `Start`–`Stop` interval by more than 5% (truncated extractions), or that the detector rejects as input (shorter than 250 ms, non-finite samples), count as unreadable.
- Every row, including excluded rows and rows whose audio is missing, needs numeric `Start`/`Stop` offsets with `Stop > Start`; repeated header names fail the run. With fewer than two verified speakers there is no held-out set; otherwise the lowest-ranked `ceil(20%)` of speakers by a seeded hash are held out (at least one, never all).
- The report records the detector revision (repository commit, whether there were uncommitted or untracked (not ignored) files other than the source-mode `Cargo.lock`, and the SHA-256 of the source pins and of the effective `Cargo.lock`, and the HEAD and local-change state of each sibling checkout compiled in source mode), the label-file, mapping and scored-audio SHA-256 (over each scored clip's id and WAV file hash), the detector configuration, row, processed-row and exclusion counts, missing and unreadable clips, per-kind prevalence, metrics over all scored clips and the held-out partition, and its limitations. Duplicate clip ids or mapping entries fail the run.
- The detector receives clip audio only. SEP-28k has no transcripts, so transcript-based detections cannot fire in this configuration; a transcript-assisted configuration is a separate experiment.
- Nothing is downloaded. Corpus audio and reports derived from it are never committed.

### Uncertainty, error review and robustness

- `allScoredIntervals` and `heldOutIntervals` are 95% percentile bootstrap intervals (1000 resamples, fixed seed `sep28k-bootstrap-v1`) for micro F1, macro F1, the fluent false-positive rate and per-kind F1. Speakers are resampled with replacement when every clip has a verified speaker (`resamplingUnit: "speaker"`), otherwise clips (`"clip"`). With fewer than two resampling units (e.g. a held-out set of one speaker) no interval is reported. The cost grows with resamples × scored clips, which is acceptable for this explicit benchmark tier.
- `errorReview` lists up to 10 false-positive and 10 false-negative clip ids per kind, chosen by a seeded hash. With a held-out partition it samples training clips only (`errorReviewScope: "train"`), so held-out errors are never reviewed during development. It holds ids only, never media, for manual listening against your own local copy.
- `challenge` (audio hashed separately in `challengeAudioSha256`) scores the robustness challenge set: clips excluded only for `poorAudioQuality`, `difficultToUnderstand` or `music`. It is reported apart from the main results and never used to choose between candidates.

### Candidate promotion criteria

Fixed before any candidate is compared with the existing detector:

1. **Protected held-out set.** Promotion decisions use only the speaker-exclusive held-out partition (seed `sep28k-partition-v1`, 20% of verified speakers). Candidates are developed and tuned on the training partition only; the held-out results of a candidate version are looked at once, recorded with its `detectorRevision`, and not used to tune that version further.
2. **Improvement must exceed uncertainty.** A candidate replaces the baseline only if its held-out macro F1 is higher and the paired bootstrap 95% interval of the difference (same resamples for both detectors) excludes zero.
3. **No hidden regressions.** No per-kind F1 and no fluent false-positive rate may get worse by more than the paired interval allows, and the challenge-set results are reported next to the main ones.
4. **Comparable inputs.** Both runs use identical label, mapping and scored-audio hashes and the same vote threshold.
5. **Calibration and abstention.** For candidates that output probabilities, the Brier rule above applies. For candidates that can abstain, coverage is reported, and abstained clips count as misses when comparing F1.

The paired-difference computation (criteria 2–3) and abstention coverage (5) are added together with the first candidate (#76).

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
