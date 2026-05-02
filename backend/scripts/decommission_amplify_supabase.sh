#!/usr/bin/env bash
# D-S9: Amplify / Supabase 해제 절차서
#
# ⚠️  실행 전제: Cloud Run 안정 운영 1주 이상 (2026-05-08 이후)
# ⚠️  이 스크립트는 interactive 확인 절차 포함 — 자동 실행 금지
#
# 사전 조건:
#   1. verify_gcp_migration.sh 전 항목 PASS
#   2. Cloud Run prod 7일 연속 오류율 < 0.1%
#   3. 팀 전원 동의 + PO 최종 승인
#
# 실행 순서:
#   Phase 1: Amplify 앱 삭제
#   Phase 2: Supabase 프로젝트 일시중지 → 30일 후 영구 삭제

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
SUPABASE_REF="${SUPABASE_REF:-hcweddmbfyfjgbqcondh}"
AMPLIFY_APP_ID="${AMPLIFY_APP_ID:-d16hmos6x9fcsc}"  # landing page app

log()  { echo "[$(date '+%H:%M:%S')] $*" >&2; }
confirm() {
  local msg="$1"
  read -r -p "$(echo -e "\n⚠️  $msg\n계속하려면 'yes' 입력: ")" answer
  [[ "$answer" == "yes" ]] || { log "취소됨."; exit 0; }
}

# ─── 사전 검증 ────────────────────────────────────────────────────────────────
preflight() {
  log "=== 사전 검증 ==="

  # Cloud Run 서비스 상태 확인
  log "Cloud Run 서비스 상태 확인..."
  gcloud run services describe sprintable-frontend-prod \
    --region=asia-northeast3 --project="$GCP_PROJECT" \
    --format="value(status.conditions[0].status)" 2>/dev/null \
    | grep -q "True" && log "✅ frontend-prod: Running" || log "❌ frontend-prod: 확인 필요"

  gcloud run services describe sprintable-backend-prod \
    --region=asia-northeast3 --project="$GCP_PROJECT" \
    --format="value(status.conditions[0].status)" 2>/dev/null \
    | grep -q "True" && log "✅ backend-prod: Running" || log "❌ backend-prod: 확인 필요"

  # verify smoke test
  log "smoke test 실행 중..."
  if bash "$(dirname "$0")/verify_gcp_migration.sh"; then
    log "✅ smoke test PASS"
  else
    log "❌ smoke test FAIL — 해제 중단"
    exit 1
  fi
}

# ─── Phase 1: Amplify 앱 삭제 ────────────────────────────────────────────────
decommission_amplify() {
  log ""
  log "=== Phase 1: Amplify 앱 삭제 ==="
  log "대상 App ID: $AMPLIFY_APP_ID (sprintable-landing)"
  log "현재 app.sprintable.ai는 Cloud Run 도메인 매핑으로 서빙 중"
  log "Amplify landing 앱만 해제 (saas 레포 아카이브 완료)"

  confirm "Amplify landing 앱($AMPLIFY_APP_ID) 삭제 진행"

  # Amplify 앱 삭제 (AWS CLI 필요)
  if command -v aws &>/dev/null; then
    log "Amplify 앱 삭제..."
    aws amplify delete-app --app-id "$AMPLIFY_APP_ID" \
      && log "✅ Amplify 앱 삭제 완료" \
      || log "⚠️  AWS CLI 오류 — Amplify Console에서 수동 삭제 필요"
  else
    log "⚠️  AWS CLI 미설치 — 수동 삭제 필요:"
    log "    https://console.aws.amazon.com/amplify → App: $AMPLIFY_APP_ID → Actions → Delete app"
  fi
}

# ─── Phase 2: Supabase 일시중지 ──────────────────────────────────────────────
decommission_supabase() {
  log ""
  log "=== Phase 2: Supabase 프로젝트 일시중지 ==="
  log "Supabase ref: $SUPABASE_REF"
  log "주의: 데이터는 migrate_supabase_to_cloud_sql.sh로 Cloud SQL에 이미 백업됨"
  log "일시중지 후 30일간 복구 가능. 이후 영구 삭제."

  confirm "Supabase 프로젝트($SUPABASE_REF) 일시중지 진행 (데이터 보존됨)"

  # Supabase Management API로 일시중지
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    log "Supabase 프로젝트 일시중지..."
    response=$(curl -s -X POST \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      "https://api.supabase.com/v1/projects/$SUPABASE_REF/pause")
    log "응답: $response"
  else
    log "⚠️  SUPABASE_ACCESS_TOKEN 미설정 — 수동 처리 필요:"
    log "    https://app.supabase.com/project/$SUPABASE_REF/settings/general"
    log "    → Pause project"
  fi

  log ""
  log "⚠️  영구 삭제는 일시중지 후 30일 이후 (2026-06-08 이후) 별도 진행"
}

# ─── 실행 ────────────────────────────────────────────────────────────────────
main() {
  local phase="${1:-all}"

  log "=== D-S9: Amplify/Supabase 해제 절차 ==="
  log "실행 시각: $(date)"
  log "⚠️  이 스크립트는 2026-05-08 이후에만 실행 바라는"
  log ""

  confirm "해제 절차를 시작"

  preflight

  case "$phase" in
    amplify) decommission_amplify ;;
    supabase) decommission_supabase ;;
    all)
      decommission_amplify
      decommission_supabase
      ;;
    *)
      echo "사용법: $0 [amplify|supabase|all]" >&2
      exit 1
      ;;
  esac

  log ""
  log "=== 해제 절차 완료 ==="
  log "다음 단계: verify_gcp_migration.sh 재실행으로 정상 서빙 최종 확인"
}

main "$@"
