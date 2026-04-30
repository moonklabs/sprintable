#!/usr/bin/env bash
# D-S7: IAM 최소 권한 설정 스크립트
#
# Cloud Run 런타임 SA (dev + prod) 생성 + 최소 권한:
#   - secretmanager.secretAccessor
#   - cloudsql.client
#
# GitHub Actions SA (D-S2에서 생성됨)는 다음 역할만 유지:
#   - cloudbuild.builds.editor
#   - artifactregistry.writer
#   (run.admin, secretAccessor는 Cloud Run SA로 이동 — 최소 권한 원칙)
#
# 사용법:
#   GCP_PROJECT=sprintable-494803 bash backend/scripts/setup_iam.sh

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── API 활성화 ───────────────────────────────────────────────────────────────
log "Enabling required APIs..."
gcloud services enable \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    run.googleapis.com \
    --project="${GCP_PROJECT}"

# ─── Cloud Run 런타임 SA 생성 헬퍼 ───────────────────────────────────────────
create_runtime_sa() {
    local env="$1"
    local sa_name="cloudrun-runtime-${env}"
    local sa_email="${sa_name}@${GCP_PROJECT}.iam.gserviceaccount.com"

    log "Creating Cloud Run runtime SA for ${env}: ${sa_email}"
    gcloud iam service-accounts create "${sa_name}" \
        --display-name="Cloud Run Runtime (${env})" \
        --project="${GCP_PROJECT}" 2>/dev/null || log "SA already exists, skipping create."

    # 최소 권한 역할만 부여
    for ROLE in \
        roles/secretmanager.secretAccessor \
        roles/cloudsql.client; do
        gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
            --member="serviceAccount:${sa_email}" \
            --role="${ROLE}" \
            --condition=None
    done

    log "SA ${sa_email} — roles: secretAccessor + cloudsql.client"
    echo "${sa_email}"
}

# ─── dev / prod SA 생성 ───────────────────────────────────────────────────────
SA_DEV=$(create_runtime_sa "dev")
SA_PROD=$(create_runtime_sa "prod")

# ─── GitHub Actions SA 권한 정리 (run.admin 불필요) ──────────────────────────
# deploy_frontend/backend.sh는 Cloud Build에서 실행되므로
# GitHub Actions SA에서 run.admin 제거 (최소 권한 강화)
GHA_SA="github-actions@${GCP_PROJECT}.iam.gserviceaccount.com"
log "Removing run.admin from GitHub Actions SA (${GHA_SA})..."
gcloud projects remove-iam-policy-binding "${GCP_PROJECT}" \
    --member="serviceAccount:${GHA_SA}" \
    --role="roles/run.admin" \
    --condition=None 2>/dev/null || log "run.admin not found, skipping."

log "=== IAM setup complete ==="
cat <<OUTPUT

Cloud Run 배포 시 SA 지정 바라는:
  deploy_frontend.sh dev  → --service-account=${SA_DEV}
  deploy_frontend.sh prod → --service-account=${SA_PROD}
  deploy_backend.sh dev   → --service-account=${SA_DEV}
  deploy_backend.sh prod  → --service-account=${SA_PROD}
OUTPUT
