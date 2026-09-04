use crate::speech_analysis::{
    analyze_speech_session_impl, AnalysisReport, AnalyzeSpeechRequest, SpeechAnalysisError,
};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum ObservationChannel {
    Transcript,
    Pause,
    Acoustic,
}

#[derive(Debug, Clone, PartialEq)]
struct ObservationBatch {
    finalized_transcript_segments: usize,
    pause_observations: usize,
    audio_sample_count: usize,
    sample_rate: Option<u32>,
    timeline_end_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct FusedObservationContext {
    channels: Vec<ObservationChannel>,
    timeline_end_seconds: f64,
    has_complete_audio_input: bool,
}

/// Product-level orchestration seam for speech analysis.
///
/// The existing detector remains the interpretation backend for now. Keeping the
/// phases explicit lets later work replace transcript observations, acoustic
/// observations, fusion, or interpretation independently without moving generic
/// audio/NLP algorithms back into the product repository.
pub(crate) fn analyze_speech_session(
    request: AnalyzeSpeechRequest,
) -> Result<AnalysisReport, SpeechAnalysisError> {
    let observations = collect_observations(&request);
    let fused = fuse_observations(&observations);
    interpret_session(request, fused)
}

fn collect_observations(request: &AnalyzeSpeechRequest) -> ObservationBatch {
    let timeline_end_seconds = request
        .segments
        .iter()
        .filter(|segment| segment.is_final)
        .map(|segment| segment.end_seconds)
        .chain(request.pauses.iter().map(|pause| pause.end_seconds))
        .filter(|value| value.is_finite())
        .fold(0.0_f64, f64::max);

    ObservationBatch {
        finalized_transcript_segments: request
            .segments
            .iter()
            .filter(|segment| segment.is_final)
            .count(),
        pause_observations: request.pauses.len(),
        audio_sample_count: request.samples.as_ref().map_or(0, Vec::len),
        sample_rate: request.sample_rate,
        timeline_end_seconds,
    }
}

fn fuse_observations(observations: &ObservationBatch) -> FusedObservationContext {
    let has_complete_audio_input = observations.audio_sample_count > 0
        && observations.sample_rate.is_some_and(|sample_rate| sample_rate > 0);
    let mut channels = Vec::with_capacity(3);
    if observations.finalized_transcript_segments > 0 {
        channels.push(ObservationChannel::Transcript);
    }
    if observations.pause_observations > 0 {
        channels.push(ObservationChannel::Pause);
    }
    if has_complete_audio_input {
        channels.push(ObservationChannel::Acoustic);
    }

    FusedObservationContext {
        channels,
        timeline_end_seconds: observations.timeline_end_seconds,
        has_complete_audio_input,
    }
}

fn interpret_session(
    request: AnalyzeSpeechRequest,
    context: FusedObservationContext,
) -> Result<AnalysisReport, SpeechAnalysisError> {
    // The context is deliberately computed before interpretation even though the
    // legacy detector still performs its own internal fusion. These assertions
    // keep the new seam behavior-neutral while protecting its basic invariants.
    debug_assert!(context.timeline_end_seconds >= 0.0);
    debug_assert_eq!(
        context.has_complete_audio_input,
        request
            .samples
            .as_ref()
            .is_some_and(|samples| !samples.is_empty())
            && request.sample_rate.is_some_and(|sample_rate| sample_rate > 0)
    );
    debug_assert_eq!(
        context.channels.contains(&ObservationChannel::Acoustic),
        context.has_complete_audio_input
    );

    analyze_speech_session_impl(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_analysis::{PauseInput, TranscriptSegmentInput};

    #[test]
    fn collection_records_available_observation_families() {
        let request = AnalyzeSpeechRequest {
            segments: vec![
                TranscriptSegmentInput {
                    text: "final".to_string(),
                    start_seconds: 0.0,
                    end_seconds: 1.0,
                    confidence: Some(0.9),
                    speaker_score: Some(0.9),
                    is_final: true,
                },
                TranscriptSegmentInput {
                    text: "partial".to_string(),
                    start_seconds: 1.0,
                    end_seconds: 1.5,
                    confidence: None,
                    speaker_score: None,
                    is_final: false,
                },
            ],
            pauses: vec![PauseInput {
                start_seconds: 1.5,
                end_seconds: 2.0,
                after_text: Some("final".to_string()),
            }],
            session_started_at: None,
            samples: Some(vec![0.0; 1_600]),
            sample_rate: Some(16_000),
        };

        let observations = collect_observations(&request);
        assert_eq!(observations.finalized_transcript_segments, 1);
        assert_eq!(observations.pause_observations, 1);
        assert_eq!(observations.audio_sample_count, 1_600);
        assert_eq!(observations.timeline_end_seconds, 2.0);

        let fused = fuse_observations(&observations);
        assert_eq!(
            fused.channels,
            vec![
                ObservationChannel::Transcript,
                ObservationChannel::Pause,
                ObservationChannel::Acoustic,
            ]
        );
        assert!(fused.has_complete_audio_input);
    }

    #[test]
    fn partial_transcript_does_not_extend_the_interpreted_timeline() {
        let request = AnalyzeSpeechRequest {
            segments: vec![
                TranscriptSegmentInput {
                    text: "final".to_string(),
                    start_seconds: 0.0,
                    end_seconds: 1.0,
                    confidence: Some(0.9),
                    speaker_score: Some(0.9),
                    is_final: true,
                },
                TranscriptSegmentInput {
                    text: "partial".to_string(),
                    start_seconds: 1.0,
                    end_seconds: 5.0,
                    confidence: None,
                    speaker_score: None,
                    is_final: false,
                },
            ],
            pauses: vec![],
            session_started_at: None,
            samples: None,
            sample_rate: None,
        };

        let observations = collect_observations(&request);
        assert_eq!(observations.finalized_transcript_segments, 1);
        assert_eq!(observations.timeline_end_seconds, 1.0);
    }

    #[test]
    fn incomplete_audio_does_not_claim_an_acoustic_channel() {
        let observations = ObservationBatch {
            finalized_transcript_segments: 1,
            pause_observations: 0,
            audio_sample_count: 1_600,
            sample_rate: None,
            timeline_end_seconds: 1.0,
        };

        let fused = fuse_observations(&observations);
        assert!(!fused.channels.contains(&ObservationChannel::Acoustic));
        assert!(!fused.has_complete_audio_input);
    }

    #[test]
    fn zero_sample_rate_does_not_claim_an_acoustic_channel() {
        let observations = ObservationBatch {
            finalized_transcript_segments: 1,
            pause_observations: 0,
            audio_sample_count: 1_600,
            sample_rate: Some(0),
            timeline_end_seconds: 1.0,
        };

        let fused = fuse_observations(&observations);
        assert!(!fused.channels.contains(&ObservationChannel::Acoustic));
        assert!(!fused.has_complete_audio_input);
    }

    #[test]
    fn orchestration_seam_preserves_legacy_detector_output() {
        let request = AnalyzeSpeechRequest {
            segments: vec![TranscriptSegmentInput {
                text: "I I want to explain this clearly".to_string(),
                start_seconds: 0.0,
                end_seconds: 2.0,
                confidence: Some(0.95),
                speaker_score: Some(0.98),
                is_final: true,
            }],
            pauses: vec![PauseInput {
                start_seconds: 2.0,
                end_seconds: 2.7,
                after_text: Some("clearly".to_string()),
            }],
            session_started_at: Some("fixture-session".to_string()),
            samples: None,
            sample_rate: None,
        };

        let legacy = analyze_speech_session_impl(request.clone()).unwrap();
        let orchestrated = analyze_speech_session(request).unwrap();

        assert_eq!(
            serde_json::to_value(orchestrated).unwrap(),
            serde_json::to_value(legacy).unwrap()
        );
    }
}
