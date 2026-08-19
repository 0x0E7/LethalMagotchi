# LethalMagotchi — Operations Runbook

Global-server operations only. LAN-host packaging (`.claude/devops.md` §2/§3 `release.yml`)
is not built yet — `apps/lan-host` and `packages/game-core` don't exist.

Design source of truth: `.claude/devops.md`.

---

## 1. Local development (daily loop)

Host-native app, containerized Postgres (`.claude/devops.md` §4).

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres 16 on localhost:5432
cp .env.example .env                             # then edit JWT_SECRET
npm ci
npm run db:migrate && npm run db:seed
npm run dev                                      # Vite :5173 + Fastify :8080
```

`docker-compose.dev.yml` uses db `lethalmagotchi`, user/pass `lethal`/`lethal`, port 5432 —
identical to a native Homebrew Postgres 16 install and to the committed `.env.example`, so
switching between the two needs no config change.

Stop / wipe:

```bash
docker compose -f docker-compose.dev.yml down       # stop, keep data
docker compose -f docker-compose.dev.yml down -v    # stop and delete the volume
```

## 2. Full-stack smoke test / self-hosting

Runs the real production image plus Postgres (`.claude/devops.md` §1).

```bash
cp .env.example .env        # JWT_SECRET must be >= 16 chars, or compose refuses to start
docker compose up --build
open http://localhost:8080  # API and SPA on the same origin
./scripts/smoke.sh          # BASE defaults to http://localhost:8080/api/v1
```

Startup order is `db` (healthy) → `migrate` (migrations + seed, exits 0) → `server`.

Notes:
- `COOKIE_SECURE` defaults to `false` here because localhost is plain HTTP. Set it to
  `true` in `.env` once this sits behind TLS.
- Postgres is not published to the host in this stack; use `docker-compose.dev.yml` if you
  want a database on `localhost:5432`.
- Requires Docker Compose >= 2.24 (`env_file` long syntax).

## 3. Configuration

All config is environment variables. `.env.example` is committed; `.env` is gitignored and
never enters the image (`.dockerignore`).

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | no | `production` in the image |
| `PORT` | no | default `8080` |
| `HOST` | no | default `0.0.0.0` |
| `DATABASE_URL` | **yes** | Postgres connection string |
| `JWT_SECRET` | **yes** | min 16 chars |
| `CLIENT_ORIGIN` | no | comma-separated CORS origins |
| `COOKIE_SECURE` | no | **must be `true` in production** |
| `CLIENT_DIST` | no | baked to `/app/public` in the image; enables same-origin SPA |

Production secrets live in the PaaS secret store, set there directly. They must never pass
through CI — the only secret CI holds is a deploy token.

## 4. Health endpoints

| Path | Touches DB | Use for |
|---|---|---|
| `/healthz` | no | liveness / restart decisions; the image `HEALTHCHECK` |
| `/readyz` | yes (`SELECT 1`), 503 on failure | traffic gating: PaaS health check, `depends_on: service_healthy`, post-deploy smoke |

Point the PaaS health check at `/readyz`, not `/healthz` — `/healthz` returns 200 even with
the database unreachable, which would let a broken instance take traffic.

## 5. Database migrations

`npm run db:migrate` then `npm run db:seed` (compiled equivalents inside the image:
`node apps/server/dist/db/migrate.js`, `node apps/server/dist/db/seed.js`).

Both are idempotent: migrations are tracked in `schema_migrations`, the seed is upsert-by-id.

**They never run at container boot.** Boot-time migrations race across replicas and turn a
schema error into a crash loop. Instead:

- **compose**: the one-shot `migrate` service, gated by `service_completed_successfully`.
- **PaaS**: a release-time step that runs once before the new image takes traffic
  (Fly `[deploy] release_command`, Railway/Render pre-deploy command). See the TODO block in
  `.github/workflows/deploy.yml`.

Migrations must stay backward-compatible with the currently-running image for one release,
since the old container is still serving while the new one rolls in.

## 6. CI

`.github/workflows/ci.yml` — every PR and every push to `master`/`main`:
install → typecheck → lint (`--if-present`) → test (`--if-present`) → build all workspaces →
`docker build` (validated, not pushed).

Lint and test are `--if-present` no-ops until a root `lint` / `test` script exists; adding
one makes CI enforce it with no workflow change.

## 7. Deploy

`.github/workflows/deploy.yml` — gated on a successful CI run on `master` (`workflow_run`).
Builds the image once, pushes to GHCR as `sha-<short>` and `latest`, and deploys that exact
digest. There is no rebuild-from-source on the hosting side: the artifact CI validated is the
artifact that ships, and it is the same image a self-hoster pulls.

**The deploy step is currently a placeholder.** No hosting account exists yet, so the workflow
publishes the image and stops. Wiring instructions are in the TODO block in that file.

### Rollback

Re-run `Deploy` via **Run workflow**, setting `image_ref` to the last good tag:

```
ghcr.io/0x0e7/lethalmagotchi-server:sha-1a2b3c4
```

That skips the build and redeploys the existing image. Find previous tags under the repo's
Packages tab. If the bad release included a migration, roll the schema forward with a new
migration rather than reverting — migrations have no down step.

## 8. Where things live

| What | Where |
|---|---|
| Container images | GHCR: `ghcr.io/0x0e7/lethalmagotchi-server` |
| CI / deploy logs | GitHub Actions tab |
| Application logs | stdout (Pino JSON) → PaaS log stream; `docker compose logs -f server` locally |
| Database | managed Postgres (Neon/Supabase planned, `.claude/devops.md` §5) |

## 9. Monitoring — current state

Deliberately minimal until there's a deployed server to monitor:

- Liveness/readiness via `/healthz` and `/readyz`; the PaaS restarts on liveness failure and
  withholds traffic on readiness failure.
- Structured JSON logs to stdout, collected by the PaaS log stream.

**Not yet wired, and the first things to add once hosting exists** (in this order):
1. Alert on `/readyz` failing for >2 consecutive minutes — this is the DB-unavailability signal.
2. Error tracking (Sentry free tier) on the server's unhandled-error path in `app.ts`.
3. Alert on a spike in 401s from `/api/v1/auth/login` — credential stuffing.
