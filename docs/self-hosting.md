# Self-Hosting Guide

Deploy Sprintable on your own infrastructure.

## Prerequisites

- Docker 24+ and Docker Compose v2
- Supabase project (cloud or self-hosted)
- Domain with SSL (recommended)

## Quick Start (Local)

```bash
# Clone the repo
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# Copy env file (defaults work for local docker setup)
cp .env.example .env

# Start everything (web + Supabase DB/API/Auth)
docker compose up
```

Visit `http://localhost:3000`. Supabase services run inside Docker — no external CLI needed. Migrations run automatically on startup.

## Production Deployment

### 1. Configure Environment

```bash
cp .env.example .env
```

Required variables:
| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `NEXT_PUBLIC_APP_URL` | Your app's public URL |

Optional:
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | For AI features (STT, summarization) |
| `ANTHROPIC_API_KEY` | Alternative AI provider |
| `PAYMENT_PROVIDER` | `paddle` or `toss` |
| `PADDLE_API_KEY` | Paddle Billing API key |

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
