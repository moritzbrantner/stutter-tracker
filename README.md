# Stutter Tracker

Cross-platform speech fluency tracker built with React and Tauri 2.

## Targets

- Web: `bun run dev`
- Desktop: `bun run desktop`
- Android/iOS setup: `bun run mobile:init`
- Android dev: `bun run android`
- iOS dev: `bun run ios`

## Current Capabilities

- Microphone recording through browser/WebView media APIs.
- Live transcription through the browser speech recognition API where available.
- Desktop transcription model selection for browser speech, whisper.cpp, Whisper CLI, and Faster-Whisper.
- whisper.cpp model catalog, local cache detection, and in-app model downloads.
- Multi-speaker enrollment and labeled speaker identification through the local Rust `audio-analysis-recognition` crate.
- Rust-side stutter event detection for repeated words, repeated sounds, prolongations, silent blocks, and fillers.
- Local session storage and JSON export.

## Notes

The app tracks speech patterns for personal review and is not a diagnostic tool. Whisper CLI and Faster-Whisper backends require their command-line tools to be available on `PATH`; whisper.cpp models are managed by the desktop app.
