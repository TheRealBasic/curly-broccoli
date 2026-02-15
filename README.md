# Curly Broccoli Chat

A full-stack, Discord-style chat app in a pnpm monorepo with:

- **Web app**: React + Vite + TypeScript
- **API**: Express + WebSocket + TypeScript
- **Database**: PostgreSQL + SQL migrations
- **Shared package**: cross-app TypeScript types/events/constants

## What’s currently implemented

- Account auth (register/login/refresh token)
- Multi-server and multi-channel chat
- Direct messages (private threads)
- Live message events over WebSocket
- Presence + typing indicators
- Voice channel participation and screen-share controls
- Message search, moderation actions, and audit logs
- Image attachment uploads
- Dockerized local and production-like environments
- Health and metrics endpoints

## Monorepo layout

```txt
apps/
  api/      # Express API + WebSocket + PostgreSQL data access
  web/      # React client (Vite)
  desktop/  # Electron wrapper for the web app
packages/
  shared/   # Shared types/constants/events used across apps
```


## Desktop app (Electron + TypeScript)

The desktop wrapper lives in `apps/desktop` and loads the existing web client:

- **Dev mode**: starts Vite (`apps/web`) and opens it in Electron.
- **Prod mode**: builds `apps/web`, copies static assets into the Electron bundle, and loads `index.html` from disk.
- **Security defaults**: `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer, and a preload bridge for IPC.
- **WebRTC permissions**:
  - microphone/camera requests are mediated through Electron permission handlers with user prompts
  - screen capture uses Electron's display-media request handler and system picker support

### Desktop prerequisites

- Node.js 20+
- pnpm 9+
- Existing API running (default expected URL is `http://localhost:4000`)

### Desktop development

From repo root:

```bash
pnpm install
pnpm desktop:dev
```

This runs:

1. TypeScript watch for Electron main/preload
2. Vite dev server for `apps/web` (`http://localhost:5173`)
3. Electron pointed at the Vite URL

### Desktop production build (no installer)

```bash
pnpm desktop:build
```

This compiles Electron TypeScript, builds the web app, and copies web static files into `apps/desktop/dist/renderer`.

### Desktop Windows installer

```bash
pnpm desktop:dist
```

This runs `electron-builder` and outputs a Windows installer (`nsis`) into:

- `apps/desktop/release/`

> Note: `dist` is configured for Windows by default. You can extend `apps/desktop/package.json` `build` targets for macOS/Linux as needed.

### Desktop workspace scripts

- `pnpm --filter @curly-broccoli/desktop dev`
- `pnpm --filter @curly-broccoli/desktop build`
- `pnpm --filter @curly-broccoli/desktop dist`

Convenience root scripts are also available:

- `pnpm desktop:dev`
- `pnpm desktop:build`
- `pnpm desktop:dist`

## Prerequisites

- **Node.js 20+**
- **pnpm 9+**
- **Docker + Docker Compose** (recommended path)

## Quick start (Docker, recommended)

1. Start the full stack:

```bash
docker compose up --build
```

2. Open:

- Web UI: `http://localhost:5173`
- API health: `http://localhost:4000/health`
- API metrics: `http://localhost:4000/metrics`

This boots:

- Postgres (`localhost:5432`)
- API (`localhost:4000`)
- Web app (`localhost:5173`)

## Local development (without Docker)

1. Install dependencies:

```bash
pnpm install
```

2. Create local env file:

```bash
cp .env.example .env
```

3. Ensure Postgres is running locally and `DATABASE_URL` in `.env` points to it.

4. Run all workspaces in watch/dev mode:

```bash
pnpm dev
```

The API runs database migrations automatically at startup from `apps/api/migrations`.

## Useful commands

From repo root:

```bash
pnpm dev        # run all workspace dev servers
pnpm test       # run tests in all packages/apps
pnpm lint       # run eslint in all packages/apps
pnpm build      # build all packages/apps
pnpm format     # prettier check
pnpm format:write
```

## Environment variables

Primary env vars used by the stack (see `.env.example`):

- `API_PORT`
- `WEB_PORT`
- `VITE_API_BASE_URL`
- `DATABASE_URL`
- `CHAT_HISTORY_LIMIT`
- `JWT_SECRET`
- `CORS_ALLOWED_ORIGINS`
- `AUTH_RATE_LIMIT_MAX`
- `AUTH_RATE_LIMIT_WINDOW_MS`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `OPENAI_API_KEY`
- `AI_GLOBAL_KILL_SWITCH` (set `true` to disable all AI invokes immediately)
- `AI_ROLLOUT_STAGE` (`internal` -> `beta` -> `full`, default `internal`)
- `AI_INTERNAL_SERVER_IDS` (comma-separated server IDs allowed during internal rollout)
- `AI_BETA_SERVER_IDS` (comma-separated server IDs added during beta rollout)

## Troubleshooting

If setup or runtime fails, use the checks below.

### Containers won’t start (`docker compose up --build` fails)

- Verify Docker is running: `docker info`
- Rebuild from scratch if cached layers are stale:

```bash
docker compose down -v
docker compose up --build
```

- Check service logs for the first error:

```bash
docker compose logs api
docker compose logs web
docker compose logs postgres
```

### Ports already in use (`EADDRINUSE` / bind errors)

- Typical conflicts are `5173` (web), `4000` (api), and `5432` (postgres).
- Stop the conflicting process or override ports in `.env` (`WEB_PORT`, `API_PORT`) and restart.

### Database connection failures (`ECONNREFUSED`, auth errors)

- Ensure Postgres is healthy and reachable at the host/port in `DATABASE_URL`.
- Confirm `.env` credentials match Postgres (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).
- If schema is out of date, restart API to re-run migrations.

### App boots but login/API calls fail (401/403/CORS)

- Confirm `JWT_SECRET` is set and consistent for API restarts.
- Verify `VITE_API_BASE_URL` points to the running API.
- Check `CORS_ALLOWED_ORIGINS` includes your web origin (for local dev usually `http://localhost:5173`).

### WebSocket disconnects or no live updates

- Open browser devtools and check failed WS requests.
- Confirm API is reachable and not crashing (`/health` should return 200).
- If behind a proxy, ensure it supports WebSocket upgrades.

### pnpm install/dev issues

- Validate tool versions:

```bash
node -v
pnpm -v
```

- Use Node 20+ and pnpm 9+ (per prerequisites).
- If lockfile/store corruption is suspected:

```bash
pnpm store prune
pnpm install
```

### Quick health checks

```bash
curl http://localhost:4000/health
curl http://localhost:4000/metrics
```

If problems persist, attach relevant `docker compose logs` output and your `.env` (with secrets redacted) when reporting the issue.

## UI conventions and chat QA

For in-repo web UI conventions (tokens, variants, panel layout rules) and the chat-screen PR checklist, see [`docs/ui-conventions-and-chat-screen-qa.md`](./docs/ui-conventions-and-chat-screen-qa.md).

## Deployment

For production-like Compose usage and release checklist, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

Production compose file:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

## Notes

- API exposes operational endpoints at `/health` and `/metrics`.
- CORS is controlled via `CORS_ALLOWED_ORIGINS`.
- Authentication uses bearer tokens (`Authorization: Bearer <token>`).


## AI rollout runbook

Use this staged rollout flow so release risk stays low and rollback is instant:

1. **Internal enablement**
   - Set `AI_ROLLOUT_STAGE=internal`.
   - Add only internal test servers to `AI_INTERNAL_SERVER_IDS`.
   - Keep `AI_GLOBAL_KILL_SWITCH=false`.
2. **Expand gradually**
   - Move to `AI_ROLLOUT_STAGE=beta` and add selected production servers to `AI_BETA_SERVER_IDS`.
   - Monitor `/metrics`, AI error events, and token budget usage.
3. **Full rollout**
   - Set `AI_ROLLOUT_STAGE=full` once beta servers are stable.
4. **Immediate rollback**
   - Set `AI_GLOBAL_KILL_SWITCH=true` and restart API. This blocks all AI invokes regardless of server settings.

Operational notes:
- Owner-only AI settings updates are enforced server-side.
- Per-server rate limits and daily/monthly budgets are enforced in invoke handling.
