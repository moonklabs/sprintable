# Self-Hosting Guide

Deploy Sprintable on your own infrastructure.

## OSS Mode (Default — No Database Required)

Run Sprintable locally with SQLite in minutes.

### Prerequisites

- Node.js >=22.5.0
- pnpm 9+

### Quick Start

```bash
# Clone the repo
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# Install dependencies
pnpm install

# Copy env file (OSS defaults work out of the box)
cp .env.example apps/web/.env.local

# Start dev server
pnpm dev
```

Visit `http://localhost:3108`. Data is stored in SQLite at `.data/sprintable.db` — no external database needed.

### Environment Variables (OSS)

| Variable | Description |
|----------|-------------|
| `APP_BASE_URL` | Public URL of this deployment (e.g. `http://localhost:3108`) |
| `OSS_MODE` | Set to `true` for OSS mode |
| `NEXT_PUBLIC_OSS_MODE` | Set to `true` (must match `OSS_MODE`) |
| `SQLITE_PATH` | Path to SQLite database file (e.g. `./.data/sprintable.db`) |
| `AGENT_API_KEY_SECRET` | Secret for agent API authentication |
| `PM_API_URL` | Internal URL used by MCP server to reach the web app |

---

## SaaS / Advanced Mode (Supabase + Docker)

For production deployments with Supabase, multi-user auth, and billing.

### Prerequisites

- Docker 24+ and Docker Compose v2
- Domain with SSL (recommended)
- Supabase project (cloud or self-hosted)

### Configure Environment

```bash
cp .env.example .env
# Set OSS_MODE=false and fill in Supabase variables
```

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `OPENAI_API_KEY` | For AI features (STT, summarization) |
| `ANTHROPIC_API_KEY` | Alternative AI provider |

### Database Migrations

```bash
# Using Supabase CLI
supabase db push --db-url postgresql://...
```

### Deploy

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Verify

```bash
curl http://localhost:3108/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

### Multi-Platform Build (ARM64 + AMD64)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/moonklabs/sprintable:latest \
  --push .
```

### Updating

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

---

## Troubleshooting

### `node:sqlite not found`
Upgrade to Node.js >=22.5.0. The `node:sqlite` module is built-in starting from that version.

### Missing environment variables
Check that all [OSS required] variables from `.env.example` are set in `apps/web/.env.local`.

### Database connection issues (SaaS)
Verify `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct and the Supabase project is accessible.

### Health check failing
Check logs: `docker compose logs web`

---

## OSS 모드 트러블슈팅

### `connection refused` (포트 충돌 또는 Docker 미실행)

```bash
# Docker daemon 실행 확인
docker info

# 3108 포트 점유 프로세스 확인
lsof -i :3108
# 또는 Linux:
ss -tlnp | grep 3108

# 점유 프로세스 종료 후 재시작
docker compose -f docker-compose.oss.yml up
```

### `localhost:3108` 응답 없음 (Mac Docker Desktop bridge 문제)

Mac에서 Docker Desktop 사용 시 bridge 네트워크 문제로 타임아웃이 발생할 수 있습니다.

```bash
# 방법 1: Docker Desktop 재시작
# Docker Desktop 메뉴 → Restart

# 방법 2: 네트워크 초기화
docker compose -f docker-compose.oss.yml down
docker network prune -f
docker compose -f docker-compose.oss.yml up

# 방법 3: 대안 포트 사용
# docker-compose.oss.yml에서 ports를 "3001:3108"으로 변경 후 http://localhost:3001 접속
```

### `permission denied` on volume mount (Linux UID 불일치)

Linux에서 volume mount 시 컨테이너 내부 UID(1000)와 호스트 UID가 다를 경우 발생합니다.

```bash
# 데이터 디렉토리 소유권 변경
sudo chown -R 1000:1000 ./data

# 또는 docker-compose.oss.yml에 user 추가:
# user: "${UID}:${GID}"
```

### GitHub Webhook Secret 불일치

```bash
# 컨테이너 로그에서 확인
docker compose -f docker-compose.oss.yml logs web | grep "github-webhook"
# "Invalid signature" → .env의 GITHUB_WEBHOOK_SECRET과 GitHub webhook secret이 다름

# 재설정 방법:
# 1. openssl rand -hex 32 로 새 secret 생성
# 2. .env의 GITHUB_WEBHOOK_SECRET 업데이트
# 3. GitHub 저장소 Settings → Webhooks → 해당 webhook 수정 → Secret 업데이트
# 4. docker compose -f docker-compose.oss.yml restart
```
