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
        APP_URL="${APP_URL:-https://dev-app.sprintable.ai}"  # OAuth redirect/이메일 링크용 프론트 URL
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
        APP_URL="${APP_URL:-https://app.sprintable.ai}"
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

# 추가 런타임 env (config.py 참조). 필요 시 env로 override.
EVENTBUS_ENABLED="${EVENTBUS_ENABLED:-true}"
MEMBER_SSOT_RESOLVER_SHADOW="${MEMBER_SSOT_RESOLVER_SHADOW:-true}"
MEMBER_SSOT_APIKEY_CUT="${MEMBER_SSOT_APIKEY_CUT:-true}"
# ⚠️ GitHub OAuth는 현재 _DEV 앱만 존재(prod 앱 미생성) → dev/prod 모두 _DEV 시크릿 참조.
#   prod GitHub 앱 생성 시 GITHUB_SECRET_SUFFIX=PROD로 override.
GITHUB_SECRET_SUFFIX="${GITHUB_SECRET_SUFFIX:-DEV}"

# ── 결함③ fix: full env. Secret Manager 시크릿 (값에 콤마 없어 콤마 구분 OK). ──
SECRETS_SPEC="DATABASE_URL=${DB_SECRET_NAME}:latest"
SECRETS_SPEC="${SECRETS_SPEC},JWT_SECRET=JWT_SECRET:latest"
# ⚠️ SUPABASE 시크릿은 dead(backend/app 0 functional refs·JWT_SECRET 우선) → 미주입(S1 결정 유지).
SECRETS_SPEC="${SECRETS_SPEC},GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest"
SECRETS_SPEC="${SECRETS_SPEC},GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest"
SECRETS_SPEC="${SECRETS_SPEC},GITHUB_CLIENT_ID=GITHUB_CLIENT_ID_${GITHUB_SECRET_SUFFIX}:latest"
SECRETS_SPEC="${SECRETS_SPEC},GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET_${GITHUB_SECRET_SUFFIX}:latest"
SECRETS_SPEC="${SECRETS_SPEC},RESEND_API_KEY=RESEND_API_KEY:latest"
SECRETS_SPEC="${SECRETS_SPEC},EMAIL_FROM=EMAIL_FROM:latest"

# ── 결함④ fix: 평문 env. CORS_ORIGINS 값에 콤마가 있어 기본(콤마) 구분자로는 env가 쪼개진다 →
#   gcloud 커스텀 구분자 '^@^'로 '@' 구분. NEXT_PUBLIC_APP_URL도 세팅(verify-link 환경정합·#1236 finding). ──
ENV_VARS_SPEC="^@^APP_ENV=${ENV}"
ENV_VARS_SPEC="${ENV_VARS_SPEC}@CORS_ORIGINS=${CORS_ORIGINS}"
ENV_VARS_SPEC="${ENV_VARS_SPEC}@APP_URL=${APP_URL}"
ENV_VARS_SPEC="${ENV_VARS_SPEC}@NEXT_PUBLIC_APP_URL=${APP_URL}"
ENV_VARS_SPEC="${ENV_VARS_SPEC}@EVENTBUS_ENABLED=${EVENTBUS_ENABLED}"
ENV_VARS_SPEC="${ENV_VARS_SPEC}@MEMBER_SSOT_RESOLVER_SHADOW=${MEMBER_SSOT_RESOLVER_SHADOW}"
ENV_VARS_SPEC="${ENV_VARS_SPEC}@MEMBER_SSOT_APIKEY_CUT=${MEMBER_SSOT_APIKEY_CUT}"

log "Deploying ${SERVICE_NAME} ← ${IMAGE}"
log "Cloud SQL: ${CLOUD_SQL_INSTANCE}"
log "DB secret: ${DB_SECRET_NAME}"
log "CORS origins: ${CORS_ORIGINS}"
log "APP_URL: ${APP_URL}"

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
APP_URL=${APP_URL}
SECRETS_SPEC=${SECRETS_SPEC}
ENV_VARS_SPEC=${ENV_VARS_SPEC}
EOF
    exit 0
fi

# 결함①: --startup-probe-path는 유효하지 않은 플래그 → 제거(Cloud Run 기본 TCP startup probe on --port).
# 결함②: VPC 누락 → --network/--subnet/--vpc-egress 추가(Private-IP 경로·dev/prod 검증된 config 일치).
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
    --network=default \
    --subnet=default \
    --vpc-egress=private-ranges-only \
    --set-env-vars="${ENV_VARS_SPEC}" \
    --set-secrets="${SECRETS_SPEC}"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --format="value(status.url)")

log "=== Deployment complete ==="
log "URL: ${SERVICE_URL}"
log "Health: ${SERVICE_URL}/api/v2/health"
