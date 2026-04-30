#!/usr/bin/env bash
# D-S4: Cloud Run 백엔드(FastAPI) 배포 스크립트
#
# 사전 조건:
#   - GCP Billing 연결 완료
#   - Cloud SQL 인스턴스 생성 완료 (D-S1 provision_cloud_sql.sh)
#   - Artifact Registry에 이미지 빌드 완료 (D-S2 cloudbuild.yaml)
#   - Secret Manager 시크릿 생성 완료 (D-S3 setup_secret_manager.sh)
#
# 사용법:
#   COMMIT_SHA=abc1234 bash backend/scripts/deploy_backend.sh dev
#   COMMIT_SHA=abc1234 bash backend/scripts/deploy_backend.sh prod
#
# 환경변수:
#   GCP_PROJECT       (기본: sprintable)
#   GCP_REGION        (기본: asia-northeast3)
#   COMMIT_SHA        [필수]
#   FRONTEND_ORIGIN   Cloud Run 프론트엔드 URL (CORS 허용)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
COMMIT_SHA="${COMMIT_SHA:?COMMIT_SHA is required}"

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/backend:${COMMIT_SHA}"

case "${ENV}" in
    dev)
        SERVICE_NAME="sprintable-backend-dev"
        CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:sprintable-dev"
        MIN_INSTANCES=0
        MAX_INSTANCES=3
        MEMORY="512Mi"
        CPU="1"
        FRONTEND_URL="${FRONTEND_ORIGIN:-https://sprintable-frontend-dev-placeholder.run.app}"
        ;;
    prod)
        SERVICE_NAME="sprintable-backend-prod"
        CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:sprintable-prod"
        MIN_INSTANCES=1
        MAX_INSTANCES=10
        MEMORY="1Gi"
        CPU="2"
        FRONTEND_URL="${FRONTEND_ORIGIN:-https://app.sprintable.ai}"
        ;;
    *)
        echo "Usage: $0 [dev|prod]"; exit 1 ;;
esac

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*"; }

CORS_ORIGINS="http://localhost:3000,http://localhost:3108,${FRONTEND_URL}"

log "Deploying ${SERVICE_NAME} ← ${IMAGE}"
log "Cloud SQL: ${CLOUD_SQL_INSTANCE}"
log "CORS origins: ${CORS_ORIGINS}"

gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --platform=managed \
    --no-allow-unauthenticated \
    --port=8000 \
    --memory="${MEMORY}" \
    --cpu="${CPU}" \
    --min-instances="${MIN_INSTANCES}" \
    --max-instances="${MAX_INSTANCES}" \
    --concurrency=80 \
    --timeout=300 \
    --add-cloudsql-instances="${CLOUD_SQL_INSTANCE}" \
    --set-env-vars="APP_ENV=${ENV},CORS_ORIGINS=${CORS_ORIGINS}" \
    --set-secrets="\
DATABASE_URL=DATABASE_URL_${ENV^^}:latest,\
JWT_SECRET=JWT_SECRET:latest,\
SUPABASE_URL=NEXT_PUBLIC_SUPABASE_URL:latest,\
SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest" \
    --startup-probe-path="/api/v2/health"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --format="value(status.url)")

log "=== Deployment complete ==="
log "URL: ${SERVICE_URL}"
log "Health: ${SERVICE_URL}/api/v2/health"
