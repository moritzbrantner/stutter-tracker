use std::collections::HashMap;

use audio_analysis_recognition::{
    AudioEmbedding, AudioEmbeddingExtractor, SpectralAudioEmbedder, SpectralEmbeddingConfig,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SpeechAnalysisError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Audio(#[from] video_analysis_core::DetectError),
}

type Result<T> = std::result::Result<T, SpeechAnalysisError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSpeechRequest {
    pub segments: Vec<TranscriptSegmentInput>,
    pub pauses: Vec<PauseInput>,
    pub session_started_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentInput {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub confidence: Option<f32>,
    pub speaker_score: Option<f32>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseInput {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub after_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisReport {
    pub session_started_at: Option<String>,
    pub total_duration_seconds: f64,
    pub word_count: usize,
    pub stutter_count: usize,
    pub stutters_per_minute: f64,
    pub severity: Severity,
    pub events: Vec<StutterEvent>,
    pub by_kind: HashMap<StutterKind, usize>,
}

#[derive(Debug, Clone, Copy, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StutterKind {
    WordRepetition,
    SoundRepetition,
    Prolongation,
    Block,
    Filler,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    None,
    Mild,
    Moderate,
    High,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StutterEvent {
    pub kind: StutterKind,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
    pub detail: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintResult {
    pub embedding: Vec<f32>,
    pub sample_rate: u32,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMatchRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub reference_embedding: Vec<f32>,
    pub threshold: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMatchResult {
    pub score: f32,
    pub is_match: bool,
}

#[derive(Debug, Clone)]
struct TimedToken {
    raw: String,
    normalized: String,
    start_seconds: f64,
    end_seconds: f64,
}

pub fn analyze_speech_session_impl(request: AnalyzeSpeechRequest) -> Result<AnalysisReport> {
    let mut events = Vec::new();
    let mut tokens = Vec::new();
    let mut duration = 0.0_f64;

    for segment in request.segments.iter().filter(|segment| segment.is_final) {
        if !segment.start_seconds.is_finite() || !segment.end_seconds.is_finite() {
            return Err(SpeechAnalysisError::Invalid(
                "segment times must be finite".to_string(),
            ));
        }
        let _segment_quality = (
            segment.confidence.unwrap_or(1.0),
            segment.speaker_score.unwrap_or(1.0),
        );
        duration = duration.max(segment.end_seconds);
        let segment_tokens = timed_tokens(segment);
        events.extend(detect_repetitions(&segment_tokens));
        events.extend(detect_prolongations(&segment_tokens));
        events.extend(detect_fillers(&segment_tokens));
        tokens.extend(segment_tokens);
    }

    events.extend(detect_blocks(&request.pauses));
    events.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    events.dedup_by(|left, right| {
        left.kind == right.kind
            && (left.start_seconds - right.start_seconds).abs() < 0.08
            && left.text == right.text
    });

    let word_count = tokens
        .iter()
        .filter(|token| !is_filler(&token.normalized))
        .count();
    let total_duration_seconds = duration.max(
        request
            .pauses
            .iter()
            .map(|pause| pause.end_seconds)
            .fold(0.0, f64::max),
    );
    let minutes = (total_duration_seconds / 60.0).max(1.0 / 60.0);
    let stutters_per_minute = events.len() as f64 / minutes;
    let severity = classify_severity(stutters_per_minute, word_count, events.len());
    let mut by_kind = HashMap::new();
    for event in &events {
        *by_kind.entry(event.kind).or_insert(0) += 1;
    }

    Ok(AnalysisReport {
        session_started_at: request.session_started_at,
        total_duration_seconds,
        word_count,
        stutter_count: events.len(),
        stutters_per_minute,
        severity,
        events,
        by_kind,
    })
}

pub fn create_voiceprint_impl(request: VoiceprintRequest) -> Result<VoiceprintResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let embedder = SpectralAudioEmbedder::new(SpectralEmbeddingConfig::default())?;
    let embedding = embedder.embed_samples(&request.samples, request.sample_rate)?;
    Ok(VoiceprintResult {
        embedding: embedding.values().to_vec(),
        sample_rate: request.sample_rate,
        sample_count: request.samples.len(),
    })
}

pub fn compare_voiceprint_impl(request: VoiceMatchRequest) -> Result<VoiceMatchResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let threshold = request.threshold.unwrap_or(0.82).clamp(-1.0, 1.0);
    let embedder = SpectralAudioEmbedder::new(SpectralEmbeddingConfig::default())?;
    let current = embedder.embed_samples(&request.samples, request.sample_rate)?;
    let reference = AudioEmbedding::new(request.reference_embedding)?;
    let score = current.cosine_similarity(&reference)?;
    Ok(VoiceMatchResult {
        score,
        is_match: score >= threshold,
    })
}

fn timed_tokens(segment: &TranscriptSegmentInput) -> Vec<TimedToken> {
    let raw_tokens = segment
        .text
        .split_whitespace()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if raw_tokens.is_empty() {
        return Vec::new();
    }

    let duration = (segment.end_seconds - segment.start_seconds).max(0.01);
    let step = duration / raw_tokens.len() as f64;
    raw_tokens
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let start_seconds = segment.start_seconds + step * index as f64;
            TimedToken {
                raw: (*raw).to_string(),
                normalized: normalize_token(raw),
                start_seconds,
                end_seconds: (start_seconds + step).min(segment.end_seconds),
            }
        })
        .filter(|token| !token.normalized.is_empty())
        .collect()
}

fn detect_repetitions(tokens: &[TimedToken]) -> Vec<StutterEvent> {
    let mut events = Vec::new();
    let mut index = 0;
    while index + 1 < tokens.len() {
        let token = &tokens[index];
        if token.normalized.is_empty() || is_filler(&token.normalized) {
            index += 1;
            continue;
        }
        let mut run_end = index + 1;
        while run_end < tokens.len() && tokens[run_end].normalized == token.normalized {
            run_end += 1;
        }
        if run_end - index >= 2 {
            let end = &tokens[run_end - 1];
            events.push(StutterEvent {
                kind: StutterKind::WordRepetition,
                start_seconds: token.start_seconds,
                end_seconds: end.end_seconds,
                text: tokens[index..run_end]
                    .iter()
                    .map(|item| item.raw.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                detail: "Repeated word sequence".to_string(),
                confidence: 0.86,
            });
            index = run_end;
            continue;
        }

        if index + 2 < tokens.len() && sound_repetition(token, &tokens[index + 1]) {
            events.push(StutterEvent {
                kind: StutterKind::SoundRepetition,
                start_seconds: token.start_seconds,
                end_seconds: tokens[index + 1].end_seconds,
                text: format!("{} {}", token.raw, tokens[index + 1].raw),
                detail: "Repeated initial sound".to_string(),
                confidence: 0.74,
            });
            index += 2;
            continue;
        }
        index += 1;
    }
    events
}

fn detect_prolongations(tokens: &[TimedToken]) -> Vec<StutterEvent> {
    tokens
        .iter()
        .filter_map(|token| {
            let repeated = longest_character_run(&token.normalized);
            let has_hyphenated_sound = token.raw.matches('-').count() >= 2;
            if repeated >= 4 || has_hyphenated_sound {
                Some(StutterEvent {
                    kind: if has_hyphenated_sound {
                        StutterKind::SoundRepetition
                    } else {
                        StutterKind::Prolongation
                    },
                    start_seconds: token.start_seconds,
                    end_seconds: token.end_seconds,
                    text: token.raw.clone(),
                    detail: if has_hyphenated_sound {
                        "Hyphenated sound repetition".to_string()
                    } else {
                        "Extended sound in word".to_string()
                    },
                    confidence: 0.81,
                })
            } else {
                None
            }
        })
        .collect()
}

fn detect_fillers(tokens: &[TimedToken]) -> Vec<StutterEvent> {
    tokens
        .iter()
        .filter(|token| is_filler(&token.normalized))
        .map(|token| StutterEvent {
            kind: StutterKind::Filler,
            start_seconds: token.start_seconds,
            end_seconds: token.end_seconds,
            text: token.raw.clone(),
            detail: "Filler or restart marker".to_string(),
            confidence: 0.61,
        })
        .collect()
}

fn detect_blocks(pauses: &[PauseInput]) -> Vec<StutterEvent> {
    pauses
        .iter()
        .filter(|pause| pause.end_seconds - pause.start_seconds >= 0.75)
        .map(|pause| StutterEvent {
            kind: StutterKind::Block,
            start_seconds: pause.start_seconds,
            end_seconds: pause.end_seconds,
            text: pause
                .after_text
                .clone()
                .unwrap_or_else(|| "pause".to_string()),
            detail: format!(
                "{:.1}s silent pause before speech",
                pause.end_seconds - pause.start_seconds
            ),
            confidence: 0.66,
        })
        .collect()
}

fn sound_repetition(left: &TimedToken, right: &TimedToken) -> bool {
    if left.normalized.len() > 2 || right.normalized.len() < 3 {
        return false;
    }
    right.normalized.starts_with(&left.normalized)
}

fn normalize_token(token: &str) -> String {
    token
        .trim_matches(|char: char| !char.is_alphanumeric() && char != '-')
        .to_lowercase()
}

fn longest_character_run(value: &str) -> usize {
    let mut previous = '\0';
    let mut current = 0;
    let mut longest = 0;
    for character in value.chars() {
        if character == previous {
            current += 1;
        } else {
            previous = character;
            current = 1;
        }
        longest = longest.max(current);
    }
    longest
}

fn is_filler(token: &str) -> bool {
    matches!(
        token,
        "um" | "uh" | "erm" | "hm" | "hmm" | "like" | "äh" | "ähm" | "eh"
    )
}

fn validate_samples(samples: &[f32], sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(SpeechAnalysisError::Invalid(
            "sampleRate must be greater than zero".to_string(),
        ));
    }
    if samples.len() < (sample_rate as usize / 4).max(1024) {
        return Err(SpeechAnalysisError::Invalid(
            "at least 250ms of audio samples are required".to_string(),
        ));
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(SpeechAnalysisError::Invalid(
            "audio samples must be finite".to_string(),
        ));
    }
    Ok(())
}

fn classify_severity(rate: f64, word_count: usize, stutter_count: usize) -> Severity {
    if stutter_count == 0 {
        return Severity::None;
    }
    let density = if word_count == 0 {
        0.0
    } else {
        stutter_count as f64 / word_count as f64
    };
    if rate >= 12.0 || density >= 0.18 {
        Severity::High
    } else if rate >= 6.0 || density >= 0.10 {
        Severity::Moderate
    } else {
        Severity::Mild
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_word_repetition_and_prolongation() {
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "I I want to sssstart now".to_string(),
                start_seconds: 0.0,
                end_seconds: 3.0,
                confidence: None,
                speaker_score: None,
                is_final: true,
            }],
            pauses: Vec::new(),
            session_started_at: None,
        })
        .unwrap();

        assert_eq!(report.word_count, 6);
        assert!(report
            .events
            .iter()
            .any(|event| event.kind == StutterKind::WordRepetition));
        assert!(report
            .events
            .iter()
            .any(|event| event.kind == StutterKind::Prolongation));
    }

    #[test]
    fn detects_blocks_from_pauses() {
        let report = analyze_speech_session_impl(AnalyzeSpeechRequest {
            segments: Vec::new(),
            pauses: vec![PauseInput {
                start_seconds: 1.0,
                end_seconds: 2.0,
                after_text: Some("then".to_string()),
            }],
            session_started_at: None,
        })
        .unwrap();

        assert_eq!(report.stutter_count, 1);
        assert_eq!(report.events[0].kind, StutterKind::Block);
    }
}
