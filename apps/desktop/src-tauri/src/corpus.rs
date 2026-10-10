use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::text_analysis_features::{
    extractive_summary, keywords, readability_summary, sentiment, summarize_text,
    ExtractiveSummaryOptions, KeywordOptions, ReadabilitySummary, SentimentLexicon,
    SentimentSummary, TextFeatureSummary,
};
use serde::{Deserialize, Serialize};
use text_analysis_corpus::{CorpusOptions, CorpusStats, CorpusTermStats, TfIdfCorpus};
use text_analysis_linguistics::{analyze_text, LinguisticAnalysis, LinguisticAnalysisOptions};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CorpusError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid corpus JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Analysis(#[from] crate::video_analysis_core::DetectError),
    #[error("session id must not be empty")]
    InvalidSessionId,
}

type Result<T> = std::result::Result<T, CorpusError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "CorpusSessionWire")]
pub struct CorpusSessionInput {
    pub id: String,
    pub started_at: String,
    pub segments: Vec<CorpusSegmentInput>,
    pub report: CorpusReportInput,
    /// Canonical session-record provenance (schema owned by `packages/shared/src/sessions.ts`),
    /// kept verbatim. Absent for callers that predate it.
    pub provenance: SessionProvenance,
}

/// The canonical record's fingerprints (`analysis.inputId`, annotation `inputId`) are computed
/// over the exact segments sent. The corpus trims and filters segments (and stores confidence as
/// f32), so the untouched segments are kept as `observedSegments` next to the normalized view.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusSessionWire {
    id: String,
    started_at: String,
    segments: serde_json::Value,
    report: CorpusReportInput,
    #[serde(flatten)]
    provenance: SessionProvenance,
}

impl TryFrom<CorpusSessionWire> for CorpusSessionInput {
    type Error = serde_json::Error;

    fn try_from(wire: CorpusSessionWire) -> std::result::Result<Self, Self::Error> {
        let segments = serde_json::from_value(wire.segments.clone())?;
        let mut provenance = wire.provenance;
        if !provenance.fields.is_empty() {
            provenance
                .fields
                .insert("observedSegments".to_owned(), wire.segments);
        }
        Ok(Self {
            id: wire.id,
            started_at: wire.started_at,
            segments,
            report: wire.report,
            provenance,
        })
    }
}

/// Every other top-level field of the canonical record, kept as-is, so fields added to the shared
/// schema later survive a desktop save without Rust changes.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct SessionProvenance {
    #[serde(flatten)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusSegmentInput {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub confidence: Option<f32>,
    pub speaker_id: Option<String>,
    pub speaker_label: Option<String>,
    pub speaker_score: Option<f32>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusReportInput {
    pub total_duration_seconds: f64,
    pub word_count: usize,
    pub stutter_count: usize,
    pub stutters_per_minute: f64,
    /// The report's capture-quality verdict (schema owned by `packages/shared/src/capture.ts`),
    /// kept verbatim so exports keep it next to the counts it qualifies.
    #[serde(default)]
    pub capture_quality: Option<serde_json::Value>,
}

/// True when the verdict says the capture quality is unknown: the session's counts are not a
/// score and stay out of corpus aggregates.
fn is_score_withheld(capture_quality: Option<&serde_json::Value>) -> bool {
    capture_quality
        .and_then(|quality| quality.get("state"))
        .and_then(serde_json::Value::as_str)
        == Some("unknown")
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechCorpusStore {
    sessions: Vec<SpeechCorpusSession>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechCorpusSession {
    id: String,
    started_at: String,
    segments: Vec<CorpusSegmentInput>,
    total_duration_seconds: f64,
    word_count: usize,
    stutter_count: usize,
    stutters_per_minute: f64,
    /// Missing in corpus files written before the capture-quality gate existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capture_quality: Option<serde_json::Value>,
    /// Missing in corpus files written before provenance was stored; those still load.
    #[serde(default, flatten)]
    provenance: SessionProvenance,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCorpusAnalysis {
    pub stats: SpeechCorpusStats,
    pub text: CorpusTextStats,
    pub readability: CorpusReadability,
    pub sentiment: CorpusSentiment,
    pub linguistic: CorpusLinguisticSummary,
    pub top_terms: Vec<CorpusTerm>,
    pub keywords: Vec<CorpusKeyword>,
    pub summary: Vec<String>,
    pub speakers: Vec<SpeakerCorpusSummary>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCorpusStats {
    pub sessions: usize,
    pub documents: usize,
    pub speakers: usize,
    pub total_duration_seconds: f64,
    pub total_terms: usize,
    pub unique_terms: usize,
    pub average_terms_per_document: f32,
    pub word_count: usize,
    /// Events of sessions with a usable or unchecked capture only.
    pub stutter_count: usize,
    /// Over the duration of the sessions counted in `stutter_count`.
    pub stutters_per_minute: f64,
    pub lexical_diversity: f32,
    /// Sessions left out of the event totals because their capture quality is unknown.
    pub withheld_sessions: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusTextStats {
    pub bytes: usize,
    pub chars: usize,
    pub words: usize,
    pub lines: usize,
    pub sentences: usize,
    pub unique_terms: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusReadability {
    pub sentence_count: usize,
    pub word_count: usize,
    pub average_sentence_words: f32,
    pub average_word_chars: f32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusSentiment {
    pub positive_score: f32,
    pub negative_score: f32,
    pub compound: f32,
    pub token_count: usize,
    pub matched_terms: usize,
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusLinguisticSummary {
    pub language: Option<String>,
    pub language_confidence: Option<f32>,
    pub token_count: usize,
    pub sentence_count: usize,
    pub lemma_count: usize,
    pub entity_count: usize,
    pub entities: Vec<String>,
    pub topics: Vec<String>,
    pub register: String,
    pub disfluency_markers: usize,
    pub question_count: usize,
    pub exclamation_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusTerm {
    pub term: String,
    pub collection_count: usize,
    pub document_count: usize,
    pub collection_frequency: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusKeyword {
    pub text: String,
    pub score: f32,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerCorpusSummary {
    pub speaker_id: Option<String>,
    pub speaker_label: String,
    pub documents: usize,
    pub word_count: usize,
    pub duration_seconds: f64,
    pub stutter_count: usize,
    pub lexical_diversity: f32,
    pub top_terms: Vec<CorpusTerm>,
    pub keywords: Vec<CorpusKeyword>,
}

#[derive(Debug, Clone)]
struct CorpusDocument {
    id: String,
    speaker_id: Option<String>,
    speaker_label: String,
    text: String,
    duration_seconds: f64,
    word_count: usize,
    stutter_count: usize,
}

pub fn load_speech_corpus_impl(path: &Path) -> Result<SpeechCorpusAnalysis> {
    let store = read_store(path)?;
    analyze_store(&store)
}

/// Per session, only what verifying its analysis needs (the analysis `inputId` and the untouched
/// observation): a small payload instead of the full store with reports and history.
pub fn speech_corpus_observations_impl(path: &Path) -> Result<serde_json::Value> {
    let store = read_store(path)?;
    let pick = |session: &SpeechCorpusSession, key: &str| {
        session
            .provenance
            .fields
            .get(key)
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    Ok(serde_json::json!({
        "sessions": store
            .sessions
            .iter()
            .map(|session| {
                serde_json::json!({
                    "analysis": {
                        "inputId": session
                            .provenance
                            .fields
                            .get("analysis")
                            .and_then(|analysis| analysis.get("inputId"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    },
                    "observedSegments": pick(session, "observedSegments"),
                    "pauses": pick(session, "pauses"),
                })
            })
            .collect::<Vec<_>>(),
    }))
}

/// Fills in the capture quality of rows saved before the corpus kept it, from the matching saved
/// sessions' verdicts. Rows that already have one are left as they are.
pub fn backfill_speech_corpus_capture_quality_impl(
    path: &Path,
    qualities: &BTreeMap<String, serde_json::Value>,
) -> Result<SpeechCorpusAnalysis> {
    let mut store = read_store(path)?;
    let mut changed = false;
    for session in &mut store.sessions {
        if session.capture_quality.is_none() {
            if let Some(quality) = qualities.get(&session.id) {
                session.capture_quality = Some(quality.clone());
                changed = true;
            }
        }
    }
    if changed {
        write_store(path, &store)?;
    }
    analyze_store(&store)
}

pub fn export_speech_corpus_impl(path: &Path) -> Result<serde_json::Value> {
    let store = read_store(path)?;
    Ok(serde_json::to_value(store)?)
}

pub fn save_speech_corpus_session_impl(
    path: &Path,
    request: CorpusSessionInput,
) -> Result<SpeechCorpusAnalysis> {
    let mut store = read_store(path)?;
    let session = normalize_session(request);
    store.sessions.retain(|existing| existing.id != session.id);
    store.sessions.push(session);
    store
        .sessions
        .sort_by(|left, right| right.started_at.cmp(&left.started_at));
    write_store(path, &store)?;
    analyze_store(&store)
}

pub fn delete_speech_corpus_session_impl(
    path: &Path,
    session_id: &str,
) -> Result<SpeechCorpusAnalysis> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(CorpusError::InvalidSessionId);
    }

    let mut store = read_store(path)?;
    if delete_session(&mut store, session_id) {
        write_store(path, &store)?;
    }
    analyze_store(&store)
}

fn delete_session(store: &mut SpeechCorpusStore, session_id: &str) -> bool {
    let previous_len = store.sessions.len();
    store.sessions.retain(|session| session.id != session_id);
    store.sessions.len() != previous_len
}

fn normalize_session(request: CorpusSessionInput) -> SpeechCorpusSession {
    SpeechCorpusSession {
        id: request.id.trim().to_string(),
        started_at: request.started_at.trim().to_string(),
        segments: request
            .segments
            .into_iter()
            .filter(|segment| segment.is_final && !segment.text.trim().is_empty())
            .map(|segment| {
                let CorpusSegmentInput {
                    text,
                    start_seconds,
                    end_seconds,
                    confidence,
                    speaker_id,
                    speaker_label,
                    speaker_score,
                    is_final,
                } = segment;
                CorpusSegmentInput {
                    text: text.trim().to_string(),
                    start_seconds,
                    end_seconds,
                    confidence,
                    speaker_id: clean_optional(speaker_id),
                    speaker_label: clean_optional(speaker_label),
                    speaker_score,
                    is_final,
                }
            })
            .collect(),
        total_duration_seconds: request.report.total_duration_seconds.max(0.0),
        word_count: request.report.word_count,
        stutter_count: request.report.stutter_count,
        stutters_per_minute: request.report.stutters_per_minute.max(0.0),
        capture_quality: request.report.capture_quality,
        provenance: request.provenance,
    }
}

fn read_store(path: &Path) -> Result<SpeechCorpusStore> {
    if !path.exists() {
        return Ok(SpeechCorpusStore::default());
    }
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn write_store(path: &Path, store: &SpeechCorpusStore) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

fn analyze_store(store: &SpeechCorpusStore) -> Result<SpeechCorpusAnalysis> {
    let documents = corpus_documents(store);
    let text = documents
        .iter()
        .map(|document| document.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    if text.trim().is_empty() {
        return Ok(empty_analysis(store));
    }

    let mut corpus = TfIdfCorpus::new(CorpusOptions::default());
    for document in &documents {
        corpus.add_document(&document.id, &document.text)?;
    }

    let corpus_stats = corpus.stats();
    let feature_summary = summarize_text(&text, 12);
    let readability = readability_summary(&text, &CorpusOptions::default().processing);
    let sentiment = sentiment(&text, &SentimentLexicon::default());
    let linguistic = analyze_text(&text, &LinguisticAnalysisOptions::default())?;
    let summary = extractive_summary(&text, &ExtractiveSummaryOptions::default())?
        .into_iter()
        .map(|sentence| sentence.text)
        .collect();

    Ok(SpeechCorpusAnalysis {
        stats: aggregate_stats(store, &documents, &corpus_stats, &feature_summary),
        text: text_stats_output(&feature_summary),
        readability: readability_output(&readability),
        sentiment: sentiment_output(&sentiment),
        linguistic: linguistic_output(&linguistic),
        top_terms: corpus.term_stats(12).into_iter().map(term_output).collect(),
        keywords: keywords(&text, &KeywordOptions::default())
            .into_iter()
            .map(keyword_output)
            .collect(),
        summary,
        speakers: speaker_summaries(&documents)?,
    })
}

fn corpus_documents(store: &SpeechCorpusStore) -> Vec<CorpusDocument> {
    let mut documents = Vec::new();
    for session in &store.sessions {
        for (index, segment) in session.segments.iter().enumerate() {
            let word_count = segment.text.split_whitespace().count();
            documents.push(CorpusDocument {
                id: format!("{}:{index}", session.id),
                speaker_id: segment.speaker_id.clone(),
                speaker_label: segment
                    .speaker_label
                    .clone()
                    .or_else(|| segment.speaker_id.clone())
                    .unwrap_or_else(|| "Unknown speaker".to_string()),
                text: segment.text.clone(),
                duration_seconds: (segment.end_seconds - segment.start_seconds).max(0.0),
                word_count,
                stutter_count: proportional_count(
                    session.scored_stutter_count(),
                    word_count,
                    session.word_count,
                ),
            });
        }
    }
    documents
}

impl SpeechCorpusSession {
    fn score_withheld(&self) -> bool {
        is_score_withheld(self.capture_quality.as_ref())
    }

    fn scored_stutter_count(&self) -> usize {
        if self.score_withheld() {
            0
        } else {
            self.stutter_count
        }
    }
}

fn withheld_sessions(store: &SpeechCorpusStore) -> usize {
    store
        .sessions
        .iter()
        .filter(|session| session.score_withheld())
        .count()
}

fn proportional_count(total: usize, part: usize, whole: usize) -> usize {
    if total == 0 || part == 0 || whole == 0 {
        return 0;
    }
    ((total as f64 * part as f64) / whole as f64).round() as usize
}

fn aggregate_stats(
    store: &SpeechCorpusStore,
    documents: &[CorpusDocument],
    corpus_stats: &CorpusStats,
    feature_summary: &TextFeatureSummary,
) -> SpeechCorpusStats {
    let total_duration_seconds = store
        .sessions
        .iter()
        .map(|session| session.total_duration_seconds)
        .sum::<f64>();
    let word_count = store
        .sessions
        .iter()
        .map(|session| session.word_count)
        .sum();
    let scored = store
        .sessions
        .iter()
        .filter(|session| !session.score_withheld());
    let (stutter_count, scored_seconds) =
        scored.fold((0usize, 0.0f64), |(count, seconds), session| {
            (
                count + session.stutter_count,
                seconds + session.total_duration_seconds,
            )
        });
    let minutes = (scored_seconds / 60.0).max(1.0 / 60.0);
    let speakers = documents
        .iter()
        .map(|document| speaker_key(document))
        .collect::<std::collections::BTreeSet<_>>()
        .len();

    SpeechCorpusStats {
        sessions: store.sessions.len(),
        documents: corpus_stats.documents,
        speakers,
        total_duration_seconds,
        total_terms: corpus_stats.total_terms,
        unique_terms: corpus_stats.unique_terms,
        average_terms_per_document: corpus_stats.average_terms_per_document,
        word_count,
        stutter_count,
        stutters_per_minute: stutter_count as f64 / minutes,
        lexical_diversity: feature_summary.lexical_diversity,
        withheld_sessions: withheld_sessions(store),
    }
}

fn speaker_summaries(documents: &[CorpusDocument]) -> Result<Vec<SpeakerCorpusSummary>> {
    let mut grouped = BTreeMap::<String, Vec<&CorpusDocument>>::new();
    for document in documents {
        grouped
            .entry(speaker_key(document))
            .or_default()
            .push(document);
    }

    let mut summaries = Vec::new();
    for (_key, docs) in grouped {
        let text = docs
            .iter()
            .map(|document| document.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let mut corpus = TfIdfCorpus::new(CorpusOptions::default());
        for document in &docs {
            corpus.add_document(&document.id, &document.text)?;
        }
        let feature_summary = summarize_text(&text, 8);
        let first = docs[0];
        summaries.push(SpeakerCorpusSummary {
            speaker_id: first.speaker_id.clone(),
            speaker_label: first.speaker_label.clone(),
            documents: docs.len(),
            word_count: docs.iter().map(|document| document.word_count).sum(),
            duration_seconds: docs.iter().map(|document| document.duration_seconds).sum(),
            stutter_count: docs.iter().map(|document| document.stutter_count).sum(),
            lexical_diversity: feature_summary.lexical_diversity,
            top_terms: corpus.term_stats(8).into_iter().map(term_output).collect(),
            keywords: keywords(&text, &KeywordOptions::default())
                .into_iter()
                .map(keyword_output)
                .collect(),
        });
    }
    summaries.sort_by(|left, right| {
        right
            .word_count
            .cmp(&left.word_count)
            .then_with(|| left.speaker_label.cmp(&right.speaker_label))
    });
    Ok(summaries)
}

fn text_stats_output(summary: &TextFeatureSummary) -> CorpusTextStats {
    CorpusTextStats {
        bytes: summary.stats.bytes,
        chars: summary.stats.chars,
        words: summary.stats.words,
        lines: summary.stats.lines,
        sentences: summary.stats.sentences,
        unique_terms: summary.unique_terms,
    }
}

fn readability_output(summary: &ReadabilitySummary) -> CorpusReadability {
    CorpusReadability {
        sentence_count: summary.sentence_count,
        word_count: summary.word_count,
        average_sentence_words: summary.average_sentence_words,
        average_word_chars: summary.average_word_chars,
    }
}

fn sentiment_output(summary: &SentimentSummary) -> CorpusSentiment {
    CorpusSentiment {
        positive_score: summary.positive_score,
        negative_score: summary.negative_score,
        compound: summary.compound,
        token_count: summary.token_count,
        matched_terms: summary.matched_terms,
        label: summary.label.clone(),
    }
}

fn linguistic_output(analysis: &LinguisticAnalysis) -> CorpusLinguisticSummary {
    CorpusLinguisticSummary {
        language: analysis
            .language
            .primary
            .as_ref()
            .map(|prediction| prediction.language.clone()),
        language_confidence: analysis
            .language
            .primary
            .as_ref()
            .map(|prediction| prediction.confidence),
        token_count: analysis.tokens.len(),
        sentence_count: analysis.sentences.len(),
        lemma_count: analysis.lemmas.len(),
        entity_count: analysis.entities.len(),
        entities: analysis
            .entities
            .iter()
            .take(8)
            .map(|entity| entity.normalized.clone())
            .collect(),
        topics: analysis
            .topics
            .descriptors
            .iter()
            .take(8)
            .map(|topic| topic.label.clone())
            .collect(),
        register: format!("{:?}", analysis.style.register),
        disfluency_markers: analysis.style.disfluency_markers,
        question_count: analysis.style.question_count,
        exclamation_count: analysis.style.exclamation_count,
    }
}

fn term_output(term: CorpusTermStats) -> CorpusTerm {
    CorpusTerm {
        term: term.term,
        collection_count: term.collection_count,
        document_count: term.document_count,
        collection_frequency: term.collection_frequency,
    }
}

fn keyword_output(keyword: crate::text_analysis_features::Keyword) -> CorpusKeyword {
    CorpusKeyword {
        text: keyword.text,
        score: keyword.score,
        count: keyword.count,
    }
}

fn empty_analysis(store: &SpeechCorpusStore) -> SpeechCorpusAnalysis {
    SpeechCorpusAnalysis {
        stats: SpeechCorpusStats {
            sessions: store.sessions.len(),
            withheld_sessions: withheld_sessions(store),
            ..SpeechCorpusStats::default()
        },
        text: CorpusTextStats::default(),
        readability: CorpusReadability::default(),
        sentiment: CorpusSentiment {
            label: "neutral".to_string(),
            ..CorpusSentiment::default()
        },
        linguistic: CorpusLinguisticSummary::default(),
        top_terms: Vec::new(),
        keywords: Vec::new(),
        summary: Vec::new(),
        speakers: Vec::new(),
    }
}

fn speaker_key(document: &CorpusDocument) -> String {
    document
        .speaker_id
        .as_deref()
        .unwrap_or(&document.speaker_label)
        .to_string()
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_corpus_by_speaker() {
        let store = SpeechCorpusStore {
            sessions: vec![SpeechCorpusSession {
                provenance: SessionProvenance::default(),
                id: "session-1".to_string(),
                started_at: "2026-05-19T12:00:00.000Z".to_string(),
                total_duration_seconds: 20.0,
                word_count: 8,
                stutter_count: 1,
                stutters_per_minute: 3.0,
                capture_quality: None,
                segments: vec![
                    CorpusSegmentInput {
                        text: "I like building speech tools".to_string(),
                        start_seconds: 0.0,
                        end_seconds: 4.0,
                        confidence: Some(0.9),
                        speaker_id: Some("me".to_string()),
                        speaker_label: Some("Me".to_string()),
                        speaker_score: Some(0.95),
                        is_final: true,
                    },
                    CorpusSegmentInput {
                        text: "Speech tools help teams".to_string(),
                        start_seconds: 5.0,
                        end_seconds: 9.0,
                        confidence: Some(0.9),
                        speaker_id: Some("other".to_string()),
                        speaker_label: Some("Other".to_string()),
                        speaker_score: Some(0.91),
                        is_final: true,
                    },
                ],
            }],
        };

        let analysis = analyze_store(&store).expect("corpus should analyze");

        assert_eq!(analysis.stats.sessions, 1);
        assert_eq!(analysis.stats.documents, 2);
        assert_eq!(analysis.stats.speakers, 2);
        assert_eq!(analysis.stats.stutter_count, 1);
        assert_eq!(analysis.speakers.len(), 2);
        assert!(analysis.top_terms.iter().any(|term| term.term == "speech"));
    }

    #[test]
    fn deletes_only_the_requested_corpus_session_idempotently() {
        let session = SpeechCorpusSession {
            provenance: SessionProvenance::default(),
            id: "session-1".to_string(),
            started_at: "2026-05-19T12:00:00.000Z".to_string(),
            total_duration_seconds: 20.0,
            word_count: 5,
            stutter_count: 1,
            stutters_per_minute: 3.0,
            capture_quality: None,
            segments: vec![CorpusSegmentInput {
                text: "I like building speech tools".to_string(),
                start_seconds: 0.0,
                end_seconds: 4.0,
                confidence: Some(0.9),
                speaker_id: Some("me".to_string()),
                speaker_label: Some("Me".to_string()),
                speaker_score: Some(0.95),
                is_final: true,
            }],
        };
        let mut store = SpeechCorpusStore {
            sessions: vec![
                session.clone(),
                SpeechCorpusSession {
                    provenance: SessionProvenance::default(),
                    id: "session-2".to_string(),
                    ..session
                },
            ],
        };

        assert!(delete_session(&mut store, "session-1"));
        assert!(!delete_session(&mut store, "session-1"));

        let analysis = analyze_store(&store).expect("remaining corpus should analyze");
        assert_eq!(store.sessions.len(), 1);
        assert_eq!(store.sessions[0].id, "session-2");
        assert_eq!(analysis.stats.sessions, 1);
    }

    #[test]
    fn leaves_unknown_quality_sessions_out_of_event_totals_but_keeps_their_verdict() {
        let path = temp_corpus_path("capture-quality");
        let session = |id: &str, stutters: usize, quality: serde_json::Value| {
            serde_json::json!({
                "id": id,
                "startedAt": "2026-10-08T10:00:00.000Z",
                "segments": [{ "text": "I want to speak", "startSeconds": 0.0, "endSeconds": 2.0, "speakerLabel": "Me", "isFinal": true }],
                "report": {
                    "totalDurationSeconds": 60.0,
                    "wordCount": 4,
                    "stutterCount": stutters,
                    "stuttersPerMinute": stutters as f64,
                    "captureQuality": quality
                }
            })
        };
        let unknown = serde_json::json!({
            "state": "unknown",
            "issues": ["clipping"],
            "explanation": "Result unknown: the input is clipping (too loud)."
        });
        save_speech_corpus_session_impl(
            &path,
            serde_json::from_value(session(
                "usable",
                2,
                serde_json::json!({ "state": "usable", "issues": [] }),
            ))
            .unwrap(),
        )
        .unwrap();
        let analysis = save_speech_corpus_session_impl(
            &path,
            serde_json::from_value(session("clipped", 30, unknown.clone())).unwrap(),
        )
        .unwrap();
        let exported = export_speech_corpus_impl(&path).unwrap();
        let _ = fs::remove_file(&path);

        assert_eq!(analysis.stats.sessions, 2);
        assert_eq!(analysis.stats.withheld_sessions, 1);
        assert_eq!(analysis.stats.stutter_count, 2);
        assert!((analysis.stats.stutters_per_minute - 2.0).abs() < 1e-9);
        assert_eq!(analysis.stats.total_duration_seconds, 120.0);
        assert_eq!(
            analysis
                .speakers
                .iter()
                .map(|speaker| speaker.stutter_count)
                .sum::<usize>(),
            2
        );
        let clipped = exported["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == "clipped")
            .unwrap();
        assert_eq!(clipped["stutterCount"], 30);
        assert_eq!(clipped["captureQuality"], unknown);
    }

    #[test]
    fn backfills_capture_quality_of_rows_saved_without_it() {
        let path = temp_corpus_path("backfill");
        fs::write(
            &path,
            r#"{"sessions":[
                {"id":"legacy","startedAt":"2026-10-08T10:00:00.000Z","segments":[{"text":"I want to speak","startSeconds":0.0,"endSeconds":2.0,"isFinal":true}],"totalDurationSeconds":60.0,"wordCount":4,"stutterCount":30,"stuttersPerMinute":30.0},
                {"id":"kept","startedAt":"2026-10-07T10:00:00.000Z","segments":[],"totalDurationSeconds":60.0,"wordCount":0,"stutterCount":2,"stuttersPerMinute":2.0,"captureQuality":{"state":"usable","issues":[]}}
            ]}"#,
        )
        .unwrap();
        let unknown = serde_json::json!({
            "state": "unknown",
            "issues": ["noInput"],
            "explanation": "Result unknown: the microphone delivered no input."
        });
        let qualities = BTreeMap::from([
            ("legacy".to_owned(), unknown.clone()),
            ("kept".to_owned(), unknown.clone()),
            ("absent".to_owned(), unknown.clone()),
        ]);
        let analysis = backfill_speech_corpus_capture_quality_impl(&path, &qualities).unwrap();
        let store = read_store(&path).unwrap();
        let _ = fs::remove_file(&path);

        assert_eq!(analysis.stats.withheld_sessions, 1);
        assert_eq!(analysis.stats.stutter_count, 2);
        assert_eq!(store.sessions[0].capture_quality, Some(unknown));
        // A row's own verdict is never overwritten.
        assert_eq!(
            store.sessions[1].capture_quality,
            Some(serde_json::json!({ "state": "usable", "issues": [] }))
        );
    }

    fn temp_corpus_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "vox-corpus-{name}-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn loads_corpus_files_written_before_provenance_was_stored() {
        let path = temp_corpus_path("legacy");
        fs::write(
            &path,
            r#"{"sessions":[{"id":"old","startedAt":"2026-05-19T12:00:00.000Z","segments":[],"totalDurationSeconds":3.0,"wordCount":0,"stutterCount":0,"stuttersPerMinute":0.0}]}"#,
        )
        .unwrap();
        let store = read_store(&path).unwrap();
        let _ = fs::remove_file(&path);

        assert_eq!(store.sessions.len(), 1);
        assert_eq!(store.sessions[0].provenance, SessionProvenance::default());
    }

    #[test]
    fn keeps_session_provenance_through_desktop_persistence() {
        let path = temp_corpus_path("provenance");
        let provenance = serde_json::json!({
            "schemaVersion": 2,
            "context": {
                "spokenLanguage": "en",
                "task": { "kind": "reading", "trained": false },
                "condition": { "kind": "assisted", "aidId": "daf", "settings": { "delayMs": 80 } }
            },
            "recordings": [{ "sessionId": "s-1", "runId": "r-1", "origin": "desktop", "role": "appInput" }],
            "analysis": {
                "id": "run-1",
                "createdAt": "2026-10-08T10:00:00.000Z",
                "analyzer": { "producer": "desktopNative", "algorithm": "analyze_speech_session", "version": "1" },
                "inputId": "obs-0011",
                "usedAudio": true,
                "audioId": "pcm-22"
            },
            "priorAnalyses": [],
            "annotations": [{ "id": "a-1", "status": "accepted" }],
            "futureOutcomes": [{ "measure": "effort", "value": 3 }]
        });
        let observed = serde_json::json!([
            { "text": "  I I want  ", "startSeconds": 0.0, "endSeconds": 1.5, "confidence": 0.91, "speakerLabel": " Me ", "isFinal": true },
            { "text": "", "startSeconds": 1.5, "endSeconds": 2.0, "isFinal": false }
        ]);
        let mut input = serde_json::json!({
            "id": "s-1",
            "startedAt": "2026-10-08T10:00:00.000Z",
            "segments": observed.clone(),
            "report": { "totalDurationSeconds": 3.0, "wordCount": 0, "stutterCount": 0, "stuttersPerMinute": 0.0 }
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(provenance.as_object().unwrap().clone());

        save_speech_corpus_session_impl(&path, serde_json::from_value(input).unwrap()).unwrap();
        let exported = export_speech_corpus_impl(&path).unwrap();
        let observations = speech_corpus_observations_impl(&path).unwrap();
        let _ = fs::remove_file(&path);

        assert_eq!(
            observations["sessions"][0],
            serde_json::json!({
                "analysis": { "inputId": provenance["analysis"]["inputId"] },
                "observedSegments": observed,
                "pauses": serde_json::Value::Null,
            })
        );
        let session = &exported["sessions"][0];
        // Fingerprints refer to the untouched segments, which are kept next to the normalized view.
        assert_eq!(session["observedSegments"], observed);
        assert_eq!(session["segments"].as_array().unwrap().len(), 1);
        assert_eq!(session["segments"][0]["text"], "I I want");
        for key in [
            "schemaVersion",
            "context",
            "recordings",
            "analysis",
            "priorAnalyses",
            "annotations",
            "futureOutcomes",
        ] {
            assert_eq!(session[key], provenance[key], "{key}");
        }
    }
}
