"""story #2141(E-ARCH, 2026-07-23): cloudbuild.yaml deploy-backend REDIS_URL env/secret 충돌 방지.

Cloud Build 스텝은 DRY_RUN 모드가 없어(gcloud CLI 스크립트와 다름) deploy_realtime_gce.sh류
DRY_RUN 검증을 그대로 못 쓴다 — 대신 ENV_VARS 조립 로직을 cloudbuild.yaml에서 그대로 추출해
독립 실행하고 dev/prod의 REDIS_URL 포함 여부를 검증한다(오르테가 확定 산출물).

⛔story #2421/#2423 배포 실패 핫픽스(2026-07-23, 2건 연속) — 1차: 이 파일의 첫 버전은 추출한
스크립트를 곧바로 bash로 실행해 통과했지만, 실 Cloud Build에는 여기 없는 층이 하나 더 있다:
args 문자열 전체가 먼저 Cloud Build 자신의 substitution 파서를 거친다. 달러중괄호로 셸 변수를
참조하면 Cloud Build가 "유효한 substitution이 아니다"로 build submit 자체를 거부한다(bash가
실행되기도 전) — 셸에서 직접 돌리면 정상 동작하는 것과 완전히 다른 실패 모드라 그 층을 건너뛴
첫 테스트는 이 결함을 못 잡았다.

2차(더 지독한 재발) — 1차 수정 직후 정적 가드 테스트를 추가했는데, 그 테스트가 "주석 줄은
스캔에서 제외"라는 규칙을 넣었다(자기 자신의 설명 주석이 예시로 문제의 표기를 언급하는 것까지
코드로 오인해 실패하는 것을 막으려던 의도). 그런데 실제 Cloud Build 파서는 args 문자열 전체를
그냥 문자열로 훑을 뿐 bash 주석 여부를 전혀 가리지 않는다 — 그래서 그 사고를 "설명하는" 주석
문장 자신이 예시로 그 표기를 그대로 써서 실제로 build submit을 다시 거부시켰다(계측기가 실제
Cloud Build보다 관대했던 것 — 테스트가 모델링한 계층과 실제 계층이 어긋난 전형적인 형태).
⇒ 주석 제외 규칙을 제거했다 — Cloud Build가 안 가리니 테스트도 안 가려야 한다.

`_apply_cloudbuild_escaping()`이 `$$`→`$` 치환 층을 재현하고,
`test_deploy_backend_no_unescaped_shell_vars_in_cloudbuild_substitution_syntax`가(주석 포함
전문 스캔으로) 회귀를 원천 차단한다(추출한 스크립트를 실행하지 않고 정적으로 스캔 — 셸
계층과 무관).

story #3118(Sign in with Apple, PO 확定 2026-08-26) — deploy-backend에 Apple OAuth 식별자
3종(APPLE_SERVICES_ID·APPLE_KEY_ID·APPLE_TEAM_ID, plain env)+개인키 1종(APPLE_PRIVATE_KEY,
Secret Manager `APPLE_SIWA_PRIVATE_KEY`, dev/prod 공용) 추가. Services ID/Key ID는 공개돼도
무해한 식별자(시크릿 아님) — Team ID는 기존 `_APPLE_TEAM_ID`(AASA 라우트, deploy-frontend)를
그대로 재사용한다(같은 값, 새 substitution 아님). 셋 다 cloudbuild.yaml 인라인 주석은 story
#3031 바이트 한도(아래) 여유가 빠듯해 짧게만 남기고, 전체 맥락은 이 docstring이 SSOT다.

## deploy-backend 인라인 주석 아카이브 (story #3124, 2026-08-26)

story #3031(2026-08-24) 실사고 — deploy-realtime 스텝이 UTF-8 바이트 한도(10,000, "max: 10000"
Cloud Build 에러 그대로)를 넘겨 dev 배포가 2연속 실패했다. deploy-backend는 그 사고 이후에도
매 story마다 인라인 주석이 계속 자라 9,829/10,000(98.3%, 여유 171B)까지 차, 다음 env 1~2개
추가만으로도 재발하는 구조였다(미르코·카디르 2026-08-26 이중 확認). story #3527(#3118)이 신규
추가분은 짧게 남겼지만 **기존** 주석은 그대로였다 — 이 스토리가 그 기존 서사를 전부 여기로
옮기고 cloudbuild.yaml엔 story 번호+한 줄 포인터만 남긴다(값/로직은 전혀 안 건드림, 순수 주석
재배치). 원문(요약 없이 옮김):

- **story #2005**: 요청 타임아웃 명시화(`_BACKEND_TIMEOUT`) — 이전엔 이 플래그 자체가 없어 Cloud
  Run 인프라 기본값에 암묵 의존했다.
- **--allow-unauthenticated 필수**: frontend가 `NEXT_PUBLIC_FASTAPI_URL`로 backend를 직접
  호출(public 필수). 없으면 `gcloud run deploy`가 기존 IAM을 preserve(non-deterministic)해
  신규/리셋 시 allUsers invoker 유실로 403(2026-06-21 prod promotion 사건).
- **OB-1**: 에이전트 onboarding generator가 읽는 backend-direct URL을 런타임 env로 주입.
- **--update-env-vars(additive) 필수**: 기존 backend env(DATABASE_URL 등) 보존. `--set-env-vars`
  금지(전체 wipe).
- **story #2442(P0)**: `DB_POOL_SIZE`/`DB_MAX_OVERFLOW`가 env별 substitution(`_DB_POOL_SIZE`/
  `_DB_MAX_OVERFLOW`, GHA per-env override, `_BACKEND_MAX_INSTANCES`와 동일 배선 패턴)이 됨 —
  dev는 #2040 검증값(3/1) 그대로, prod는 P0 완화값(20/10) durable화. rollout 산식:
  `2×maxScale×(pool+overflow+pg_pubsub raw 1) ≤ DB max_conn` — 값 바꿀 때 cloud-build.yml의
  maxScale·db_pool_size/db_max_overflow output과 짝으로 검토.
- **story #2078(E-ARCH 1단계)**: `PG_LISTEN_ENABLED` durable화(dev=false·prod=true, GHA per-env).
- **story #2078/#2123 정정**: `EVENT_BROKER_REDIS_CONSUME_ENABLED`/`_DISPATCH_ENABLED` durable화
  — "api는 SSE 미서빙" 전제가 틀렸음이 드러나 값을 true로 정정(에이전트 SSE가
  `agent_onboarding_config.py` 설계상 backend-dev를 직접 서빙). 키 이름도 story #2135에서 정정
  (구 `REDIS_CONSUME_ENABLED`는 Settings 필드와 안 맞아 무시되던 키) — 구 키는
  `--remove-env-vars`로 명시 제거(안 지우면 두 키 공존, additive 함정).
- **story #2123 S0-b**: `FANOUT_WAKE_REDIS_ENABLED`(dev만 true, prod는 손대지 않음).
- **story #2141(2026-07-23, prod Redis Memorystore 전환)**: `REDIS_URL`을 이 스텝이 예전엔
  dev/prod 공용으로 plain env 넘겼다 — prod는 Secret Manager 바인딩(`REDIS_URL_PROD`, AUTH
  필요)으로 전환하는데, 같은 배포에 plain `REDIS_URL` 키까지 넘기면 Cloud Run이 "env와 secret이
  동명 키"로 배포 자체를 거부한다(값 유무 무관 — 키 존재 자체가 충돌). dev는 AUTH 없는 plain
  Memorystore라 시크릿 바인딩 자체가 없으므로 기존처럼 plain으로 넘긴다. prod는 여기서
  `REDIS_URL`을 절대 안 넘김 — 시크릿 바인딩(별도 1회 gcloud, PO lane)이 `--set-secrets` 없는 이
  스텝에 preserve된다(`DATABASE_URL_PROD` 등 기존 15개와 동일 컨벤션).
- **⛔story #2423 배포 실패 핫픽스(2026-07-23, 오르테가군 진단, 2차)**: Cloud Build는 bash 스텝
  안이라도 args 문자열 전체(주석 포함 — bash에겐 주석이지만 Cloud Build 파서는 주석/코드를
  구분하지 않고 그냥 문자열로 훑는다)를 자기 substitution 파서로 먼저 훑는다. 셸 변수 ENV_VARS는
  유효한 built-in/사용자 substitution이 아니라서, 달러중괄호 표기로 참조하면(설명 예시로 적어도
  마찬가지) build submit 자체가 INVALID_ARGUMENT로 거부된다(부분 배포 없이 안전하게 막힘 — 1차
  사고와 동일 에러, 이번엔 그 사고를 설명하던 주석 문장 자체가 같은 표기를 그대로 써서
  재현했다). 이후 이 파일 어디서도 ENV_VARS를 달러중괄호로 예시조차 적지 않는다 — 셸 변수
  실참조는 달러 두 개로 이스케이프한 표기만 쓴다(진짜 substitution인 DEPLOY_ENV 등은 달러 한 개
  표기 그대로 유지 — Cloud Build가 실제로 채워야 하는 값이라 안전하다).
- **story #2777**: `ADMIN_OPERATOR_AUDIENCE`/`ALLOWLIST`도 REDIS_URL과 동일 원칙: dev만 싣는다.
  prod는 이 두 env var 자체가 없어(`require_admin_operator`가 `auth_configured` 부재를
  fail-closed 503으로 처리) 대표 승인 前 prod 결제 개입 전면금지 태세와 정합.
- **story #3117(2026-08-26, prod 실사고 후속)**: `GCS_AVATARS_BUCKET`은 REDIS_URL/
  ADMIN_OPERATOR_*와 달리 dev/prod 양쪽 다 명시 값으로 싣는다(prod 버킷 `gs://sprintable-avatars-
  prod` PO 프로비저닝 완료 — story #2887의 "prod엔 키 자체가 없어야 안전" 유보 전제가 사라짐,
  그 유보가 실사용 503으로 터진 게 이 스토리).
- **카디르 QA(2026-08-19)**: office-converter 자체가 dev 전용 하드게이트인데(deploy-office-
  converter 스텝) 이 배선엔 REDIS_URL/ADMIN_OPERATOR_*와 같은 `_DEPLOY_ENV != prod` 게이트가
  빠져 있었다. `_GOTENBERG_SERVICE_URL` 기본값이 빈 문자열이라 무해했지만, prod substitution에
  값이 실수로 채워지는 단 한 번의 수동 bootstrap 오조작만으로 prod backend가 dev
  office-converter로 테넌트 pptx를 흘리는 구조가 된다 — 값의 유무가 아니라 prod에서는 이 키
  자체가 없어야 안전(story #2141 REDIS_URL과 동일 원칙). dev만 싣는다.
- **story #2445 Phase1(2026-08-03)**: dev만 `DATABASE_URL`/`DATABASE_URL_DIRECT`를 PgBouncer
  경유 시크릿으로 재바인딩(`--update-secrets`=additive, 기존 다른 시크릿 preserve — REDIS_URL_
  PROD 등과 동일 컨벤션). prod는 이 플래그 자체를 안 넘겨 현재 `DATABASE_URL_PROD` 바인딩
  무변경. 시크릿 자체(`DATABASE_URL_DEV_PGBOUNCER`/`DATABASE_URL_DIRECT_DEV`)는 PO가 생성.
- **story #3110 1보(2026-08-26, 보안 위생)**: `DATABASE_URL_DIRECT`는 postgres 수퍼유저 DSN
  (`DATABASE_URL_DIRECT_DEV`)이었다(`pg_pubsub.py` LISTEN/NOTIFY 전용 소비 — 애초에 수퍼유저가
  필요 없는 경로). sprintable 앱 유저는 이미 public 197테이블 전부에 GRANT 보유(#3110 실측,
  postgres 116/197보다도 넓음) — 신규 시크릿 `DATABASE_URL_DIRECT_DEV_SPRINTABLE`(PO 발급·PO
  실왕복 검증: current_user=sprintable·SELECT OK)로 전환. `DATABASE_URL`(PgBouncer 경유)은 이번
  스코프 밖 — 유저 스왑이 PgBouncer userlist 갱신과 짝이라(안 맞추면 dev 서빙 인증 실패) #3110
  2보로 분리.
- **story #2445 Phase1(2026-08-04)**: prod cutover — `DATABASE_URL`→PgBouncer VIP
  (`DATABASE_URL_PROD_PGBOUNCER`, =10.178.0.111:6432), `DATABASE_URL_DIRECT`→직결
  (`DATABASE_URL_PROD`). `_BACKEND_DB_PGBOUNCER`=true와 짝. 시크릿은 PO 생성·backend-prod SA
  (`cloudrun-runtime-prod`)에 secretAccessor 부여됨. + `DATABASE_URL_READ`(#2451 §6 읽기 라우팅,
  rev 00266 라이브 flip): read replica DSN(PgBouncer sprintable_read 풀 경유). 지금까지 라이브
  「수동 바인딩」이라 배포 SSOT 어디에도 선언이 없어 env-drift-guard 축①이 매일 빨강이었다
  (additive `--update-secrets`라 값은 보존됐으나 미선언=fragile: `--set-secrets` 리팩터·서비스
  재생성 時 조용히 소실→reads가 primary로 새 병목 악화). 여기 편입해 durable화.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"

# cloudbuild.yaml 최상위 substitutions: 블록에 선언된 키 + GCP 내장 substitution.
# story #2421 핫픽스 테스트가 이 목록 밖의 `${...}` 참조를 전부 "이스케이프 안 된 셸 변수"로 간주한다.
_DECLARED_SUBSTITUTIONS = {
    "_AR_REGION", "_AR_REPO", "_DEPLOY_ENV", "_FASTAPI_URL", "_BACKEND_MIN_INSTANCES",
    "_BACKEND_MAX_INSTANCES", "_DB_POOL_SIZE", "_DB_MAX_OVERFLOW", "_BACKEND_DB_PGBOUNCER", "_BACKEND_TIMEOUT", "_REALTIME_MIN_INSTANCES",
    "_REALTIME_MAX_INSTANCES", "_REALTIME_TIMEOUT", "_REALTIME_URL", "_FRONTEND_TIMEOUT",
    "_BACKEND_PG_LISTEN_ENABLED", "_BACKEND_REDIS_CONSUME_ENABLED",
    "_BACKEND_REDIS_DISPATCH_ENABLED", "_BACKEND_REDIS_DUAL_PUBLISH_ENABLED", "_REDIS_URL",
    "_BACKEND_FANOUT_WAKE_REDIS_ENABLED", "_SSE_MULTIPLEX_ENABLED",
    "_BACKEND_PRESENCE_REDIS_ENABLED", "_BACKEND_PRESENCE_ONLINE_REDIS_ENABLED",
    "_BACKEND_SSE_LEASE_REDIS_ENABLED", "_BACKEND_SSE_TRANSIENT_REPLAY_ENABLED",
    "_FRONTEND_MIN_INSTANCES", "_FRONTEND_MAX_INSTANCES", "_LICENSE_CONSENT",
    # story aec3ec09([P1 후속] OAuth 핸드오프 활성화) — LICENSE_CONSENT와 동일 배선 클래스.
    "_FIREBASE_OAUTH_HANDOFF_ENABLED",
    "_NEXT_PUBLIC_APP_URL", "_ADMIN_OPERATOR_AUDIENCE", "_ADMIN_OPERATOR_ALLOWLIST",
    # story #2771 — office-converter(Gotenberg) URL, deploy-office-converter 스텝과 짝.
    "_GOTENBERG_SERVICE_URL", "_OFFICE_CONVERTER_MAX_INSTANCES",
    # story #2887 — avatar 전용 GCS 버킷, deploy-backend dev 분기(ADMIN_OPERATOR_*와 동일 패턴).
    "_GCS_AVATARS_BUCKET",
    # story #3079 — realtime path-filter 판정을 GHA에서 계산해 넘기는 skip 플래그(GCE·Cloud Run).
    "_REALTIME_GCE_SKIP", "_REALTIME_CLOUDRUN_SKIP",
    # story #3118(Sign in with Apple) — deploy-backend(bash entrypoint)가 이제 이 3개를
    # 직접 참조한다. _APPLE_TEAM_ID는 이전엔 deploy-frontend(순수 gcloud args 리스트 —
    # 이 가드가 스캔하는 4개 bash 스텝 밖)에서만 쓰여 이 목록에 없어도 무해했으나, backend
    # 쪽으로도 재사용하며 처음 걸린다.
    "_APPLE_SERVICES_ID", "_APPLE_KEY_ID", "_APPLE_TEAM_ID",
    # story #3263(지원v1·5에스컬레이션) — 메일 «고객센터» fiction 정정, 위젯 prod 승격과
    # 같은 커밋으로 묶는 env 분기. deploy-backend ENV_VARS가 이제 이 값을 직접 참조.
    "_SUPPORT_CONTACT_SURFACE_WIDGET",
    # story #3263(같은 스토리 AC1/2) — 에스컬레이션 게이트/DM 배선(requester·approver
    # team_members.id·moonklabs org/project slug). deploy-backend ENV_VARS가 이제 이 4개를
    # 직접 참조.
    "_SUPPORT_ESCALATION_REQUESTER_MEMBER_ID", "_SUPPORT_ESCALATION_APPROVER_MEMBER_ID",
    "_SUPPORT_ESCALATION_TARGET_ORG_SLUG", "_SUPPORT_ESCALATION_TARGET_PROJECT_SLUG",
    "PROJECT_ID", "PROJECT_NUMBER", "BUILD_ID", "COMMIT_SHA", "SHORT_SHA",
    "REPO_NAME", "BRANCH_NAME", "TAG_NAME", "REVISION_ID", "LOCATION",
}


# Cloud Build의 substitution 파서가 실제로 훑는 대상 = entrypoint: bash 스텝의 args 블록
# 스칼라 문자열뿐이다(오르테가 실측, 2026-07-23) — YAML 레벨 주석(이 스칼라 밖)은 YAML
# 파서가 먼저 걷어내 Cloud Build가 아예 보지 못한다. 그래서 가드 스캔 스코프를 파일 전체가
# 아니라 이 스텝들로 좁힌다 — 넓히면 순수 YAML 주석(예: 다른 스텝을 설명하는 프로즈 안의
# `${ENV}` 언급)에 오탐이 나서 안전한 주석을 억지로 고치게 만든다. bash entrypoint 스텝이
# 새로 생기면 이 목록에 추가할 것(오르테가 지시 — deploy-realtime도 같은 함정 자리라 포함).
# story #2771 후속(2026-08-19) — deploy-office-converter도 실 substitution(${_DEPLOY_ENV} 등)을
# 쓰는 bash entrypoint라 포함.
_BASH_ENTRYPOINT_STEP_IDS = (
    "deploy-backend", "deploy-realtime", "deploy-office-converter", "apply-gcs-attachments-cors",
)


def _extract_step_script(step_id: str) -> str:
    """cloudbuild.yaml의 지정 스텝 bash 스크립트 본문을 그대로 추출(원문 그대로 — $$ 이스케이프 미처리)."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == step_id)
    assert step["entrypoint"] == "bash", f"{step_id}가 더 이상 bash entrypoint가 아님 — 이 테스트 갱신 필요"
    # args: ["-c", "<script>"]
    return step["args"][1]


def _extract_deploy_backend_script() -> str:
    return _extract_step_script("deploy-backend")


def _apply_cloudbuild_escaping(script: str) -> str:
    """Cloud Build가 args 문자열을 bash에 넘기기 前 수행하는 `$$` → `$` 치환을 재현.

    story #2421 교훈 — 이 전처리 없이 원문을 바로 bash에 넘기면 `$$`(bash에서 PID로 해석)가
    남아 실제 배포와 다르게 동작한다. 이 함수가 그 간극을 메운다.
    """
    return script.replace("$$", "$")


def _run_env_vars_assembly(deploy_env: str, redis_url: str, gotenberg_url: str = "") -> str:
    """실제 gcloud 호출부만 잘라내고 ENV_VARS 조립 로직까지만 실행 — 실제 배포 없이 결과 문자열만 얻는다."""
    script = _apply_cloudbuild_escaping(_extract_deploy_backend_script())
    # 실제 gcloud run deploy 호출 라인 이후는 잘라내고 ENV_VARS를 echo하도록 붙인다.
    # ⚠️"gcloud run deploy"만으로 찾으면 그 문구를 언급하는 주석(설명 문장)에 먼저 매치된다 —
    # 실제 호출부에만 있는 서비스명까지 포함해 정확히 그 라인을 찾는다.
    marker = "gcloud run deploy sprintable-backend"
    idx = script.index(marker)
    assembly_only = script[:idx] + '\necho "RESULT_ENV_VARS=${ENV_VARS}"\n'

    env = {
        **os.environ,
        "_DEPLOY_ENV": deploy_env,
        "_FASTAPI_URL": "https://example.run.app",
        "_DB_POOL_SIZE": "3",
        "_DB_MAX_OVERFLOW": "1",
        "_BACKEND_DB_PGBOUNCER": "false",
        "_BACKEND_PG_LISTEN_ENABLED": "true",
        "_BACKEND_REDIS_CONSUME_ENABLED": "false",
        "_BACKEND_REDIS_DISPATCH_ENABLED": "false",
        "_BACKEND_REDIS_DUAL_PUBLISH_ENABLED": "false",
        "_BACKEND_FANOUT_WAKE_REDIS_ENABLED": "false",
        "_BACKEND_PRESENCE_REDIS_ENABLED": "false",
        "_BACKEND_PRESENCE_ONLINE_REDIS_ENABLED": "false",
        "_BACKEND_SSE_LEASE_REDIS_ENABLED": "false",
        "_BACKEND_SSE_TRANSIENT_REPLAY_ENABLED": "false",
        "_REDIS_URL": redis_url,
        "_LICENSE_CONSENT": "agreed",
        # story aec3ec09 — set -u라 미설정이면 스크립트가 죽는다(LICENSE_CONSENT와 동일 이유).
        "_FIREBASE_OAUTH_HANDOFF_ENABLED": "false",
        "_NEXT_PUBLIC_APP_URL": "https://example.run.app",
        "_ADMIN_OPERATOR_AUDIENCE": "https://example-audience.run.app",
        "_ADMIN_OPERATOR_ALLOWLIST": "operator@example.iam.gserviceaccount.com",
        # story #2887 — set -u라 미설정이면 스크립트가 죽는다(ADMIN_OPERATOR_*와 동일 이유).
        "_GCS_AVATARS_BUCKET": "sprintable-avatars-dev",
        # story #2771 — 기본 빈 문자열(substitutions 기본값과 정합, set -u라 미설정이면 스크립트가
        # 죽는다 — 여기 없으면 이 테스트 전체가 붕괴).
        "_GOTENBERG_SERVICE_URL": gotenberg_url,
        # story #3118 — set -u라 미설정이면 스크립트가 죽는다(GOTENBERG_SERVICE_URL과 동일 이유).
        # 값은 cloudbuild.yaml substitutions 기본값과 정합(비밀 아님, dev/prod 동일).
        "_APPLE_SERVICES_ID": "ai.sprintable.web",
        "_APPLE_KEY_ID": "DF2G3UV649",
        "_APPLE_TEAM_ID": "JN798BC4KC",
        # story #3263 — set -u라 미설정이면 스크립트가 죽는다(APPLE_TEAM_ID 등과 동일 이유).
        # 값은 cloudbuild.yaml substitutions 기본값과 정합(prod 현재값 — 위젯 미승격 상태).
        "_SUPPORT_CONTACT_SURFACE_WIDGET": "false",
        # story #3263(같은 스토리 AC1/2) — 값은 cloudbuild.yaml substitutions 기본값과 정합
        # (빈 문자열 — PO가 dev 배선 시 채움).
        "_SUPPORT_ESCALATION_REQUESTER_MEMBER_ID": "",
        "_SUPPORT_ESCALATION_APPROVER_MEMBER_ID": "",
        "_SUPPORT_ESCALATION_TARGET_ORG_SLUG": "moonklabs",
        "_SUPPORT_ESCALATION_TARGET_PROJECT_SLUG": "sprintable",
    }
    proc = subprocess.run(
        ["bash", "-c", assembly_only],
        capture_output=True, text=True, env=env, check=True,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("RESULT_ENV_VARS="):
            return line[len("RESULT_ENV_VARS="):]
    raise AssertionError(f"ENV_VARS not found in output: {proc.stdout!r}")


def test_deploy_backend_no_unescaped_shell_vars_in_cloudbuild_substitution_syntax():
    """⭐story #2421/#2423 회귀 방지 핵심 AC — Cloud Build가 build submit 자체를 거부하는 층을 정적으로 잡는다.

    달러중괄호 형태로 스크립트에 등장하는 이름이 cloudbuild.yaml의 substitutions: 선언 또는
    GCP 내장 변수 목록에 없다면, 그건 이스케이프(달러 두 개) 안 된 셸 변수 참조 — 실 Cloud
    Build가 "key ... is not a valid built-in substitution"로 build를 거부한다(부분 배포 없이
    막히지만, dev 파이프라인 전체가 멈춘다 — #2421 실 사고).

    ⛔#2423 재발 교훈 — **주석 줄을 제외하지 않는다.** Cloud Build의 substitution 파서는 args
    문자열 전체를 그냥 문자열로 훑고 bash 주석 여부를 전혀 가리지 않는다. 이전 버전이 주석을
    스캔에서 뺐다가 "이 사고를 설명하는 주석 자신이 그 표기를 예시로 써서 사고를 재현"하는
    것을 놓쳤다 — 그 재발이 이 규칙을 없앤 이유다. 새 주석을 쓸 때도 달러중괄호로 미선언
    이름을 언급하면(설명 목적이라도) 이 테스트가 실패해야 정상이다.

    스캔 범위는 파일 전체가 아니라 `_BASH_ENTRYPOINT_STEP_IDS`의 args 블록 스칼라로 한정한다
    (오르테가 확認, 2026-07-23) — Cloud Build는 그 스칼라 문자열만 보고, YAML 레벨 주석(스텝
    args 밖의 프로즈)은 YAML 파서가 먼저 걷어내 Cloud Build가 아예 못 본다. 파일 전체로
    넓히면 그런 순수 YAML 주석에 오탐이 나서(실측: 다른 스텝을 설명하는 주석이 예시로
    `${ENV}` 를 언급하는 자리) 안전한 문장을 억지로 고치게 된다.
    """
    for step_id in _BASH_ENTRYPOINT_STEP_IDS:
        script = _extract_step_script(step_id)
        # `$$`(이스케이프)로 시작하는 자리는 실제 셸 변수 참조라 스킵 — `$$` 다음 글자부터 다시 스캔.
        # 정규식으로 `$$` 뒤에 오는 참조는 애초에 매치 대상에서 제외(단일 `$`만 substitution 후보).
        # 주석 포함 스크립트 원문 전체를 스캔한다(주석 제외 금지 — 위 docstring 참조).
        unescaped = re.findall(r"(?<!\$)\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", script)
        unknown = sorted(set(unescaped) - _DECLARED_SUBSTITUTIONS)
        assert not unknown, (
            f"cloudbuild.yaml {step_id} 스텝에 이스케이프 안 된(달러 두 개 누락) 셸 변수로 "
            f"보이는 미선언 substitution 참조 발견(주석 포함 전문 스캔): {unknown} — 셸 변수라면 "
            f"달러 두 개로 이스케이프할 것. 설명 주석이라도 달러중괄호로 이 이름들을 언급하지 말 것."
        )


_CLOUDBUILD_STEP_ARG_BYTE_LIMIT = 10_000


def test_bash_entrypoint_steps_under_cloudbuild_arg_byte_limit():
    """⭐story #3031 핫픽스(2026-08-24) — Cloud Build 실사고: `deploy-realtime` 스텝이
    "invalid .steps field: build step 11 arg 1 too long (max: 10000)"로 dev develop
    배포를 2연속 실패시켰다(4d8014ab3·2406e6f89).

    함정의 본체: 그 스텝은 **문자 수로는 7,590자**(다른 스텝들과 비슷한 규모)였는데
    **UTF-8 바이트로는 11,459바이트**였다 — 한글 완성형 1글자가 UTF-8에서 3바이트라,
    한글 주석이 많은 스텝은 "문자 수 감각"으로 안전해 보여도 실제 한도(Cloud Build는
    **바이트** 기준)를 조용히 넘길 수 있다. 리뷰에서 육안으로 "길다"는 못 느끼면서
    바이트 한도를 넘기는 이 클래스는 다시 재발할 수 있다 — 그래서 문자 수가 아니라
    **`.encode('utf-8')` 길이**로 정적 고정한다(에디터 표시 글자수를 믿지 않는다).

    ⛔PO 리뷰 지적(2026-08-24, PR#3455 1라운드) — 최초 버전은 `_BASH_ENTRYPOINT_STEP_IDS`
    (substitution-escape 가드용 4개 목록, 위)만 순회해 apply-gcs-avatars-cors·
    update-migrate-job·deploy-mcp·deploy-realtime-gce 4개 스텝이 가드 밖이었다 — 이
    함정은 "한글 주석이 자라는 어느 bash 스텝에서든" 재발하는 클래스라 목록 상수(용도가
    다른 가드와 공유하는 고정 집합)로는 원천적으로 사각을 만든다. 그래서 이 가드만큼은
    `entrypoint == "bash"`인 스텝 **전부**를 cloudbuild.yaml에서 동적으로 순회한다(신규
    bash 스텝이 나중에 추가돼도 목록 갱신 없이 자동 커버 — `_BASH_ENTRYPOINT_STEP_IDS`는
    $$ substitution 가드 용도로만 그대로 둔다, 그쪽은 실 substitution 참조가 있는
    스텝만 의도적으로 좁힌 것이라 별개 스코프).

    ⛔이 값(10,000)은 story #3031 사고 당시 GitHub 에러 메시지("max: 10000")를 그대로
    반영한 것 — Cloud Build 쪽 실제 한도가 바뀌면(추정: 인프라 변경 없이는 안 바뀜) 이
    상수도 같이 갱신할 것.
    """
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    bash_steps = [s for s in doc["steps"] if s.get("entrypoint") == "bash"]
    assert bash_steps, "cloudbuild.yaml에 bash entrypoint 스텝이 0개 — 이 가드 자체가 무의미해짐(파일 구조 변경 의심)"
    for step in bash_steps:
        script = step["args"][1]
        byte_len = len(script.encode("utf-8"))
        assert byte_len < _CLOUDBUILD_STEP_ARG_BYTE_LIMIT, (
            f"cloudbuild.yaml {step['id']} 스텝 args가 UTF-8 {byte_len}바이트로 Cloud Build "
            f"한도({_CLOUDBUILD_STEP_ARG_BYTE_LIMIT})를 넘김(문자 수={len(script)} — 문자 "
            "수만으로는 안 걸리는 게 story #3031 사고의 정확한 함정). 긴 한글 주석은 "
            "관련 테스트 파일 docstring 등 외부로 옮기고 스텝엔 짧은 포인터만 남길 것."
        )


# story #3124(2026-08-26) — deploy-backend가 9,829/10,000(98.3%, 여유 171B)까지 자라 다음
# env 1~2개 추가만으로도 #3031급 사고가 재발하는 구조였다. 위 test_bash_entrypoint_steps_
# under_cloudbuild_arg_byte_limit()의 <10,000 하드 컷은 "이미 넘은 뒤"에만 CI를 빨갛게
# 한다 — submit 시점까지 아무도 재지 않는 사각과 본질적으로 같은 모양(닥쳐서야 아는 것).
# 90%(9,000B)를 넘는 순간 CI를 미리 빨갛게 해 "다음 PR이 그냥 넘겨버리는" 걸 막는다.
_CLOUDBUILD_STEP_ARG_BYTE_WARN_RATIO = 0.9


def test_bash_entrypoint_steps_have_byte_headroom():
    """⭐story #3124 — 바이트 한도의 90%(9,000B)를 넘는 bash 스텝이 있으면 실패. 하드 한도
    (10,000B, 위 테스트)와 별개 축 — 그 테스트는 "이미 넘었다"만 잡고, 이 테스트는 "곧 넘긴다"를
    미리 잡는다(구조적 여유 확保가 이 스토리의 핵심 AC, 그 여유가 실제로 있는지를 이 테스트가
    영구히 재확인한다). deploy-backend는 이 스토리에서 9,829→4,391B로 낮췄다(여유
    5,609B, AC1의 ≥2,000B 목표 초과 달성) — 다른 bash 스텝이 이 임계를 넘으면 그 스텝도
    같은 방식(서사 주석 외부화)으로 손볼 시점이라는 신호."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    bash_steps = [s for s in doc["steps"] if s.get("entrypoint") == "bash"]
    warn_threshold = int(_CLOUDBUILD_STEP_ARG_BYTE_LIMIT * _CLOUDBUILD_STEP_ARG_BYTE_WARN_RATIO)
    over_threshold = []
    for step in bash_steps:
        byte_len = len(step["args"][1].encode("utf-8"))
        if byte_len >= warn_threshold:
            over_threshold.append(
                f"{step['id']}: {byte_len}B/{_CLOUDBUILD_STEP_ARG_BYTE_LIMIT}B "
                f"({byte_len * 100 // _CLOUDBUILD_STEP_ARG_BYTE_LIMIT}%)"
            )
    assert not over_threshold, (
        f"bash 스텝이 바이트 한도의 {int(_CLOUDBUILD_STEP_ARG_BYTE_WARN_RATIO * 100)}%"
        f"({warn_threshold}B)를 넘었다 — 다음 env/secret 1~2개 추가로 #3031급 submit 실패가 "
        f"재발할 수 있는 구조: {over_threshold}. 서사 주석을 관련 테스트 파일 docstring으로 "
        "외부화하거나 스텝을 분할해 여유를 만들 것(story #3124가 deploy-backend에 적용한 패턴)."
    )


def test_deploy_backend_is_bash_entrypoint():
    """story #2141 정정 — env 조건분기를 위해 gcloud 단순 args에서 bash로 전환됐다."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-backend")
    assert step["entrypoint"] == "bash"
    assert "set -euo pipefail" in step["args"][1], "실패 시 배포가 조용히 반쪽 되지 않도록 하는 안전장치 누락"


def test_deploy_backend_dev_includes_plain_redis_url():
    """dev: AUTH 없는 plain Memorystore — 시크릿 바인딩이 없으므로 기존처럼 plain env로 넘긴다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert "REDIS_URL=redis://10.164.120.243:6379" in result


def test_deploy_backend_prod_excludes_plain_redis_url():
    """⭐#2141 핵심 AC — prod는 REDIS_URL을 절대 plain env로 안 넘긴다(Secret Manager 바인딩과
    동명 충돌 방지, 값의 유무와 무관하게 키 자체가 없어야 한다)."""
    result = _run_env_vars_assembly("prod", "")
    assert "REDIS_URL" not in result


def test_deploy_backend_dev_includes_admin_operator_env_vars():
    """story #2777 — dev는 ADMIN_OPERATOR_AUDIENCE/ALLOWLIST를 plain env로 넘긴다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert "ADMIN_OPERATOR_AUDIENCE=https://example-audience.run.app" in result
    assert "ADMIN_OPERATOR_ALLOWLIST=operator@example.iam.gserviceaccount.com" in result


def test_deploy_backend_prod_excludes_admin_operator_env_vars():
    """⭐story #2777 핵심 AC — prod는 ADMIN_OPERATOR_AUDIENCE/ALLOWLIST를 절대 안 싣는다(⛔대표
    승인 前 prod 결제 개입 전면금지 태세 — require_admin_operator가 미설정을 fail-closed 503으로
    처리해, 이 두 키가 없으면 그 엔드포인트 자체가 prod에서 항상 503)."""
    result = _run_env_vars_assembly("prod", "")
    assert "ADMIN_OPERATOR_AUDIENCE" not in result
    assert "ADMIN_OPERATOR_ALLOWLIST" not in result


def test_deploy_backend_dev_includes_avatars_bucket_env_var():
    """story #2887 — dev는 GCS_AVATARS_BUCKET을 plain env로 넘긴다(ADMIN_OPERATOR_*와 동일 배선)."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert "GCS_AVATARS_BUCKET=sprintable-avatars-dev" in result


def test_deploy_backend_prod_includes_avatars_bucket_env_var():
    """⭐story #3117(2026-08-26, prod 실사고 후속) — prod 버킷(gs://sprintable-avatars-prod)을
    PO가 프로비저닝 완료해 REDIS_URL/ADMIN_OPERATOR_*와 같던 "prod엔 키 자체가 없어야 안전"
    유보가 풀렸다. 그 유보가 실사용 503(AVATAR_UPLOAD_NOT_CONFIGURED)으로 터진 게 이 스토리라
    이제 prod는 substitution이 아닌 prod 전용 리터럴 버킷명을 싣는다(dev와 다른 값 — 취급
    혼동 방지 위해 하드코딩 확인)."""
    result = _run_env_vars_assembly("prod", "")
    assert "GCS_AVATARS_BUCKET=sprintable-avatars-prod" in result


def test_deploy_backend_includes_gotenberg_service_url_when_set():
    """story #2771 — 부트스트랩 후(_GOTENBERG_SERVICE_URL 채워짐) env var가 실린다."""
    result = _run_env_vars_assembly(
        "dev", "redis://10.164.120.243:6379", gotenberg_url="https://office-converter-dev.example.run.app"
    )
    assert "GOTENBERG_SERVICE_URL=https://office-converter-dev.example.run.app" in result


def test_deploy_backend_excludes_gotenberg_service_url_when_unset():
    """⭐story #2771 부트스트랩 전 상태 — 빈 값이면 키 자체를 안 싣는다(office_conversion.py가
    미설정을 503 fail-closed로 처리하므로 이게 안전한 기본 상태)."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379", gotenberg_url="")
    assert "GOTENBERG_SERVICE_URL" not in result


def test_deploy_backend_prod_excludes_gotenberg_service_url_even_when_set():
    """⭐QA catch(카디르군, 2026-08-19) 회귀 방지 — office-converter는 dev 전용 하드게이트
    (deploy-office-converter 스텝)인데 이 배선에 REDIS_URL/ADMIN_OPERATOR_*와 같은 prod
    게이트가 없었다. **값이 채워져 있어도** prod에서는 이 키 자체가 없어야 한다(#2141 원칙과
    동일 — 값 유무가 아니라 키 존재 자체가 신호). substitution에 실수로 값이 남아 있는
    상태를 흉내내 검증(빈 값 fallback에 기대지 않음)."""
    result = _run_env_vars_assembly(
        "prod", "", gotenberg_url="https://office-converter-dev.example.run.app"
    )
    assert "GOTENBERG_SERVICE_URL" not in result


def test_deploy_backend_dev_env_vars_unchanged_by_prod_branch():
    """dev 경로 무회귀 — prod 분기 추가가 dev의 다른 필드에 영향을 주지 않는다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert result == (
        "FASTAPI_URL=https://example.run.app,DB_POOL_SIZE=3,DB_MAX_OVERFLOW=1,"
        "DB_PGBOUNCER=false,"
        "PG_LISTEN_ENABLED=true,EVENT_BROKER_REDIS_CONSUME_ENABLED=false,"
        "EVENT_BROKER_REDIS_DISPATCH_ENABLED=false,EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED=false,"
        "FANOUT_WAKE_REDIS_ENABLED=false,PRESENCE_REDIS_ENABLED=false,"
        "PRESENCE_ONLINE_REDIS_ENABLED=false,SSE_LEASE_REDIS_ENABLED=false,"
        "SSE_TRANSIENT_REPLAY_ENABLED=false,LICENSE_CONSENT=agreed,"
        "NEXT_PUBLIC_APP_URL=https://example.run.app,DEPLOY_ENV=dev,"
        "FIREBASE_OAUTH_HANDOFF_ENABLED=false,"
        # story #3118 — 베이스 ENV_VARS 조립 문자열의 맨 끝(FIREBASE_OAUTH_HANDOFF_ENABLED
        # 다음)에 이어붙는다 — REDIS_URL/ADMIN_OPERATOR_*/GCS_AVATARS_BUCKET은 그 뒤에
        # 조건부로 append되는 후속 라인이라 실제 순서상 APPLE_*·SUPPORT_CONTACT_SURFACE_
        # WIDGET(story #3263 AC3)·SUPPORT_ESCALATION_*(같은 스토리 AC1/2, 베이스 문자열
        # 맨 끝에 순서대로 추가)가 먼저 온다.
        "APPLE_SERVICES_ID=ai.sprintable.web,APPLE_KEY_ID=DF2G3UV649,APPLE_TEAM_ID=JN798BC4KC,"
        "SUPPORT_CONTACT_SURFACE_WIDGET=false,"
        "SUPPORT_ESCALATION_REQUESTER_MEMBER_ID=,SUPPORT_ESCALATION_APPROVER_MEMBER_ID=,"
        "SUPPORT_ESCALATION_TARGET_ORG_SLUG=moonklabs,SUPPORT_ESCALATION_TARGET_PROJECT_SLUG=sprintable,"
        "REDIS_URL=redis://10.164.120.243:6379,"
        "ADMIN_OPERATOR_AUDIENCE=https://example-audience.run.app,"
        "ADMIN_OPERATOR_ALLOWLIST=operator@example.iam.gserviceaccount.com,"
        "GCS_AVATARS_BUCKET=sprintable-avatars-dev"
    )
