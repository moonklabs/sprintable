#!/usr/bin/env bash
# D-S2: Artifact Registry 저장소 + Cloud Build 트리거 설정 스크립트
#
# 사전 조건:
#   - GCP Billing 연결 완료
#   - gcloud auth login 완료
#
# 사용법:
#   GCP_PROJECT=sprintable bash backend/scripts/setup_artifact_registry.sh

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
AR_REGION="${AR_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
GITHUB_OWNER="${GITHUB_OWNER:-moonklabs}"
GITHUB_REPO="${GITHUB_REPO:-sprintable}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── API 활성화 ───────────────────────────────────────────────────────────────
log "Enabling APIs..."
gcloud services enable \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    --project="${GCP_PROJECT}"

# ─── Artifact Registry 저장소 생성 ───────────────────────────────────────────
log "Creating Artifact Registry repository '${AR_REPO}'..."
if ! gcloud artifacts repositories describe "${AR_REPO}" \
        --location="${AR_REGION}" --project="${GCP_PROJECT}" &>/dev/null; then
    gcloud artifacts repositories create "${AR_REPO}" \
        --repository-format=docker \
        --location="${AR_REGION}" \
        --description="Sprintable container images" \
        --project="${GCP_PROJECT}"
    log "Repository created: ${AR_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}"
else
    log "Repository '${AR_REPO}' already exists, skipping."
fi

# ─── Cloud Build Service Account 권한 부여 ───────────────────────────────────
PROJECT_NUMBER=$(gcloud projects describe "${GCP_PROJECT}" --format="value(projectNumber)")
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

log "Granting Artifact Registry Writer to Cloud Build SA (${CB_SA})..."
gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
    --member="serviceAccount:${CB_SA}" \
    --role="roles/artifactregistry.writer" \
    --condition=None

# ─── Cloud Build 트리거 생성 (main 브랜치) ────────────────────────────────────
log "Creating Cloud Build trigger for main branch..."
gcloud builds triggers create github \
    --name="sprintable-main-build" \
    --repo-name="${GITHUB_REPO}" \
    --repo-owner="${GITHUB_OWNER}" \
    --branch-pattern="^main$" \
    --build-config="cloudbuild.yaml" \
    --project="${GCP_PROJECT}" 2>/dev/null || log "Trigger already exists, skipping."

log "=== Artifact Registry setup complete ==="
log "Images will be pushed to:"
log "  ${AR_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/frontend:SHA"
log "  ${AR_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/backend:SHA"
