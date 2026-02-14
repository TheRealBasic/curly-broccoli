# Curly Broccoli Chat

Stage-based build of a minimal Discord-like realtime chat app.

## Current status

- ✅ Stage 0 complete: monorepo + dev environment bootstrapped.
- ⏭️ Next: Stage 1 minimal realtime chat.

## Monorepo structure

```txt
apps/
  api/      # Node.js + TypeScript API (Express for now)
  web/      # React + TypeScript app (Vite)
packages/
  shared/   # Shared constants/types used by apps
```

## Tech in Stage 0

- Package manager: `pnpm`
- API: Node.js + TypeScript
- Web: React + TypeScript + Vite
- Shared package: simple workspace package consumed by both apps
- Tooling: ESLint + Prettier + Vitest

## Setup

1. Install dependencies:

```bash
pnpm i
```

2. (Optional) Copy env file:

```bash
cp .env.example .env
```

3. Start both apps in watch/dev mode:

```bash
pnpm dev
```

Expected output (similar):

- API log: `API listening on http://localhost:4000`
- Web/Vite log: `Local: http://localhost:5173/`

## Scripts

From repository root:

- `pnpm dev` — run all packages in dev mode
- `pnpm build` — build all packages
- `pnpm test` — run all package tests
- `pnpm lint` — lint all packages
- `pnpm format` — verify formatting
- `pnpm format:write` — auto-format files

## Stage 0 acceptance checks

Run these commands from repo root:

```bash
pnpm i
pnpm dev
```

Manual verification:

1. Open `http://localhost:5173` and confirm the page renders:
   - "Curly Broccoli Chat"
   - "Web app says hello."
2. Open `http://localhost:4000/health` and confirm JSON response:

```json
{"ok":true,"service":"api"}
```

## Testing/checks used for this stage

```bash
pnpm lint
pnpm test
pnpm build
pnpm format
```

## Notes

- Stage 0 intentionally uses a simple HTTP API endpoint and hello-world web UI.
- Realtime messaging and websocket protocol begin in Stage 1.
