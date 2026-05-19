mod corpus;
mod speech_analysis;
pub mod transcription;

use std::fs;
use std::path::PathBuf;

use corpus::{
    export_speech_corpus_impl, load_speech_corpus_impl, save_speech_corpus_session_impl,
    CorpusSessionInput, SpeechCorpusAnalysis,
};
use speech_analysis::{
    analyze_speech_session_impl, compare_voiceprint_impl, create_voiceprint_impl, AnalysisReport,
    AnalyzeSpeechRequest, SpeakerIdentificationRequest, SpeakerIdentificationResult,
    SpeakerProfileRequest, SpeakerProfileResult, VoiceMatchRequest, VoiceMatchResult,
    VoiceprintRequest, VoiceprintResult,
};
use tauri::{Emitter, Manager};
use transcription::{
    download_transcription_model_impl, transcribe_audio_impl, transcription_models_impl,
    DownloadTranscriptionModelRequest, TranscribeAudioRequest, TranscribeAudioResult,
    TranscriptionModelStatus, TranscriptionModelsRequest, TranscriptionModelsResult,
    TranscriptionProgressEvent,
};

#[tauri::command]
fn analyze_speech_session(request: AnalyzeSpeechRequest) -> Result<AnalysisReport, String> {
    analyze_speech_session_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_voiceprint(request: VoiceprintRequest) -> Result<VoiceprintResult, String> {
    create_voiceprint_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn compare_voiceprint(request: VoiceMatchRequest) -> Result<VoiceMatchResult, String> {
    compare_voiceprint_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_speaker_profile(request: SpeakerProfileRequest) -> Result<SpeakerProfileResult, String> {
    speech_analysis::create_speaker_profile_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn identify_speaker(
    request: SpeakerIdentificationRequest,
) -> Result<SpeakerIdentificationResult, String> {
    speech_analysis::identify_speaker_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn load_speaker_profiles(app: tauri::AppHandle) -> Result<Vec<SpeakerProfileResult>, String> {
    let path = speaker_profiles_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let speakers: Vec<SpeakerProfileResult> =
        serde_json::from_str(&content).map_err(|err| err.to_string())?;
    Ok(normalize_speaker_profiles(speakers))
}

#[tauri::command]
fn save_speaker_profiles(
    app: tauri::AppHandle,
    speakers: Vec<SpeakerProfileResult>,
) -> Result<Vec<SpeakerProfileResult>, String> {
    let path = speaker_profiles_path(&app)?;
    let speakers = normalize_speaker_profiles(speakers);
    let content = serde_json::to_string_pretty(&speakers).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| err.to_string())?;
    Ok(speakers)
}

#[tauri::command]
fn load_speech_corpus(app: tauri::AppHandle) -> Result<SpeechCorpusAnalysis, String> {
    load_speech_corpus_impl(&speech_corpus_path(&app)?).map_err(|err| err.to_string())
}

#[tauri::command]
fn export_speech_corpus(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    export_speech_corpus_impl(&speech_corpus_path(&app)?).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_speech_corpus_session(
    app: tauri::AppHandle,
    session: CorpusSessionInput,
) -> Result<SpeechCorpusAnalysis, String> {
    save_speech_corpus_session_impl(&speech_corpus_path(&app)?, session)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn transcribe_audio(request: TranscribeAudioRequest) -> Result<TranscribeAudioResult, String> {
    transcribe_audio_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn transcription_models(
    request: TranscriptionModelsRequest,
) -> Result<TranscriptionModelsResult, String> {
    transcription_models_impl(request).map_err(|err| err.to_string())
}

#[tauri::command]
fn download_transcription_model(
    app: tauri::AppHandle,
    request: DownloadTranscriptionModelRequest,
) -> Result<TranscriptionModelStatus, String> {
    download_transcription_model_impl(request, |event: TranscriptionProgressEvent| {
        let _ = app.emit("transcription-progress", event);
    })
    .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            analyze_speech_session,
            create_voiceprint,
            compare_voiceprint,
            create_speaker_profile,
            identify_speaker,
            load_speaker_profiles,
            save_speaker_profiles,
            load_speech_corpus,
            export_speech_corpus,
            save_speech_corpus_session,
            transcribe_audio,
            transcription_models,
            download_transcription_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stutter Tracker");
}

fn speaker_profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    Ok(data_dir.join("known-speakers.json"))
}

fn speech_corpus_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    Ok(data_dir.join("speech-corpus.json"))
}

fn normalize_speaker_profiles(speakers: Vec<SpeakerProfileResult>) -> Vec<SpeakerProfileResult> {
    speakers
        .into_iter()
        .filter(|speaker| {
            !speaker.id.trim().is_empty()
                && !speaker.label.trim().is_empty()
                && !speaker.embeddings.is_empty()
        })
        .collect()
}
