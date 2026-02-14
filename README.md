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
packages/
  shared/   # Shared types/constants/events used across apps
```

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
