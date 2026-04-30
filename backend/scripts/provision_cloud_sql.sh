#!/usr/bin/env bash
# D-S1: Cloud SQL PostgreSQL 15 인스턴스 프로비저닝 스크립트
#
# 사전 조건:
#   - GCP 프로젝트에 Billing 계정 연결 완료
#   - Cloud SQL Admin API, Compute Engine API, Service Networking API 활성화
#   - gcloud auth login 완료
#
# 사용법:
#   bash backend/scripts/provision_cloud_sql.sh [dev|prod|both]
#
# 환경변수 (선택):
#   GCP_PROJECT   (기본: sprintable)
#   GCP_REGION    (기본: asia-northeast3)
#   VPC_NETWORK   (기본: default)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
VPC_NETWORK="${VPC_NETWORK:-default}"
TARGET="${1:-both}"

INSTANCE_DEV="sprintable-dev"
INSTANCE_PROD="sprintable-prod"
DB_NAME="sprintable"
DB_USER="sprintable"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── API 활성화 ───────────────────────────────────────────────────────────────
enable_apis() {
    log "Enabling required GCP APIs..."
    gcloud services enable \
        sqladmin.googleapis.com \
        compute.googleapis.com \
        servicenetworking.googleapis.com \
        --project="${GCP_PROJECT}"
    log "APIs enabled."
}

# ─── Private IP VPC 피어링 설정 ───────────────────────────────────────────────
setup_private_ip() {
    log "Setting up Private Services Access for VPC '${VPC_NETWORK}'..."
    # IP range 이미 존재하면 skip
    if ! gcloud compute addresses describe google-managed-services-"${VPC_NETWORK}" \
            --global --project="${GCP_PROJECT}" &>/dev/null; then
        gcloud compute addresses create google-managed-services-"${VPC_NETWORK}" \
            --global \
            --purpose=VPC_PEERING \
            --prefix-length=16 \
            --network="${VPC_NETWORK}" \
            --project="${GCP_PROJECT}"
    fi
    # 피어링 이미 존재하면 skip
    gcloud services vpc-peerings connect \
        --service=servicenetworking.googleapis.com \
        --ranges=google-managed-services-"${VPC_NETWORK}" \
        --network="${VPC_NETWORK}" \
        --project="${GCP_PROJECT}" 2>/dev/null || log "VPC peering already exists, skipping."
    log "Private Services Access configured."
}

# ─── Dev 인스턴스 생성 ────────────────────────────────────────────────────────
create_dev() {
    log "Creating dev instance '${INSTANCE_DEV}' (db-f1-micro)..."
    gcloud sql instances create "${INSTANCE_DEV}" \
        --database-version=POSTGRES_15 \
        --tier=db-f1-micro \
        --region="${GCP_REGION}" \
        --network="${VPC_NETWORK}" \
        --no-assign-ip \
        --enable-google-private-path \
        --backup-start-time=03:00 \
        --retained-backups-count=7 \
        --storage-size=10 \
        --storage-type=SSD \
        --project="${GCP_PROJECT}"

    gcloud sql databases create "${DB_NAME}" \
        --instance="${INSTANCE_DEV}" --project="${GCP_PROJECT}"

    gcloud sql users create "${DB_USER}" \
        --instance="${INSTANCE_DEV}" \
        --password="$(openssl rand -base64 24)" \
        --project="${GCP_PROJECT}"

    log "Dev instance ready: ${INSTANCE_DEV}"
    log "Connection: ${GCP_PROJECT}:${GCP_REGION}:${INSTANCE_DEV}"
}

# ─── Prod 인스턴스 생성 ───────────────────────────────────────────────────────
create_prod() {
    log "Creating prod instance '${INSTANCE_PROD}' (db-custom-2-7680)..."
    gcloud sql instances create "${INSTANCE_PROD}" \
        --database-version=POSTGRES_15 \
        --tier=db-custom-2-7680 \
        --region="${GCP_REGION}" \
        --network="${VPC_NETWORK}" \
        --no-assign-ip \
        --enable-google-private-path \
        --backup-start-time=03:00 \
        --retained-backups-count=7 \
        --enable-point-in-time-recovery \
        --retained-transaction-log-days=7 \
        --storage-size=50 \
        --storage-type=SSD \
        --storage-auto-increase \
        --project="${GCP_PROJECT}"

    gcloud sql databases create "${DB_NAME}" \
        --instance="${INSTANCE_PROD}" --project="${GCP_PROJECT}"

    gcloud sql users create "${DB_USER}" \
        --instance="${INSTANCE_PROD}" \
        --password="$(openssl rand -base64 24)" \
        --project="${GCP_PROJECT}"

    log "Prod instance ready: ${INSTANCE_PROD}"
    log "Connection: ${GCP_PROJECT}:${GCP_REGION}:${INSTANCE_PROD}"
}

# ─── Cloud SQL Auth Proxy 설치 안내 ───────────────────────────────────────────
print_proxy_instructions() {
    cat <<'PROXY'

=== Cloud SQL Auth Proxy 설정 ===

1. Proxy 다운로드 (macOS):
   curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.15.2/cloud-sql-proxy.darwin.arm64
   chmod +x cloud-sql-proxy

2. Dev 인스턴스 연결:
   ./cloud-sql-proxy sprintable-494803:asia-northeast3:sprintable-dev --port 5433 &

3. FastAPI .env 설정:
   DATABASE_URL=postgresql+asyncpg://sprintable:PASSWORD@127.0.0.1:5433/sprintable

4. Alembic 마이그레이션 적용:
   alembic upgrade head

5. 연결 검증:
   curl http://localhost:8000/api/v2/health
PROXY
}

# ─── Main ─────────────────────────────────────────────────────────────────────
enable_apis
setup_private_ip

case "${TARGET}" in
    dev)  create_dev ;;
    prod) create_prod ;;
    both) create_dev; create_prod ;;
    *) echo "Usage: $0 [dev|prod|both]"; exit 1 ;;
esac

print_proxy_instructions
log "=== Provisioning complete ==="
