# Self-Hosting Guide

Deploy Sprintable on your own infrastructure.

## Prerequisites

- Docker 24+ and Docker Compose v2
- Domain with SSL (recommended)
- For SaaS mode only: Supabase project (cloud or self-hosted)

## Quick Start (Local — OSS Mode)

```bash
# Clone the repo
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# Copy env file (defaults work for local OSS setup)
cp .env.example .env

# Start
docker compose up
```

Visit `http://localhost:3000`. In OSS mode, data is stored in SQLite — no external database needed.

## Production Deployment

### 1. Configure Environment

```bash
cp .env.example .env
```

Required variables (OSS mode):
| Variable | Description |
|----------|-------------|
| `APP_BASE_URL` | Your app's public URL (used in webhook links) |
| `OSS_MODE` | Set to `true` for OSS self-hosting |
| `SQLITE_PATH` | Path to SQLite database file |
| `AGENT_API_KEY_SECRET` | Secret for agent API authentication |

Optional (SaaS mode — set `OSS_MODE=false`):
| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `OPENAI_API_KEY` | For AI features (STT, summarization) |
| `ANTHROPIC_API_KEY` | Alternative AI provider |

### 2. Database Migrations

Migrations run **automatically** on container startup when `DATABASE_URL` is set in `.env`.

```bash
# .env
DATABASE_URL=postgresql://postgres:password@db-host:5432/postgres
```

Alternatively, run manually:
```bash
# Using Supabase CLI
supabase db push --db-url postgresql://...

# Or using the migration script
./scripts/run-migrations.sh "postgresql://..."
```

### 3. Deploy

```bash
docker compose -f docker-compose.prod.yml up -d
```

### 4. Verify

```bash
curl http://localhost:3000/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

## Multi-Platform Build (ARM64 + AMD64)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/moonklabs/sprintable:latest \
  --push .
```

## Updating

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

## Troubleshooting

### Missing environment variables
The container validates required env vars at startup. If any are missing, it will print a clear error message and exit.

### Database connection issues
Ensure your `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct and the Supabase project is accessible.

### Health check failing
Check logs: `docker compose logs web`
