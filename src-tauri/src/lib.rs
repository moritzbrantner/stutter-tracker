mod speech_analysis;
mod transcription;

use speech_analysis::{
    analyze_speech_session_impl, compare_voiceprint_impl, create_voiceprint_impl, AnalysisReport,
    AnalyzeSpeechRequest, VoiceMatchRequest, VoiceMatchResult, VoiceprintRequest, VoiceprintResult,
};
use tauri::Emitter;
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
            transcribe_audio,
            transcription_models,
            download_transcription_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stutter Tracker");
}
