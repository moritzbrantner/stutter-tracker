# Stutter Tracker

Cross-platform speech fluency tracker organized as a Bun monorepo.

## Workspaces

- `apps/web`: Vite React web app. It calls the external compute server first and falls back to browser-local analysis with WebGPU probing when the server is unavailable.
- `apps/desktop`: Tauri 2 desktop app. It keeps the Rust-backed local hardware path for analysis, speaker matching, transcription, and model downloads.
- `apps/mobile`: React Native app built with Expo. It talks to the external compute server through the shared client.
- `apps/server`: Bun HTTP compute server with shared analysis, speaker persistence, secured CORS/auth, and native transcription worker delegation.
- `packages/shared`: Shared domain types, model catalogs, fallback analysis, audio resampling, and speaker helpers.
- `packages/compute-client`: Shared HTTP compute client used by web and mobile.

## Commands

- Local web + compute server: `bun run dev`
- Web only: `bun run web`
- Compute server only: `bun run server`
- Desktop: `bun run desktop`
- Mobile: `bun run mobile`
- Artifact status: `bun run artifacts:status`
- Download default local transcription artifact: `bun run artifacts:download`
- Build web/shared packages: `bun run build`
- Unit tests: `bun run test:unit`
- Integration tests: `bun run test:integration`
- E2E tests: `bun run test:e2e`
- Rust tests: `bun run test:rust`

## Compute Setup

The default external compute URL is `http://127.0.0.1:8787`.

Known speaker profiles are persisted by the server when `DATABASE_URL` or `POSTGRES_URL` points at a Postgres database. The server creates the `known_speakers` table on first use. Without a database URL, the server writes a local JSON speaker store at `.stutter-tracker/server-speakers.json` by default. Override that path with `STUTTER_SPEAKER_STORE_PATH`.

For local development, run:

```sh
bun run dev
```

This starts the compute server on `http://127.0.0.1:8787` and the web app on `http://127.0.0.1:1421`, with the web app pointed at the local server.

Optional local overrides:

```sh
STUTTER_SERVER_PORT=8788 STUTTER_WEB_PORT=3000 bun run dev
```

For the web app, override it with:

```sh
VITE_STUTTER_SERVER_URL=http://host:8787 bun run web
```

For the mobile app, edit the server URL in the app UI. Android emulators usually need the host loopback alias instead of `127.0.0.1`.

The compute server delegates native transcription to the Rust worker used by the desktop app. In local development it falls back to running:

```sh
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin compute-worker
```

For production, build the worker and point the server at it:

```sh
cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml --bin compute-worker
STUTTER_NATIVE_WORKER=/absolute/path/to/compute-worker bun run server
```

### Public Compute Deployment

The server is permissive only for loopback local development. When `HOST` is not loopback, `NODE_ENV=production`, or `STUTTER_PUBLIC_READY=1`, the server requires explicit security configuration:

```sh
HOST=0.0.0.0 \
STUTTER_PUBLIC_READY=1 \
STUTTER_API_TOKEN=replace-with-a-long-random-token \
STUTTER_ALLOWED_ORIGINS=https://app.example.com \
STUTTER_NATIVE_WORKER=/absolute/path/to/compute-worker \
bun run server
```

Clients send the token as `Authorization: Bearer <token>`. The web app reads `VITE_STUTTER_API_TOKEN`; the mobile app has an API token field in the UI. Public-ready CORS uses the configured origin allowlist and never emits wildcard origins.

Optional server settings:

```sh
STUTTER_MAX_BODY_BYTES=25mb
STUTTER_MAX_AUDIO_BYTES=50mb
STUTTER_UPLOAD_TMP_DIR=/tmp
STUTTER_FFMPEG_BIN=ffmpeg
STUTTER_SPEAKER_STORE_PATH=/var/lib/stutter-tracker/speakers.json
DATABASE_URL=postgres://user:pass@host:5432/db
```

Mobile and other non-browser clients can upload recorded audio with
`POST /transcriptions/file`. The server stores uploads in a temporary directory,
delegates to the native worker, and deletes the temporary file after success or
failure. Non-WAV uploads for `whisperCpp` are normalized with `ffmpeg`; set
`STUTTER_FFMPEG_BIN` if the binary is not on `PATH`.

## Desktop Rust Dependencies

The desktop crate fetches the Rust analysis crates from the pinned
`https://github.com/moritzbrantner/rust-packages.git` revision in
`apps/desktop/src-tauri/Cargo.toml`. A clean `stutter-tracker` checkout no
longer needs a sibling `../rust-packages` checkout for normal builds.

For local cross-repo crate development, copy the example patch config:

```sh
cp apps/desktop/src-tauri/.cargo/config.toml.example apps/desktop/src-tauri/.cargo/config.toml
```

That local-only config patches the pinned git crates back to
`../../../../rust-packages/...`.

## Artifacts

Generated build output, benchmark media, model caches, recordings, exports, and partial downloads are ignored by Git. Keep source code, configuration, lockfiles, and small app assets in the repository; put heavyweight runtime artifacts under ignored artifact/cache directories.

The desktop app downloads missing whisper.cpp models on demand before transcription and reuses cached models afterward. To prepare local artifacts explicitly, run:

```sh
bun run artifacts:status
bun run artifacts:download -- small.en
```

`bun run artifacts:download` is idempotent and defaults to `base.en`. Use `bun run artifacts:download:all` only when you intentionally want every supported whisper.cpp model cached locally.

## Notes

The app tracks speech patterns for personal review and is not a diagnostic tool.
