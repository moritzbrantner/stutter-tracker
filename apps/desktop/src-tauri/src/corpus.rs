use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use text_analysis_corpus::{CorpusOptions, CorpusStats, CorpusTermStats, TfIdfCorpus};
use text_analysis_features::{
    extractive_summary, keywords, readability_summary, sentiment, summarize_text,
    ExtractiveSummaryOptions, KeywordOptions, ReadabilitySummary, SentimentLexicon,
    SentimentSummary, TextFeatureSummary,
};
use text_analysis_linguistics::{analyze_text, LinguisticAnalysis, LinguisticAnalysisOptions};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CorpusError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid corpus JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Analysis(#[from] video_analysis_core::DetectError),
}

type Result<T> = std::result::Result<T, CorpusError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusSessionInput {
    pub id: String,
    pub started_at: String,
    pub segments: Vec<CorpusSegmentInput>,
    pub report: CorpusReportInput,
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
    pub stutter_count: usize,
    pub stutters_per_minute: f64,
    pub lexical_diversity: f32,
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
        return Ok(empty_analysis(store.sessions.len()));
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
                    session.stutter_count,
                    word_count,
                    session.word_count,
                ),
            });
        }
    }
    documents
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
    let stutter_count = store
        .sessions
        .iter()
        .map(|session| session.stutter_count)
        .sum();
    let minutes = (total_duration_seconds / 60.0).max(1.0 / 60.0);
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

fn keyword_output(keyword: text_analysis_features::Keyword) -> CorpusKeyword {
    CorpusKeyword {
        text: keyword.text,
        score: keyword.score,
        count: keyword.count,
    }
}

fn empty_analysis(sessions: usize) -> SpeechCorpusAnalysis {
    SpeechCorpusAnalysis {
        stats: SpeechCorpusStats {
            sessions,
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
                id: "session-1".to_string(),
                started_at: "2026-05-19T12:00:00.000Z".to_string(),
                total_duration_seconds: 20.0,
                word_count: 8,
                stutter_count: 1,
                stutters_per_minute: 3.0,
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
}
