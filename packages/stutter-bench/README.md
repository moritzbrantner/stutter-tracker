# @stutter-tracker/stutter-bench

Product-owned evaluation contracts for stuttering detection.

The package deliberately contains **no corpus audio**. It normalizes external annotations into the five product event kinds, enforces speaker-safe partitioning when real speaker identities are available, and computes deterministic classification/calibration metrics. Corpus acquisition remains an explicit local step so normal installs and CI do not download multi-gigabyte datasets.

## Initial corpus contract

SEP-28k annotations map to:

- `WordRep` → `wordRepetition`
- `SoundRep` → `soundRepetition`
- `Prolongation` → `prolongation`
- `Block` → `block`
- `Interjection` → `filler`

The default importer requires a majority vote (2 of 3 annotators). Clips with majority-vote uncertainty or audio-quality flags are excluded from evaluation by default.

SEP-28k is a clip-level multi-label corpus. Therefore the first benchmark measures clip classification rather than pretending it contains exact event timestamps. Timestamp/onset error belongs to later corpora or locally curated fixtures that actually provide temporal labels.

The original SEP-28k annotation table does not provide trustworthy speaker identity for every podcast clip. The importer therefore leaves `speakerId` unset instead of fabricating identity from show or episode metadata. `speakerSafeSplit` fails closed when any item lacks a speaker ID. Use an explicit speaker map such as SEP-28k-Extended (SEP-28k-E), or another verified identity source, before claiming speaker-exclusive train/evaluation splits.

## Required reporting

Baseline/candidate reports should retain at least:

- per-kind precision, recall, and F1;
- micro precision/recall/F1;
- macro F1;
- false-positive clip rate on fluent clips;
- confidence calibration (Brier score) when probabilities are available;
- speaker count and split identity when verified speaker metadata is available.

Performance evidence belongs beside these correctness metrics but is produced by runtime-profiler scenarios rather than hidden inside the corpus evaluator.
