#!/usr/bin/env bash
# D-S8: Cloud Monitoring 대시보드 + 알럿 정책 설정 스크립트
#
# ─── 로그 필터 쿼리 참조 ─────────────────────────────────────────────────────
#
# Cloud Run 에러 로그:
#   resource.type="cloud_run_revision"
#   resource.labels.service_name=~"sprintable-"
#   severity>=ERROR
#
# FastAPI 5xx 요청:
#   resource.type="cloud_run_revision"
#   resource.labels.service_name=~"sprintable-backend"
#   httpRequest.status>=500
#
# Cloud SQL 슬로우 쿼리:
#   resource.type="cloudsql_database"
#   resource.labels.database_id=~"sprintable-494803:sprintable-"
#   log_name=~"postgres.log"
#   textPayload=~"duration:"
#
# 사용법:
#   bash backend/scripts/setup_monitoring.sh [dashboard|alerts|channel|all]
#
# 환경변수:
#   GCP_PROJECT          (기본: sprintable-494803)
#   ALERT_EMAIL          알럿 수신 이메일 (선택)
#   DISCORD_WEBHOOK_URL  Discord 웹훅 URL (선택)
#   ALERT_CHANNEL_IDS    이미 있는 알림 채널 리소스 이름(공백 구분 · projects/…/notificationChannels/…) — 주면 `alerts` 는 새 채널을 만들지 않고 이걸 쓴다
#                        (story 4694 · PO: 새 채널 0). 비면 예전처럼 ALERT_EMAIL · DISCORD_WEBHOOK_URL 로 채널을 만든다.
#
# `alerts` 는 이미 같은 displayName 의 정책이 있으면 그 정책을 건너뛴다(story 4694) — 파일에 정책이 하나 늘 때마다 다시 돌려도 있던 것이 복제되지 않는다.

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
ALERT_CHANNEL_IDS="${ALERT_CHANNEL_IDS:-}"
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITORING_DIR="${SCRIPT_DIR}/../monitoring"
CMD="${1:-all}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

# ─── API 활성화 ───────────────────────────────────────────────────────────────
enable_apis() {
    log "Enabling Monitoring API..."
    gcloud services enable monitoring.googleapis.com --project="${GCP_PROJECT}"
}

# ─── 대시보드 생성 ────────────────────────────────────────────────────────────
create_dashboard() {
    log "Creating Cloud Monitoring dashboard..."
    gcloud monitoring dashboards create \
        --config-from-file="${MONITORING_DIR}/dashboard.json" \
        --project="${GCP_PROJECT}"
    log "Dashboard created."
}

# ─── 알림 채널 생성 ───────────────────────────────────────────────────────────
create_channels() {
    CHANNEL_IDS=()

    # story 4694: reuse channels that already exist (resource names) — create none
    if [[ -n "${ALERT_CHANNEL_IDS}" ]]; then
        log "Reusing existing notification channels (none created)"
        echo "${ALERT_CHANNEL_IDS}"
        return 0
    fi

    if [[ -n "${ALERT_EMAIL}" ]]; then
        log "Creating email notification channel: ${ALERT_EMAIL}"
        CHANNEL_ID=$(gcloud alpha monitoring channels create \
            --display-name="Sprintable Alert Email" \
            --type=email \
            --channel-labels="email_address=${ALERT_EMAIL}" \
            --project="${GCP_PROJECT}" \
            --format="value(name)")
        CHANNEL_IDS+=("${CHANNEL_ID}")
        log "Email channel: ${CHANNEL_ID}"
    fi

    if [[ -n "${DISCORD_WEBHOOK_URL}" ]]; then
        log "Creating Discord webhook channel..."
        CHANNEL_ID=$(gcloud alpha monitoring channels create \
            --display-name="Sprintable Discord Alert" \
            --type=webhooks \
            --channel-labels="url=${DISCORD_WEBHOOK_URL}" \
            --project="${GCP_PROJECT}" \
            --format="value(name)")
        CHANNEL_IDS+=("${CHANNEL_ID}")
        log "Discord channel: ${CHANNEL_ID}"
    fi

    echo "${CHANNEL_IDS[@]:-}"
}

# ─── 알럿 정책 생성 ───────────────────────────────────────────────────────────
create_alerts() {
    local channel_ids=("$@")
    local policies_file="${MONITORING_DIR}/alert_policies.json"
    # story 4694: policies that already exist (by displayName) are skipped, never created twice
    local existing
    existing=$(gcloud alpha monitoring policies list --project="${GCP_PROJECT}" --format="value(displayName)")

    log "Creating alert policies from ${policies_file}..."
    local count
    count=$(python3 -c "import json; data=json.load(open('${policies_file}')); print(len(data))")

    for i in $(seq 0 $((count - 1))); do
        local policy
        policy=$(python3 -c "
import json, sys
data = json.load(open('${policies_file}'))
p = data[${i}]
if ${#channel_ids[@]} > 0:
    p['notificationChannels'] = [c for c in '${channel_ids[*]:-}'.split() if c]
print(json.dumps(p))
")
        local name
        name=$(echo "${policy}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("displayName",""))')
        if printf '%s\n' "${existing}" | grep -Fxq -- "${name}"; then
            log "Alert policy already exists, skipped: ${name}"
            continue
        fi
        echo "${policy}" | gcloud alpha monitoring policies create \
            --policy-from-file=- \
            --project="${GCP_PROJECT}"
        log "Alert policy created: $(echo "${policy}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("displayName",""))')"
    done
}

# ─── Main ─────────────────────────────────────────────────────────────────────
enable_apis

case "${CMD}" in
    dashboard)
        create_dashboard
        ;;
    alerts)
        CHANNELS=($(create_channels))
        create_alerts "${CHANNELS[@]:-}"
        ;;
    channel)
        create_channels
        ;;
    all)
        create_dashboard
        CHANNELS=($(create_channels))
        create_alerts "${CHANNELS[@]:-}"
        ;;
    *) echo "Usage: $0 [dashboard|alerts|channel|all]"; exit 1 ;;
esac

log "=== Monitoring setup complete ==="
