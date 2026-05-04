# Self-Hosting Guide

Deploy Sprintable on your own infrastructure.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 |
| Backend | FastAPI (Python) |
| Database | PostgreSQL |

---

## Quick Start (Docker — 1 minute)

### Prerequisites

- Docker Desktop 4.x+ (or Docker Engine 24+ with Compose v2)

### Run

```bash
# Clone
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# Configure
cp .env.example .env
# Edit .env — defaults work for local use.
# Set JWT_SECRET, SECRET_KEY, and POSTGRES_PASSWORD before production.

# Start
docker compose up -d
```

Visit `http://localhost:3108`. The database is initialized automatically on first run.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3108` | Public URL of this deployment (used in webhook payloads) |
| `POSTGRES_DB` | `sprintable` | PostgreSQL database name |
| `POSTGRES_USER` | `sprintable` | PostgreSQL user |
| `POSTGRES_PASSWORD` | — | PostgreSQL password — **required, set before production** |
| `JWT_SECRET` | — | Signs JWT tokens — **required, set before production** |
| `SECRET_KEY` | — | Application secret key — **required, set before production** |
| `NEXT_PUBLIC_FASTAPI_URL` | `http://localhost:8000` | FastAPI backend URL (used by the frontend) |
| `GITHUB_WEBHOOK_SECRET` | — | Optional: auto-close stories on PR merge |

---

## Production Deployment

### 1. Prepare environment

```bash
cp .env.example .env
```

Edit `.env` and set strong values for `POSTGRES_PASSWORD`, `JWT_SECRET`, and `SECRET_KEY`:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
SECRET_KEY=$(openssl rand -hex 32)
APP_BASE_URL=https://your-domain.com
NEXT_PUBLIC_FASTAPI_URL=https://your-domain.com/api
```

### 2. Start

```bash
docker compose up -d
```

### 3. Verify

```bash
curl https://your-domain.com/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

---

## Updating

```bash
git pull origin main
docker compose up -d --build
```

---

## Multi-Platform Build (ARM64 + AMD64)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/moonklabs/sprintable:latest \
  --push .
```

---

## Troubleshooting

### `connection refused` (port conflict or Docker not running)

```bash
# Confirm Docker daemon is running
docker info

# Find process on port 3108
lsof -i :3108
# Linux:
ss -tlnp | grep 3108

# Kill conflicting process, then restart
docker compose up -d
```

### `localhost:3108` timeout (Mac Docker Desktop bridge issue)

```bash
# Option 1: Restart Docker Desktop
# Docker Desktop menu → Restart

# Option 2: Reset network
docker compose down
docker network prune -f
docker compose up -d
```

### `permission denied` on volume mount (Linux UID mismatch)

```bash
sudo chown -R 1000:1000 ./data
docker compose up -d
```

### Database connection error

Verify `POSTGRES_PASSWORD` in `.env` matches what was used when the volume was initialized. If changing the password on an existing volume, recreate the volume:

```bash
docker compose down -v
docker compose up -d
```

### Health check failing

```bash
docker compose logs backend
docker compose logs web
```

### GitHub Webhook Secret mismatch

```bash
# Check container logs
docker compose logs web | grep "github-webhook"
# "Invalid signature" → GITHUB_WEBHOOK_SECRET in .env doesn't match GitHub webhook secret

# Fix:
# 1. openssl rand -hex 32  (generate new secret)
# 2. Update GITHUB_WEBHOOK_SECRET in .env
# 3. Update secret in GitHub repo Settings → Webhooks
# 4. docker compose restart
```
