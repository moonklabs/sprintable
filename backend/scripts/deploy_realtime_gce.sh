#!/usr/bin/env bash
# story c4c72eb1(E-ARCH) PR-B: realtime-gateway GCE 인스턴스 템플릿 + MIG 배포.
#
# 설계 doc: gce-realtime-gateway-migration-design(d361193c-a53d-4a18-8d6d-8f31d0fd3774) ⓐⓑⓒ.
# 콜드스타트 원천 제거가 목적 — MIG target size 고정(오토스케일 없음), 상시 2노드.
#
# 사전 조건:
#   - VPC/서브넷(default, asia-northeast3) 이미 존재(gcloud 실측 완료, 2026-07-22)
#   - RUNTIME_SA(cloudrun-runtime-dev)에 cloudsql.client·secretmanager.secretAccessor 이미 부여
#     (Cloud Run 서비스와 동일 SA 재사용 — 신규 SA 불요, 기존 정책 신뢰)
#
# ⛔story #2142(2026-07-23) 정정 — GCLB 스택(헬스체크·백엔드서비스·URL맵·포워딩규칙·방화벽)
# 은 provision_realtime_gclb.sh가 만들지만, **이 스크립트(MIG 생성)가 먼저 돌아야** 한다
# (provision의 add-backend 스텝이 실재하는 MIG를 요구 — 예전엔 순서가 반대로 적혀 있었다).
#
# 사용법:
#   COMMIT_SHA=abc1234 bash backend/scripts/deploy_realtime_gce.sh dev
#
# 환경변수:
#   GCP_PROJECT   (기본: sprintable-494803)
#   GCP_REGION    (기본: asia-northeast3)
#   COMMIT_SHA    [필수, DRY_RUN=1이면 불요]
#   DRY_RUN       1이면 gcloud 호출 없이 resolved config만 stdout 출력(검증용)
#
# 동작: 새 인스턴스 템플릿 버전(커밋 SHA로 명명) 생성 → MIG가 없으면 신규 생성,
#       있으면 rolling-update(--max-unavailable=0 --max-surge=1, 새 인스턴스 먼저 띄우고
#       헬스체크 통과 後 옮기는 무중단 갱신 — SSE 장수명 연결 보존이 목적, story #2445 후속)로 갱신.
#       기존 sprintable-realtime-dev(Cloud Run)는 건드리지 않는다 — 병행 배포, 트래픽
#       0%부터 검증 후 GCLB로 전환(롤백 경로 보존, ⓔ).
#
# ⚠️이미지 분리 없음(설계 doc 스코프 확定) — backend와 완전 동일 이미지를 그대로 쓴다.
# story #2142(2026-07-23, 선생님 GCE prod 전환 승인): prod 분기 신설 — 이 스크립트가 prod를
# 받아들이게 하는 것만이 이 변경의 스코프. 실 리소스 생성(gcloud 실행)은 오르테가 DRY_RUN
# 검수 통과 後 별도 승인 시점(이 PR에서 안 함).

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
GCP_REGION="${GCP_REGION:-asia-northeast3}"
AR_REPO="${AR_REPO:-sprintable}"
ENV="${1:-${ENV:-dev}}"
DRY_RUN="${DRY_RUN:-0}"
if [ "${DRY_RUN}" = "1" ]; then
    COMMIT_SHA="${COMMIT_SHA:-dryrun}"
else
    COMMIT_SHA="${COMMIT_SHA:?COMMIT_SHA is required}"
fi

case "${ENV}" in
    dev)
        MIG_NAME="sprintable-realtime-gateway-dev"
        TEMPLATE_PREFIX="sprintable-realtime-gateway-dev"
        # story #2110(E-GCE-RT S1): 2-zone → 3-zone(a/b/c) 확장. HA는 zone 분산에서 나오므로
        # 상시 노드 수 = zone 수(각 zone 1노드·even 분산·오토스케일 없음). 한 zone 장애 시
        # 나머지 2 zone이 계속 SSE를 흘리게 하는 것이 이 확장의 목적(게이트 S5 HA 무손실).
        TARGET_SIZE=3
        ZONES="${GCP_REGION}-a,${GCP_REGION}-b,${GCP_REGION}-c"
        # 재생성 시 detach 대상(provision_realtime_gclb.sh의 BACKEND_SERVICE_NAME과 동일해야 함).
        GCLB_BACKEND_SERVICE="realtime-gateway-dev-backend"
        MACHINE_TYPE="e2-small"
        SQL_INSTANCE_CONN="${GCP_PROJECT}:${GCP_REGION}:sprintable-dev"
        RUNTIME_SA="cloudrun-runtime-dev@${GCP_PROJECT}.iam.gserviceaccount.com"
        DB_SECRET_NAME="DATABASE_URL_DEV"
        CRON_SECRET_NAME="cron-secret"
        GITHUB_SECRET_SUFFIX="DEV"
        GITHUB_APP_SECRET_ENV="dev"  # story #2142 발견: github-app-*-dev Secret Manager ID의 소문자 접미(위 GITHUB_SECRET_SUFFIX와 별개 컨벤션 — 이 시크릿 3종만 하이픈+소문자)
        # story #2142(2026-07-23, 오르테가 DRY_RUN 검수 적발) — GITHUB_APP_ID/CLIENT_ID/SLUG가
        # 여태 PLAIN_ENV_SPEC에 env 분기 밖 리터럴로 박혀 있었다(DATABASE_URL_DEV·MCP_PUBLIC_URL과
        # 같은 클래스). dev는 라이브 실측 그대로 유지.
        GITHUB_APP_ID="4120278"
        GITHUB_APP_CLIENT_ID="Iv23liRkrmyqoCZIlrgh"
        GITHUB_APP_SLUG="sprintable-dev"
        # story #2142(2026-07-23, 오르테가 DRY_RUN 검수 3번째 적발, 같은 클래스) — L2_TRIGGER_*·
        # GATE_CONFIG_ENFORCE_*·DECISION_GATE_LINE_*는 backend-dev에만 실재하는 기능(라이브
        # 대조: backend-prod엔 이 키들 자체가 없음 = 그 기능이 prod에서 한 번도 켜진 적 없음).
        # 이 GCE 노드는 backend와 동일 이미지를 돌리므로 플래그가 켜지면 그 lifespan 워커가
        # 그대로 뜬다 — "SSE 전용이라 안 탈 것"이라는 추론에 기대지 않고 backend-prod를
        # 그대로 미러링한다(오르테가 판정: 코드 경로를 추론해 안전을 주장하는 대신 prod와
        # 같게 만드는 것이 규칙). dev는 이 3그룹을 그대로 킨다.
        L2_TRIGGER_ENABLED_LINE=true
        GATE_CONFIG_ENFORCE_ENABLED_LINE=true
        DECISION_GATE_LINE_ENABLED_LINE=true
        # H1_MERGE_GATE는 backend-prod에도 실재하지만 허용목록 값이 dev(단일 org)와 다르다
        # (prod: 2-org 콤마리스트, describe 대조 확認) — ENABLED/ADVISORY는 dev·prod 동일(true).
        H1_MERGE_GATE_ORG_ALLOWLIST_VALUE="54bac162-5c0d-49fa-8e49-85977063a091"
        APP_URL="https://dev-app.sprintable.ai"
        # story #2142(오르테가 라이브 실측 2026-07-23): sprintable-backend-dev/-prod MCP_PUBLIC_URL
        # 라이브 값 그대로 — 이것도 DATABASE_URL_DEV와 같은 클래스(env 분기 밖 리터럴)였던 걸 정정.
        MCP_PUBLIC_URL="https://dev-mcp.sprintable.ai/mcp"
        # ⚠️FASTAPI_URL — 라이브 실측 그대로(cloudbuild.yaml routine dispatch-realtime과 동일값,
        # 2026-07-22 gcloud describe로 확認). 이 값은 이 서비스 "자기 자신"을 가리키는 self-URL로
        # 쓰이는 것으로 보이며(agent onboarding SPRINTABLE_API_URL 등), GCE 이전 후 이 값이
        # 최종적으로 GCLB 프론트 URL로 바뀌어야 하는지는 provision_realtime_gclb.sh 완료 후
        # 별도 재확認 필요(TODO — 현재는 라이브 값 그대로 이관해 드리프트 0으로 시작).
        FASTAPI_URL="https://sprintable-realtime-dev-787818285179.asia-northeast3.run.app"
        ;;
    prod)
        # story #2142(2026-07-23, 선생님 GCE prod 전환 승인): dev와 동일 구조, 리소스명·Cloud
        # SQL·시크릿 접미만 prod로 전환(deploy_backend.sh의 dev/prod 분기와 동일 컨벤션 재사용).
        MIG_NAME="sprintable-realtime-gateway-prod"
        TEMPLATE_PREFIX="sprintable-realtime-gateway-prod"
        TARGET_SIZE=3
        ZONES="${GCP_REGION}-a,${GCP_REGION}-b,${GCP_REGION}-c"
        GCLB_BACKEND_SERVICE="realtime-gateway-prod-backend"
        MACHINE_TYPE="e2-small"
        SQL_INSTANCE_CONN="${GCP_PROJECT}:${GCP_REGION}:sprintable-prod"
        RUNTIME_SA="cloudrun-runtime-prod@${GCP_PROJECT}.iam.gserviceaccount.com"
        DB_SECRET_NAME="DATABASE_URL_PROD"
        # ⛔story #2142(2026-07-23, 오르테가 gcloud 실측+정정) — CRON_SECRET_PROD가 실재하고
        # backend-prod Cloud Run이 실제로 그걸 쓴다(describe 대조 확認). "cron-secret"(dev가
        # 쓰는 이름)을 prod에 그대로 쓰면 존재는 해서 fetch는 성공하지만 backend-prod가 실제
        # 쓰는 값과 다른 값이 실린다 — #2135(env 이름 불일치)와 같은 클래스, 여기선 시크릿
        # 자체가 존재해 조용히 다른 값이 실리는 형태라 더 발견하기 어려움.
        CRON_SECRET_NAME="CRON_SECRET_PROD"
        # ⛔story #2142(2026-07-23, 오르테가 gcloud 실측+정정) — prod 분기인데 DEV 접미를
        # 쓰는 게 **버그로 보일 자리라 명시적으로 남긴다: 이건 의도다.**
        # backend-prod(Cloud Run)가 라이브로 GITHUB_CLIENT_ID_DEV/GITHUB_CLIENT_SECRET_DEV를
        # 물고 있다(2026-07-23 실측, describe 대조 확認 — GITHUB_CLIENT_ID_PROD/_SECRET_PROD는
        # Secret Manager에 아예 없음). GCE도 동일한 것을 물게 맞춘 것뿐이다.
        # ⚠️prod가 dev OAuth 앱(유저 로그인용, config.py:209 — GitHub App 봇 시크릿과는 완전히
        # 별개 물건, 그건 이미 -prod 접미로 정상 배선돼 있음)을 쓰는 것 자체가 적절한지는 별건
        # (오르테가가 별도 스토리로 관측 사실만 세워둠 — 의도/누락 판단은 선생님 확認 後).
        # ⛔"prod인데 왜 DEV?" 하고 이 줄을 고치면 GCE만 다른 OAuth 앱을 물어 로그인이
        # backend-prod와 갈라진다 — 그 별건 스토리가 먼저 판단을 내리기 전엔 건드리지 말 것.
        GITHUB_SECRET_SUFFIX="DEV"
        GITHUB_APP_SECRET_ENV="prod"
        # ⛔story #2142(2026-07-23, 오르테가 DRY_RUN 검수 적발 — "repo에 없다"≠"존재하지 않는다",
        # 값은 레포가 아니라 Cloud Run env에 살아 있었다) — GITHUB_APP_ID/CLIENT_ID/SLUG가
        # PLAIN_ENV_SPEC에 dev App 리터럴(4120278/Iv23liRkrmyqoCZIlrgh/sprintable-dev)로 박혀
        # 있어, 이 스크립트가 prod용 시크릿(github-app-*-prod, GITHUB_APP_SECRET_ENV=prod)과
        # dev App의 ID/CLIENT_ID를 섞은 채 배포할 뻔했다 — 어느 쪽 App으로도 인증이 안 되는
        # 조합. backend-prod 라이브 실측(gcloud describe)으로 교정.
        GITHUB_APP_ID="4244849"
        GITHUB_APP_CLIENT_ID="Iv23liGdo7u9vkHjRKS0"
        GITHUB_APP_SLUG="sprintable-prod"
        # ⛔story #2142(2026-07-23, 오르테가 DRY_RUN 검수 3번째 적발) — L2_TRIGGER_ENABLED=true·
        # GATE_CONFIG_ENFORCE_ENABLED=true·DECISION_GATE_LINE_ENABLED=true가 env 분기 밖
        # 리터럴로 박혀 있어, prod가 한 번도 가져본 적 없는 기능 3종이 dev의 org 허용목록을
        # 달고 그대로 켜질 뻔했다(backend-prod에 이 키들 자체가 없음, describe 대조 확認).
        # 이 GCE 노드가 backend와 동일 이미지라 플래그가 켜지면 lifespan 워커가 실제로 뜬다 —
        # "SSE 전용 서비스니 그 코드 경로를 안 탈 것"이라는 추론에 기대지 않는다(오르테가
        # 판정 — 그 추론이 틀리는 날 prod에서 드러난다). prod는 이 3그룹을 아예 붙이지 않는다.
        L2_TRIGGER_ENABLED_LINE=false
        GATE_CONFIG_ENFORCE_ENABLED_LINE=false
        DECISION_GATE_LINE_ENABLED_LINE=false
        # H1_MERGE_GATE_ENABLED/_ADVISORY는 backend-prod에도 true/true로 실재(dev와 동일) —
        # 다만 허용목록은 dev 단일 org가 아니라 prod의 실제 2-org 값을 그대로 옮긴다.
        H1_MERGE_GATE_ORG_ALLOWLIST_VALUE="54bac162-5c0d-49fa-8e49-85977063a091,588186bf-1558-48a3-b3a0-fe3759a925fc"
        APP_URL="https://app.sprintable.ai"
        # story #2142(오르테가 라이브 실측 2026-07-23, gcloud env 직접 대조): 추측 아니라
        # sprintable-backend-prod의 실측 라이브 값.
        MCP_PUBLIC_URL="https://mcp.sprintable.ai/mcp"
        # ⚠️TODO(실 배포 前 재확認 필요, 오르테가 DRY_RUN 검수 시 판단 요청) — dev는 기존
        # Cloud Run realtime-dev의 라이브 실측 URL을 그대로 이관했으나(cloudbuild.yaml
        # deploy-realtime 스텝이 실제로 존재·서빙 중이었음), prod는 Cloud Run realtime 서비스
        # 자체가 존재한 적이 없어 이관할 라이브 값이 없다. backend-prod Cloud Run URL을
        # 잠정값으로 둔다 — provision_realtime_gclb.sh 완료 후 GCLB 프론트 IP/도메인으로
        # 바꿔야 하는지는 별도 재확認 대상(이 PR은 스크립트가 prod를 받게만 하는 스코프).
        FASTAPI_URL="https://sprintable-backend-prod-787818285179.asia-northeast3.run.app"
        ;;
    *)
        echo "Usage: $0 [dev|prod]" >&2
        exit 1 ;;
esac

_AR_HOST="${GCP_REGION}-docker.pkg.dev"
IMAGE="${_AR_HOST}/${GCP_PROJECT}/${AR_REPO}/backend:${COMMIT_SHA}"
# GCE 리소스 이름 63자 제한(regex '[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?') — 풀 SHA(40자)를 그대로
# 붙이면 넘친다. 이미지 태그(IMAGE)는 풀 SHA 그대로 쓰고, 리소스 이름만 앞 8자로 축약.
SHORT_SHA="${COMMIT_SHA:0:8}"
# TEMPLATE_NAME은 startup-script 생성 후 확定한다 — 템플릿 내용 = 이미지 SHA + startup-script.
# 같은 이미지 SHA라도 startup-script(마운트 경로·env 등)가 바뀌면 다른 템플릿이어야 하므로
# 이름에 startup-script 내용 해시를 함께 넣는다(SHA만으론 stale 템플릿 재사용 함정).

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$ENV] $*" >&2; }

# ── 라이브 실측 그대로 이관(2026-07-22, gcloud run services describe 전량 대조) ──
# 평문 35개 + 시크릿 15개 = 50개, drift-guard(infra/manual-env-allowlist.yml)가 감시 중인
# Cloud Run 쪽 카테고리 C와 별개로 여기서도 전량 명시(두 배포 표면이 다르므로 각자 SSOT).
# ⛔story #2142(2026-07-23, 오르테가 지적 — 자기 지시가 만든 결함 자인) — PLAIN_ENV_SPEC을
# 예전엔 콤마로 join하고 소비부에서 `IFS=',' read -ra`로 무조건 콤마 분해했다. 값 자체에
# 콤마가 들어 있으면(H1_MERGE_GATE_ORG_ALLOWLIST의 2-org 콤마리스트 등) 그 값이 조각나
# VM에는 절반만 실리는 조용한 절단이 났다 — cloudbuild.yaml이 CORS_ORIGINS로 이미 겪고
# 커스텀 구분자('^@^')로 고쳐둔 바로 그 함정을 이 스크립트가 다시 밟은 것. 값에 절대
# 나타나지 않는 ASCII Unit Separator(0x1F)를 join 구분자로 써서 이 클래스 전체를 원천
# 차단한다 — 어떤 미래 값이 콤마를 포함해도 더 이상 쪼개지지 않는다.
_PLAIN_SEP=$'\x1f'
PLAIN_ENV_SPEC="EVENTBUS_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}APP_URL=${APP_URL}"
# ⛔story #2142(2026-07-23, 오르테가 전수 3방향 diff 적발 — GCE 플랜 vs 라이브 backend-prod
# env, "prod에 있는데 GCE엔 없는" 축) — APP_ENV/CORS_ORIGINS/NEXT_PUBLIC_APP_URL 셋 다
# backend-dev에도 backend-prod에도 이 스크립트 작성 당시엔 없었는데, backend-prod는 그 후
# 별도로 이 값들을 받았다(describe 대조 확認) — dev는 지금도 없음. 즉 이번 건은 "dev값이
# 분기 밖에 남은" 이전 3건과 반대 방향: **prod가 나중에 추가로 받은 값을 이 스크립트가
# 못 따라간 것**. 특히 APP_ENV는 `config.py::is_really_local`(story #2071 — `K_SERVICE`
# 부재로 로컬 판정, GCE엔 K_SERVICE가 원천적으로 없어 그 프로퍼티 자체는 이 값과 무관하게
# 계속 True로 나옴, 이건 별도 코드 결함으로 등재)와는 별개로 `app_env` 문자열을 직접 보는
# 코드 경로를 위해 필요 — 지금 당장 시크릿 fail-open 구멍은 아니지만(CRON_SECRET_PROD·
# FIREBASE_BFF_INTERNAL_SECRET 둘 다 바인딩돼 있어 그 경로는 안전) 미러링 원칙 그대로 적용.
if [ "${ENV}" = "prod" ]; then
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}APP_ENV=prod"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}NEXT_PUBLIC_APP_URL=${APP_URL}"
    # story #2142(2026-07-23) — CORS_ORIGINS는 처음엔 콤마 분해 함정 때문에 생략했으나(옛
    # `IFS=',' read -ra` 소비부가 이 값 자체의 콤마에서 쪼개짐), 그 소비부 자체를 _PLAIN_SEP
    # (0x1F) 기반으로 고친 뒤(위 참조)에는 값에 콤마가 있어도 안전하다 — 이제 넣는다.
    # config.py의 cors_origins 기본값과 문자열까지 완전히 동일(2026-07-23 확認)하므로 이
    # 값 자체는 무회귀이며, 명시로 durable화하는 것뿐이다.
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}CORS_ORIGINS=http://localhost:3000,http://localhost:3108,https://app.sprintable.ai"
fi
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}MEMBER_SSOT_RESOLVER_SHADOW=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}MEMBER_SSOT_APIKEY_CUT=true"
# ⛔story #2142(2026-07-23, 오르테가 DRY_RUN 검수 3번째 적발 — 같은 뿌리: dev 라이브에서
# 관측한 사실을 env 분기 없이 prod에 적용) — L2_TRIGGER_*/GATE_CONFIG_ENFORCE_*/
# DECISION_GATE_LINE_*는 backend-prod에 키 자체가 없다(그 기능이 prod에서 한 번도 켜진 적
# 없음, describe 대조 확認). 이 GCE 노드는 backend와 동일 이미지라 플래그가 켜지면 그
# lifespan 워커가 그대로 뜬다 — "SSE 전용이라 안 탈 것"이라는 추론 대신 backend-prod를
# 그대로 미러링한다(오르테가 판정). prod 분기에서 이 3그룹은 아예 붙이지 않는다.
if [ "${L2_TRIGGER_ENABLED_LINE}" = "true" ]; then
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}L2_TRIGGER_ENABLED=true"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}L2_TRIGGER_ADVISORY_LOCK=true"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}L2_TRIGGER_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}L2_TRIGGER_MAX_WAKES_PER_ORG_PER_HOUR=5"
fi
# H1_MERGE_GATE는 backend-prod에도 실재(ENABLED/ADVISORY=true/true, dev와 동일) — 허용목록만
# env별로 다르다(H1_MERGE_GATE_ORG_ALLOWLIST_VALUE, case 분기에서 라이브 실측값으로 설정).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}H1_MERGE_GATE_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}H1_MERGE_GATE_ORG_ALLOWLIST=${H1_MERGE_GATE_ORG_ALLOWLIST_VALUE}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}H1_MERGE_GATE_ADVISORY=true"
# ⛔story #2142(2026-07-23, 오르테가 전수 3방향 diff 적발, 4번째 묶음) — 같은 뿌리(dev
# 라이브 리터럴이 env 분기 밖에 남음). BUILD_APP_METADATA_DEFALLBACK은 backend-prod에
# 키 자체가 없다(describe 대조 확認) — dev 전용으로 되돌림.
if [ "${ENV}" = "dev" ]; then
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}BUILD_APP_METADATA_DEFALLBACK=true"
fi
if [ "${GATE_CONFIG_ENFORCE_ENABLED_LINE}" = "true" ]; then
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}GATE_CONFIG_ENFORCE_ENABLED=true"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}GATE_CONFIG_ENFORCE_ORG_ALLOWLIST=03970fbf-2db6-434b-a7b1-cb74f9547059"
fi
if [ "${DECISION_GATE_LINE_ENABLED_LINE}" = "true" ]; then
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}DECISION_GATE_LINE_ENABLED=true"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}DECISION_GATE_LINE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}DECISION_GATE_LINE_MODE=shadow"
fi
# ⛔story #2142(2026-07-23, 오르테가 DRY_RUN 검수 적발) 정정 — 이 세 값이 env 분기 밖의
# 리터럴(dev App 값)이라 prod 플랜에도 그대로 실려, prod 시크릿(github-app-*-prod)과 dev App의
# ID/CLIENT_ID가 섞이는 조합이 될 뻔했다. ${GITHUB_APP_ID}/${GITHUB_APP_CLIENT_ID}/
# ${GITHUB_APP_SLUG}(case 분기, 위 참조 — dev/prod 각각 라이브 실측값)로 정정.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}GITHUB_APP_ID=${GITHUB_APP_ID}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}GITHUB_APP_CLIENT_ID=${GITHUB_APP_CLIENT_ID}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}GITHUB_APP_SLUG=${GITHUB_APP_SLUG}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}FASTAPI_URL=${FASTAPI_URL}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}STORAGE_PROVIDER=gcs"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}DB_POOL_SIZE=3"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}DB_MAX_OVERFLOW=1"
# story #2115(S6): 앱 per-instance SSE 소프트캡(events.py MAX_SSE_CONNECTIONS·기본 100)을 상향.
# GCE는 Cloud Run concurrency 제약이 없어 실질 상한은 노드 fd/mem이고, 이 캡은 그 전에 걸리는
# 앱 자체 소프트캡이라 env로 무료 확장 가능. 500으로 올려 ceiling이 실제 확장됨을 실증(3노드=1500 이론).
# ⛔story #2142(2026-07-23, 오르테가 전수 3방향 diff 검수 시 확認 요청) — backend-prod는
# 이 값이 코드 기본값(100)인데, 이 GCE 노드가 그보다 높은 500을 쓰는 건 **dev값이 새어든
# 것이 아니라 이 스택 자체의 설계 의도**다: realtime-gateway는 SSE 전용 노드라 요청당
# 다른 부하(REST·DB write 등)와 경쟁하지 않고, Cloud Run concurrency 상한도 없어 노드
# fd/mem이 진짜 상한이 되므로 캡을 올려도 안전 — backend-prod가 이 값을 안 올린 이유는
# backend-prod는 SSE 전용이 아니라 REST 트래픽과 캡을 공유하기 때문(다른 성격의 노드).
# dev/prod 둘 다 이 GCE 스택에서는 500 그대로 유지 — env 분기 대상 아님.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}MAX_SSE_CONNECTIONS=500"
# story #2139/#2143 후속(2026-07-23, 오르테가군 판정 — dev 게이트 GREEN 확認 後 같은 날
# prod 승격, "절반만 고치는 것" 방지 교정): dev/prod 둘 다 true. backend(cloudbuild.yaml
# _BACKEND_PRESENCE_*/_BACKEND_SSE_LEASE_*)와 같은 흐름에서 켠다 — 한쪽만 켜고 멈추면
# backend는 Redis 공유·GCE는 로컬인 반쪽 상태가 prod에 남는다(오늘 #2448 인시던트와 동형).
# 손 env override(PRESENCE_REDIS_ENABLED=true bash ... prod 식)는 여기 SSOT 기본값을 다음
# 배포가 덮으므로 durable 값 자체를 여기 못박는다.
_BACKPLANE_DEFAULT=true
# #2120(E-ARCH 근본): chat_presence working → Redis 공유 롤아웃 게이트(프로세스-로컬 dict라
# GCE 멀티노드에서 노드마다 다르게 보이는 실제 결함 — 미르코의 working 판정이 여기 걸림).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}PRESENCE_REDIS_ENABLED=${PRESENCE_REDIS_ENABLED:-${_BACKPLANE_DEFAULT}}"
# #2120 AC2: online liveness Redis 롤아웃 게이트(§2 working 과 독립 flag). DB 폴백이 있어
# 지금도 안 깨져 있음 — 켜면 신선도 개선이지 결함 수정은 아니다(성격 구분, 오르테가군 지적).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}PRESENCE_ONLINE_REDIS_ENABLED=${PRESENCE_ONLINE_REDIS_ENABLED:-${_BACKPLANE_DEFAULT}}"
# #2121(E-ARCH 근본): SSE 연결 카운터(429/503) → Redis ZSET lease 롤아웃 게이트(인스턴스별
# 카운터라 전역 동시연결 상한이 실제로 성립하지 않는 실제 결함 — 까심의 노드편차 판정이
# 여기 걸림, GCE 3노드 필수·멀티노드 합산 대조).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}SSE_LEASE_REDIS_ENABLED=${SSE_LEASE_REDIS_ENABLED:-${_BACKPLANE_DEFAULT}}"
# #2122(E-ARCH 근본): fanout(wake_agent) → Redis 백플레인 롤아웃 게이트(presence/lease 와 독립 flag).
# env 로 flip(기본 false=pg_notify 직행 무회귀). #2122 라이브 재측정 배포=true(GCE PG_LISTEN=false라 wake
# 가 Redis 백플레인 타야 타노드 도달 — 미설정 시 cross-node wake 0/2 재현). REALTIME_BACKPLANE 는 별개(cutover).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}FANOUT_WAKE_REDIS_ENABLED=${FANOUT_WAKE_REDIS_ENABLED:-false}"
# ⛔story #2142(2026-07-23, 오르테가 전수 3방향 diff 적발, 4번째 묶음) — 같은 뿌리.
# LLM_GEMINI_MODEL/_LOCATION·FIREBASE_OAUTH_HANDOFF_ENABLED 전부 backend-prod에 키
# 자체가 없다(describe 대조 확認) — FIREBASE_OAUTH_HANDOFF_ENABLED=1은 특히 firebase
# 내부 경로를 **켜는** 값이라 더 신중해야 하는 자리였다. dev 전용으로 되돌림.
if [ "${ENV}" = "dev" ]; then
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}LLM_GEMINI_MODEL=gemini-3.1-pro-preview"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}LLM_GEMINI_LOCATION=global"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}FIREBASE_OAUTH_HANDOFF_ENABLED=1"
fi
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}MCP_PUBLIC_URL=${MCP_PUBLIC_URL}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}LICENSE_CONSENT=agreed"
# realtime 고유값(backend/api와 다름 — cloudbuild.yaml deploy-realtime 스텝과 동일 컨벤션):
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}PG_LISTEN_ENABLED=false"
# story #2135(2026-07-23, #2123 실측 적발): 키 이름이 여태 `REDIS_CONSUME_ENABLED`였다 —
# Settings 필드(`event_broker_redis_consume_enabled`)와 안 맞아 pydantic-settings가 조용히
# 무시했다(GCE는 필드 기본값이 우연히 True라 결과만 의도와 같았음). 실제 필드가 요구하는
# 키로 정정.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}EVENT_BROKER_REDIS_CONSUME_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}EVENT_BROKER_REDIS_DISPATCH_ENABLED=true"
# ⛔story #2142(2026-07-23, 오르테가 리뷰 적발 — 실행 前 발견) 정정: REDIS_URL이 여태 env
# 분기 없이 PLAIN_ENV_SPEC(평문·인스턴스 메타데이터에 그대로 박힘)에 얹혀 있었다. 두 가지가
# 동시에 걸리는 자리였다 — ①prod Redis는 AUTH 활성이라 URL이 비밀번호를 품는데, 그게 평문
# 메타데이터로 가면 이 스크립트가 SECRET_PAIRS를 따로 만든 이유("디스크 미기록·메타데이터
# 무기록") 자체를 무너뜨린다. ②기본값이 dev Memorystore IP 리터럴이라 prod 호출 시 REDIS_URL
# 을 안 넘기면 prod GCE가 dev Redis를 무는다 — DATABASE_URL_DEV(위 SECRET_PAIRS)와 정확히
# 같은 클래스. dev(AUTH 없는 plain Memorystore)는 시크릿 자체가 없으니 기존처럼 평문 유지,
# prod는 Secret Manager 바인딩(REDIS_URL_PROD)으로 완전히 옮겨 평문 경로에서 뺀다.
if [ "${ENV}" = "prod" ]; then
    SECRET_PAIRS_REDIS="REDIS_URL_PROD:REDIS_URL"
else
    # dev: Memorystore가 AUTH 없는 plain 인스턴스 — VPC 내부 IP(10.164.120.243)라 평문이어도
    # 시크릿이 아니다. env로 override 가능하게 기존 그대로 유지(재실측 없이 하드코딩 안 함).
    REDIS_URL_VALUE="${REDIS_URL:-redis://10.164.120.243:6379}"
    PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC}${_PLAIN_SEP}REDIS_URL=${REDIS_URL_VALUE}"
    SECRET_PAIRS_REDIS=""
fi
# DB_POOL_SIZE/DB_MAX_OVERFLOW는 위에서 이미 3/1로 명시(Cloud Run realtime과 동일).
#
# ⚠️의도적 제외(50개 라이브 실측 중 1개, 침묵 누락 아님) — OPS_RESTART_TS=1784527154:
# Cloud Run 전용 "재배포 강제 트리거" 값(값 자체를 바꿔야 신규 리비전이 뜨는 그 서비스만의
# 관례) — GCE MIG는 인스턴스 템플릿 버전(TEMPLATE_NAME에 COMMIT_SHA 포함)이 이미 그 역할을
# 하므로 이관 대상 아님. 나머지 34개 평문 + 15개 시크릿 = 라이브 50개 전량 이관 완료.

# ── 시크릿 — 부팅 시점에 VM 자신의 SA로 Secret Manager에서 직접 fetch(디스크 미기록,
#    인스턴스 메타데이터에도 안 남음 — startup-script 안에서만 메모리 상주). ──
# secret_name:env_var_name 페어 — 라이브 실측 15개 그대로(2026-07-22).
# ⚠️story #2142(2026-07-23) 정정: 아래 두 줄이 여태 DB_SECRET_NAME 변수를 안 쓰고
# "DATABASE_URL_DEV"를 리터럴로 박아뒀었다(dev 전용일 땐 무해했으나, prod 분기를 그대로
# 얹으면 prod GCE가 dev DB 시크릿을 끌어오는 사고가 났을 자리 — #2135와 같은 클래스,
# "변수가 있는데 안 쓰인다"). ${DB_SECRET_NAME}으로 정정.
SECRET_PAIRS="${DB_SECRET_NAME}:DATABASE_URL"
SECRET_PAIRS="${SECRET_PAIRS} JWT_SECRET:JWT_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} GOOGLE_CLIENT_ID:GOOGLE_CLIENT_ID"
SECRET_PAIRS="${SECRET_PAIRS} GOOGLE_CLIENT_SECRET:GOOGLE_CLIENT_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} GITHUB_CLIENT_ID_${GITHUB_SECRET_SUFFIX}:GITHUB_CLIENT_ID"
SECRET_PAIRS="${SECRET_PAIRS} GITHUB_CLIENT_SECRET_${GITHUB_SECRET_SUFFIX}:GITHUB_CLIENT_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} RESEND_API_KEY:RESEND_API_KEY"
SECRET_PAIRS="${SECRET_PAIRS} EMAIL_FROM:EMAIL_FROM"
SECRET_PAIRS="${SECRET_PAIRS} github-webhook-secret:GITHUB_WEBHOOK_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} ${CRON_SECRET_NAME}:CRON_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} github-app-client-secret-${GITHUB_APP_SECRET_ENV}:GITHUB_APP_CLIENT_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} github-app-private-key-${GITHUB_APP_SECRET_ENV}:GITHUB_APP_PRIVATE_KEY"
SECRET_PAIRS="${SECRET_PAIRS} github-app-state-secret-${GITHUB_APP_SECRET_ENV}:GITHUB_APP_STATE_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} FIREBASE_BFF_INTERNAL_SECRET:FIREBASE_BFF_INTERNAL_SECRET"
# ⛔story #2142(2026-07-23, 오르테가 DRY_RUN 검수 적발 — GitHub App 건과 동일 클래스:
# "dev 라이브에서 관측한 사실을 env 분기 없이 prod에 적용") — 이 줄이 env 분기 밖이라 prod
# 플랜에서도 DATABASE_URL_PROD:DATABASE_URL_PROD로 그대로 실렸다. 라이브 대조 결과 이
# 자기이름 바인딩은 backend-dev에만 실재하는 계약이었다(DATABASE_URL_DEV 키가 backend-dev엔
# 있고 backend-prod엔 DATABASE_URL_PROD 키 자체가 없음) — 코드 grep으로도 DATABASE_URL_PROD를
# 읽는 경로 0건 확認. prod에 그 값(비밀번호 포함 DB 접속 문자열)을 이름만 추가해 한 벌 더
# 싣는 것은 불필요한 자격증명 표면 확장이라 prod에서는 붙이지 않는다.
if [ "${ENV}" = "dev" ]; then
    SECRET_PAIRS="${SECRET_PAIRS} ${DB_SECRET_NAME}:${DB_SECRET_NAME}"
fi
# story #2142: prod만 REDIS_URL을 시크릿으로 추가(위 SECRET_PAIRS_REDIS 분기 참조) — dev는
# 이미 PLAIN_ENV_SPEC에 실렸으므로 빈 문자열이라 여기선 아무것도 안 붙는다.
if [ -n "${SECRET_PAIRS_REDIS}" ]; then
    SECRET_PAIRS="${SECRET_PAIRS} ${SECRET_PAIRS_REDIS}"
fi

# ── startup-script 생성 — 부팅마다: cloud-sql-proxy 컨테이너(소켓 공유볼륨) → 시크릿
#    fetch(메모리만, 디스크 미기록) → 앱 컨테이너. 재부팅 시에도 동일하게 재실행돼 자가복구.
#
# ⚠️COS(Container-Optimized OS)는 루트 파일시스템이 read-only — `/cloudsql`를 루트에 mkdir
# 하면 "Read-only file system"으로 실패하고 set -e가 startup-script 전체를 중단시킨다(컨테이너
# 미기동·헬스 영구 UNHEALTHY, 2026-07-22 실측 근본원인). 소켓 디렉터리는 쓰기 가능한
# `/mnt/stateful_partition/cloudsql`(호스트)에 두고, 컨테이너 안에서는 `/cloudsql`로 마운트한다
# — DATABASE_URL의 `/cloudsql/...` 소켓 경로는 컨테이너 내부 경로라 그대로 동작(변경 0). ──
_HOST_SOCKET_DIR="/mnt/stateful_partition/cloudsql"
STARTUP_SCRIPT_FILE="$(mktemp)"
trap 'rm -f "${STARTUP_SCRIPT_FILE}"' EXIT

{
    echo '#!/bin/bash'
    echo 'set -euo pipefail'
    echo ''
    echo '# story c4c72eb1 PR-B — realtime-gateway GCE startup-script.'
    echo '# 재부팅마다 재실행(COS 컨벤션) — 컨테이너 자가복구 겸함.'
    echo '# ⚠️소켓 디렉터리는 COS 쓰기가능 경로(/mnt/stateful_partition)에 — 루트는 read-only.'
    echo ''
    echo '# ⚠️docker CLI는 자격증명/설정을 $HOME/.docker(=/root/.docker)에 쓰는데 COS 루트FS가'
    echo '#   read-only라 docker login이 "mkdir /root/.docker: read-only file system"으로 실패한다.'
    echo '#   DOCKER_CONFIG를 쓰기가능 경로로 지정해 모든 docker 명령이 그곳을 쓰게 한다(실측 수정).'
    echo 'export DOCKER_CONFIG=/mnt/stateful_partition/docker'
    echo 'mkdir -p "${DOCKER_CONFIG}"'
    echo ''
    echo "mkdir -p ${_HOST_SOCKET_DIR}"
    echo '# ⚠️cloud-sql-proxy:2 이미지는 nonroot(UID 65532)로 실행돼 root 소유 소켓 dir 안에'
    echo '#   인스턴스 서브dir를 mkdir 못 한다("permission denied"·프록시 crash loop, 실측).'
    echo '#   소켓 dir을 world-writable로 — 프록시(생성)·앱(소켓 접속) 양쪽 UID 무관하게 통과.'
    echo "chmod 777 ${_HOST_SOCKET_DIR}"
    echo 'docker rm -f cloud-sql-proxy 2>/dev/null || true'
    echo 'docker run -d --name cloud-sql-proxy --restart=always \'
    echo "  -v ${_HOST_SOCKET_DIR}:/cloudsql \\"
    echo "  gcr.io/cloud-sql-connectors/cloud-sql-proxy:2 \\"
    echo '  --private-ip \'
    echo '  --unix-socket=/cloudsql \'
    echo "  ${SQL_INSTANCE_CONN}"
    echo '# ⚠️--private-ip 필수 — Cloud SQL sprintable-dev는 private IP만(ipv4Enabled=false,'
    echo '#   10.110.0.3, privateNetwork=default). 외부IP 없는 VM은 public IP 경로로 못 가고,'
    echo '#   PGA도 Cloud SQL 데이터경로는 커버 안 함. VM이 같은 VPC라 private IP로 도달(실측 수정).'
    echo ''
    echo '# 소켓 파일이 실제로 나타날 때까지 대기(최대 30초) — 앱이 소켓 없이 먼저 뜨는 레이스 방지.'
    echo '# (호스트 경로에서 확認 — proxy가 /mnt/stateful_partition/cloudsql에 소켓을 만든다.)'
    echo 'for i in $(seq 1 30); do'
    echo "  [ -S \"${_HOST_SOCKET_DIR}/${SQL_INSTANCE_CONN}/.s.PGSQL.5432\" ] && break"
    echo '  sleep 1'
    echo 'done'
    echo ''
    echo '# 시크릿 — 부팅 시점에 fetch(디스크 미기록·bash 변수=메모리 상주).'
    echo '# ⚠️COS엔 gcloud 바이너리가 없다(실측: line 24 "gcloud: command not found", exit 127).'
    echo '# ⇒ gcloud를 담은 컨테이너(cloud-sdk:slim)로 fetch한다. 컨테이너 안 gcloud는'
    echo '#   GCE 메타데이터 서버로 VM 자신의 SA(Secret Manager Accessor)를 자동 인증한다.'
    echo '# ⚠️반드시 gcr.io 호스팅 이미지 사용 — Docker Hub(google/cloud-sdk)는 PGA 커버 밖이라'
    echo '#   외부IP 없는 VM에서 pull 불가. gcr.io/google.com/cloudsdktool/cloud-sdk는 PGA로 도달.'
    echo 'docker pull gcr.io/google.com/cloudsdktool/cloud-sdk:slim >/dev/null'
    echo '# 개별 secret을 컨테이너 gcloud로 읽어 bash 변수에 담는다(값은 stdout로만·디스크 미경유).'
    for pair in ${SECRET_PAIRS}; do
        secret_name="${pair%%:*}"
        env_name="${pair##*:}"
        echo "${env_name}=\$(docker run --rm gcr.io/google.com/cloudsdktool/cloud-sdk:slim gcloud secrets versions access latest --secret=${secret_name} --project=${GCP_PROJECT})"
    done
    echo ''
    echo '# 앱 이미지는 사설 Artifact Registry에 있어 docker 인증 필요 — COS docker는 AR 자동인증이'
    echo '# 안 된다(public gcr.io는 무인증 pull됐지만 사설 AR은 "Unauthenticated request" 거절, 실측).'
    echo '# VM SA(artifactregistry.reader 보유)의 access token으로 해당 AR 호스트에 docker login.'
    echo "_AR_TOKEN=\$(docker run --rm gcr.io/google.com/cloudsdktool/cloud-sdk:slim gcloud auth print-access-token)"
    echo "echo \"\${_AR_TOKEN}\" | docker login -u oauth2accesstoken --password-stdin https://${_AR_HOST}"
    echo ''
    # ⛔story #2142(2026-07-23, 오르테가 지적 — 자기 지시가 만든 결함 자인) — 이전엔 여기서
    # PLAIN_ENV_SPEC을 `IFS=',' read -ra`로 무조건 콤마 분해해 개별 `-e KEY=VALUE \` 인자로
    # 만들었다. 값 자체에 콤마가 있으면(H1_MERGE_GATE_ORG_ALLOWLIST의 2-org 리스트 등) 그
    # 값이 조각나 VM에는 절반만 실리는 조용한 절단이 났었다 — 위 _PLAIN_SEP(0x1F join)로
    # 그 클래스 자체는 이미 막았지만, 여기서도 `docker --env-file`로 전환해 ⭐구분자 싸움을
    # 아예 끝낸다(오르테가 권고) — 부수 이득으로 PLAIN 값들이 더 이상 프로세스 인자
    # (`docker run -e ...`, `ps` 등으로 노출 가능)에 안 실리고 파일로만 전달된다.
    echo 'cat > /tmp/realtime-gateway-plain.env <<'"'"'PLAIN_ENV_EOF'"'"''
    IFS="${_PLAIN_SEP}" read -ra _plain_pairs <<< "${PLAIN_ENV_SPEC}"
    for kv in "${_plain_pairs[@]}"; do
        printf '%s\n' "${kv}"
    done
    echo 'PLAIN_ENV_EOF'
    echo ''
    echo 'docker rm -f realtime-gateway 2>/dev/null || true'
    echo 'docker run -d --name realtime-gateway --restart=always \'
    echo '  -p 8000:8000 \'
    echo "  -v ${_HOST_SOCKET_DIR}:/cloudsql \\"
    for pair in ${SECRET_PAIRS}; do
        env_name="${pair##*:}"
        echo "  -e ${env_name}=\"\${${env_name}}\" \\"
    done
    echo '  --env-file=/tmp/realtime-gateway-plain.env \'
    echo "  ${IMAGE} \\"
    echo '  uvicorn app.main:app --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 30'
    echo ''
    echo '# ── 부팅 진단(시리얼 콘솔로) — COS는 SSH/Cloud Logging 접근이 제한적이라, 컨테이너'
    echo '#    상태·소켓·프록시/앱 로그를 startup-script stdout(=시리얼)로 남겨 원격 진단 가능케 한다.'
    echo 'sleep 75'
    echo 'echo "=== DIAG docker ps ==="'
    echo 'docker ps -a --format "{{.Names}} {{.Status}} {{.Image}}"'
    echo "echo \"=== DIAG socket dir (${_HOST_SOCKET_DIR}) ===\""
    echo "ls -alR ${_HOST_SOCKET_DIR} 2>&1 | head -20"
    echo 'echo "=== DIAG cloud-sql-proxy logs ==="'
    echo 'docker logs cloud-sql-proxy 2>&1 | tail -8'
    echo 'echo "=== DIAG realtime-gateway logs ==="'
    echo 'docker logs realtime-gateway 2>&1 | tail -60'
    echo 'echo "=== DIAG end ==="'
} > "${STARTUP_SCRIPT_FILE}"

# 템플릿 이름 확定 — startup-script 내용 해시(앞 6자)를 SHA와 함께 넣어, 같은 이미지라도
# startup-script가 바뀌면 새 템플릿 이름이 되게 한다(stale 템플릿 재사용 방지).
_STARTUP_HASH="$(shasum -a 256 "${STARTUP_SCRIPT_FILE}" | cut -c1-6)"
TEMPLATE_NAME="${TEMPLATE_PREFIX}-${SHORT_SHA}-${_STARTUP_HASH}"

log "Deploying ${MIG_NAME} ← ${IMAGE}"
log "Machine type: ${MACHINE_TYPE}, target size: ${TARGET_SIZE}"
log "Cloud SQL: ${SQL_INSTANCE_CONN}"

if [ "${DRY_RUN}" = "1" ]; then
    # ⛔story #2142(2026-07-23, 오르테가 지적) — 이전 DRY_RUN 출력은 PLAIN_ENV_SPEC "요약
    # 문자열"만 보여줬다. 그 요약은 join 구분자가 무엇이든 항상 올바르게 보였을 것이라
    # (부분 문자열 검사만 하니) H1_MERGE_GATE_ORG_ALLOWLIST의 콤마-절단 결함을 회귀 테스트가
    # 전혀 못 잡았던 근본 원인이다 — 검증 대상(요약 문자열)과 실제 배포되는 것(생성된
    # startup-script의 env-file)이 달랐다. 실제 생성된 env-file 내용을 그대로 노출해
    # 테스트가 "진짜 배포될 것"을 검증하게 한다(base64 — 줄바꿈을 한 줄 KEY=VALUE 출력
    # 포맷 안에 안전하게 실어야 해서).
    _GENERATED_PLAIN_ENV_FILE_B64="$(sed -n '/^cat > \/tmp\/realtime-gateway-plain\.env/,/^PLAIN_ENV_EOF$/p' "${STARTUP_SCRIPT_FILE}" | sed '1d;$d' | base64 | tr -d '\n')"
    cat <<EOF
ENV=${ENV}
MIG_NAME=${MIG_NAME}
TEMPLATE_NAME=${TEMPLATE_NAME}
IMAGE=${IMAGE}
MACHINE_TYPE=${MACHINE_TYPE}
TARGET_SIZE=${TARGET_SIZE}
ZONES=${ZONES}
SQL_INSTANCE_CONN=${SQL_INSTANCE_CONN}
RUNTIME_SA=${RUNTIME_SA}
PLAIN_ENV_SPEC=${PLAIN_ENV_SPEC}
SECRET_PAIRS=${SECRET_PAIRS}
GENERATED_PLAIN_ENV_FILE_B64=${_GENERATED_PLAIN_ENV_FILE_B64}
EOF
    exit 0
fi

# 템플릿 이름 = SHA + startup-script 해시 — 같은 이름이면 내용이 확실히 동일하므로 재사용(멱등).
# (startup-script가 바뀌면 해시가 바뀌어 새 이름 → 새 템플릿 생성. stale 재사용 없음.)
if gcloud compute instance-templates describe "${TEMPLATE_NAME}" \
        --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    log "Instance template ${TEMPLATE_NAME} already exists — reusing (SHA+해시 동일 ⇒ 내용 동일)"
else
    log "Creating instance template ${TEMPLATE_NAME}"
    gcloud compute instance-templates create "${TEMPLATE_NAME}" \
        --project="${GCP_PROJECT}" \
        --machine-type="${MACHINE_TYPE}" \
        --region="${GCP_REGION}" \
        --network=default \
        --subnet=default \
        --no-address \
        --image-family=cos-stable \
        --image-project=cos-cloud \
        --service-account="${RUNTIME_SA}" \
        --scopes=cloud-platform \
        --tags=realtime-gateway \
        --metadata-from-file=startup-script="${STARTUP_SCRIPT_FILE}"
fi

if gcloud compute instance-groups managed describe "${MIG_NAME}" \
        --region="${GCP_REGION}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
    # story #2110(S1) 이력: 그 당시 2-zone→3-zone 확장은 **zone 구성 자체를 바꾸는** 작업이었고,
    # regional MIG의 zone 구성은 불변(immutable — gcloud `update`엔 --zones 플래그가 없고,
    # Compute API patch로 distributionPolicy.zones를 넣으면 400 "Zone configuration is
    # immutable"로 거절됨, 2026-07-22 실측)이라 그때는 delete+recreate가 유일 경로였다.
    #
    # ⛔story #2142(2026-07-23, 오르테가 지적) — 그 delete+recreate 코드가 "MIG가 존재하기만
    # 하면" 무조건 타는 조건이었다. zone 구성은 이제(3-zone) 안정됐는데도 **매 재배포마다**
    # 이 경로를 타면서 MIG 객체 자체가 삭제→재생성돼, backend-service 부착(멤버십)과
    # named-ports(MIG 자체의 속성 — 인스턴스 템플릿엔 없음)가 매번 함께 사라졌다. 헬스체크는
    # 포트를 직접(8000) 찌르므로 이 단절과 무관하게 HEALTHY로 보여 — "3대 다 HEALTHY"만
    # 보고 트래픽을 넘겼으면 사용자만 502를 봤을 상태였다(파일 상단 §26 "rolling-update로
    # 갱신"이라는 원래 의도 자체가 #2110에서 깨진 것 — 아래가 그 의도를 되살린 것).
    #
    # 근본수정: zone 구성이 이미 3개 zone으로 안정된 지금, **기본 경로는 항상 rolling-update**
    # (MIG 객체 보존 → backend-service 부착·named-ports 그대로 유지)다. delete+recreate는
    # 미래에 진짜 zone 구성을 다시 바꿔야 하는 드문 경우에만, `FORCE_MIG_RECREATE=1`로 명시
    # opt-in해야 탄다(암묵적 zone-diff 실행시점 비교보다 명시 플래그가 더 안전 — zone 문자열
    # 포맷 파싱 실수로 조용히 잘못된 경로를 타는 것을 원천 차단).
    if [ "${FORCE_MIG_RECREATE:-0}" = "1" ]; then
        log "FORCE_MIG_RECREATE=1 — recreating ${MIG_NAME} (zone 구성 자체를 바꿔야 하는 드문 경우 전용)"

        # ① detach: 이 MIG를 backend로 참조하는 backend-service가 있으면 remove-backend.
        #    (없거나 이미 detach면 조용히 넘어간다 — 멱등.)
        if gcloud compute backend-services describe "${GCLB_BACKEND_SERVICE}" --global --project="${GCP_PROJECT}" \
                --format='value(backends[].group)' 2>/dev/null | grep -q "${MIG_NAME}"; then
            log "Detaching ${MIG_NAME} from backend-service ${GCLB_BACKEND_SERVICE} (S2 멤버십만 제거·config 미변경)"
            gcloud compute backend-services remove-backend "${GCLB_BACKEND_SERVICE}" \
                --project="${GCP_PROJECT}" \
                --global \
                --instance-group="${MIG_NAME}" \
                --instance-group-region="${GCP_REGION}"
        else
            log "No backend-service attachment found for ${MIG_NAME} — skip detach"
        fi

        # ② delete 기존 MIG (동기 대기 — 삭제 완료 후 create가 이름 충돌 없이 진행).
        log "Deleting ${MIG_NAME} (기존 노드 전량 제거 — FORCE_MIG_RECREATE)"
        gcloud compute instance-groups managed delete "${MIG_NAME}" \
            --region="${GCP_REGION}" \
            --project="${GCP_PROJECT}" \
            --quiet

        # ③ create — 신규 MIG(재생성 경로).
        log "Creating MIG ${MIG_NAME} (size ${TARGET_SIZE}, zones ${ZONES}, no autoscaling)"
        gcloud compute instance-groups managed create "${MIG_NAME}" \
            --project="${GCP_PROJECT}" \
            --region="${GCP_REGION}" \
            --template="${TEMPLATE_NAME}" \
            --size="${TARGET_SIZE}" \
            --zones="${ZONES}"
    else
        # 기본 경로 — MIG 객체를 그대로 두고 인스턴스 템플릿만 교체(rolling-update).
        # backend-service 부착·named-ports는 MIG 객체 자체의 속성이라 이 경로에서 전혀 안
        # 건드려진다 → 재배포가 트래픽을 끊지 않는다(provision_realtime_gclb.sh doc이 명시한
        # "SSE 급단절 방지" 목표와 동일 축).
        #
        # ⛔story #2445 후속(2026-07-23, 오르테가 실 재배포 실측 — main 체크아웃 오실행 자인
        # 後 develop 재실행으로 재현) — `--max-unavailable=1`은 **regional MIG에선 GCP 자체가
        # 거부**한다: "Fixed updatePolicy.maxUnavailable for regional managed instance group
        # has to be either 0 or at least equal to the number of zones"(3). 실패 자체는
        # 안전했다(아무 것도 건드리기 전에 멈춤 — backends/named-ports/https 200 전부 무영향,
        # fail-fast) — 그래도 실행 없이는 코드리뷰/CI로 못 잡는 gcloud API 제약이었다.
        #
        # ⛔prod 재배포 핫픽스(2026-07-24, 오르테가 실 재배포 실측 — 오늘 이 파일 세 번째 같은
        # 결함류: delete+recreate·maxUnavailable·이번 maxSurge, 전부 "실행은 됐는데 실효는
        # 없는" 형태) — `--max-surge=1`도 같은 regional MIG 제약에 걸린다: "Fixed
        # updatePolicy.maxSurge for regional managed instance group has to be either 0 or at
        # least equal to the number of zones". dev(당시 실측 zone 구성)에선 우연히 통과했지만
        # prod(3존)에선 거부됐다 — "1"을 하드코딩하지 않고 **이 MIG가 실제로 걸쳐 있는 존
        # 개수를 조회**해 그 값을 쓴다(하드코딩 "3"도 안 쓴다 — 스크립트가 아는 값과 라이브
        # 존 구성이 어긋나면 오늘 반복된 "코드는 맞는데 실측과 다르다" 함정이 그대로 재현된다).
        # max-unavailable=0 유지(항상 유효값·SSE 무중단 우선 — 새 인스턴스 먼저 띄우고
        # 헬스체크 통과 後 옮기는 설계 의도는 그대로).
        # json(...) 서브셋으로 좁혀 zones 리스트만 뽑은 뒤 "zone" 키 등장 횟수로 카운트 —
        # gcloud value()의 리스트 join 구분자를 가정하지 않는 가장 안전한 방식. ⚠️grep -c는
        # "매치된 줄 수"를 세지 총 매치 횟수가 아니다 — gcloud json 출력이 한 줄로 나오면
        # (pretty-print 보장 없음) zone이 몇 개든 항상 1로 잡히는 실측 버그를 mock-gcloud
        # 테스트로 직접 재현·확認했다. grep -o | wc -l로 줄 구조와 무관하게 총 출현 횟수를 센다.
        _ZONE_COUNT=$(gcloud compute instance-groups managed describe "${MIG_NAME}" \
            --project="${GCP_PROJECT}" --region="${GCP_REGION}" \
            --format='json(distributionPolicy.zones)' | grep -o '"zone":' | wc -l | tr -d ' ')
        log "Rolling-updating ${MIG_NAME} to template ${TEMPLATE_NAME} (MIG 객체 보존 — backend-service 부착·named-ports 무영향, max-surge=${_ZONE_COUNT} zone 수 실측)"
        # ⛔같은 실측(2026-07-24) — rolling-action 실패가 파이프라인/래퍼를 거치면 rc=0으로
        # 보일 수 있다(캡처 방식에 따라 exit code가 가려짐). `if ! CMD; then`로 이 명령
        # **자체의** 종료코드를 명시 확인해 실패를 실패로 드러낸다(암묵적 set -e 전파에만
        # 의존하지 않는다 — 이 파일 상단 `_REALTIME_URL` 빈값 가드와 동일한 명시-실패 컨벤션).
        if ! gcloud compute instance-groups managed rolling-action start-update "${MIG_NAME}" \
            --project="${GCP_PROJECT}" \
            --region="${GCP_REGION}" \
            --version=template="${TEMPLATE_NAME}" \
            --max-unavailable=0 \
            --max-surge="${_ZONE_COUNT}"; then
            echo "FAIL: rolling-action start-update 실패(${MIG_NAME}) — MIG는 이전 템플릿에 그대로 남아있다."
            echo "      위 gcloud 에러 메시지를 확인할 것(예: maxSurge/maxUnavailable 제약)."
            exit 1
        fi
    fi
else
    log "Creating MIG ${MIG_NAME} (size ${TARGET_SIZE}, zones ${ZONES}, no autoscaling)"
    gcloud compute instance-groups managed create "${MIG_NAME}" \
        --project="${GCP_PROJECT}" \
        --region="${GCP_REGION}" \
        --template="${TEMPLATE_NAME}" \
        --size="${TARGET_SIZE}" \
        --zones="${ZONES}"
fi

# story #2142(2026-07-23, 오르테가 적발) 근본수정 — named-ports는 MIG 객체 자체의 속성(인스턴스
# 템플릿에는 없음)이라 신규 생성/강제재생성 경로에서는 항상 비어 있는 채로 시작한다. 그 상태로
# 두면 backend-service는 port-name="http"을 찾다 못 찾아 **기본 포트 80**으로 폴백하는데 앱은
# 8000에서 듣는다 — 502(헬스체크는 8000을 직접 찌르므로 이 단절과 무관하게 HEALTHY로 보이는
# 게 제일 고약한 부분). set-named-ports는 멱등(이미 같은 값이면 no-op에 가까움)이라 매 배포마다
# 무조건 실행 — provision_realtime_gclb.sh 스텝④와 동일 명령·동일 named-port 값 유지(SSOT 중복
# 아님 — 그 스크립트가 "1회성 프로비저닝"이라 재배포마다 자동으로 다시 안 돌기 때문에 여기서도
# 방어적으로 보장한다. 사람이 그 스크립트 재실행을 잊어도 이 스크립트 하나로 무결하게 닫힘).
NAMED_PORT="http:8000"
log "Ensuring named port ${NAMED_PORT} on ${MIG_NAME} (MIG 객체 속성 — 신규/재생성 시 비어있음)"
gcloud compute instance-groups managed set-named-ports "${MIG_NAME}" \
    --project="${GCP_PROJECT}" --region="${GCP_REGION}" --named-ports="${NAMED_PORT}"

# story #2142 근본수정 — backend-service 부착도 같은 이유로 이 스크립트가 방어적으로 보장한다
# (provision_realtime_gclb.sh 스텝④와 동일 멱등 로직 재사용). 이미 붙어 있으면 조용히 스킵.
if ! gcloud compute backend-services describe "${GCLB_BACKEND_SERVICE}" --global --project="${GCP_PROJECT}" \
        --format='value(backends[].group)' 2>/dev/null | grep -q "${MIG_NAME}"; then
    log "Attaching ${MIG_NAME} to backend-service ${GCLB_BACKEND_SERVICE}"
    gcloud compute backend-services add-backend "${GCLB_BACKEND_SERVICE}" \
        --project="${GCP_PROJECT}" \
        --global \
        --instance-group="${MIG_NAME}" \
        --instance-group-region="${GCP_REGION}" \
        --balancing-mode=UTILIZATION \
        --max-utilization=0.8
else
    log "${MIG_NAME} already attached to backend-service ${GCLB_BACKEND_SERVICE} — skip"
fi

# story #2142 근본수정 — "조용히 넘어가는 게 제일 나쁜 것"(오르테가). 위 attach 스텝이 어떤
# gcloud 이유로든 조용히 실패/no-op했다면, 트래픽을 전환하기 전에 반드시 여기서 크게 실패한다.
if ! gcloud compute backend-services describe "${GCLB_BACKEND_SERVICE}" --global --project="${GCP_PROJECT}" \
        --format='value(backends[].group)' 2>/dev/null | grep -q "${MIG_NAME}"; then
    log "⛔ FATAL: ${MIG_NAME} is NOT attached to backend-service ${GCLB_BACKEND_SERVICE} after deploy."
    log "   트래픽을 이 상태로 전환하면 프로덕션이 조용히 502가 됩니다 — 전환 전 반드시 원인 확認."
    exit 1
fi

log "=== Deployment submitted ==="
log "Instance template: ${TEMPLATE_NAME}"
log "MIG: ${MIG_NAME} (region ${GCP_REGION})"
log "Health check target: /api/v2/ping (DB 미조회, GCLB 나머지 스택은 provision_realtime_gclb.sh 참조)"
