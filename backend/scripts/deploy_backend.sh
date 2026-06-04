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
#   DEV_SQL_INSTANCE  dev Cloud SQL 인스턴스명  (기본: sprintable-dev)
#   PROD_SQL_INSTANCE prod Cloud SQL 인스턴스명 (기본: sprintable-prod)
#   DRY_RUN           1이면 gcloud 호출 없이 resolved config만 stdout 출력 (검증용)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
DRY_RUN="${DRY_RUN:-0}"
# DRY_RUN(검증 전용)에서는 실제 이미지 태그가 필요 없으므로 COMMIT_SHA를 강제하지 않는다.
if [ "${DRY_RUN}" = "1" ]; then
    COMMIT_SHA="${COMMIT_SHA:-dryrun}"
else
    COMMIT_SHA="${COMMIT_SHA:?COMMIT_SHA is required}"
fi

# E-INFRA S1: dev/prod 인스턴스 분리. prod→새 인스턴스, dev→기존.
# 인스턴스명은 env 변수로 override 가능하되 기본값은 표준 명명 규칙을 따른다.
DEV_SQL_INSTANCE="${DEV_SQL_INSTANCE:-sprintable-dev}"
PROD_SQL_INSTANCE="${PROD_SQL_INSTANCE:-sprintable-prod}"

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/backend:${COMMIT_SHA}"

case "${ENV}" in
    dev)
        SERVICE_NAME="sprintable-backend-dev"
        CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:${DEV_SQL_INSTANCE}"
        MIN_INSTANCES=0
        MAX_INSTANCES=3
        MEMORY="512Mi"
        CPU="1"
        FRONTEND_URL="${FRONTEND_ORIGIN:-https://sprintable-frontend-dev-placeholder.run.app}"
        RUNTIME_SA="cloudrun-runtime-dev@${GCP_PROJECT}.iam.gserviceaccount.com"
        ;;
    prod)
        SERVICE_NAME="sprintable-backend-prod"
        CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:${PROD_SQL_INSTANCE}"
        MIN_INSTANCES=1
        MAX_INSTANCES=10
        MEMORY="1Gi"
        CPU="2"
        FRONTEND_URL="${FRONTEND_ORIGIN:-https://app.sprintable.ai}"
        RUNTIME_SA="cloudrun-runtime-prod@${GCP_PROJECT}.iam.gserviceaccount.com"
        ;;
    *)
        echo "Usage: $0 [dev|prod]" >&2; exit 1 ;;
esac

# DATABASE_URL 시크릿은 env별로 분리된 시크릿을 참조한다 (DATABASE_URL_DEV / DATABASE_URL_PROD).
# bash 3.2(macOS) 호환을 위해 ${ENV^^} 대신 tr 사용.
ENV_UPPER="$(printf '%s' "${ENV}" | tr '[:lower:]' '[:upper:]')"
DB_SECRET_NAME="DATABASE_URL_${ENV_UPPER}"

# log는 stderr로 — DRY_RUN의 machine-readable stdout과 섞이지 않도록.
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*" >&2; }

CORS_ORIGINS="http://localhost:3000,http://localhost:3108,${FRONTEND_URL}"

log "Deploying ${SERVICE_NAME} ← ${IMAGE}"
log "Cloud SQL: ${CLOUD_SQL_INSTANCE}"
log "DB secret: ${DB_SECRET_NAME}"
log "CORS origins: ${CORS_ORIGINS}"

# ─── DRY_RUN: gcloud 호출 없이 resolved config를 stdout으로 출력 (양 경로 검증용) ──
if [ "${DRY_RUN}" = "1" ]; then
    cat <<EOF
ENV=${ENV}
SERVICE_NAME=${SERVICE_NAME}
CLOUD_SQL_INSTANCE=${CLOUD_SQL_INSTANCE}
DB_SECRET_NAME=${DB_SECRET_NAME}
IMAGE=${IMAGE}
RUNTIME_SA=${RUNTIME_SA}
MIN_INSTANCES=${MIN_INSTANCES}
MAX_INSTANCES=${MAX_INSTANCES}
EOF
    exit 0
fi

gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --platform=managed \
    --no-allow-unauthenticated \
    --service-account="${RUNTIME_SA}" \
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
DATABASE_URL=${DB_SECRET_NAME}:latest,\
JWT_SECRET=JWT_SECRET:latest" \
    --startup-probe-path="/api/v2/health"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --format="value(status.url)")

log "=== Deployment complete ==="
log "URL: ${SERVICE_URL}"
log "Health: ${SERVICE_URL}/api/v2/health"
