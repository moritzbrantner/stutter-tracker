use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use text_analysis_core::tokenize_words;
use text_analysis_prediction::MarkovChain;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PredictionError {
    #[error("{0}")]
    Model(#[from] video_analysis_core::DetectError),
}

type Result<T> = std::result::Result<T, PredictionError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIntentRequest {
    pub segments: Vec<PredictionSegmentInput>,
    #[serde(default)]
    pub sessions: Vec<PredictionSessionInput>,
    #[serde(default)]
    pub events: Vec<PredictionEventInput>,
    pub partial_text: Option<String>,
    pub max_contexts: Option<usize>,
    pub max_predictions: Option<usize>,
    pub phrase_tokens: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionSegmentInput {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub speaker_id: Option<String>,
    pub speaker_label: Option<String>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionSessionInput {
    #[serde(default)]
    pub segments: Vec<PredictionSegmentInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionEventInput {
    pub kind: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIntentPrediction {
    pub id: String,
    pub reason: IntentPredictionReason,
    pub context_text: String,
    pub trigger_text: Option<String>,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
    pub speaker_id: Option<String>,
    pub speaker_label: Option<String>,
    pub confidence: f32,
    pub suggestions: Vec<IntentWordPrediction>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IntentPredictionReason {
    CurrentContext,
    Block,
    Filler,
    Repetition,
    Prolongation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentWordPrediction {
    pub token: String,
    pub count: usize,
    pub probability: f32,
    pub phrase: String,
}

#[derive(Debug, Clone)]
struct CandidateContext {
    reason: IntentPredictionReason,
    tokens: Vec<String>,
    context_text: String,
    trigger_text: Option<String>,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    speaker_id: Option<String>,
    speaker_label: Option<String>,
}

pub fn predict_speaker_intent_impl(
    request: SpeakerIntentRequest,
) -> Result<Vec<SpeakerIntentPrediction>> {
    let mut order_two = MarkovChain::new(2)?;
    let mut order_one = MarkovChain::new(1)?;
    for document in training_documents(&request) {
        order_two.train_text(&document);
        order_one.train_text(&document);
    }

    let max_contexts = request.max_contexts.unwrap_or(6).clamp(1, 12);
    let max_predictions = request.max_predictions.unwrap_or(4).clamp(1, 8);
    let phrase_tokens = request.phrase_tokens.unwrap_or(4).clamp(1, 8);
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();

    for candidate in candidate_contexts(&request)
        .into_iter()
        .take(max_contexts * 2)
    {
        let Some((suggestions, confidence)) = predict_for_context(
            &order_two,
            &order_one,
            &candidate.tokens,
            max_predictions,
            phrase_tokens,
        )?
        else {
            continue;
        };
        let key = format!(
            "{:?}:{}:{}",
            candidate.reason,
            candidate.context_text,
            candidate.trigger_text.as_deref().unwrap_or_default()
        );
        if !seen.insert(key) {
            continue;
        }
        output.push(SpeakerIntentPrediction {
            id: format!("intent-{}", output.len() + 1),
            reason: candidate.reason,
            context_text: candidate.context_text,
            trigger_text: candidate.trigger_text,
            start_seconds: candidate.start_seconds,
            end_seconds: candidate.end_seconds,
            speaker_id: candidate.speaker_id,
            speaker_label: candidate.speaker_label,
            confidence,
            suggestions,
        });
        if output.len() >= max_contexts {
            break;
        }
    }

    Ok(output)
}

fn training_documents(request: &SpeakerIntentRequest) -> Vec<String> {
    request
        .sessions
        .iter()
        .flat_map(|session| session.segments.iter())
        .chain(request.segments.iter())
        .filter(|segment| segment.is_final)
        .map(|segment| segment.text.trim().to_string())
        .filter(|text| !text.is_empty())
        .collect()
}

fn candidate_contexts(request: &SpeakerIntentRequest) -> Vec<CandidateContext> {
    let mut candidates = Vec::new();
    if let Some(partial_text) = request.partial_text.as_deref() {
        let tokens = tokenize_words(partial_text);
        if !tokens.is_empty() {
            candidates.push(CandidateContext {
                reason: IntentPredictionReason::CurrentContext,
                context_text: context_text(&tokens),
                tokens,
                trigger_text: None,
                start_seconds: request.segments.last().map(|segment| segment.end_seconds),
                end_seconds: request.segments.last().map(|segment| segment.end_seconds),
                speaker_id: request
                    .segments
                    .last()
                    .and_then(|segment| segment.speaker_id.clone()),
                speaker_label: request
                    .segments
                    .last()
                    .and_then(|segment| segment.speaker_label.clone()),
            });
        }
    }

    for event in request.events.iter().rev() {
        let Some(segment) =
            nearest_segment(&request.segments, event.start_seconds, event.end_seconds)
        else {
            continue;
        };
        let segment_tokens = tokenize_words(&segment.text);
        let event_tokens = tokenize_words(&event.text);
        let tokens = prefix_for_event(&segment_tokens, &event_tokens)
            .or_else(|| tokens_before_seconds(&request.segments, event.start_seconds));
        let Some(tokens) = tokens else {
            continue;
        };
        if tokens.is_empty() {
            continue;
        }
        candidates.push(CandidateContext {
            reason: reason_for_kind(&event.kind),
            context_text: context_text(&tokens),
            tokens,
            trigger_text: Some(event.text.clone()),
            start_seconds: Some(event.start_seconds),
            end_seconds: Some(event.end_seconds),
            speaker_id: segment.speaker_id.clone(),
            speaker_label: segment.speaker_label.clone(),
        });
    }

    candidates
}

fn predict_for_context(
    order_two: &MarkovChain,
    order_one: &MarkovChain,
    context: &[String],
    limit: usize,
    phrase_tokens: usize,
) -> Result<Option<(Vec<IntentWordPrediction>, f32)>> {
    let (model, order) = if context.len() >= 2 {
        let predictions = order_two.predict_next_tokens(context, limit)?;
        if !predictions.is_empty() {
            return Ok(Some(predictions_to_suggestions(
                order_two,
                context,
                predictions,
                phrase_tokens,
            )?));
        }
        (order_one, 1)
    } else {
        (order_one, 1)
    };

    if context.len() < order {
        return Ok(None);
    }
    let predictions = model.predict_next_tokens(context, limit)?;
    if predictions.is_empty() {
        return Ok(None);
    }
    Ok(Some(predictions_to_suggestions(
        model,
        context,
        predictions,
        phrase_tokens,
    )?))
}

fn predictions_to_suggestions(
    model: &MarkovChain,
    context: &[String],
    predictions: Vec<text_analysis_prediction::MarkovPrediction>,
    phrase_tokens: usize,
) -> Result<(Vec<IntentWordPrediction>, f32)> {
    let context_len = context.len();
    let mut suggestions = Vec::new();
    for prediction in predictions {
        let mut seed = context.to_vec();
        seed.push(prediction.token.clone());
        let generated = model.generate_from_tokens(&seed, context_len + phrase_tokens)?;
        let phrase = generated
            .tokens
            .get(context_len..)
            .unwrap_or_default()
            .join(" ");
        suggestions.push(IntentWordPrediction {
            token: prediction.token,
            count: prediction.count,
            probability: prediction.probability,
            phrase,
        });
    }
    let confidence = suggestions
        .iter()
        .map(|suggestion| suggestion.probability)
        .fold(0.0_f32, f32::max);
    Ok((suggestions, confidence))
}

fn nearest_segment(
    segments: &[PredictionSegmentInput],
    start_seconds: f64,
    end_seconds: f64,
) -> Option<&PredictionSegmentInput> {
    segments
        .iter()
        .filter(|segment| segment.is_final)
        .min_by(|left, right| {
            let left_distance = distance_to_span(left, start_seconds, end_seconds);
            let right_distance = distance_to_span(right, start_seconds, end_seconds);
            left_distance
                .partial_cmp(&right_distance)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn distance_to_span(segment: &PredictionSegmentInput, start_seconds: f64, end_seconds: f64) -> f64 {
    if segment.start_seconds <= end_seconds && segment.end_seconds >= start_seconds {
        0.0
    } else if segment.end_seconds < start_seconds {
        start_seconds - segment.end_seconds
    } else {
        segment.start_seconds - end_seconds
    }
}

fn prefix_for_event(segment_tokens: &[String], event_tokens: &[String]) -> Option<Vec<String>> {
    if event_tokens.is_empty() {
        return None;
    }
    for index in 0..segment_tokens.len() {
        if segment_tokens[index..].starts_with(event_tokens) {
            let end = (index + 1).min(segment_tokens.len());
            return Some(segment_tokens[..end].to_vec());
        }
    }
    None
}

fn tokens_before_seconds(segments: &[PredictionSegmentInput], seconds: f64) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    for segment in segments.iter().filter(|segment| segment.is_final) {
        if segment.end_seconds <= seconds {
            tokens.extend(tokenize_words(&segment.text));
        }
    }
    (!tokens.is_empty()).then_some(tokens)
}

fn context_text(tokens: &[String]) -> String {
    let start = tokens.len().saturating_sub(5);
    tokens[start..].join(" ")
}

fn reason_for_kind(kind: &str) -> IntentPredictionReason {
    match kind {
        "block" => IntentPredictionReason::Block,
        "filler" => IntentPredictionReason::Filler,
        "wordRepetition" | "soundRepetition" => IntentPredictionReason::Repetition,
        "prolongation" => IntentPredictionReason::Prolongation,
        _ => IntentPredictionReason::CurrentContext,
    }
}

#[allow(dead_code)]
fn _counts_by_context(chain: &MarkovChain) -> BTreeMap<Vec<String>, usize> {
    chain
        .transitions()
        .iter()
        .map(|(context, next)| (context.clone(), next.values().sum()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predicts_from_repetition_context() {
        let predictions = predict_speaker_intent_impl(SpeakerIntentRequest {
            segments: vec![PredictionSegmentInput {
                text: "I I want coffee".to_string(),
                start_seconds: 0.0,
                end_seconds: 2.0,
                speaker_id: Some("speaker-a".to_string()),
                speaker_label: Some("Ari".to_string()),
                is_final: true,
            }],
            sessions: vec![PredictionSessionInput {
                segments: vec![PredictionSegmentInput {
                    text: "I want coffee now".to_string(),
                    start_seconds: 0.0,
                    end_seconds: 2.0,
                    speaker_id: None,
                    speaker_label: None,
                    is_final: true,
                }],
            }],
            events: vec![PredictionEventInput {
                kind: "wordRepetition".to_string(),
                start_seconds: 0.0,
                end_seconds: 0.4,
                text: "I I".to_string(),
            }],
            partial_text: Some("I".to_string()),
            max_contexts: Some(3),
            max_predictions: Some(3),
            phrase_tokens: Some(3),
        })
        .unwrap();

        assert!(predictions
            .iter()
            .flat_map(|prediction| prediction.suggestions.iter())
            .any(|suggestion| suggestion.token == "want"));
    }
}
