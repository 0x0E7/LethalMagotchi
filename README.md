# LethalMagotchi
From pixel care to pixel warfare

## Quick start (development)

Requires **Node 22+** and Docker (or a native Postgres 16).

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres on localhost:5432
cp .env.example .env                             # set a real JWT_SECRET (>= 16 chars)
npm ci
npm run db:migrate && npm run db:seed
npm run dev                                      # client :5173, server :8080
```

## Tests

Two tools: **Vitest** (unit + integration) and **Playwright** (end-to-end).

```bash
npm test            # unit + integration — needs Postgres on localhost:5432
npm run test:unit   # pure logic only, no database, ~0.5s
npm run test:e2e    # builds the app, then drives it in a headless browser
npm run test:all    # everything
```

Integration and e2e tests use a dedicated `lethalmagotchi_test` database, created
and migrated automatically on first run; they never touch the dev database.
Playwright needs its browser once: `npx playwright install chromium`.

## Run the whole stack in containers

```bash
docker compose up --build                        # http://localhost:8080
```

Deploy, rollback, config, health checks and monitoring: **[docs/ops/runbook.md](docs/ops/runbook.md)**.
