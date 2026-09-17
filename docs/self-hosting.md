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
| `LOCAL_KMS_MASTER_KEY` | — | BYOM 자격증명 암호화 마스터 키. `make up`/`init-env.py`가 자동 생성. **필수 — BYOM 사용 시** |

### BYOM 자격증명과 `LOCAL_KMS_MASTER_KEY`

BYOM(자체 모델 키)을 쓰려면 이 키가 필요하다. `KMS_PROVIDER` 미설정 시 `local`이 기본값이고,
그때 마스터 키가 비어 있으면 자격증명 저장이 실패한다
(`apps/web/src/lib/kms/provider.ts`).

```bash
# .env 에 추가 (기존 설치 — init-env.py 이전에 만든 .env 에는 이 줄이 없다)
LOCAL_KMS_MASTER_KEY=$(openssl rand -hex 32)
```

- **frontend(Next.js) 컨테이너에서 쓰인다.** 모델 호출을 실제로 `fetch` 하는 주체가
  `apps/web/src/lib/llm/client.ts` 이기 때문. backend(Python)는 BYOM 암호문을 복호화하지
  않는다(채널 자격증명은 `channel_credential_crypto.py` 로 별개 경로).
- **이 키는 인스턴스 로컬이다.** 여기서 만든 암호문은 다른 인스턴스로 이전되지 않으므로,
  로컬 docker 스택의 BYOM 설정은 그 스택에만 유효하다.
- 누락 시 `validate-env.sh` 는 **경고만** 하고 기동을 막지 않는다 — BYOM 을 아직 안 쓰는
  설치는 정상 기동해야 하기 때문. 첫 BYOM 저장 시점에 실패한다.

### 로컬 LLM(Ollama / LM Studio) 연결

호스트에서 도는 로컬 LLM 을 모델 제공자로 쓰려면 컨테이너에서 호스트를 볼 수 있어야 한다.
docker-compose 는 `extra_hosts` 로 `host.docker.internal` 을 배선해 두었다.

```
baseUrl: http://host.docker.internal:11434/v1     # Ollama
baseUrl: http://host.docker.internal:1234/v1      # LM Studio
```

경로에 `/v1` 이 없으면 `validateCustomEndpoint` 가 `OPENAI_BASE_URL_MUST_INCLUDE_V1` 로
거절한다. provider 는 `openai-compatible` 을 쓴다.

### 데스크톱 에이전트의 기기 자격증명(`dt_live_`)

데스크톱 앱은 에이전트 자격증명을 **기기 단위**로 등록한다(`POST /api/v2/device-credentials`).
조직 전역 키(`sk_live_`)와 달리 기기 하나를 잃어도 **그 기기만 폐기**하면 되고, 나머지 기기는
계속 붙어 있다. 자체호스팅에서 여러 대를 쓰려면 이 경로가 사실상 필요하다 — `sk_live_` 는
발급이 곧 교체라 두 번째 기기를 등록하는 순간 첫 기기가 끊긴다.

**인증 강도는 자체호스팅과 호스팅이 다르다.** 기기 자격증명은 등록 시 제출한 **공개키로 요청
서명을 검증**하는 계층이 항상 성립한다(개인키는 서버에 오지 않는다). 그 위의 **앱 무결성
증명(attestation)** 계층은 이 배포 형태에서 쓰지 않는다. 이유는 "인터넷이 없어서"가 아니라
**플랫폼 커버리지와 범위 결정**이다:

- App Attest 는 Apple 플랫폼(iOS·iPadOS·macOS 등), Play Integrity 는 Android 전용이다.
  데스크톱 앱이 함께 돌아야 하는 **Linux·Windows 에는 대응 서비스가 없다.**
- 서버측 검증 자체는 오프라인에서도 가능하다 — App Attest 의 assertion 검증은 저장된 공개키와
  Apple 루트 인증서로 **로컬에서** 이뤄지고, 매 요청 Apple 에 접속할 필요가 없다. 네트워크가
  필요한 것은 앱의 **최초 키 증명(enrollment)** 단계와, 그때 쓸 인증서 체인을 준비하는 쪽이다.
- Play Integrity 는 verdict 가 여러 축이다. `appRecognitionVerdict=PLAY_RECOGNIZED` 는
  "패키지·서명·버전이 Google Play 가 인식하는 것과 일치한다"는 뜻이라 **정확히 서명된
  사이드로드 APK 도 받을 수 있다** — Play 설치를 요구하는 값이 아니다. 설치 경로를 보려면
  별도 축인 `appLicensingVerdict`(Play 자격이 있으면 `LICENSED`, 사이드로드면 대개
  `UNLICENSED`)를 함께 봐야 한다. 어느 쪽이든 검증은 서버가 로컬에서 한다.
- 무엇보다 이 계층은 이번 구현에서 **의도적으로 범위 밖**이다(attestation 무접촉).

즉 자체호스팅은 "무증명"이 아니라 **한 계층 얇은 증명**이고, 그만큼 "이 요청이 진짜 그 앱에서
났다"는 보증이 약하다. 그 대신 기기 단위 폐기(`DELETE /api/v2/device-credentials/{id}`)가
통제 수단이다.

폐기는 다음 요청부터 즉시 유효하다. 등록·폐기 모두 **인증한 그 사람의 기기만** 대상이므로,
조직 관리자도 남의 기기를 대신 끊을 수 없다 — 기기는 사람에 붙는 자원이다.

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
