//! Scores the existing detector on locally provided SEP-28k labels and clip audio.
//!
//! bun run benchmark:stutter:corpus -- --labels SEP-28k_labels.csv --clips clips [--speakers map.csv]

use std::path::PathBuf;
use std::process::ExitCode;

mod video_analysis_core {
    pub use media_core::DetectError;
}

// Shared with the app; this binary uses only the analysis entry point and the benchmark.
#[allow(dead_code)]
#[path = "../speech_analysis.rs"]
mod speech_analysis;
#[allow(dead_code)]
#[path = "../speech_pipeline.rs"]
mod speech_pipeline;
#[allow(dead_code)]
#[path = "../stutter_bench.rs"]
mod stutter_bench;

const USAGE: &str = "usage: stutter-eval --labels <labels.csv> --clips <clips dir> [--speakers <clipId,speakerId csv>] [--vote-threshold 1-3] [--limit N] [--out report.json]";

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let mut labels = None;
    let mut clips = None;
    let mut speakers = None;
    let mut vote_threshold = 2_u8;
    let mut limit = None;
    let mut out = None;
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))
        };
        match flag.as_str() {
            "--labels" => labels = Some(PathBuf::from(value()?)),
            "--clips" => clips = Some(PathBuf::from(value()?)),
            "--speakers" => speakers = Some(PathBuf::from(value()?)),
            "--vote-threshold" => {
                vote_threshold = value()?
                    .parse()
                    .map_err(|_| "--vote-threshold must be 1, 2 or 3".to_owned())?
            }
            "--limit" => {
                limit = Some(
                    value()?
                        .parse::<usize>()
                        .ok()
                        .filter(|limit| *limit > 0)
                        .ok_or_else(|| "--limit must be a positive integer".to_owned())?,
                )
            }
            "--out" => out = Some(PathBuf::from(value()?)),
            "--help" | "-h" => return Err(USAGE.to_owned()),
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    let options = stutter_bench::CorpusRunOptions {
        labels_csv: labels.ok_or(USAGE)?,
        clips_dir: clips.ok_or(USAGE)?,
        speakers_csv: speakers,
        vote_threshold,
        limit,
    };
    let report = stutter_bench::run_sep28k_corpus(&options).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    match out {
        Some(path) => std::fs::write(&path, json + "\n")
            .map_err(|error| format!("cannot write {}: {error}", path.display())),
        None => {
            println!("{json}");
            Ok(())
        }
    }
}
