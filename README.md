# Curly Broccoli Chat

Stage-based build of a minimal Discord-like realtime chat app.

## Current status

- ✅ Stage 0 complete: monorepo + dev environment bootstrapped.
- ✅ Stage 1 complete: realtime websocket chat.
- ✅ Stage 2 complete: PostgreSQL persistence + migrations + history on connect.
- ✅ Stage 6 complete: Direct Messages (DM inbox, private threads, DM chat).
- ✅ Stage 7 complete: Moderation basics (message delete/report, server mute, audit log).
- ✅ Stage 12 complete: Docker + CI + observability + security hardening.

## Monorepo structure

```txt
apps/
  api/      # Node.js + TypeScript API + websocket + PostgreSQL persistence
  web/      # React + TypeScript app (Vite)
packages/
  shared/   # Shared constants/types used by apps
```

## Quick start (fresh clone, one command)

### 1) Run everything with Docker (recommended)

```bash
docker compose up --build
```

That one command starts:

- PostgreSQL on `localhost:5432`
- API on `http://localhost:4000`
- Web app on `http://localhost:5173`

### 2) Open the app

- Web UI: `http://localhost:5173`
- API health: `http://localhost:4000/health`
- API metrics: `http://localhost:4000/metrics`

## Local non-Docker dev

1. Install dependencies:

```bash
pnpm i
```

2. Copy env file:

```bash
cp .env.example .env
```

3. Ensure PostgreSQL is running and the `DATABASE_URL` in `.env` is valid.

4. Start both apps:

```bash
pnpm dev
```

The API automatically runs SQL migrations from `apps/api/migrations` on startup.

## Security + production-readiness notes

- **CORS is restricted** by `CORS_ALLOWED_ORIGINS` (comma-separated list).
- **Auth endpoints are rate-limited** (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`).
- **Input validation** is enforced for auth and paging parameters.
- **Security headers** are set (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).
- **CSRF**: not required currently because authentication uses bearer tokens in headers (no cookie-based session auth).
- **Structured request logs** are emitted by API.
- **Basic metrics** available at `GET /metrics`.

## CI

GitHub Actions workflow at `.github/workflows/ci.yml` runs:

- format check
- lint
- tests
- build

## Deployment

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for production-like compose usage and release checklist.
