#!/usr/bin/env bash
# story c4c72eb1(E-ARCH) PR-B: realtime-gateway 전용 외부 HTTP(S) LB 스택 프로비저닝.
#
# 설계 doc: gce-realtime-gateway-migration-design(d361193c-a53d-4a18-8d6d-8f31d0fd3774) ⓑ.
#
# ⚠️⚠️ 이 스크립트의 존재 이유 — doc이 가장 강조한 함정: GCLB backend-service 기본
# timeoutSec=30. SSE는 장수명 연결이므로 30초로 두면 Cloud Run 현재치(3600초)보다
# **더 나빠진다**(콜드스타트 제거하러 왔다가 SSE 수명을 30초로 깎는 퇴보). 아래
# --timeout=3600 이 이 스크립트에서 가장 중요한 한 줄이다 — 절대 빠뜨리지 말 것.
#
# 1회성 프로비저닝(멱등 — 이미 있으면 스킵) — deploy_realtime_gce.sh(MIG 배포)보다
# 먼저 실행돼야 한다(백엔드서비스가 MIG를 참조하므로 MIG가 먼저 있어야 add-backend 가능).
#
# 실행 순서: ① 방화벽(GCLB 헬스체크 프로브 대역 허용) → ② 헬스체크(/api/v2/ping)
#           → ③ 백엔드서비스(timeout=3600!) → ④ MIG를 백엔드로 부착
#           → ⑤ URL맵 → ⑥ 타겟프록시 → ⑦ 전역 고정IP → ⑧ 포워딩규칙
#
# 사용법: bash backend/scripts/provision_realtime_gclb.sh dev
# 환경변수: GCP_PROJECT, GCP_REGION, DRY_RUN=1(gcloud 호출 없이 계획만 출력)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
ENV="${1:-${ENV:-dev}}"
DRY_RUN="${DRY_RUN:-0}"

case "${ENV}" in
    dev)
        MIG_NAME="sprintable-realtime-gateway-dev"
        FW_RULE_NAME="allow-gclb-health-check-realtime-dev"
        HEALTH_CHECK_NAME="realtime-gateway-dev-health-check"
        BACKEND_SERVICE_NAME="realtime-gateway-dev-backend"
        URL_MAP_NAME="realtime-gateway-dev-urlmap"
        HTTP_PROXY_NAME="realtime-gateway-dev-http-proxy"
        IP_NAME="realtime-gateway-dev-ip"
        FORWARDING_RULE_NAME="realtime-gateway-dev-fwd-rule"
        NAMED_PORT="http:8000"
        ;;
    *)
        echo "Usage: $0 [dev] — prod는 realtime 서비스 자체가 없음(설계 doc 스코프 확定)" >&2
        exit 1 ;;
esac

# GCLB backend-service의 최대 허용 timeout이 3600(1시간)이라 SSE 무제한 장수명은 원천적으로
# 안 되고, Cloud Run 현재치(3600s)와 동일 상한으로 맞추는 것이 이번 이전의 현실적 목표다
# (더 늘릴 수단 자체가 GCLB엔 없음 — 이 값이 사실상 이 스택의 최댓값).
BACKEND_TIMEOUT_SEC=3600
# 드레이닝 — 롤링업데이트/인스턴스 교체 시 기존 연결을 끊지 않고 흘려보낼 유예 시간.
# 설계 doc ⓔ "재배포가 SSE 연결을 급단절하지 않는다"(게이트②)를 만족시키는 핵심 파라미터.
DRAINING_TIMEOUT_SEC=120

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*" >&2; }

if [ "${DRY_RUN}" = "1" ]; then
    cat <<EOF
ENV=${ENV}
FW_RULE_NAME=${FW_RULE_NAME}
HEALTH_CHECK_NAME=${HEALTH_CHECK_NAME} (target: /api/v2/ping, DB 미조회 — PR-A 확認됨)
BACKEND_SERVICE_NAME=${BACKEND_SERVICE_NAME} (timeout=${BACKEND_TIMEOUT_SEC}s, draining=${DRAINING_TIMEOUT_SEC}s)
MIG_NAME=${MIG_NAME}
URL_MAP_NAME=${URL_MAP_NAME}
FORWARDING_RULE_NAME=${FORWARDING_RULE_NAME}
EOF
    exit 0
fi

# ── ① 방화벽 — GCLB 헬스체크 프로브는 이 두 대역에서만 나온다(GCP 고정, 전세계 공통).
#    현재 라이브 방화벽 규칙 전량 확認(2026-07-22 실측) — 이 대역 허용 규칙이 없었다. ──
if ! gcloud compute firewall-rules describe "${FW_RULE_NAME}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Creating firewall rule ${FW_RULE_NAME} (GCLB health-check probe ranges → tcp:8000)"
    gcloud compute firewall-rules create "${FW_RULE_NAME}" \
        --project="${GCP_PROJECT}" \
        --network=default \
        --direction=INGRESS \
        --action=ALLOW \
        --rules=tcp:8000 \
        --source-ranges=130.211.0.0/22,35.191.0.0/16 \
        --target-tags=realtime-gateway
else
    log "Firewall rule ${FW_RULE_NAME} already exists — skip"
fi

# ── ② 헬스체크 — /api/v2/ping (DB 안 타는 엔드포인트, PR-A에서 이미 구현·배포됨).
#    /api/v2/health 아님 — 그건 DB 조회가 걸려 있어 콜드/DB부하 시 오탐 우려(설계 doc 명시). ──
if ! gcloud compute health-checks describe "${HEALTH_CHECK_NAME}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Creating health check ${HEALTH_CHECK_NAME} → /api/v2/ping"
    gcloud compute health-checks create http "${HEALTH_CHECK_NAME}" \
        --project="${GCP_PROJECT}" \
        --port=8000 \
        --request-path=/api/v2/ping \
        --check-interval=10s \
        --timeout=5s \
        --healthy-threshold=2 \
        --unhealthy-threshold=3
else
    log "Health check ${HEALTH_CHECK_NAME} already exists — skip"
fi

# ── ③ 백엔드서비스 — ⚠️timeout=3600 명시(기본 30 그대로 두면 Cloud Run보다 퇴보). ──
if ! gcloud compute backend-services describe "${BACKEND_SERVICE_NAME}" --global --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Creating backend service ${BACKEND_SERVICE_NAME} (timeout=${BACKEND_TIMEOUT_SEC}s ⚠️SSE 장수명 필수값)"
    gcloud compute backend-services create "${BACKEND_SERVICE_NAME}" \
        --project="${GCP_PROJECT}" \
        --global \
        --protocol=HTTP \
        --port-name=http \
        --health-checks="${HEALTH_CHECK_NAME}" \
        --timeout="${BACKEND_TIMEOUT_SEC}" \
        --connection-draining-timeout="${DRAINING_TIMEOUT_SEC}"
else
    log "Backend service ${BACKEND_SERVICE_NAME} already exists — verifying timeout is still ${BACKEND_TIMEOUT_SEC}s"
    _live_timeout="$(gcloud compute backend-services describe "${BACKEND_SERVICE_NAME}" --global --project="${GCP_PROJECT}" --format='value(timeoutSec)')"
    if [ "${_live_timeout}" != "${BACKEND_TIMEOUT_SEC}" ]; then
        log "⚠️ drift detected — live timeoutSec=${_live_timeout}, expected=${BACKEND_TIMEOUT_SEC}. Correcting."
        gcloud compute backend-services update "${BACKEND_SERVICE_NAME}" \
            --project="${GCP_PROJECT}" --global --timeout="${BACKEND_TIMEOUT_SEC}"
    fi
fi

# ── ④ 명명 포트 부여 + MIG를 백엔드로 부착 (MIG가 먼저 존재해야 함 — deploy_realtime_gce.sh 선행). ──
gcloud compute instance-groups managed set-named-ports "${MIG_NAME}" \
    --project="${GCP_PROJECT}" --region="${GCP_REGION}" --named-ports="${NAMED_PORT}"

if ! gcloud compute backend-services describe "${BACKEND_SERVICE_NAME}" --global --project="${GCP_PROJECT}" \
        --format='value(backends[].group)' | grep -q "${MIG_NAME}"; then
    log "Attaching MIG ${MIG_NAME} to backend service"
    gcloud compute backend-services add-backend "${BACKEND_SERVICE_NAME}" \
        --project="${GCP_PROJECT}" \
        --global \
        --instance-group="${MIG_NAME}" \
        --instance-group-region="${GCP_REGION}" \
        --balancing-mode=UTILIZATION \
        --max-utilization=0.8
else
    log "MIG ${MIG_NAME} already attached to backend service — skip"
fi

# ── ⑤~⑧ URL맵 → HTTP 프록시 → 전역 고정IP → 포워딩규칙 ──
# ⚠️dev 검증 단계는 HTTP만(HTTPS/인증서는 프론트 도메인 CF 뒤에 실제로 붙일 때 별건 — 설계
# doc 스코프에 SSL은 없음, 6개 게이트가 먼저 통과해야 그 다음 단계로 넘어가는 순서).
if ! gcloud compute url-maps describe "${URL_MAP_NAME}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Creating URL map ${URL_MAP_NAME}"
    gcloud compute url-maps create "${URL_MAP_NAME}" \
        --project="${GCP_PROJECT}" \
        --default-service="${BACKEND_SERVICE_NAME}"
else
    log "URL map ${URL_MAP_NAME} already exists — skip"
fi

if ! gcloud compute target-http-proxies describe "${HTTP_PROXY_NAME}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Creating target HTTP proxy ${HTTP_PROXY_NAME}"
    gcloud compute target-http-proxies create "${HTTP_PROXY_NAME}" \
        --project="${GCP_PROJECT}" \
        --url-map="${URL_MAP_NAME}"
else
    log "Target HTTP proxy ${HTTP_PROXY_NAME} already exists — skip"
fi

if ! gcloud compute addresses describe "${IP_NAME}" --global --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Reserving global static IP ${IP_NAME}"
    gcloud compute addresses create "${IP_NAME}" --project="${GCP_PROJECT}" --global
else
    log "Global static IP ${IP_NAME} already exists — skip"
fi

if ! gcloud compute forwarding-rules describe "${FORWARDING_RULE_NAME}" --global --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Creating global forwarding rule ${FORWARDING_RULE_NAME}"
    gcloud compute forwarding-rules create "${FORWARDING_RULE_NAME}" \
        --project="${GCP_PROJECT}" \
        --global \
        --target-http-proxy="${HTTP_PROXY_NAME}" \
        --address="${IP_NAME}" \
        --ports=80
else
    log "Forwarding rule ${FORWARDING_RULE_NAME} already exists — skip"
fi

_gclb_ip="$(gcloud compute addresses describe "${IP_NAME}" --global --project="${GCP_PROJECT}" --format='value(address)')"
log "=== GCLB stack ready ==="
log "Global IP: ${_gclb_ip} (HTTP:80 — 검증용, 트래픽 0%로 이 시점 기존 Cloud Run 서비스는 무영향)"
log "Backend service timeoutSec: ${BACKEND_TIMEOUT_SEC} (⚠️재확認 완료 — 함정 회피됨)"
log "다음: curl로 이 IP에 직접 SSE 연결 열어 게이트①(60분 생존) 실측 시작"
