#!/usr/bin/env bash
# story #2402 그라운딩 제안 A(2026-08-17, 미르코·페드루 PO 승인) — sprintable-readonly-prod
# 재프로비저닝 스크립트화.
#
# 배경: 이 잡은 2026-08-01 ad-hoc gcloud로 수동 생성돼(story #2399 그라운딩 중 발견 —
# `run.googleapis.com/creator` 애노테이션으로 확認) 어떤 스크립트/자동화도 이 잡을 몰랐다
# — 정확히 이 저장소의 `provision_migrate_job.sh` 자신이 경고하는 그 패턴("기존
# sprintable-migrate-dev 잡은 ad-hoc gcloud로 생성되어 재현 불가능했다")의 재발이었다.
# 실제로 이미지가 2026-08-01 커밋(f001b52b)에 16일 넘게 고정된 채 방치돼 있었고, 그 사이
# 머지된 마이그레이션 파일(0252/0253)을 몰라 `alembic current`가 리비전 이름조차 못 읽고
# 실패하는 것을 라이브로 재현했다(story #2402 참고).
#
# 잡 구성(라이브 sprintable-readonly-prod 미러, provision_migrate_job.sh와 동형 패턴):
#   - command : sh -c 'cd /app && alembic current'   ⚠️읽기전용 — upgrade 없음, 구조로 보장
#               (쓰기 구문을 넣을 자리 자체가 없다 — 명령이 고정 리터럴)
#   - ALEMBIC_DATABASE_URL : 시크릿 ALEMBIC_DATABASE_URL_PROD(prod 전용, dev 변형 없음 —
#     이 잡 자체가 prod 스키마 확認용이라 dev에선 존재 이유가 없음)
#   - cloudsql-instances/network/vpc-egress : prod 마이그 잡과 동형
#
# ⚠️이 스크립트는 "생성/갱신"만 한다 — 실행(`gcloud run jobs execute`)은 별도 명시 호출로
# 분리(story #2399의 확認↔삭제 분리 관행과 동형, 실수로 같이 실행되는 걸 막는다).
#
# 사용법:
#   COMMIT_SHA=abc1234 bash backend/scripts/provision_readonly_prod_job.sh
#   # 프로비저닝 후 실행(별도 호출):
#   gcloud run jobs execute sprintable-readonly-prod --region=asia-northeast3 --project=sprintable-494803 --wait
#
# 환경변수:
#   GCP_PROJECT        (기본: sprintable-494803)
#   GCP_REGION         (기본: asia-northeast3)
#   AR_REPO            (기본: sprintable)
#   COMMIT_SHA         이미지 태그 — **필수**(story 19754b93과 동일 규율: floating tag 폴백
#                      없음, 미지정 시 fail-fast. DRY_RUN=1 검증 시엔 예외)
#   PROD_SQL_INSTANCE  (기본: sprintable-prod)
#   DRY_RUN            1이면 gcloud 호출 없이 resolved config만 stdout 출력(검증용)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
DRY_RUN="${DRY_RUN:-0}"
PROD_SQL_INSTANCE="${PROD_SQL_INSTANCE:-sprintable-prod}"

JOB_NAME="sprintable-readonly-prod"

if [ -z "${COMMIT_SHA:-}" ] && [ "${DRY_RUN:-0}" != "1" ]; then
    echo "ERROR: COMMIT_SHA is not set." >&2
    echo "Manual provisioning requires an explicit image SHA — floating tag 폴백 없음" >&2
    echo "(story 19754b93 규율과 동일 — 이 잡 자체가 08-01 stale 고정으로 고장난 사례다)." >&2
    echo "Usage: COMMIT_SHA=<git-sha-or-image-tag> bash $0" >&2
    exit 1
fi
IMAGE_TAG="${COMMIT_SHA:-latest-prod}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/backend:${IMAGE_TAG}"
CLOUD_SQL_INSTANCE="${GCP_PROJECT}:${GCP_REGION}:${PROD_SQL_INSTANCE}"
ALEMBIC_SECRET_NAME="ALEMBIC_DATABASE_URL_PROD"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [readonly-prod] $*" >&2; }

log "Job: ${JOB_NAME}"
log "Image: ${IMAGE}"
log "Cloud SQL: ${CLOUD_SQL_INSTANCE}"
log "ALEMBIC secret: ${ALEMBIC_SECRET_NAME}"

if [ "${DRY_RUN}" = "1" ]; then
    cat <<EOF
JOB_NAME=${JOB_NAME}
IMAGE=${IMAGE}
CLOUD_SQL_INSTANCE=${CLOUD_SQL_INSTANCE}
ALEMBIC_SECRET_NAME=${ALEMBIC_SECRET_NAME}
COMMAND=sh -c 'cd /app && alembic current'
EOF
    exit 0
fi

# `gcloud run jobs deploy`는 잡이 없으면 생성, 있으면 갱신(idempotent) — 라이브 잡의
# 현재 리소스(cpu=1·memory=512Mi·maxRetries=0·timeout=300s)를 그대로 명시해 드리프트 없이
# 재현한다.
gcloud run jobs deploy "${JOB_NAME}" \
    --image="${IMAGE}" \
    --region="${GCP_REGION}" \
    --project="${GCP_PROJECT}" \
    --command=sh \
    --args="-c,cd /app && alembic current" \
    --set-secrets="ALEMBIC_DATABASE_URL=${ALEMBIC_SECRET_NAME}:latest" \
    --set-cloudsql-instances="${CLOUD_SQL_INSTANCE}" \
    --network=default \
    --subnet=default \
    --vpc-egress=private-ranges-only \
    --execution-environment=gen2 \
    --cpu=1 \
    --memory=512Mi \
    --max-retries=0 \
    --task-timeout=300

log "=== ${JOB_NAME} provisioned ==="
log "Run(별도 호출): gcloud run jobs execute ${JOB_NAME} --region=${GCP_REGION} --project=${GCP_PROJECT} --wait"
