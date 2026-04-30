#!/usr/bin/env bash
# D-S2: Workload Identity Federation 설정 스크립트
# GitHub Actions → GCP 키 없는 인증
#
# 사용법:
#   GCP_PROJECT=sprintable GITHUB_OWNER=moonklabs GITHUB_REPO=sprintable \
#   bash backend/scripts/setup_workload_identity.sh

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GITHUB_OWNER="${GITHUB_OWNER:-moonklabs}"
GITHUB_REPO="${GITHUB_REPO:-sprintable}"
SA_NAME="${SA_NAME:-github-actions}"
POOL_NAME="${POOL_NAME:-github}"
PROVIDER_NAME="${PROVIDER_NAME:-github}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── API 활성화 ───────────────────────────────────────────────────────────────
log "Enabling IAM Credentials API..."
gcloud services enable iamcredentials.googleapis.com --project="${GCP_PROJECT}"

PROJECT_NUMBER=$(gcloud projects describe "${GCP_PROJECT}" --format="value(projectNumber)")

# ─── Service Account 생성 ─────────────────────────────────────────────────────
SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
log "Creating Service Account '${SA_EMAIL}'..."
gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="GitHub Actions CI/CD" \
    --project="${GCP_PROJECT}" 2>/dev/null || log "SA already exists, skipping."

# 필요 권한 부여
for ROLE in roles/cloudbuild.builds.editor roles/artifactregistry.writer roles/run.admin roles/secretmanager.secretAccessor; do
    gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
        --member="serviceAccount:${SA_EMAIL}" \
        --role="${ROLE}" \
        --condition=None
done

# ─── Workload Identity Pool 생성 ─────────────────────────────────────────────
log "Creating Workload Identity Pool '${POOL_NAME}'..."
gcloud iam workload-identity-pools create "${POOL_NAME}" \
    --location=global \
    --display-name="GitHub Actions Pool" \
    --project="${GCP_PROJECT}" 2>/dev/null || log "Pool already exists, skipping."

POOL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}"

# ─── Workload Identity Provider 생성 ─────────────────────────────────────────
log "Creating OIDC provider '${PROVIDER_NAME}'..."
gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_NAME}" \
    --location=global \
    --workload-identity-pool="${POOL_NAME}" \
    --display-name="GitHub OIDC Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GITHUB_OWNER}/${GITHUB_REPO}'" \
    --project="${GCP_PROJECT}" 2>/dev/null || log "Provider already exists, skipping."

# ─── SA → WIF Pool 바인딩 ─────────────────────────────────────────────────────
log "Binding Service Account to Workload Identity Pool..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}" \
    --project="${GCP_PROJECT}"

PROVIDER_FULL="${POOL_ID}/providers/${PROVIDER_NAME}"
log "=== Workload Identity Federation setup complete ==="
cat <<OUTPUT

GitHub Actions secrets 설정 바라는:
  GCP_PROJECT_ID:          ${GCP_PROJECT}
  GCP_SERVICE_ACCOUNT:     ${SA_EMAIL}
  GCP_WORKLOAD_IDENTITY_PROVIDER: ${PROVIDER_FULL}
OUTPUT
