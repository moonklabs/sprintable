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
#   - GCLB 스택(헬스체크·백엔드서비스·NEG·URL맵·포워딩규칙·방화벽)은
#     provision_realtime_gclb.sh로 별도 1회 프로비저닝(먼저 실행 필요)
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
#       있으면 rolling-update(--max-unavailable=1, 2노드 중 1개씩 순차 교체)로 갱신.
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
        GITHUB_SECRET_SUFFIX="DEV"
        GITHUB_APP_SECRET_ENV="dev"  # story #2142 발견: github-app-*-dev Secret Manager ID의 소문자 접미(위 GITHUB_SECRET_SUFFIX와 별개 컨벤션 — 이 시크릿 3종만 하이픈+소문자)
        APP_URL="https://dev-app.sprintable.ai"
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
        GITHUB_SECRET_SUFFIX="PROD"
        # ⚠️TODO(실 배포 前 확認 필요) — "-prod" 접미 Secret Manager 시크릿(github-app-client-secret-prod
        # 등)이 실제로 존재하는지 미확認(repo grep 0건 — dev만 프로비저닝된 상태로 보임). 존재
        # 안 하면 GitHub App(webhook/PR 캡처) 기능이 prod GCE에서 fail-closed(gcloud secrets
        # access 실패)로 죽는다 — 실 배포 前 별도 확認/프로비저닝 필요.
        GITHUB_APP_SECRET_ENV="prod"
        APP_URL="https://app.sprintable.ai"
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
PLAIN_ENV_SPEC="EVENTBUS_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},APP_URL=${APP_URL}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},MEMBER_SSOT_RESOLVER_SHADOW=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},MEMBER_SSOT_APIKEY_CUT=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},L2_TRIGGER_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},L2_TRIGGER_ADVISORY_LOCK=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},L2_TRIGGER_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},L2_TRIGGER_MAX_WAKES_PER_ORG_PER_HOUR=5"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},H1_MERGE_GATE_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},H1_MERGE_GATE_ADVISORY=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},BUILD_APP_METADATA_DEFALLBACK=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},GATE_CONFIG_ENFORCE_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},GATE_CONFIG_ENFORCE_ORG_ALLOWLIST=03970fbf-2db6-434b-a7b1-cb74f9547059"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},DECISION_GATE_LINE_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},DECISION_GATE_LINE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},DECISION_GATE_LINE_MODE=shadow"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},GITHUB_APP_ID=4120278"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},GITHUB_APP_CLIENT_ID=Iv23liRkrmyqoCZIlrgh"
# ⚠️story #2142 TODO(실 배포 前 확認 필요) — GITHUB_APP_ID/CLIENT_ID/SLUG는 env 분기 밖의
# 리터럴이라 dev 값이 prod 플랜에도 그대로 실린다. repo grep 결과 prod용 GitHub App 등록/슬러그가
# 어디에도 없어(이 App이 dev/prod 공유인지 별도 prod App이 필요한지가 이 스크립트로 답할 수
# 없는 제품 결정) — 이 값을 건드리지 않고 그대로 두되, 오르테가 DRY_RUN 검수 시 판단 요청.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},GITHUB_APP_SLUG=sprintable-dev"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},FASTAPI_URL=${FASTAPI_URL}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},STORAGE_PROVIDER=gcs"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},DB_POOL_SIZE=3"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},DB_MAX_OVERFLOW=1"
# story #2115(S6): 앱 per-instance SSE 소프트캡(events.py MAX_SSE_CONNECTIONS·기본 100)을 상향.
# GCE는 Cloud Run concurrency 제약이 없어 실질 상한은 노드 fd/mem이고, 이 캡은 그 전에 걸리는
# 앱 자체 소프트캡이라 env로 무료 확장 가능. 500으로 올려 ceiling이 실제 확장됨을 실증(3노드=1500 이론).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},MAX_SSE_CONNECTIONS=500"
# #2120(E-ARCH 근본): chat_presence working → Redis 공유 롤아웃 게이트. 실측용으로 env 로 flip
# (기본 false=현 in-memory 무회귀). OFF 실측=false, ON 실측=true. 라이브 실측 후 durable 값 확定.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},PRESENCE_REDIS_ENABLED=${PRESENCE_REDIS_ENABLED:-false}"
# #2120 AC2: online liveness Redis 롤아웃 게이트(§2 working 과 독립 flag). env 로 flip(기본 false).
# AC2 실측 배포=true. Redis-down fail-open 실측 땐 REDIS_URL 오배선(공유 Memorystore 무접촉)로 시뮬.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},PRESENCE_ONLINE_REDIS_ENABLED=${PRESENCE_ONLINE_REDIS_ENABLED:-false}"
# #2121(E-ARCH 근본): SSE 연결 카운터(429/503) → Redis ZSET lease 롤아웃 게이트(presence 와 독립 flag).
# env 로 flip(기본 false=in-process 무회귀). AC5 실측 배포=true(GCE 3노드 필수·멀티노드 합산 대조).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},SSE_LEASE_REDIS_ENABLED=${SSE_LEASE_REDIS_ENABLED:-false}"
# #2122(E-ARCH 근본): fanout(wake_agent) → Redis 백플레인 롤아웃 게이트(presence/lease 와 독립 flag).
# env 로 flip(기본 false=pg_notify 직행 무회귀). #2122 라이브 재측정 배포=true(GCE PG_LISTEN=false라 wake
# 가 Redis 백플레인 타야 타노드 도달 — 미설정 시 cross-node wake 0/2 재현). REALTIME_BACKPLANE 는 별개(cutover).
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},FANOUT_WAKE_REDIS_ENABLED=${FANOUT_WAKE_REDIS_ENABLED:-false}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},LLM_GEMINI_MODEL=gemini-3.1-pro-preview"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},LLM_GEMINI_LOCATION=global"
# ⚠️story #2142 TODO(실 배포 前 확認 필요) — MCP_PUBLIC_URL도 env 분기 밖 리터럴(dev 도메인
# 고정). sprintable-mcp-prod Cloud Run 서비스는 이미 존재하나(별도 배포 경로) 그 public
# 도메인이 실제로 "mcp.sprintable.ai"인지 이 스크립트가 확認할 수단이 없어 grep 0건 상태로
# 그대로 둔다 — 오르테가 DRY_RUN 검수 시 판단 요청.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},MCP_PUBLIC_URL=https://dev-mcp.sprintable.ai/mcp"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},LICENSE_CONSENT=agreed"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},FIREBASE_OAUTH_HANDOFF_ENABLED=1"
# realtime 고유값(backend/api와 다름 — cloudbuild.yaml deploy-realtime 스텝과 동일 컨벤션):
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},PG_LISTEN_ENABLED=false"
# story #2135(2026-07-23, #2123 실측 적발): 키 이름이 여태 `REDIS_CONSUME_ENABLED`였다 —
# Settings 필드(`event_broker_redis_consume_enabled`)와 안 맞아 pydantic-settings가 조용히
# 무시했다(GCE는 필드 기본값이 우연히 True라 결과만 의도와 같았음). 실제 필드가 요구하는
# 키로 정정.
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},EVENT_BROKER_REDIS_CONSUME_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED=true"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},EVENT_BROKER_REDIS_DISPATCH_ENABLED=true"
# ⚠️REDIS_URL은 Memorystore 내부 IP(10.164.120.243) — VPC 안에서만 유효, GCE도 같은 VPC/서브넷에
# 붙으므로 그대로 이관 가능(라이브 실측 그대로, 재실측 없이 하드코딩하지 않고 env로 override 가능하게).
REDIS_URL_VALUE="${REDIS_URL:-redis://10.164.120.243:6379}"
PLAIN_ENV_SPEC="${PLAIN_ENV_SPEC},REDIS_URL=${REDIS_URL_VALUE}"
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
SECRET_PAIRS="${SECRET_PAIRS} cron-secret:CRON_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} github-app-client-secret-${GITHUB_APP_SECRET_ENV}:GITHUB_APP_CLIENT_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} github-app-private-key-${GITHUB_APP_SECRET_ENV}:GITHUB_APP_PRIVATE_KEY"
SECRET_PAIRS="${SECRET_PAIRS} github-app-state-secret-${GITHUB_APP_SECRET_ENV}:GITHUB_APP_STATE_SECRET"
SECRET_PAIRS="${SECRET_PAIRS} FIREBASE_BFF_INTERNAL_SECRET:FIREBASE_BFF_INTERNAL_SECRET"
# DATABASE_URL_DEV 자체 이름으로도 참조되는 라이브 계약(코드가 두 이름 다 읽는 경로가
# 있을 수 있어 원본 그대로 이관 — config.py 확認 없이 값만 옮기는 원칙, 동작 변경 없음).
SECRET_PAIRS="${SECRET_PAIRS} ${DB_SECRET_NAME}:${DB_SECRET_NAME}"

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
    echo 'docker rm -f realtime-gateway 2>/dev/null || true'
    echo 'docker run -d --name realtime-gateway --restart=always \'
    echo '  -p 8000:8000 \'
    echo "  -v ${_HOST_SOCKET_DIR}:/cloudsql \\"
    for pair in ${SECRET_PAIRS}; do
        env_name="${pair##*:}"
        echo "  -e ${env_name}=\"\${${env_name}}\" \\"
    done
    # PLAIN_ENV_SPEC은 콤마 구분 KEY=VAL 목록 — docker run -e 인자로 한 줄씩 분해.
    IFS=',' read -ra _plain_pairs <<< "${PLAIN_ENV_SPEC}"
    for kv in "${_plain_pairs[@]}"; do
        echo "  -e ${kv} \\"
    done
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
    # story #2110(S1): 기존 2-zone MIG를 3-zone으로 확장·승계/정리.
    #
    # ⚠️핵심 실측(2026-07-22): **regional MIG의 zone 구성은 불변(immutable)**. gcloud `update`엔
    # --zones 플래그 자체가 없고(GA·beta 모두), Compute API `instanceGroupManagers.patch`로
    # distributionPolicy.zones를 넣으면 GCP가 400 "Zone configuration is immutable"로 거절한다
    # (기존 zone 재지정도, 신규 zone 추가도 불가). ⇒ 2→3-zone은 **재생성이 유일 경로**.
    # (오르테가군 in-place 승인은 zone 가변 전제였고, 이 실측이 그 전제를 바로잡아 재생성으로 확定.)
    #
    # 재생성 절차(파괴적이나 S1 범위 "기존 2-zone 승계/정리"에 포함·0트래픽 dev):
    #   ① backend-service(S2)에서 detach — GCP는 backend로 물린 MIG 삭제를 막으므로 필수.
    #      backend-service **설정 자체는 미변경**, MIG 멤버십만 제거(최소범위). 재attach는
    #      provision_realtime_gclb.sh(멱등)가 담당.
    #   ② 2-zone MIG 삭제(기존 노드 전량 제거 → "2-zone 잔재 0" 확실).
    #   ③ 아래 create 경로로 3-zone MIG 신규 생성.
    log "MIG ${MIG_NAME} exists but regional zones are immutable — recreating as 3-zone"

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

    # ② delete 2-zone MIG (동기 대기 — 삭제 완료 후 create가 이름 충돌 없이 진행).
    log "Deleting 2-zone MIG ${MIG_NAME} (기존 노드 전량 제거)"
    gcloud compute instance-groups managed delete "${MIG_NAME}" \
        --region="${GCP_REGION}" \
        --project="${GCP_PROJECT}" \
        --quiet
fi

# ③ create — 신규 3-zone MIG(재생성 경로 및 최초 생성 경로 공용).
log "Creating 3-zone MIG ${MIG_NAME} (size ${TARGET_SIZE}, zones ${ZONES}, no autoscaling)"
gcloud compute instance-groups managed create "${MIG_NAME}" \
    --project="${GCP_PROJECT}" \
    --region="${GCP_REGION}" \
    --template="${TEMPLATE_NAME}" \
    --size="${TARGET_SIZE}" \
    --zones="${ZONES}"

log "=== Deployment submitted ==="
log "Instance template: ${TEMPLATE_NAME}"
log "MIG: ${MIG_NAME} (region ${GCP_REGION})"
log "Health check target: /api/v2/ping (DB 미조회, GCLB 스택은 provision_realtime_gclb.sh 참조)"
