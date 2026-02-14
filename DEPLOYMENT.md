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
