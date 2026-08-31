#!/usr/bin/env bash
# story #f2a27d2a(지원v1·1경계) flip PR — Support Gateway Alembic 마이그레이션 Cloud Run Job
# 프로비저닝(dev/prod 분리). backend/scripts/provision_migrate_job.sh와 동형 패턴이나 훨씬
# 단순하다 — ALEMBIC 전용 별도 URL/드라이버를 안 쓴다: 앱 런타임과 마이그레이션 둘 다 같은
# SUPPORT_GATEWAY_DATABASE_URL(asyncpg, unix socket)을 그대로 쓴다(backend가 psycopg2 Private-IP
# 전용 URL로 분리한 건 그쪽 alembic env.py가 sync 엔진이라 그런 것 — 이 서비스의 alembic
# env.py는 처음부터 async engine이라 분리할 이유가 없다).
#
# 현재(2026-08-31, dev): 전용 Cloud SQL 인스턴스가 아니라 backend와 **같은** sprintable-${ENV}
# 인스턴스 안 전용 database(support_gateway)+전용 user(support_gw) — 물리 인스턴스 분리는
# prod 승격 판단 시점에 재평가(페드루 PO, 프로비저닝 보고 원문).
#
# 사용법:
#   COMMIT_SHA=abc1234 bash support-gateway/scripts/provision_migrate_job.sh dev
#   DRY_RUN=1 bash support-gateway/scripts/provision_migrate_job.sh dev   # gcloud 호출 없이 검증

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
DRY_RUN="${DRY_RUN:-0}"

SQL_INSTANCE_NAME="${SQL_INSTANCE_NAME:-sprintable-${ENV}}"

case "${ENV}" in
    dev|prod) ;;
    *) echo "Usage: $0 [dev|prod]" >&2; exit 1 ;;
esac

if [ -z "${COMMIT_SHA:-}" ] && [ "${DRY_RUN}" != "1" ]; then
    echo "ERROR: COMMIT_SHA is not set (동일 사유 — backend migrate job 스크립트 주석 참고, 19754b93)." >&2
    exit 1
fi

JOB_NAME="sprintable-support-gateway-migrate-${ENV}"
IMAGE_TAG="${COMMIT_SHA:-latest-${ENV}}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/support-gateway:${IMAGE_TAG}"
CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:${SQL_INSTANCE_NAME}"
# ⚠️소문자 env 접미사 — Secret Manager 실물이 SUPPORT_GATEWAY_DATABASE_URL_dev(소문자)로
# 프로비저닝됨(페드루 PO 보고 원문). backend류 다른 시크릿(DATABASE_URL_DEV_PGBOUNCER_*
# 등)은 대문자 DEV/PROD 접미사 관례지만, 이 시크릿은 그 관례를 안 따른다 — 실측(gcloud
# secrets list)이 관례보다 우선, ENV_UPPER로 바꾸지 말 것(#3140 sync 가드가 바로 잡아준다).
DB_SECRET_NAME="SUPPORT_GATEWAY_DATABASE_URL_${ENV}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${ENV}] $*" >&2; }

log "Migrate job: ${JOB_NAME}"
log "Image: ${IMAGE}"
log "Cloud SQL: ${CLOUD_SQL_INSTANCE}"
log "DB secret: ${DB_SECRET_NAME}"

if [ "${DRY_RUN}" = "1" ]; then
    cat <<EOF
ENV=${ENV}
JOB_NAME=${JOB_NAME}
IMAGE=${IMAGE}
CLOUD_SQL_INSTANCE=${CLOUD_SQL_INSTANCE}
DB_SECRET_NAME=${DB_SECRET_NAME}
COMMAND=/app/scripts/migrate.sh
EOF
    exit 0
fi

gcloud run jobs deploy "${JOB_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --command="/app/scripts/migrate.sh" \
    --set-secrets="SUPPORT_GATEWAY_DATABASE_URL=${DB_SECRET_NAME}:latest" \
    --set-cloudsql-instances="${CLOUD_SQL_INSTANCE}" \
    --execution-environment=gen2 \
    --max-retries=1 \
    --task-timeout=300

log "=== ${JOB_NAME} provisioned ==="
log "Run: gcloud run jobs execute ${JOB_NAME} --region=${GCP_REGION} --project=${GCP_PROJECT} --wait"
