#!/usr/bin/env bash
# E-INFRA S1: Alembic 마이그레이션 Cloud Run Job 프로비저닝 (dev/prod 분리).
#
# 기존 sprintable-migrate-dev 잡은 ad-hoc gcloud로 생성되어 재현 불가능했다.
# 이 스크립트는 dev/prod 양쪽 마이그 잡을 동일 패턴으로 재현 가능하게 생성/갱신한다.
#
# 잡 구성 (라이브 sprintable-migrate-dev 미러):
#   - command         : /app/scripts/migrate.sh  (alembic upgrade heads — story bda4beac,
#                        ee_pricing 별도 head 분기 후 복수형으로 전환)
#   - ALEMBIC_DATABASE_URL : 시크릿 ALEMBIC_DATABASE_URL_<ENV> (Private-IP psycopg2)
#   - cloudsql-instances   : env별 인스턴스 (prod→sprintable-prod, dev→sprintable-dev)
#   - network/vpc-egress   : default / private-ranges-only
#
# 사용법:
#   COMMIT_SHA=abc1234 bash backend/scripts/provision_migrate_job.sh dev
#   COMMIT_SHA=abc1234 bash backend/scripts/provision_migrate_job.sh prod
#   # 잡 생성/갱신 후 실행:
#   gcloud run jobs execute sprintable-migrate-prod --region=asia-northeast3 --project=sprintable-494803 --wait
#
# 환경변수:
#   GCP_PROJECT       (기본: sprintable-494803)
#   GCP_REGION        (기본: asia-northeast3)
#   AR_REPO           (기본: sprintable)
#   COMMIT_SHA        이미지 태그 — **필수**(story 19754b93: `latest-<env>` floating 폴백 제거·
#                     미지정 시 fail-fast, DRY_RUN=1 검증 시엔 예외)
#   DEV_SQL_INSTANCE  (기본: sprintable-dev)
#   PROD_SQL_INSTANCE (기본: sprintable-prod)
#   DRY_RUN           1이면 gcloud 호출 없이 resolved config만 stdout 출력 (검증용·COMMIT_SHA 불필요)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
DRY_RUN="${DRY_RUN:-0}"

DEV_SQL_INSTANCE="${DEV_SQL_INSTANCE:-sprintable-dev}"
PROD_SQL_INSTANCE="${PROD_SQL_INSTANCE:-sprintable-prod}"

case "${ENV}" in
    dev)  SQL_INSTANCE_NAME="${DEV_SQL_INSTANCE}" ;;
    prod) SQL_INSTANCE_NAME="${PROD_SQL_INSTANCE}" ;;
    *) echo "Usage: $0 [dev|prod]" >&2; exit 1 ;;
esac

JOB_NAME="sprintable-migrate-${ENV}"
# story 19754b93(E-RECRUIT S15): `${COMMIT_SHA:-latest-${ENV}}` floating-tag 폴백이 out-of-band
# 수동 실행 시 stale 이미지에 도달할 수 있었다(#1886/S13 사고의 근본원인과 동형 — 잡이 코드와
# 동기화 안 된 이미지를 물고 도는 것). cloudbuild.yaml(S13)의 자동 경로는 COMMIT_SHA를 항상
# 명시 전달하므로 이 가드는 그 경로에 영향 없음 — 사람이 잊고 COMMIT_SHA 없이 수동 실행할 때만
# fail-fast로 막는다(DRY_RUN=1 검증은 예외 — resolved config 확인 목적이라 SHA 없어도 됨).
if [ -z "${COMMIT_SHA:-}" ] && [ "${DRY_RUN:-0}" != "1" ]; then
    echo "ERROR: COMMIT_SHA is not set." >&2
    echo "Manual provisioning requires an explicit image SHA — floating 'latest-${ENV}' tag fallback" >&2
    echo "was removed (story 19754b93) to prevent stale-image drift on out-of-band runs." >&2
    echo "Usage: COMMIT_SHA=<git-sha-or-image-tag> bash $0 ${ENV}" >&2
    exit 1
fi
IMAGE_TAG="${COMMIT_SHA:-latest-${ENV}}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/backend:${IMAGE_TAG}"
CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:${SQL_INSTANCE_NAME}"
# Private-IP psycopg2 URL을 담은 env별 시크릿 (setup_secret_manager.sh에서 생성).
# bash 3.2(macOS) 호환을 위해 ${ENV^^} 대신 tr 사용.
ENV_UPPER="$(printf '%s' "${ENV}" | tr '[:lower:]' '[:upper:]')"
ALEMBIC_SECRET_NAME="ALEMBIC_DATABASE_URL_${ENV_UPPER}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*" >&2; }

log "Migrate job: ${JOB_NAME}"
log "Image: ${IMAGE}"
log "Cloud SQL: ${CLOUD_SQL_INSTANCE}"
log "ALEMBIC secret: ${ALEMBIC_SECRET_NAME}"

# ─── DRY_RUN: gcloud 호출 없이 resolved config를 stdout으로 출력 (검증용) ──────────
if [ "${DRY_RUN}" = "1" ]; then
    cat <<EOF
ENV=${ENV}
JOB_NAME=${JOB_NAME}
IMAGE=${IMAGE}
CLOUD_SQL_INSTANCE=${CLOUD_SQL_INSTANCE}
ALEMBIC_SECRET_NAME=${ALEMBIC_SECRET_NAME}
COMMAND=/app/scripts/migrate.sh
EOF
    exit 0
fi

# `gcloud run jobs deploy`는 잡이 없으면 생성, 있으면 갱신 (idempotent).
gcloud run jobs deploy "${JOB_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --command="/app/scripts/migrate.sh" \
    --set-secrets="ALEMBIC_DATABASE_URL=${ALEMBIC_SECRET_NAME}:latest" \
    --set-cloudsql-instances="${CLOUD_SQL_INSTANCE}" \
    --network=default \
    --subnet=default \
    --vpc-egress=private-ranges-only \
    --execution-environment=gen2 \
    --max-retries=1 \
    --task-timeout=600

log "=== ${JOB_NAME} provisioned ==="
log "Run: gcloud run jobs execute ${JOB_NAME} --region=${GCP_REGION} --project=${GCP_PROJECT} --wait"
