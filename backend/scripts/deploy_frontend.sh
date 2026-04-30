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

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
COMMIT_SHA="${COMMIT_SHA:?COMMIT_SHA is required}"

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/frontend:${COMMIT_SHA}"

case "${ENV}" in
    dev)
        SERVICE_NAME="sprintable-frontend-dev"
        MIN_INSTANCES=0
        MAX_INSTANCES=3
        MEMORY="512Mi"
        CPU="1"
        FASTAPI_SERVICE="sprintable-backend-dev"
        ;;
    prod)
        SERVICE_NAME="sprintable-frontend-prod"
        MIN_INSTANCES=1
        MAX_INSTANCES=10
        MEMORY="1Gi"
        CPU="2"
        FASTAPI_SERVICE="sprintable-backend-prod"
        ;;
    *)
        echo "Usage: $0 [dev|prod]"; exit 1 ;;
esac

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*"; }

log "Deploying ${SERVICE_NAME} ← ${IMAGE}"

# FastAPI Cloud Run 서비스 URL 조회
FASTAPI_URL=$(gcloud run services describe "${FASTAPI_SERVICE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --format="value(status.url)" 2>/dev/null || echo "")

if [[ -z "${FASTAPI_URL}" ]]; then
    log "WARNING: FastAPI service '${FASTAPI_SERVICE}' not found. NEXT_PUBLIC_FASTAPI_URL will be empty."
fi

gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --platform=managed \
    --allow-unauthenticated \
    --port=3000 \
    --memory="${MEMORY}" \
    --cpu="${CPU}" \
    --min-instances="${MIN_INSTANCES}" \
    --max-instances="${MAX_INSTANCES}" \
    --concurrency=80 \
    --timeout=60 \
    --set-env-vars="NODE_ENV=production,NEXT_TELEMETRY_DISABLED=1" \
    --set-env-vars="NEXT_PUBLIC_FASTAPI_URL=${FASTAPI_URL}" \
    --set-secrets="\
NEXT_PUBLIC_SUPABASE_URL=NEXT_PUBLIC_SUPABASE_URL:latest,\
NEXT_PUBLIC_SUPABASE_ANON_KEY=NEXT_PUBLIC_SUPABASE_ANON_KEY:latest,\
NEXT_PUBLIC_COOKIE_DOMAIN=NEXT_PUBLIC_COOKIE_DOMAIN:latest,\
JWT_SECRET=JWT_SECRET:latest" \
    --startup-cpu-boost \
    --startup-probe-path="/api/health"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --format="value(status.url)")

log "=== Deployment complete ==="
log "URL: ${SERVICE_URL}"
log "Health: ${SERVICE_URL}/api/health"
