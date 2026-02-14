# Deployment Notes

## Production-like deployment with Docker Compose

1. Copy environment template:
   ```bash
   cp .env.example .env
   ```
2. Update these **required** values in `.env`:
   - `JWT_SECRET`
   - `POSTGRES_PASSWORD`
   - `CORS_ALLOWED_ORIGINS`
   - `VITE_API_BASE_URL`
3. Build and start:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env up -d --build
   ```
4. Verify health:
   ```bash
   curl http://localhost:4000/health
   curl http://localhost:4000/metrics
   ```

## Release checklist

- [ ] `pnpm format`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `docker compose up --build` works from a clean clone
- [ ] `docker compose -f docker-compose.prod.yml --env-file .env up -d --build` works
- [ ] API health endpoint is OK
- [ ] API metrics endpoint is reachable
- [ ] CORS origin list is configured for real frontend domains
- [ ] Strong `JWT_SECRET` is configured in production


## AI rollout and rollback operations

Add these AI vars in `.env` before enabling assistant features:
- `OPENAI_API_KEY`
- `AI_GLOBAL_KILL_SWITCH=false`
- `AI_ROLLOUT_STAGE=internal`
- `AI_INTERNAL_SERVER_IDS=<comma-separated internal server ids>`
- `AI_BETA_SERVER_IDS=<comma-separated beta server ids>`

Recommended change sequence:
1. Deploy with `AI_ROLLOUT_STAGE=internal` and only internal server IDs allowed.
2. Verify owner-only AI settings updates and invoke success/failure behavior in internal servers.
3. Promote to `beta` and add a limited list to `AI_BETA_SERVER_IDS`.
4. Promote to `full` after observing stable metrics and budgets.

Rollback procedure:
1. Set `AI_GLOBAL_KILL_SWITCH=true`.
2. Restart/redeploy API.
3. Verify clients receive AI invoke rejection and no new AI completions are emitted.
