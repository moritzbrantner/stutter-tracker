use std::collections::BTreeSet;
use std::env;
use std::process::ExitCode;

use stutter_tracker_lib::transcription::{
    download_transcription_model_impl, transcription_models_impl,
    DownloadTranscriptionModelRequest, TranscriptionModelsRequest, TranscriptionProgressEvent,
    TranscriptionProvider,
};

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
    let options = Options::parse(env::args().skip(1))?;
    let statuses = transcription_models_impl(TranscriptionModelsRequest {
        provider: TranscriptionProvider::WhisperCpp,
    })
    .map_err(|error| error.to_string())?
    .models;

    if options.list {
        for status in &statuses {
            let state = if status.cached { "cached" } else { "missing" };
            println!("{}\t{}", status.id, state);
        }
        return Ok(());
    }

    let available = statuses
        .iter()
        .map(|status| status.id.as_str())
        .collect::<BTreeSet<_>>();
    let models = if options.all {
        statuses
            .iter()
            .map(|status| status.id.clone())
            .collect::<Vec<_>>()
    } else if options.models.is_empty() {
        vec!["base.en".to_string()]
    } else {
        options.models
    };

    for model in models {
        if !available.contains(model.as_str()) {
            return Err(format!(
                "unknown whisper.cpp model `{model}`. Run `bun run artifacts:status` to list models."
            ));
        }

        let cached = statuses
            .iter()
            .find(|status| status.id == model)
            .map(|status| status.cached)
            .unwrap_or(false);

        if cached {
            println!("{model}: cached");
            continue;
        }

        println!("{model}: downloading");
        let mut last_bucket = None;
        let status = download_transcription_model_impl(
            DownloadTranscriptionModelRequest {
                provider: TranscriptionProvider::WhisperCpp,
                model: model.clone(),
            },
            |event| print_progress(&mut last_bucket, event),
        )
        .map_err(|error| error.to_string())?;

        if status.cached {
            println!("{}: ready", status.id);
        }
    }

    Ok(())
}

fn print_progress(last_bucket: &mut Option<u32>, event: TranscriptionProgressEvent) {
    if let Some(progress) = event.progress {
        let bucket = (progress * 100.0).floor() as u32 / 10 * 10;
        if Some(bucket) != *last_bucket || bucket == 100 {
            *last_bucket = Some(bucket);
            println!("{}: {}%", event.model.as_deref().unwrap_or("model"), bucket);
        }
        return;
    }
    println!("{}", event.message);
}

struct Options {
    all: bool,
    list: bool,
    models: Vec<String>,
}

impl Options {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut all = false;
        let mut list = false;
        let mut models = Vec::new();
        let mut args = args.peekable();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--all" | "--all-whisper-cpp" => all = true,
                "--list" | "list" | "status" => list = true,
                "--model" | "-m" => {
                    let model = args
                        .next()
                        .ok_or_else(|| "--model requires a model id".to_string())?;
                    models.push(model);
                }
                "--help" | "-h" => return Err(usage()),
                value if value.starts_with('-') => {
                    return Err(format!(
                        "{usage}\n\nunknown option `{value}`",
                        usage = usage()
                    ))
                }
                value => models.push(value.to_string()),
            }
        }

        if all && !models.is_empty() {
            return Err("--all cannot be combined with explicit model ids".to_string());
        }

        Ok(Self { all, list, models })
    }
}

fn usage() -> String {
    "Usage: ensure-artifacts [--list] [--all] [--model <id> ...] [model ...]\n\
     Defaults to downloading the base.en whisper.cpp model when no model is specified."
        .to_string()
}
