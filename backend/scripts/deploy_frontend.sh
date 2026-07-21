#!/usr/bin/env bash
# D-S3: Cloud Run 프론트엔드 배포 스크립트
#
# 사전 조건:
#   - GCP Billing 연결 완료
#   - Artifact Registry에 이미지 빌드 완료 (D-S2 cloudbuild.yaml)
#   - Secret Manager 시크릿 생성 완료 (setup_secret_manager.sh)
#
# 사용법:
#   COMMIT_SHA=abc1234 bash backend/scripts/deploy_frontend.sh dev
#   COMMIT_SHA=abc1234 bash backend/scripts/deploy_frontend.sh prod
#
# 환경변수:
#   GCP_PROJECT   (기본: sprintable)
#   GCP_REGION    (기본: asia-northeast3)
#   COMMIT_SHA    [필수] 배포할 이미지 태그
#   ENV           dev|prod (또는 첫 번째 인자)
#   DRY_RUN       1이면 실 배포(gcloud run deploy) 없이 resolved config만 stdout 출력
#                 (story #2098, 드리프트 가드 ②값 대조 축용 — deploy_backend.sh와 동형).
#                 prod의 NEXT_PUBLIC_FASTAPI_URL 동적 discovery(아래) 자체는 read-only
#                 gcloud describe라 DRY_RUN에서도 그대로 수행(실 배포만 스킵).

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
DRY_RUN="${DRY_RUN:-0}"
# DRY_RUN(검증 전용)에서는 실제 이미지 태그가 필요 없으므로 COMMIT_SHA를 강제하지 않는다.
if [ "${DRY_RUN}" = "1" ]; then
    COMMIT_SHA="${COMMIT_SHA:-dry-run-placeholder}"
else
    COMMIT_SHA="${COMMIT_SHA:?COMMIT_SHA is required}"
fi

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/frontend:${COMMIT_SHA}"

# ⚠️story cd10e123 계열(2026-07-21, 오르테가군 SPEC-vs-라이브 1:1 대조 지적): dev의
# NEXT_PUBLIC_COOKIE_DOMAIN — story e5225c0a(3차 근본, 이 세션 초입에 다룬 "prod 로그인
# 풀림" 원인 그 자체)가 정확히 이 값의 유무 차이 때문이었다: prod FE에만 이 도메인 속성이
# 있어야 SET/DELETE 쿠키 속성이 갈리지 않는다. 예전 SECRETS_SPEC은 dev/prod 구분 없이 항상
# 이 시크릿을 바인딩했다 — 재실행되면 dev에 이 값이 새로 생겨 dev/prod parity가 깨지고
# (dev가 원래 없어야 할 조건을 얻어) 그 클래스 버그를 다시 만들 위험이 있었다. env별로
# 분리한다(dev=미포함, prod=포함).
case "${ENV}" in
    dev)
        SERVICE_NAME="sprintable-frontend-dev"
        MIN_INSTANCES=0
        MAX_INSTANCES=3
        MEMORY="512Mi"
        CPU="1"
        FASTAPI_SERVICE="sprintable-backend-dev"
        RUNTIME_SA="cloudrun-runtime-dev@${GCP_PROJECT}.iam.gserviceaccount.com"
        # CF-fronted 깔끔 도메인(라이브 실측 2026-07-21 확認) — 동적 discovery(아래 fallback)는
        # 항상 raw *.run.app 로 resolve돼 재실행 시 이 값을 조용히 되돌린다.
        FASTAPI_URL_OVERRIDE="https://dev-api.sprintable.ai"
        COOKIE_DOMAIN_SECRET_SPEC=""
        ;;
    prod)
        SERVICE_NAME="sprintable-frontend-prod"
        MIN_INSTANCES=1
        MAX_INSTANCES=10
        MEMORY="1Gi"
        CPU="2"
        FASTAPI_SERVICE="sprintable-backend-prod"
        RUNTIME_SA="cloudrun-runtime-prod@${GCP_PROJECT}.iam.gserviceaccount.com"
        FASTAPI_URL_OVERRIDE=""
        COOKIE_DOMAIN_SECRET_SPEC=",NEXT_PUBLIC_COOKIE_DOMAIN=NEXT_PUBLIC_COOKIE_DOMAIN:latest"
        ;;
    *)
        echo "Usage: $0 [dev|prod]"; exit 1 ;;
esac

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*"; }

log "Deploying ${SERVICE_NAME} ← ${IMAGE}"

if [[ -n "${FASTAPI_URL_OVERRIDE}" ]]; then
    FASTAPI_URL="${FASTAPI_URL_OVERRIDE}"
else
    # FastAPI Cloud Run 서비스 URL 조회(동적 discovery — prod는 아직 CF-fronted 도메인이 없어
    # raw *.run.app 이 곧 정답값).
    # ⚠️story #2098 정정(2026-07-22, 드리프트 가드 ②값 대조가 실측 중 발견): `status.url`은
    # hash 포맷(`sprintable-backend-prod-57iommnikq-du.a.run.app`)을 반환하는데 라이브
    # NEXT_PUBLIC_FASTAPI_URL은 project-number 포맷(`sprintable-backend-prod-787818285179.
    # asia-northeast3.run.app`)이다 — 둘 다 유효한 별칭(`metadata.annotations['run.googleapis.
    # com/urls']`에 둘 다 등재돼 있음, curl 200 각각 확認)이지만 재배포 시 표기가 바뀌는
    # 드리프트였다. `skip`으로 눈 감는 대신 라이브와 같은 포맷(그 annotation의 첫 번째
    # 원소)을 명시적으로 골라 스크립트가 라이브와 일치하는 값을 계산하게 고쳤다.
    FASTAPI_URL=$(gcloud run services describe "${FASTAPI_SERVICE}" \
        --region="${GCP_REGION}" \
        --project="${GCP_PROJECT}" \
        --format="value(metadata.annotations['run.googleapis.com/urls'])" 2>/dev/null \
        | sed -E 's/^\["([^"]*)".*/\1/' || echo "")
fi

if [[ -z "${FASTAPI_URL}" ]]; then
    log "WARNING: FastAPI service '${FASTAPI_SERVICE}' not found. NEXT_PUBLIC_FASTAPI_URL will be empty."
fi

ENV_VARS_SPEC="NODE_ENV=production,NEXT_TELEMETRY_DISABLED=1,NEXT_PUBLIC_FASTAPI_URL=${FASTAPI_URL}"
SECRETS_SPEC="NEXT_PUBLIC_SUPABASE_URL=NEXT_PUBLIC_SUPABASE_URL:latest,NEXT_PUBLIC_SUPABASE_ANON_KEY=NEXT_PUBLIC_SUPABASE_ANON_KEY:latest,JWT_SECRET=JWT_SECRET:latest${COOKIE_DOMAIN_SECRET_SPEC}"

if [ "${DRY_RUN}" = "1" ]; then
    cat <<EOF
ENV=${ENV}
SERVICE_NAME=${SERVICE_NAME}
IMAGE=${IMAGE}
RUNTIME_SA=${RUNTIME_SA}
MIN_INSTANCES=${MIN_INSTANCES}
MAX_INSTANCES=${MAX_INSTANCES}
ENV_VARS_SPEC=${ENV_VARS_SPEC}
SECRETS_SPEC=${SECRETS_SPEC}
EOF
    exit 0
fi

# ⛔story cd10e123 계열 긴급수정(2026-07-21, durable-wiring 전수 스윕 ⓐ): deploy_backend.sh와
# 동형 결함 — --set-env-vars/--set-secrets(전체교체)로 재실행되면 cloudbuild.yaml deploy-frontend
# 스텝이 additive로 쌓아온 REALTIME_URL 등이 소실된다. --update-*(additive)로 교정.
gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --platform=managed \
    --allow-unauthenticated \
    --service-account="${RUNTIME_SA}" \
    --port=3000 \
    --memory="${MEMORY}" \
    --cpu="${CPU}" \
    --min-instances="${MIN_INSTANCES}" \
    --max-instances="${MAX_INSTANCES}" \
    --concurrency=80 \
    --timeout=60 \
    --update-env-vars="${ENV_VARS_SPEC}" \
    --update-secrets="${SECRETS_SPEC}" \
    --cpu-boost

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --format="value(status.url)")

log "=== Deployment complete ==="
log "URL: ${SERVICE_URL}"
log "Health: ${SERVICE_URL}/api/health"
