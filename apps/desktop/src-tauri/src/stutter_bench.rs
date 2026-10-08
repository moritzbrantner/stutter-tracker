use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::speech_analysis::{analyze_speech_session_impl, AnalyzeSpeechRequest, StutterKind};

const BENCHMARK_KINDS: [StutterKind; 5] = [
    StutterKind::WordRepetition,
    StutterKind::SoundRepetition,
    StutterKind::Prolongation,
    StutterKind::Block,
    StutterKind::Filler,
];

#[derive(Debug, thiserror::Error)]
pub(crate) enum BenchmarkError {
    #[error("vote threshold must be between 1 and 3")]
    InvalidVoteThreshold,
    #[error("evaluation fraction must be between 0 and 1")]
    InvalidEvaluationFraction,
    #[error("benchmark clip `{0}` has an invalid duration")]
    InvalidDuration(String),
    #[error("speaker-safe splitting requires explicit speaker metadata for every clip")]
    MissingSpeaker,
    #[error("clip `{clip_id}` is missing a complete probability vector")]
    IncompleteProbabilityVector { clip_id: String },
    #[error("probability for {kind:?} in clip `{clip_id}` must be between 0 and 1")]
    InvalidProbability { clip_id: String, kind: StutterKind },
    #[error("existing detector baseline failed: {0}")]
    Detector(String),
    #[error("cannot read {path}: {message}")]
    Io { path: String, message: String },
    #[error("{path}:{line}: {message}")]
    Csv {
        path: String,
        line: usize,
        message: String,
    },
    #[error("corpus manifest lists clip `{0}` more than once")]
    DuplicateClip(String),
    #[error("speaker mapping lists clip `{0}` more than once")]
    DuplicateSpeakerMapping(String),
}

#[derive(Debug, Clone)]
struct BenchmarkClip {
    id: String,
    speaker_id: Option<String>,
    duration_seconds: f64,
    reference_kinds: Vec<StutterKind>,
    predicted_kinds: Vec<StutterKind>,
    predicted_probabilities: Option<HashMap<StutterKind, f64>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindMetrics {
    true_positive: usize,
    false_positive: usize,
    false_negative: usize,
    true_negative: usize,
    precision: f64,
    recall: f64,
    f1: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    clip_count: usize,
    speaker_count: usize,
    micro_precision: f64,
    micro_recall: f64,
    micro_f1: f64,
    macro_f1: f64,
    false_positive_clip_rate: f64,
    brier_score: Option<f64>,
    #[serde(serialize_with = "serialize_by_kind")]
    by_kind: HashMap<StutterKind, KindMetrics>,
}

type Sep28kRow = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Sep28kFlags {
    no_stutter: bool,
    unsure: bool,
    poor_audio_quality: bool,
    difficult_to_understand: bool,
    natural_pause: bool,
    music: bool,
    no_speech: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Sep28kManifestEntry {
    id: String,
    show: String,
    episode_id: String,
    clip_id: String,
    start_sample: Option<u64>,
    stop_sample: Option<u64>,
    speaker_id: Option<String>,
    reference_kinds: Vec<StutterKind>,
    annotation_votes: HashMap<StutterKind, u8>,
    flags: Sep28kFlags,
}

#[derive(Debug, Clone)]
struct BaselineCase {
    id: String,
    speaker_id: Option<String>,
    reference_kinds: Vec<StutterKind>,
    request: AnalyzeSpeechRequest,
}

fn normalize_sep28k_row(
    row: &Sep28kRow,
    vote_threshold: u8,
    speaker_id: Option<&str>,
) -> Result<Sep28kManifestEntry, BenchmarkError> {
    if !(1..=3).contains(&vote_threshold) {
        return Err(BenchmarkError::InvalidVoteThreshold);
    }

    let show = first(row, &["Show", "show"]).unwrap_or("unknown-show");
    let episode_id = first(row, &["EpId", "episodeId", "episode_id"]).unwrap_or("unknown-episode");
    let clip_id = first(row, &["ClipId", "clipId", "clip_id"]).unwrap_or("unknown-clip");
    let speaker_id = speaker_id.map(str::to_owned).or_else(|| {
        first(row, &["speaker", "Speaker", "speakerId", "speaker_id"]).map(str::to_owned)
    });

    let annotation_votes = BENCHMARK_KINDS
        .into_iter()
        .map(|kind| (kind, sep28k_votes(row, kind)))
        .collect::<HashMap<_, _>>();
    let reference_kinds = BENCHMARK_KINDS
        .into_iter()
        .filter(|kind| annotation_votes.get(kind).copied().unwrap_or_default() >= vote_threshold)
        .collect();

    Ok(Sep28kManifestEntry {
        id: format!("{show}:{episode_id}:{clip_id}"),
        show: show.to_owned(),
        episode_id: episode_id.to_owned(),
        clip_id: clip_id.to_owned(),
        start_sample: unsigned(row, &["Start", "start"]),
        stop_sample: unsigned(row, &["Stop", "stop"]),
        speaker_id,
        reference_kinds,
        annotation_votes,
        flags: Sep28kFlags {
            no_stutter: selected(
                row,
                &["NoStutteredWords", "NoStutter", "No Stuttered Words"],
                vote_threshold,
            ),
            unsure: selected(row, &["Unsure"], vote_threshold),
            poor_audio_quality: selected(
                row,
                &["PoorAudioQuality", "Poor Audio Quality"],
                vote_threshold,
            ),
            difficult_to_understand: selected(
                row,
                &["DifficultToUnderstand", "Difficult To Understand"],
                vote_threshold,
            ),
            natural_pause: selected(row, &["NaturalPause", "Natural Pause"], vote_threshold),
            music: selected(row, &["Music"], vote_threshold),
            no_speech: selected(row, &["NoSpeech", "No Speech"], vote_threshold),
        },
    })
}

fn should_evaluate_sep28k(entry: &Sep28kManifestEntry) -> bool {
    !(entry.flags.unsure
        || entry.flags.poor_audio_quality
        || entry.flags.difficult_to_understand
        || entry.flags.music
        || entry.flags.no_speech)
}

fn evaluate_clips(clips: &[BenchmarkClip]) -> Result<BenchmarkReport, BenchmarkError> {
    let mut by_kind = BENCHMARK_KINDS
        .into_iter()
        .map(|kind| (kind, KindMetrics::default()))
        .collect::<HashMap<_, _>>();
    let score_calibration = clips
        .iter()
        .any(|clip| clip.predicted_probabilities.is_some());
    let mut false_positive_fluent_clips = 0_usize;
    let mut fluent_clip_count = 0_usize;
    let mut brier_sum = 0.0_f64;

    for clip in clips {
        if !clip.duration_seconds.is_finite() || clip.duration_seconds <= 0.0 {
            return Err(BenchmarkError::InvalidDuration(clip.id.clone()));
        }

        let references = clip.reference_kinds.iter().copied().collect::<HashSet<_>>();
        let predictions = clip.predicted_kinds.iter().copied().collect::<HashSet<_>>();
        if references.is_empty() {
            fluent_clip_count += 1;
            if !predictions.is_empty() {
                false_positive_fluent_clips += 1;
            }
        }

        let probabilities = if score_calibration {
            Some(clip.predicted_probabilities.as_ref().ok_or_else(|| {
                BenchmarkError::IncompleteProbabilityVector {
                    clip_id: clip.id.clone(),
                }
            })?)
        } else {
            None
        };

        for kind in BENCHMARK_KINDS {
            let expected = references.contains(&kind);
            let predicted = predictions.contains(&kind);
            let metrics = by_kind
                .get_mut(&kind)
                .expect("all benchmark kinds are initialized");
            match (expected, predicted) {
                (true, true) => metrics.true_positive += 1,
                (false, true) => metrics.false_positive += 1,
                (true, false) => metrics.false_negative += 1,
                (false, false) => metrics.true_negative += 1,
            }

            if let Some(probabilities) = probabilities {
                let probability = probabilities.get(&kind).copied().ok_or_else(|| {
                    BenchmarkError::IncompleteProbabilityVector {
                        clip_id: clip.id.clone(),
                    }
                })?;
                if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
                    return Err(BenchmarkError::InvalidProbability {
                        clip_id: clip.id.clone(),
                        kind,
                    });
                }
                brier_sum += (probability - if expected { 1.0 } else { 0.0 }).powi(2);
            }
        }
    }

    let mut true_positive = 0_usize;
    let mut false_positive = 0_usize;
    let mut false_negative = 0_usize;
    for kind in BENCHMARK_KINDS {
        let metrics = by_kind
            .get_mut(&kind)
            .expect("all benchmark kinds are initialized");
        metrics.precision = ratio(
            metrics.true_positive,
            metrics.true_positive + metrics.false_positive,
        );
        metrics.recall = ratio(
            metrics.true_positive,
            metrics.true_positive + metrics.false_negative,
        );
        metrics.f1 = f1(metrics.precision, metrics.recall);
        true_positive += metrics.true_positive;
        false_positive += metrics.false_positive;
        false_negative += metrics.false_negative;
    }

    let micro_precision = ratio(true_positive, true_positive + false_positive);
    let micro_recall = ratio(true_positive, true_positive + false_negative);
    let speaker_count = clips
        .iter()
        .filter_map(|clip| clip.speaker_id.as_deref())
        .collect::<HashSet<_>>()
        .len();

    Ok(BenchmarkReport {
        clip_count: clips.len(),
        speaker_count,
        micro_precision,
        micro_recall,
        micro_f1: f1(micro_precision, micro_recall),
        macro_f1: BENCHMARK_KINDS
            .into_iter()
            .map(|kind| by_kind.get(&kind).expect("benchmark kind exists").f1)
            .sum::<f64>()
            / BENCHMARK_KINDS.len() as f64,
        false_positive_clip_rate: ratio(false_positive_fluent_clips, fluent_clip_count),
        brier_score: score_calibration
            .then(|| ratio_f64(brier_sum, clips.len().saturating_mul(BENCHMARK_KINDS.len()))),
        by_kind,
    })
}

fn speaker_safe_split(
    clips: &[BenchmarkClip],
    evaluation_fraction: f64,
    seed: &str,
) -> Result<(Vec<BenchmarkClip>, Vec<BenchmarkClip>), BenchmarkError> {
    if !evaluation_fraction.is_finite()
        || !(0.0..1.0).contains(&evaluation_fraction)
        || evaluation_fraction == 0.0
    {
        return Err(BenchmarkError::InvalidEvaluationFraction);
    }

    let mut train = Vec::new();
    let mut evaluation = Vec::new();
    for clip in clips {
        let speaker_id = clip
            .speaker_id
            .as_deref()
            .map(str::trim)
            .filter(|speaker| !speaker.is_empty())
            .ok_or(BenchmarkError::MissingSpeaker)?;
        let bucket = stable_hash(&format!("{seed}:{speaker_id}")) as f64 / 4_294_967_296.0;
        if bucket < evaluation_fraction {
            evaluation.push(clip.clone());
        } else {
            train.push(clip.clone());
        }
    }
    Ok((train, evaluation))
}

fn evaluate_existing_detector(cases: &[BaselineCase]) -> Result<BenchmarkReport, BenchmarkError> {
    let mut clips = Vec::with_capacity(cases.len());
    for case in cases {
        let report = analyze_speech_session_impl(case.request.clone())
            .map_err(|error| BenchmarkError::Detector(error.to_string()))?;
        let observed = report
            .events
            .iter()
            .map(|event| event.kind)
            .collect::<HashSet<_>>();
        let predicted_kinds = BENCHMARK_KINDS
            .into_iter()
            .filter(|kind| observed.contains(kind))
            .collect();
        clips.push(BenchmarkClip {
            id: case.id.clone(),
            speaker_id: case.speaker_id.clone(),
            duration_seconds: report.total_duration_seconds.max(0.001),
            reference_kinds: case.reference_kinds.clone(),
            predicted_kinds,
            predicted_probabilities: None,
        });
    }
    evaluate_clips(&clips)
}

fn sep28k_votes(row: &Sep28kRow, kind: StutterKind) -> u8 {
    let columns: &[&str] = match kind {
        StutterKind::WordRepetition => &["WordRep", "WordRepetition"],
        StutterKind::SoundRepetition => &["SoundRep", "SoundRepetition"],
        StutterKind::Prolongation => &["Prolongation"],
        StutterKind::Block => &["Block"],
        StutterKind::Filler => &["Interjection", "Filler"],
    };
    vote(row, columns)
}

fn selected(row: &Sep28kRow, columns: &[&str], threshold: u8) -> bool {
    vote(row, columns) >= threshold
}

fn vote(row: &Sep28kRow, columns: &[&str]) -> u8 {
    first(row, columns)
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or_default()
}

fn unsigned(row: &Sep28kRow, columns: &[&str]) -> Option<u64> {
    first(row, columns).and_then(|value| value.parse::<u64>().ok())
}

fn first<'a>(row: &'a Sep28kRow, columns: &[&str]) -> Option<&'a str> {
    columns.iter().find_map(|column| {
        row.get(*column)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    })
}

fn stable_hash(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn ratio_f64(numerator: f64, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator / denominator as f64
    }
}

fn f1(precision: f64, recall: f64) -> f64 {
    if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    }
}

// ---------------------------------------------------------------------------------------------
// Filesystem corpus runner. Reads a SEP-28k label CSV and locally provided clip audio, runs the
// existing detector and emits a scored report. It never downloads corpus media.
// ---------------------------------------------------------------------------------------------

const DEFAULT_EVALUATION_FRACTION: f64 = 0.2;
const PARTITION_SEED: &str = "sep28k-partition-v1";
const LISTED_ID_LIMIT: usize = 20;

#[derive(Debug, Clone)]
pub(crate) struct CorpusRunOptions {
    pub(crate) labels_csv: PathBuf,
    pub(crate) clips_dir: PathBuf,
    /// Verified clip → speaker mapping (`clipId,speakerId`, clip ids as `Show:EpId:ClipId`).
    pub(crate) speakers_csv: Option<PathBuf>,
    pub(crate) vote_threshold: u8,
    pub(crate) limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CorpusRunReport {
    schema_version: u32,
    corpus: CorpusIdentity,
    configuration: RunConfiguration,
    counts: CorpusCounts,
    /// Reference positives and detector predictions per kind over the scored clips.
    prevalence: BTreeMap<String, KindPrevalence>,
    partition: PartitionSummary,
    /// Metrics over every scored clip. The detector is not trained on this corpus.
    all_scored: Option<BenchmarkReport>,
    /// Metrics over the speaker-exclusive held-out partition, when a verified mapping exists.
    held_out: Option<BenchmarkReport>,
    missing_clip_ids: Vec<String>,
    unreadable_clip_ids: Vec<String>,
    limitations: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusIdentity {
    name: &'static str,
    labels_sha256: String,
    label_rows: usize,
    speaker_mapping_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunConfiguration {
    detector: &'static str,
    detector_input: &'static str,
    vote_threshold: u8,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusCounts {
    rows: usize,
    excluded: BTreeMap<&'static str, usize>,
    missing_audio: usize,
    unreadable_audio: usize,
    scored: usize,
    fluent_scored: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindPrevalence {
    reference: usize,
    predicted: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum PartitionSummary {
    /// No verified mapping: results are not speaker-exclusive and say so.
    NotSpeakerExclusive { reason: String },
    SpeakerExclusive {
        seed: &'static str,
        evaluation_fraction: f64,
        train_clips: usize,
        evaluation_clips: usize,
        train_speakers: usize,
        evaluation_speakers: usize,
    },
}

pub(crate) fn run_sep28k_corpus(
    options: &CorpusRunOptions,
) -> Result<CorpusRunReport, BenchmarkError> {
    let labels = read_file(&options.labels_csv)?;
    let rows = parse_csv(&labels, &options.labels_csv)?;
    let speaker_file = options
        .speakers_csv
        .as_ref()
        .map(|path| read_file(path).map(|text| (path, text)))
        .transpose()?;
    let speakers = speaker_file
        .as_ref()
        .map(|(path, text)| parse_speaker_mapping(text, path))
        .transpose()?;

    let mut counts = CorpusCounts {
        rows: rows.len(),
        ..CorpusCounts::default()
    };
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    let mut unreadable = Vec::new();
    let mut clips = Vec::new();
    for row in rows.iter().take(options.limit.unwrap_or(usize::MAX)) {
        let mut entry = normalize_sep28k_row(row, options.vote_threshold, None)?;
        if !seen.insert(entry.id.clone()) {
            return Err(BenchmarkError::DuplicateClip(entry.id));
        }
        entry.speaker_id = speakers
            .as_ref()
            .and_then(|mapping| mapping.get(&entry.id).cloned());
        if let Some(reason) = exclusion_reason(&entry) {
            *counts.excluded.entry(reason).or_default() += 1;
            continue;
        }
        let path = sep28k_clip_path(&options.clips_dir, &entry);
        if !path.is_file() {
            counts.missing_audio += 1;
            missing.push(entry.id);
            continue;
        }
        let Ok((samples, sample_rate)) = read_mono_wav(&path) else {
            counts.unreadable_audio += 1;
            unreadable.push(entry.id);
            continue;
        };
        if samples.is_empty() {
            counts.unreadable_audio += 1;
            unreadable.push(entry.id);
            continue;
        }
        let duration_seconds = samples.len() as f64 / f64::from(sample_rate);
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: Vec::new(),
            session_started_at: None,
            samples: Some(samples),
            sample_rate: Some(sample_rate),
        })
        .map_err(|error| BenchmarkError::Detector(error.to_string()))?;
        let observed = report
            .events
            .iter()
            .map(|event| event.kind)
            .collect::<HashSet<_>>();
        clips.push(BenchmarkClip {
            id: entry.id,
            speaker_id: entry.speaker_id,
            duration_seconds,
            reference_kinds: entry.reference_kinds,
            predicted_kinds: BENCHMARK_KINDS
                .into_iter()
                .filter(|kind| observed.contains(kind))
                .collect(),
            predicted_probabilities: None,
        });
    }

    counts.scored = clips.len();
    counts.fluent_scored = clips
        .iter()
        .filter(|clip| clip.reference_kinds.is_empty())
        .count();
    let prevalence = BENCHMARK_KINDS
        .into_iter()
        .map(|kind| {
            (
                kind_name(kind).to_owned(),
                KindPrevalence {
                    reference: clips
                        .iter()
                        .filter(|clip| clip.reference_kinds.contains(&kind))
                        .count(),
                    predicted: clips
                        .iter()
                        .filter(|clip| clip.predicted_kinds.contains(&kind))
                        .count(),
                },
            )
        })
        .collect();

    let (partition, held_out) = match &speakers {
        None => (
            PartitionSummary::NotSpeakerExclusive {
                reason: "no verified speaker mapping was supplied".to_owned(),
            },
            None,
        ),
        Some(_) if clips.iter().any(|clip| clip.speaker_id.is_none()) => (
            PartitionSummary::NotSpeakerExclusive {
                reason: format!(
                    "{} scored clips have no verified speaker",
                    clips
                        .iter()
                        .filter(|clip| clip.speaker_id.is_none())
                        .count()
                ),
            },
            None,
        ),
        Some(_) => {
            let (train, evaluation) =
                speaker_safe_split(&clips, DEFAULT_EVALUATION_FRACTION, PARTITION_SEED)?;
            let summary = PartitionSummary::SpeakerExclusive {
                seed: PARTITION_SEED,
                evaluation_fraction: DEFAULT_EVALUATION_FRACTION,
                train_clips: train.len(),
                evaluation_clips: evaluation.len(),
                train_speakers: speaker_count(&train),
                evaluation_speakers: speaker_count(&evaluation),
            };
            let held_out = (!evaluation.is_empty())
                .then(|| evaluate_clips(&evaluation))
                .transpose()?;
            (summary, held_out)
        }
    };

    missing.sort();
    unreadable.sort();
    Ok(CorpusRunReport {
        schema_version: 1,
        corpus: CorpusIdentity {
            name: "SEP-28k",
            labels_sha256: sha256_hex(labels.as_bytes()),
            label_rows: rows.len(),
            speaker_mapping_sha256: speaker_file
                .as_ref()
                .map(|(_, text)| sha256_hex(text.as_bytes())),
        },
        configuration: RunConfiguration {
            detector: "existing-detector",
            detector_input: "clip audio only; no transcript",
            vote_threshold: options.vote_threshold,
            limit: options.limit,
        },
        counts,
        prevalence,
        partition,
        all_scored: (!clips.is_empty())
            .then(|| evaluate_clips(&clips))
            .transpose()?,
        held_out,
        missing_clip_ids: missing.into_iter().take(LISTED_ID_LIMIT).collect(),
        unreadable_clip_ids: unreadable.into_iter().take(LISTED_ID_LIMIT).collect(),
        limitations: vec![
            "SEP-28k labels are clip-level votes by non-clinician annotators, not a clinical reference.",
            "Clip classification only; no event timing is evaluated.",
            "The detector receives clip audio without a transcript, so transcript-based detections cannot fire.",
            "Precision, recall and F1 are 0 when their denominator is 0; check prevalence before reading them.",
            "No confidence intervals yet.",
        ],
    })
}

fn exclusion_reason(entry: &Sep28kManifestEntry) -> Option<&'static str> {
    let flags = &entry.flags;
    [
        (flags.unsure, "unsure"),
        (flags.poor_audio_quality, "poorAudioQuality"),
        (flags.difficult_to_understand, "difficultToUnderstand"),
        (flags.music, "music"),
        (flags.no_speech, "noSpeech"),
    ]
    .into_iter()
    .find_map(|(flagged, reason)| flagged.then_some(reason))
}

/// Layout written by the dataset's own download script: `clips/<Show>/<EpId>/<Show>_<EpId>_<ClipId>.wav`.
fn sep28k_clip_path(clips_dir: &Path, entry: &Sep28kManifestEntry) -> PathBuf {
    clips_dir
        .join(&entry.show)
        .join(&entry.episode_id)
        .join(format!(
            "{}_{}_{}.wav",
            entry.show, entry.episode_id, entry.clip_id
        ))
}

fn read_mono_wav(path: &Path) -> Result<(Vec<f32>, u32), hound::Error> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let interleaved = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 2_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

/// Minimal CSV reader for the dataset's plain comma-separated files; quoted fields are rejected
/// rather than misparsed.
fn parse_csv(text: &str, path: &Path) -> Result<Vec<Sep28kRow>, BenchmarkError> {
    let mut lines = text
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty());
    let Some((_, header)) = lines.next() else {
        return Ok(Vec::new());
    };
    let columns = header
        .split(',')
        .map(|column| column.trim().to_owned())
        .collect::<Vec<_>>();
    lines
        .map(|(index, line)| {
            let error = |message: &str| BenchmarkError::Csv {
                path: path.display().to_string(),
                line: index + 1,
                message: message.to_owned(),
            };
            if line.contains('"') {
                return Err(error("quoted fields are not supported"));
            }
            let values = line.split(',').map(str::trim).collect::<Vec<_>>();
            if values.len() != columns.len() {
                return Err(error("field count does not match the header"));
            }
            Ok(columns
                .iter()
                .cloned()
                .zip(values.into_iter().map(str::to_owned))
                .collect())
        })
        .collect()
}

fn parse_speaker_mapping(
    text: &str,
    path: &Path,
) -> Result<HashMap<String, String>, BenchmarkError> {
    let mut mapping = HashMap::new();
    for row in parse_csv(text, path)? {
        let clip = first(&row, &["clipId", "clip_id"]);
        let speaker = first(&row, &["speakerId", "speaker_id"]);
        let (Some(clip), Some(speaker)) = (clip, speaker) else {
            continue;
        };
        if mapping
            .insert(clip.to_owned(), speaker.to_owned())
            .is_some()
        {
            return Err(BenchmarkError::DuplicateSpeakerMapping(clip.to_owned()));
        }
    }
    Ok(mapping)
}

fn read_file(path: &Path) -> Result<String, BenchmarkError> {
    std::fs::read_to_string(path).map_err(|error| BenchmarkError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

fn speaker_count(clips: &[BenchmarkClip]) -> usize {
    clips
        .iter()
        .filter_map(|clip| clip.speaker_id.as_deref())
        .collect::<HashSet<_>>()
        .len()
}

fn kind_name(kind: StutterKind) -> &'static str {
    match kind {
        StutterKind::WordRepetition => "wordRepetition",
        StutterKind::SoundRepetition => "soundRepetition",
        StutterKind::Prolongation => "prolongation",
        StutterKind::Block => "block",
        StutterKind::Filler => "filler",
    }
}

/// Kind order is fixed so identical runs serialize identically.
fn serialize_by_kind<S: serde::Serializer>(
    by_kind: &HashMap<StutterKind, KindMetrics>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(
        BENCHMARK_KINDS
            .into_iter()
            .filter_map(|kind| by_kind.get(&kind).map(|metrics| (kind_name(kind), metrics))),
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_analysis::TranscriptSegmentInput;

    fn row(entries: &[(&str, &str)]) -> Sep28kRow {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn clip(
        id: &str,
        speaker_id: Option<&str>,
        reference_kinds: Vec<StutterKind>,
        predicted_kinds: Vec<StutterKind>,
    ) -> BenchmarkClip {
        BenchmarkClip {
            id: id.to_owned(),
            speaker_id: speaker_id.map(str::to_owned),
            duration_seconds: 3.0,
            reference_kinds,
            predicted_kinds,
            predicted_probabilities: None,
        }
    }

    fn complete_probabilities(default: f64) -> HashMap<StutterKind, f64> {
        BENCHMARK_KINDS
            .into_iter()
            .map(|kind| (kind, default))
            .collect()
    }

    #[test]
    fn sep28k_normalization_uses_the_product_taxonomy_and_real_no_stutter_column() {
        let input = row(&[
            ("Show", "HeStutters"),
            ("EpId", "7"),
            ("ClipId", "12"),
            ("Start", "48000"),
            ("Stop", "192000"),
            ("WordRep", "2"),
            ("SoundRep", "1"),
            ("Prolongation", "3"),
            ("Block", "0"),
            ("Interjection", "2"),
            ("NoStutteredWords", "2"),
        ]);

        let entry = normalize_sep28k_row(&input, 2, Some("speaker-17")).unwrap();
        assert_eq!(entry.id, "HeStutters:7:12");
        assert_eq!(entry.show, "HeStutters");
        assert_eq!(entry.episode_id, "7");
        assert_eq!(entry.clip_id, "12");
        assert_eq!(entry.start_sample, Some(48_000));
        assert_eq!(entry.stop_sample, Some(192_000));
        assert_eq!(entry.speaker_id.as_deref(), Some("speaker-17"));
        assert_eq!(
            entry.reference_kinds,
            vec![
                StutterKind::WordRepetition,
                StutterKind::Prolongation,
                StutterKind::Filler,
            ]
        );
        assert_eq!(entry.annotation_votes[&StutterKind::SoundRepetition], 1);
        assert!(entry.flags.no_stutter);
        assert!(!entry.flags.unsure);
        assert!(!entry.flags.poor_audio_quality);
        assert!(!entry.flags.difficult_to_understand);
        assert!(!entry.flags.natural_pause);
        assert!(!entry.flags.music);
        assert!(!entry.flags.no_speech);
        assert!(should_evaluate_sep28k(&entry));
    }

    #[test]
    fn sep28k_quality_flags_fail_closed_for_evaluation() {
        let input = row(&[
            ("Show", "show"),
            ("EpId", "1"),
            ("ClipId", "2"),
            ("PoorAudioQuality", "2"),
        ]);
        let entry = normalize_sep28k_row(&input, 2, None).unwrap();
        assert!(!should_evaluate_sep28k(&entry));
    }

    #[test]
    fn fluent_false_positive_rate_uses_only_fluent_clips_as_the_denominator() {
        let report = evaluate_clips(&[
            clip(
                "a",
                Some("speaker-a"),
                vec![StutterKind::WordRepetition],
                vec![StutterKind::WordRepetition],
            ),
            clip(
                "b",
                Some("speaker-b"),
                vec![StutterKind::Block],
                vec![StutterKind::Filler],
            ),
            clip("c", Some("speaker-c"), vec![], vec![StutterKind::Filler]),
        ])
        .unwrap();

        assert_eq!(report.clip_count, 3);
        assert_eq!(report.speaker_count, 3);
        assert_eq!(report.false_positive_clip_rate, 1.0);
        assert_eq!(report.by_kind[&StutterKind::WordRepetition].f1, 1.0);
        assert_eq!(report.by_kind[&StutterKind::Block].false_negative, 1);
        assert_eq!(report.by_kind[&StutterKind::Filler].false_positive, 2);
        assert!(report.micro_precision < 1.0);
        assert!(report.micro_recall < 1.0);
        assert!(report.micro_f1 < 1.0);
        assert!(report.macro_f1 < 1.0);
        assert_eq!(report.brier_score, None);
    }

    #[test]
    fn calibration_requires_a_complete_vector_for_every_scored_clip() {
        let mut incomplete = HashMap::new();
        incomplete.insert(StutterKind::WordRepetition, 0.9);
        let mut first = clip(
            "a",
            Some("speaker-a"),
            vec![StutterKind::WordRepetition],
            vec![StutterKind::WordRepetition],
        );
        first.predicted_probabilities = Some(incomplete);
        let second = clip("b", Some("speaker-b"), vec![], vec![]);

        assert!(matches!(
            evaluate_clips(&[first, second]),
            Err(BenchmarkError::IncompleteProbabilityVector { .. })
        ));
    }

    #[test]
    fn calibration_scores_all_five_product_classes() {
        let mut probabilities = complete_probabilities(0.1);
        probabilities.insert(StutterKind::WordRepetition, 0.9);
        let mut item = clip(
            "a",
            Some("speaker-a"),
            vec![StutterKind::WordRepetition],
            vec![StutterKind::WordRepetition],
        );
        item.predicted_probabilities = Some(probabilities);

        let report = evaluate_clips(&[item]).unwrap();
        assert!(report
            .brier_score
            .is_some_and(|score| score > 0.0 && score < 0.1));
    }

    #[test]
    fn speaker_safe_split_rejects_missing_identity_and_never_leaks_a_speaker() {
        assert!(matches!(
            speaker_safe_split(&[clip("missing", None, vec![], vec![])], 0.2, "fixture"),
            Err(BenchmarkError::MissingSpeaker)
        ));

        let clips = (0..20)
            .map(|index| {
                clip(
                    &format!("clip-{index}"),
                    Some(&format!("speaker-{}", index / 2)),
                    vec![],
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        let (train, evaluation) = speaker_safe_split(&clips, 0.35, "fixture").unwrap();
        let train_speakers = train
            .iter()
            .filter_map(|item| item.speaker_id.as_deref())
            .collect::<HashSet<_>>();
        let evaluation_speakers = evaluation
            .iter()
            .filter_map(|item| item.speaker_id.as_deref())
            .collect::<HashSet<_>>();
        assert!(train_speakers.is_disjoint(&evaluation_speakers));
        assert_eq!(train.len() + evaluation.len(), clips.len());
    }

    #[test]
    fn existing_detector_is_the_initial_benchmark_baseline() {
        let report = evaluate_existing_detector(&[BaselineCase {
            id: "baseline".to_owned(),
            speaker_id: Some("speaker-a".to_owned()),
            reference_kinds: vec![StutterKind::WordRepetition],
            request: AnalyzeSpeechRequest {
                segments: vec![TranscriptSegmentInput {
                    text: "I I want to explain this clearly".to_owned(),
                    start_seconds: 0.0,
                    end_seconds: 2.0,
                    confidence: Some(0.95),
                    speaker_score: Some(0.98),
                    is_final: true,
                }],
                pauses: vec![],
                session_started_at: None,
                samples: None,
                sample_rate: None,
            },
        }])
        .unwrap();

        assert_eq!(report.clip_count, 1);
        assert_eq!(report.speaker_count, 1);
        assert_eq!(report.by_kind.len(), BENCHMARK_KINDS.len());
    }

    // Synthetic corpus fixture: labels, a clip directory in the SEP-28k layout and generated
    // audio. No real corpus media is used.
    struct FixtureCorpus {
        root: PathBuf,
    }

    impl FixtureCorpus {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "stutter-bench-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(root.join("clips")).unwrap();
            Self { root }
        }

        fn labels(&self, rows: &[&str]) -> PathBuf {
            let header = "Show,EpId,ClipId,Start,Stop,Unsure,PoorAudioQuality,Prolongation,Block,SoundRep,WordRep,DifficultToUnderstand,Interjection,NoStutteredWords,NaturalPause,Music,NoSpeech";
            let path = self.root.join("labels.csv");
            std::fs::write(&path, format!("{header}\n{}\n", rows.join("\n"))).unwrap();
            path
        }

        fn speakers(&self, rows: &[(&str, &str)]) -> PathBuf {
            let path = self.root.join("speakers.csv");
            let body = rows
                .iter()
                .map(|(clip, speaker)| format!("{clip},{speaker}"))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(&path, format!("clipId,speakerId\n{body}\n")).unwrap();
            path
        }

        fn clip_path(&self, show: &str, episode: &str, clip: &str) -> PathBuf {
            let dir = self.root.join("clips").join(show).join(episode);
            std::fs::create_dir_all(&dir).unwrap();
            dir.join(format!("{show}_{episode}_{clip}.wav"))
        }

        fn wav(&self, show: &str, episode: &str, clip: &str, tone_hz: Option<f32>) {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer =
                hound::WavWriter::create(self.clip_path(show, episode, clip), spec).unwrap();
            for index in 0..48_000 {
                let value = tone_hz.map_or(0.0, |hz| {
                    0.3 * (2.0 * std::f32::consts::PI * hz * index as f32 / 16_000.0).sin()
                });
                writer.write_sample((value * 32_767.0) as i16).unwrap();
            }
            writer.finalize().unwrap();
        }

        fn options(&self, labels: PathBuf, speakers: Option<PathBuf>) -> CorpusRunOptions {
            CorpusRunOptions {
                labels_csv: labels,
                clips_dir: self.root.join("clips"),
                speakers_csv: speakers,
                vote_threshold: 2,
                limit: None,
            }
        }
    }

    impl Drop for FixtureCorpus {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    const FLUENT: &str = "show,1,1,0,48000,0,0,0,0,0,0,0,0,3,0,0,0";
    const PROLONGATION: &str = "show,1,2,0,48000,0,0,3,0,0,0,0,0,0,0,0,0";
    const POOR_AUDIO: &str = "show,1,3,0,48000,0,2,0,0,0,0,0,0,0,0,0,0";
    const MISSING: &str = "show,2,4,0,48000,0,0,0,2,0,0,0,0,0,0,0,0";
    const CORRUPT: &str = "show,2,5,0,48000,0,0,0,0,0,0,0,0,3,0,0,0";

    fn standard_fixture(name: &str) -> (FixtureCorpus, PathBuf) {
        let corpus = FixtureCorpus::new(name);
        corpus.wav("show", "1", "1", None);
        corpus.wav("show", "1", "2", Some(220.0));
        std::fs::write(corpus.clip_path("show", "2", "5"), b"not a wav file").unwrap();
        let labels = corpus.labels(&[FLUENT, PROLONGATION, POOR_AUDIO, MISSING, CORRUPT]);
        (corpus, labels)
    }

    #[test]
    fn corpus_runner_scores_local_clips_and_accounts_for_every_row() {
        let (corpus, labels) = standard_fixture("accounting");
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();

        assert_eq!(report.counts.rows, 5);
        assert_eq!(report.counts.excluded.get("poorAudioQuality"), Some(&1));
        assert_eq!(report.counts.missing_audio, 1);
        assert_eq!(report.counts.unreadable_audio, 1);
        assert_eq!(report.counts.scored, 2);
        assert_eq!(report.counts.fluent_scored, 1);
        assert_eq!(report.missing_clip_ids, vec!["show:2:4".to_owned()]);
        assert_eq!(report.unreadable_clip_ids, vec!["show:2:5".to_owned()]);
        assert_eq!(report.prevalence["prolongation"].reference, 1);
        assert_eq!(report.prevalence["block"].reference, 0);
        let all = report.all_scored.as_ref().unwrap();
        assert_eq!(all.clip_count, 2);
        assert_eq!(all.by_kind.len(), BENCHMARK_KINDS.len());
        assert_eq!(report.corpus.labels_sha256.len(), 64);
        assert!(matches!(
            report.partition,
            PartitionSummary::NotSpeakerExclusive { .. }
        ));
        assert!(report.held_out.is_none());
    }

    #[test]
    fn corpus_runner_output_is_deterministic() {
        let (corpus, labels) = standard_fixture("deterministic");
        let options = corpus.options(labels, None);
        let first = serde_json::to_string(&run_sep28k_corpus(&options).unwrap()).unwrap();
        let second = serde_json::to_string(&run_sep28k_corpus(&options).unwrap()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn corpus_runner_partitions_only_with_a_complete_verified_speaker_mapping() {
        let corpus = FixtureCorpus::new("speakers");
        let mut rows = Vec::new();
        let mut mapping = Vec::new();
        for clip in 0..12 {
            corpus.wav("show", "1", &clip.to_string(), None);
            rows.push(format!("show,1,{clip},0,48000,0,0,0,0,0,0,0,0,3,0,0,0"));
            mapping.push((format!("show:1:{clip}"), format!("speaker-{}", clip / 2)));
        }
        let rows = rows.iter().map(String::as_str).collect::<Vec<_>>();
        let labels = corpus.labels(&rows);
        let pairs = mapping
            .iter()
            .map(|(clip, speaker)| (clip.as_str(), speaker.as_str()))
            .collect::<Vec<_>>();

        let complete =
            run_sep28k_corpus(&corpus.options(labels.clone(), Some(corpus.speakers(&pairs))))
                .unwrap();
        let PartitionSummary::SpeakerExclusive {
            train_clips,
            evaluation_clips,
            train_speakers,
            evaluation_speakers,
            ..
        } = complete.partition
        else {
            panic!("expected a speaker-exclusive partition");
        };
        assert_eq!(train_clips + evaluation_clips, 12);
        assert_eq!(train_speakers + evaluation_speakers, 6);
        assert!(complete.corpus.speaker_mapping_sha256.is_some());

        let partial =
            run_sep28k_corpus(&corpus.options(labels, Some(corpus.speakers(&pairs[1..])))).unwrap();
        assert!(matches!(
            partial.partition,
            PartitionSummary::NotSpeakerExclusive { ref reason } if reason.contains("1 scored clips")
        ));
        assert!(partial.held_out.is_none());
    }

    #[test]
    fn corpus_runner_rejects_duplicate_clips_and_mappings() {
        let corpus = FixtureCorpus::new("duplicates");
        let labels = corpus.labels(&[FLUENT, FLUENT]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(labels, None)),
            Err(BenchmarkError::DuplicateClip(id)) if id == "show:1:1"
        ));

        let labels = corpus.labels(&[FLUENT]);
        let speakers = corpus.speakers(&[("show:1:1", "a"), ("show:1:1", "b")]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(labels, Some(speakers))),
            Err(BenchmarkError::DuplicateSpeakerMapping(_))
        ));
    }

    #[test]
    fn corpus_runner_rejects_csv_it_cannot_parse_faithfully() {
        let corpus = FixtureCorpus::new("csv");
        let quoted = corpus.labels(&["\"show, with comma\",1,1,0,48000,0,0,0,0,0,0,0,0,3,0,0,0"]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(quoted, None)),
            Err(BenchmarkError::Csv { .. })
        ));
        let short = corpus.labels(&["show,1,1"]);
        assert!(matches!(
            run_sep28k_corpus(&corpus.options(short, None)),
            Err(BenchmarkError::Csv { .. })
        ));
    }

    #[test]
    fn corpus_runner_reports_an_empty_scored_set_without_metrics() {
        let corpus = FixtureCorpus::new("empty");
        let labels = corpus.labels(&[MISSING]);
        let report = run_sep28k_corpus(&corpus.options(labels, None)).unwrap();
        assert_eq!(report.counts.scored, 0);
        assert!(report.all_scored.is_none());
    }
}
