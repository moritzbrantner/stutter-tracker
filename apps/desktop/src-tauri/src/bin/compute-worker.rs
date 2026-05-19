use std::io::{self, Read};
use std::process::ExitCode;

use serde::Deserialize;
use serde_json::Value;
use stutter_tracker_lib::transcription::{
    download_transcription_model_impl, transcribe_audio_impl, transcription_models_impl,
    DownloadTranscriptionModelRequest, TranscribeAudioRequest, TranscriptionModelsRequest,
    TranscriptionProgressEvent,
};

#[derive(Debug, Deserialize)]
#[serde(tag = "command", content = "request", rename_all = "kebab-case")]
enum WorkerCommand {
    TranscriptionModels(TranscriptionModelsRequest),
    DownloadTranscriptionModel(DownloadTranscriptionModelRequest),
    TranscribeAudio(TranscribeAudioRequest),
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let command = read_command()?;
    let response = match command {
        WorkerCommand::TranscriptionModels(request) => {
            to_value(transcription_models_impl(request).map_err(|error| error.to_string())?)?
        }
        WorkerCommand::DownloadTranscriptionModel(request) => to_value(
            download_transcription_model_impl(request, print_progress)
                .map_err(|error| error.to_string())?,
        )?,
        WorkerCommand::TranscribeAudio(request) => {
            to_value(transcribe_audio_impl(request).map_err(|error| error.to_string())?)?
        }
    };
    println!("{response}");
    Ok(())
}

fn read_command() -> Result<WorkerCommand, String> {
    let mut payload = String::new();
    io::stdin()
        .read_to_string(&mut payload)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&payload).map_err(|error| format!("invalid worker command: {error}"))
}

fn to_value(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn print_progress(event: TranscriptionProgressEvent) {
    if let Some(progress) = event.progress {
        eprintln!(
            "{}: {:.0}%",
            event.model.as_deref().unwrap_or("model"),
            progress * 100.0
        );
        return;
    }
    eprintln!("{}", event.message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use stutter_tracker_lib::transcription::TranscriptionProvider;

    #[test]
    fn parses_transcription_models_command() {
        let command: WorkerCommand = serde_json::from_str(
            r#"{"command":"transcription-models","request":{"provider":"whisperCpp"}}"#,
        )
        .unwrap();
        match command {
            WorkerCommand::TranscriptionModels(request) => {
                assert!(matches!(
                    request.provider,
                    TranscriptionProvider::WhisperCpp
                ));
            }
            _ => panic!("unexpected command"),
        }
    }

    #[test]
    fn rejects_unknown_command() {
        let err = serde_json::from_str::<WorkerCommand>(
            r#"{"command":"missing","request":{"provider":"whisperCpp"}}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown variant"));
    }
}
