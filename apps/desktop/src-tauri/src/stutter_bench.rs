use std::collections::{HashMap, HashSet};

use crate::speech_analysis::{analyze_speech_session_impl, AnalyzeSpeechRequest, StutterKind};

const BENCHMARK_KINDS: [StutterKind; 5] = [
    StutterKind::WordRepetition,
    StutterKind::SoundRepetition,
    StutterKind::Prolongation,
    StutterKind::Block,
    StutterKind::Filler,
];

#[derive(Debug, thiserror::Error)]
enum BenchmarkError {
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

#[derive(Debug, Clone, Default, PartialEq)]
struct KindMetrics {
    true_positive: usize,
    false_positive: usize,
    false_negative: usize,
    true_negative: usize,
    precision: f64,
    recall: f64,
    f1: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct BenchmarkReport {
    clip_count: usize,
    speaker_count: usize,
    micro_precision: f64,
    micro_recall: f64,
    micro_f1: f64,
    macro_f1: f64,
    false_positive_clip_rate: f64,
    brier_score: Option<f64>,
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
}
