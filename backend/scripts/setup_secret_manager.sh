#!/usr/bin/env bash
# D-S3: Secret Manager 시크릿 생성 + Cloud Run SA 접근 권한 설정
#
# 사용법:
#   GCP_PROJECT=sprintable bash backend/scripts/setup_secret_manager.sh
#
# 시크릿 값 입력은 대화형 프롬프트 또는 환경변수로 전달:
#   SECRET_SUPABASE_URL="https://..." bash backend/scripts/setup_secret_manager.sh

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── API 활성화 ───────────────────────────────────────────────────────────────
log "Enabling Secret Manager API..."
gcloud services enable secretmanager.googleapis.com --project="${GCP_PROJECT}"

# ─── 시크릿 생성 헬퍼 ────────────────────────────────────────────────────────
create_secret() {
    local name="$1"
    local value="$2"
    if ! gcloud secrets describe "${name}" --project="${GCP_PROJECT}" &>/dev/null; then
        printf '%s' "${value}" | gcloud secrets create "${name}" \
            --data-file=- \
            --replication-policy=user-managed \
            --locations="${GCP_REGION}" \
            --project="${GCP_PROJECT}"
        log "Created secret: ${name}"
    else
        # 버전 추가
        printf '%s' "${value}" | gcloud secrets versions add "${name}" \
            --data-file=- \
            --project="${GCP_PROJECT}"
        log "Updated secret: ${name}"
    fi
}

# ─── 시크릿 생성 ─────────────────────────────────────────────────────────────
create_secret "NEXT_PUBLIC_SUPABASE_URL"       "${SECRET_SUPABASE_URL:-placeholder}"
create_secret "NEXT_PUBLIC_SUPABASE_ANON_KEY"  "${SECRET_SUPABASE_ANON_KEY:-placeholder}"
create_secret "NEXT_PUBLIC_COOKIE_DOMAIN"      "${SECRET_COOKIE_DOMAIN:-app.sprintable.ai}"
create_secret "JWT_SECRET"                     "${SECRET_JWT_SECRET:?JWT_SECRET required}"
create_secret "SUPABASE_SERVICE_ROLE_KEY"      "${SECRET_SERVICE_ROLE_KEY:-placeholder}"

# ─── Cloud Run SA에 Secret Accessor 권한 ──────────────────────────────────────
PROJECT_NUMBER=$(gcloud projects describe "${GCP_PROJECT}" --format="value(projectNumber)")
CR_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

log "Granting Secret Accessor to Cloud Run SA (${CR_SA})..."
gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
    --member="serviceAccount:${CR_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None

log "=== Secret Manager setup complete ==="
log "Secrets created in project '${GCP_PROJECT}', region '${GCP_REGION}'"
