# Curly Broccoli Chat

Stage-based build of a minimal Discord-like realtime chat app.

## Current status

- ✅ Stage 0 complete: monorepo + dev environment bootstrapped.
- ✅ Stage 1 complete: realtime websocket chat.
- ✅ Stage 2 complete: PostgreSQL persistence + migrations + history on connect.
- ✅ Stage 6 complete: Direct Messages (DM inbox, private threads, DM chat).

## Monorepo structure

```txt
apps/
  api/      # Node.js + TypeScript API + websocket + PostgreSQL persistence
  web/      # React + TypeScript app (Vite)
packages/
  shared/   # Shared constants/types used by apps
```

## Setup

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

## Stage 2 details

- Messages are stored in PostgreSQL (`chat_messages`).
- Message history is fetched from the DB and sent on websocket connect.
- History size is configurable using `CHAT_HISTORY_LIMIT`.
- HTTP endpoint `GET /messages?limit=<n>` returns recent messages.
