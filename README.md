# Stutter Tracker

Cross-platform speech fluency tracker organized as a Bun monorepo.

## Workspaces

- `apps/web`: Vite React web app. It calls the external compute server first and falls back to browser-local analysis with WebGPU probing when the server is unavailable.
- `apps/desktop`: Tauri 2 desktop app. It keeps the Rust-backed local hardware path for analysis, speaker matching, transcription, and model downloads.
- `apps/mobile`: React Native app built with Expo. It talks to the external compute server through the shared client.
- `apps/server`: Bun HTTP compute server scaffold exposing the shared analysis, speaker, and transcription API shape.
- `packages/shared`: Shared domain types, model catalogs, fallback analysis, audio resampling, and speaker helpers.
- `packages/compute-client`: Shared HTTP compute client used by web and mobile.

## Commands

- Local web + compute server: `bun run dev`
- Web only: `bun run web`
- Compute server only: `bun run server`
- Desktop: `bun run desktop`
- Mobile: `bun run mobile`
- Build web/shared packages: `bun run build`
- Unit tests: `bun run test:unit`
- Integration tests: `bun run test:integration`
- E2E tests: `bun run test:e2e`
- Rust tests: `bun run test:rust`

## Compute Setup

The default external compute URL is `http://127.0.0.1:8787`.

Known speaker profiles are persisted by the server when `DATABASE_URL` or `POSTGRES_URL` points at a Postgres database. The server creates the `known_speakers` table on first use. Without a database URL, the web app falls back to browser-local speaker storage.

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

The current TypeScript server provides the HTTP contract and shared fallback analysis. Production transcription and other heavyweight processing should be wired into `apps/server/src/index.ts` with a native worker or Rust service using the same request and response shapes.

## Notes

The app tracks speech patterns for personal review and is not a diagnostic tool.
