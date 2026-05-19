use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use text_analysis_transcription::{
    Transcriber, TranscriptionResult, WhisperCliTranscriber, WhisperCppConfig, WhisperCppModel,
    WhisperCppModelStore, WhisperCppTranscriber,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TranscriptionCommandError {
    #[error("{0}")]
    Invalid(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("WAV error: {0}")]
    Wav(#[from] hound::Error),
    #[error("network error: {0}")]
    Network(String),
    #[error("{0}")]
    Transcription(#[from] text_analysis_transcription::TranscriptionError),
}

type Result<T> = std::result::Result<T, TranscriptionCommandError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioRequest {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub provider: TranscriptionProvider,
    pub model: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelsRequest {
    pub provider: TranscriptionProvider,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTranscriptionModelRequest {
    pub provider: TranscriptionProvider,
    pub model: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionProvider {
    Browser,
    WhisperCpp,
    WhisperCli,
    FasterWhisper,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelsResult {
    pub provider: TranscriptionProviderResult,
    pub models: Vec<TranscriptionModelStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelStatus {
    pub id: String,
    pub label: String,
    pub cached: bool,
    pub downloadable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeAudioResult {
    pub text: Option<String>,
    pub language: Option<String>,
    pub segments: Vec<TranscribedSegment>,
    pub provider: TranscriptionProviderResult,
    pub model: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionProviderResult {
    Browser,
    WhisperCpp,
    WhisperCli,
    FasterWhisper,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedSegment {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub confidence: Option<f32>,
    pub is_final: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgressEvent {
    pub phase: String,
    pub message: String,
    pub model: Option<String>,
    pub progress: Option<f32>,
}

pub fn transcription_models_impl(
    request: TranscriptionModelsRequest,
) -> Result<TranscriptionModelsResult> {
    Ok(match request.provider {
        TranscriptionProvider::Browser => TranscriptionModelsResult {
            provider: TranscriptionProviderResult::Browser,
            models: vec![model_status("default", true, false)],
        },
        TranscriptionProvider::WhisperCpp => {
            let store = WhisperCppModelStore::default();
            TranscriptionModelsResult {
                provider: TranscriptionProviderResult::WhisperCpp,
                models: WhisperCppModel::ALL
                    .into_iter()
                    .map(|model| TranscriptionModelStatus {
                        id: model.id().to_string(),
                        label: model.id().to_string(),
                        cached: store.model_path(model).is_file(),
                        downloadable: true,
                    })
                    .collect(),
            }
        }
        TranscriptionProvider::WhisperCli => TranscriptionModelsResult {
            provider: TranscriptionProviderResult::WhisperCli,
            models: ["tiny", "base", "small", "medium", "large", "turbo"]
                .into_iter()
                .map(|model| model_status(model, false, false))
                .collect(),
        },
        TranscriptionProvider::FasterWhisper => TranscriptionModelsResult {
            provider: TranscriptionProviderResult::FasterWhisper,
            models: [
                "tiny",
                "base",
                "small",
                "medium",
                "large-v3",
                "distil-large-v3",
            ]
            .into_iter()
            .map(|model| model_status(model, false, false))
            .collect(),
        },
    })
}

pub fn download_transcription_model_impl<F>(
    request: DownloadTranscriptionModelRequest,
    mut emit: F,
) -> Result<TranscriptionModelStatus>
where
    F: FnMut(TranscriptionProgressEvent),
{
    if !matches!(request.provider, TranscriptionProvider::WhisperCpp) {
        return Err(TranscriptionCommandError::Invalid(
            "only whisper.cpp models can be downloaded by this app".to_string(),
        ));
    }

    let model = parse_whisper_cpp_model(&request.model)?;
    let store = WhisperCppModelStore::default();
    fs::create_dir_all(store.models_dir())?;
    let model_path = store.model_path(model);
    if model_path.is_file() {
        return Ok(TranscriptionModelStatus {
            id: model.id().to_string(),
            label: model.id().to_string(),
            cached: true,
            downloadable: true,
        });
    }

    emit(TranscriptionProgressEvent {
        phase: "downloading".to_string(),
        message: format!("Downloading `{}`", model.id()),
        model: Some(model.id().to_string()),
        progress: Some(0.0),
    });

    let temp_path = model_path.with_extension("bin.part");
    let _ = fs::remove_file(&temp_path);
    let response = ureq::get(&model.download_url())
        .call()
        .map_err(|error| TranscriptionCommandError::Network(error.to_string()))?;
    let total_bytes = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut writer = BufWriter::new(File::create(&temp_path)?);
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| TranscriptionCommandError::Network(error.to_string()))?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        let progress = total_bytes.map(|total| (downloaded as f32 / total as f32).clamp(0.0, 1.0));
        emit(TranscriptionProgressEvent {
            phase: "downloading".to_string(),
            message: format!("Downloading `{}`", model.id()),
            model: Some(model.id().to_string()),
            progress,
        });
    }
    writer.flush()?;

    let checksum = format!("{:x}", hasher.finalize());
    if checksum != model.checksum_sha256() {
        let _ = fs::remove_file(&temp_path);
        return Err(TranscriptionCommandError::Invalid(format!(
            "downloaded model `{}` failed checksum verification",
            model.id()
        )));
    }

    fs::rename(temp_path, &model_path)?;
    emit(TranscriptionProgressEvent {
        phase: "ready".to_string(),
        message: format!("Model `{}` is ready", model.id()),
        model: Some(model.id().to_string()),
        progress: Some(1.0),
    });

    Ok(TranscriptionModelStatus {
        id: model.id().to_string(),
        label: model.id().to_string(),
        cached: true,
        downloadable: true,
    })
}

pub fn transcribe_audio_impl(request: TranscribeAudioRequest) -> Result<TranscribeAudioResult> {
    validate_samples(&request.samples, request.sample_rate)?;
    let temp_dir = temp_transcription_dir()?;
    let transcribed = transcribe_with_temp_dir(&request, &temp_dir);
    let _ = fs::remove_dir_all(&temp_dir);
    transcribed
}

fn transcribe_with_temp_dir(
    request: &TranscribeAudioRequest,
    temp_dir: &Path,
) -> Result<TranscribeAudioResult> {
    let wav_path = temp_dir.join("input.wav");
    write_mono_wav(&wav_path, &request.samples, request.sample_rate)?;

    let language = normalize_language(request.language.as_deref());
    let model = request.model.trim().to_string();
    Ok(match request.provider {
        TranscriptionProvider::Browser => {
            return Err(TranscriptionCommandError::Invalid(
                "browser transcription runs in the web view".to_string(),
            ));
        }
        TranscriptionProvider::WhisperCpp => {
            let parsed_model = parse_whisper_cpp_model(&model)?;
            let store = WhisperCppModelStore::default();
            if !store.model_path(parsed_model).is_file() {
                download_transcription_model_impl(
                    DownloadTranscriptionModelRequest {
                        provider: TranscriptionProvider::WhisperCpp,
                        model: parsed_model.id().to_string(),
                    },
                    |_| {},
                )?;
            }
            let mut transcriber = WhisperCppTranscriber::new(WhisperCppConfig {
                model: parsed_model,
                language,
                translate: false,
                threads: None,
            });
            let result = transcriber.transcribe(&wav_path)?;
            build_result(
                result,
                TranscriptionProviderResult::WhisperCpp,
                parsed_model.id().to_string(),
            )
        }
        TranscriptionProvider::WhisperCli => {
            let mut transcriber = WhisperCliTranscriber::new("whisper")
                .args(cli_args(&model, language.as_deref()))
                .output_dir(temp_dir.join("whisper-output"));
            let result = transcriber.transcribe(&wav_path)?;
            build_result(result, TranscriptionProviderResult::WhisperCli, model)
        }
        TranscriptionProvider::FasterWhisper => {
            let mut transcriber = WhisperCliTranscriber::new("faster-whisper")
                .args(cli_args(&model, language.as_deref()))
                .output_dir(temp_dir.join("faster-whisper-output"));
            let result = transcriber.transcribe(&wav_path)?;
            build_result(result, TranscriptionProviderResult::FasterWhisper, model)
        }
    })
}

fn validate_samples(samples: &[f32], sample_rate: u32) -> Result<()> {
    if sample_rate == 0 {
        return Err(TranscriptionCommandError::Invalid(
            "sample rate must be greater than zero".to_string(),
        ));
    }
    if samples.len() < sample_rate as usize / 2 {
        return Err(TranscriptionCommandError::Invalid(
            "at least 500ms of audio samples are required".to_string(),
        ));
    }
    if !samples.iter().all(|sample| sample.is_finite()) {
        return Err(TranscriptionCommandError::Invalid(
            "audio samples must be finite".to_string(),
        ));
    }
    Ok(())
}

fn model_status(model: &str, cached: bool, downloadable: bool) -> TranscriptionModelStatus {
    TranscriptionModelStatus {
        id: model.to_string(),
        label: model.to_string(),
        cached,
        downloadable,
    }
}

fn build_result(
    result: TranscriptionResult,
    provider: TranscriptionProviderResult,
    model: String,
) -> TranscribeAudioResult {
    let segments = result
        .segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| {
            let start_seconds = segment.start_seconds.unwrap_or(index as f64 * 2.0);
            let end_seconds = segment
                .end_seconds
                .unwrap_or_else(|| (start_seconds + 2.0).max(start_seconds));
            TranscribedSegment {
                text: segment.text.trim().to_string(),
                start_seconds,
                end_seconds,
                confidence: segment.confidence,
                is_final: true,
            }
        })
        .filter(|segment| !segment.text.is_empty())
        .collect();
    TranscribeAudioResult {
        text: result.text,
        language: result.language,
        segments,
        provider,
        model,
    }
}

fn cli_args(model: &str, language: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if !model.is_empty() && model != "default" {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(language) = language {
        args.push("--language".to_string());
        args.push(language.to_string());
    }
    args
}

fn parse_whisper_cpp_model(value: &str) -> Result<WhisperCppModel> {
    match value.trim() {
        "tiny.en" => Ok(WhisperCppModel::TinyEn),
        "tiny" => Ok(WhisperCppModel::Tiny),
        "base.en" | "" | "default" => Ok(WhisperCppModel::BaseEn),
        "base" => Ok(WhisperCppModel::Base),
        "small.en" => Ok(WhisperCppModel::SmallEn),
        "small" => Ok(WhisperCppModel::Small),
        "medium.en" => Ok(WhisperCppModel::MediumEn),
        "medium" => Ok(WhisperCppModel::Medium),
        "large-v1" => Ok(WhisperCppModel::LargeV1),
        "large-v2" => Ok(WhisperCppModel::LargeV2),
        "large-v3" => Ok(WhisperCppModel::LargeV3),
        "large-v3-turbo" => Ok(WhisperCppModel::LargeV3Turbo),
        other => Err(TranscriptionCommandError::Invalid(format!(
            "unsupported whisper.cpp model `{other}`"
        ))),
    }
}

fn normalize_language(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return None;
    }
    value
        .split(['-', '_'])
        .next()
        .map(str::to_lowercase)
        .filter(|value| !value.is_empty())
}

fn temp_transcription_dir() -> Result<PathBuf> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!(
        "stutter-tracker-transcription-{}-{millis}",
        std::process::id()
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn write_mono_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for sample in samples {
        writer.write_sample(sample.clamp(-1.0, 1.0))?;
    }
    writer.finalize()?;
    Ok(())
}
