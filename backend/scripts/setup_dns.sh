#!/usr/bin/env bash
# D-S6: DNS 전환 스크립트 — Amplify → Cloud Run
#
# ═══════════════════════════════════════════════════════════════════════════════
# DNS 전환 절차서 (Blue/Green)
# ═══════════════════════════════════════════════════════════════════════════════
#
# 사전 조건 (이 스크립트 실행 전 완료 필수):
#   ✅ D-S1: Cloud SQL dev/prod 인스턴스 생성 + Alembic 마이그레이션 적용
#   ✅ D-S2: Artifact Registry + Cloud Build 트리거 활성
#   ✅ D-S3: sprintable-frontend-prod Cloud Run 서비스 기동 + /api/health 200
#   ✅ D-S4: sprintable-backend-prod Cloud Run 서비스 기동 + /api/v2/health db:ok
#   ✅ D-S5: Secret Manager 시크릿 7건 정상 마운트 확인
#   ✅ 전체 Smoke Test PASS (로그인, 메모, 스프린트, 스탠드업)
#
# 전환 단계:
#   Phase 1. Cloud Run 도메인 매핑 생성 (트래픽 미전환)
#   Phase 2. DNS TXT 소유권 확인 (Google Search Console)
#   Phase 3. DNS A/CNAME 레코드 변경 (Route53 또는 도메인 등록사)
#   Phase 4. SSL 프로비저닝 대기 (최대 15분)
#   Phase 5. 검증 체크리스트 실행
#   Phase 6. (문제 시) Amplify 롤백 플랜 실행
#
# 롤백 플랜 (문제 발생 시):
#   1. DNS를 Amplify CNAME으로 즉시 복원
#   2. gcloud run domain-mappings delete로 도메인 매핑 제거
#   3. Cloud Run 서비스 장애 원인 조사 후 재시도
#
# ═══════════════════════════════════════════════════════════════════════════════
#
# 사용법:
#   bash backend/scripts/setup_dns.sh [map|verify|rollback]
#
# 환경변수:
#   GCP_PROJECT   (기본: sprintable-494803)
#   GCP_REGION    (기본: asia-northeast3)
#   DOMAIN_APP    (기본: app.sprintable.ai)
#   DOMAIN_API    (기본: api.sprintable.ai, 백엔드 도메인 - 선택)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
DOMAIN_APP="${DOMAIN_APP:-app.sprintable.ai}"
DOMAIN_API="${DOMAIN_API:-api.sprintable.ai}"
FRONTEND_SERVICE="sprintable-frontend-prod"
BACKEND_SERVICE="sprintable-backend-prod"
CMD="${1:-map}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── Phase 1+4: 도메인 매핑 생성 ─────────────────────────────────────────────
do_map() {
    log "=== Phase 1: Cloud Run 도메인 매핑 생성 ==="

    log "Mapping ${DOMAIN_APP} → ${FRONTEND_SERVICE}..."
    gcloud run domain-mappings create \
        --service="${FRONTEND_SERVICE}" \
        --domain="${DOMAIN_APP}" \
        --region="${GCP_REGION}" \
        --project="${GCP_PROJECT}"

    log "Mapping ${DOMAIN_API} → ${BACKEND_SERVICE} (optional)..."
    gcloud run domain-mappings create \
        --service="${BACKEND_SERVICE}" \
        --domain="${DOMAIN_API}" \
        --region="${GCP_REGION}" \
        --project="${GCP_PROJECT}" 2>/dev/null || log "API domain mapping skipped (optional)."

    log ""
    log "=== Phase 2: DNS 레코드 변경 안내 ==="
    log "아래 CNAME/A 레코드를 도메인 등록사(Route53 등)에 설정 바라는:"
    gcloud run domain-mappings describe \
        --domain="${DOMAIN_APP}" \
        --region="${GCP_REGION}" \
        --project="${GCP_PROJECT}" \
        --format="table(resourceRecords[].name, resourceRecords[].rrdata, resourceRecords[].type)" 2>/dev/null || true

    log ""
    log "DNS 전파 후 verify 실행: bash setup_dns.sh verify"
}

# ─── Phase 5: 검증 체크리스트 ─────────────────────────────────────────────────
do_verify() {
    log "=== Phase 5: Blue/Green 검증 체크리스트 ==="
    PASS=0; FAIL=0

    check() {
        local label="$1"; local cmd="$2"
        if eval "$cmd" &>/dev/null; then
            log "  ✅ ${label}"; ((PASS++)) || true
        else
            log "  ❌ ${label}"; ((FAIL++)) || true
        fi
    }

    FRONTEND_URL="https://${DOMAIN_APP}"
    BACKEND_URL=$(gcloud run services describe "${BACKEND_SERVICE}" \
        --region="${GCP_REGION}" --project="${GCP_PROJECT}" \
        --format="value(status.url)" 2>/dev/null || echo "")

    check "Frontend /api/health 200" \
        "curl -sf ${FRONTEND_URL}/api/health | grep -q ok"
    check "Backend /api/v2/health db:ok" \
        "curl -sf ${BACKEND_URL}/api/v2/health | grep -q 'db.*ok'"
    check "Frontend → Backend 프록시 /api/v2/health" \
        "curl -sf ${FRONTEND_URL}/api/v2/health | grep -q ok"
    check "SSL 인증서 유효" \
        "curl -sf --max-time 10 https://${DOMAIN_APP} -o /dev/null"
    check "app.sprintable.ai DNS 전파" \
        "dig +short ${DOMAIN_APP} | grep -q '.'"

    log ""
    log "결과: ${PASS} PASS / ${FAIL} FAIL"
    [[ ${FAIL} -eq 0 ]] && log "✅ 전환 완료 — Amplify 비활성화 가능" || log "❌ 문제 발견 — rollback 실행 권고"
    return ${FAIL}
}

# ─── Phase 6: 롤백 ───────────────────────────────────────────────────────────
do_rollback() {
    log "=== Phase 6: Amplify 롤백 ==="
    log "1. 도메인 매핑 제거 중..."
    gcloud run domain-mappings delete \
        --domain="${DOMAIN_APP}" \
        --region="${GCP_REGION}" \
        --project="${GCP_PROJECT}" --quiet 2>/dev/null || log "Mapping not found, skipping."
    log "2. DNS를 Amplify CNAME으로 즉시 복원 바라는:"
    log "   app.sprintable.ai → Amplify 배포 도메인 (AWS Console 확인)"
    log "롤백 완료."
}

case "${CMD}" in
    map)      do_map ;;
    verify)   do_verify ;;
    rollback) do_rollback ;;
    *) echo "Usage: $0 [map|verify|rollback]"; exit 1 ;;
esac
