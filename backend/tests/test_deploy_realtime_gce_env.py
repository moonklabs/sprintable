"""story #2142(E-ARCH, 2026-07-23): GCE realtime-gateway 배포 스크립트 dev/prod 분기 검증.

test_deploy_env.py(deploy_backend.sh 등)와 동일 패턴 — DRY_RUN=1 resolved config를
파싱해 dev/prod 경로를 검증한다.

⛔story #2142 배포 함정 핫픽스(2026-07-23, 오르테가 자인) — 이 파일의 기존 테스트는 전부
`PLAIN_ENV_SPEC` "요약 문자열"의 부분 문자열만 검사했다. 그 요약은 실제 배포되는 것과 다른
층이라(요약은 파이썬 쪽에서 그냥 이어붙인 문자열, 실제 배포는 스크립트 자신의 셸 소비
로직을 거친 결과), `H1_MERGE_GATE_ORG_ALLOWLIST`의 2-org 콤마 값이 옛 `IFS=',' read -ra`
소비부에서 조각나 VM에는 절반만 실리는 결함을 전혀 못 잡았다 — 요약 문자열엔 원본 그대로
있었으니 부분 문자열 검사는 항상 통과했을 것이다. `test_deploy_gce_*_no_comma_value_truncation`
이 그 갭을 닫는다 — 요약이 아니라 스크립트가 실제로 생성하는 env-file 내용(`GENERATED_
PLAIN_ENV_FILE_B64`)을 디코드해 검증한다.
"""
from __future__ import annotations

import base64
import os
import subprocess

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DEPLOY_GCE = os.path.join(_SCRIPTS, "deploy_realtime_gce.sh")
_PROVISION_GCLB = os.path.join(_SCRIPTS, "provision_realtime_gclb.sh")


def _resolve(script: str, env: str, extra: dict | None = None) -> dict[str, str]:
    """스크립트를 DRY_RUN=1로 실행하고 KEY=VALUE stdout을 dict로 파싱(stderr의 log()는 무시)."""
    environ = {**os.environ, "DRY_RUN": "1"}
    if extra:
        environ.update(extra)
    proc = subprocess.run(
        ["bash", script, env],
        capture_output=True, text=True, env=environ, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


def _resolve_generated_env_lines(env: str, extra: dict | None = None) -> list[str]:
    """실제 VM에 실릴 env-file 내용을 그대로 디코드해 줄 목록으로 반환 — `_resolve()`의
    요약 문자열이 아니라 스크립트가 진짜로 생성하는 산출물을 검증 대상으로 삼는다."""
    cfg = _resolve(_DEPLOY_GCE, env, extra)
    b64 = cfg["GENERATED_PLAIN_ENV_FILE_B64"]
    return base64.b64decode(b64).decode().splitlines()


def _resolve_generated_env_lines_without(env: str, *unset_keys: str) -> list[str]:
    """story #2180 — **caller env 를 비운 상태**의 산출물을 반환한다.

    `_resolve()` 는 `os.environ` 을 상속하므로, `${FOO:-기본값}` 형태의 «기본값»을 재려면
    그 키를 명시적으로 지워야 한다. 안 지우면 실행 환경에 우연히 그 변수가 있을 때 통과해
    버려 «SSOT 밖 손 값» 결함을 그대로 놓친다 — 이 스토리가 잡으려는 것이 정확히 그것이다.
    """
    environ = {**os.environ, "DRY_RUN": "1"}
    for k in unset_keys:
        environ.pop(k, None)
    proc = subprocess.run(
        ["bash", _DEPLOY_GCE, env],
        capture_output=True, text=True, env=environ, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return base64.b64decode(cfg["GENERATED_PLAIN_ENV_FILE_B64"]).decode().splitlines()


# ── deploy_realtime_gce.sh ───────────────────────────────────────────────────

def test_deploy_gce_dev_targets_dev_instance():
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-dev"
    assert cfg["SQL_INSTANCE_CONN"].endswith(":sprintable-dev")
    assert "DATABASE_URL_DEV:DATABASE_URL" in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_targets_prod_instance():
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-prod"
    assert cfg["SQL_INSTANCE_CONN"].endswith(":sprintable-prod")
    assert "DATABASE_URL_PROD:DATABASE_URL" in cfg["SECRET_PAIRS"]


def test_deploy_gce_dev_and_prod_are_separated():
    """핵심 AC: 양 경로가 서로 다른 인스턴스·시크릿·MIG명."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert dev["SQL_INSTANCE_CONN"] != prod["SQL_INSTANCE_CONN"]
    assert dev["MIG_NAME"] != prod["MIG_NAME"]
    assert dev["SECRET_PAIRS"] != prod["SECRET_PAIRS"]


def test_deploy_gce_mcp_public_url_env_specific():
    """story #2142(오르테가 라이브 실측 2026-07-23) — DATABASE_URL_DEV와 같은 클래스로
    발견된 env 분기 밖 리터럴 재발 방지."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "MCP_PUBLIC_URL=https://dev-mcp.sprintable.ai/mcp" in dev["PLAIN_ENV_SPEC"]
    assert "MCP_PUBLIC_URL=https://mcp.sprintable.ai/mcp" in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_github_app_identity_matches_live_cloud_run_binding():
    """story #2142(오르테가 DRY_RUN 검수 적발, 2026-07-23) — GITHUB_APP_ID/CLIENT_ID/SLUG가
    env 분기 밖 리터럴(dev App 값)로 박혀 있어, prod 플랜이 dev App의 ID/CLIENT_ID와
    prod 전용 시크릿(github-app-*-prod)을 섞은 채 배포될 뻔했다(둘 다 값의 유무와 무관하게
    같은 App 소속이어야 인증이 성립 — 섞이면 어느 쪽으로도 인증 불가). backend-prod
    gcloud describe 라이브 실측으로 prod 분기를 교정 — dev는 무회귀."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "GITHUB_APP_ID=4120278" in dev["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_CLIENT_ID=Iv23liRkrmyqoCZIlrgh" in dev["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_SLUG=sprintable-dev" in dev["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_ID=4244849" in prod["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_CLIENT_ID=Iv23liGdo7u9vkHjRKS0" in prod["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_SLUG=sprintable-prod" in prod["PLAIN_ENV_SPEC"]
    # 섞임 재발 차단 — prod 플랜에 dev App 식별자가 전혀 없어야 한다.
    assert "4120278" not in prod["PLAIN_ENV_SPEC"]
    assert "Iv23liRkrmyqoCZIlrgh" not in prod["PLAIN_ENV_SPEC"]
    assert "sprintable-dev" not in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_dev_only_gate_features_absent_from_prod():
    """story #2142(오르테가 DRY_RUN 검수 3번째 적발, 2026-07-23) — 같은 뿌리
    ("dev 라이브 관측 사실을 env 분기 없이 prod에 적용"), 셋 중 가장 큰 건. L2_TRIGGER_*/
    GATE_CONFIG_ENFORCE_*/DECISION_GATE_LINE_*는 backend-prod에 키 자체가 없다(그 기능이
    prod에서 한 번도 켜진 적 없음, describe 대조 확認) — env 분기 밖 리터럴이라 prod 플랜에
    dev 전용 org 허용목록을 단 채 그대로 켜질 뻔했다. 이 GCE 노드가 backend와 동일 이미지라
    플래그가 켜지면 실제로 그 lifespan 워커가 뜬다(추론 아니라 미러링으로 처리 — 오르테가
    판정). prod는 이 3그룹을 아예 안 붙인다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    for key in ("L2_TRIGGER_ENABLED", "L2_TRIGGER_ADVISORY_LOCK", "L2_TRIGGER_ORG_ALLOWLIST",
                "L2_TRIGGER_MAX_WAKES_PER_ORG_PER_HOUR", "GATE_CONFIG_ENFORCE_ENABLED",
                "GATE_CONFIG_ENFORCE_ORG_ALLOWLIST", "DECISION_GATE_LINE_ENABLED",
                "DECISION_GATE_LINE_ORG_ALLOWLIST", "DECISION_GATE_LINE_MODE"):
        assert key not in prod["PLAIN_ENV_SPEC"], f"{key}가 prod 플랜에 실리면 안 됨"


def test_deploy_gce_dev_gate_features_unchanged():
    """dev는 이 4그룹(L2_TRIGGER/H1_MERGE_GATE/GATE_CONFIG_ENFORCE/DECISION_GATE_LINE) 전부
    현행 그대로 — 무회귀."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    assert "L2_TRIGGER_ENABLED=true" in dev["PLAIN_ENV_SPEC"]
    assert "L2_TRIGGER_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091" in dev["PLAIN_ENV_SPEC"]
    assert "GATE_CONFIG_ENFORCE_ENABLED=true" in dev["PLAIN_ENV_SPEC"]
    assert "DECISION_GATE_LINE_ENABLED=true" in dev["PLAIN_ENV_SPEC"]
    assert "H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091" in dev["PLAIN_ENV_SPEC"]
    # dev의 H1 허용목록은 단일 org — prod의 2-org 값이 섞여 들어가면 안 됨.
    assert "588186bf-1558-48a3-b3a0-fe3759a925fc" not in dev["PLAIN_ENV_SPEC"]


def test_deploy_gce_prod_h1_merge_gate_matches_live_two_org_allowlist():
    """story #2142(오르테가 gcloud 실측, 2026-07-23) — H1_MERGE_GATE는 backend-prod에도
    실재(ENABLED/ADVISORY=true/true, dev와 동일)하지만 허용목록은 dev 단일 org가 아니라
    prod의 실제 2-org 콤마리스트다(describe 대조 확認). prod 플랜이 dev 값을 쓰면 실제
    prod 허용 조직 중 하나(588186bf-...)가 빠지는 것과 같아 라이브과 어긋난다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "H1_MERGE_GATE_ENABLED=true" in prod["PLAIN_ENV_SPEC"]
    assert "H1_MERGE_GATE_ADVISORY=true" in prod["PLAIN_ENV_SPEC"]
    assert (
        "H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091,"
        "588186bf-1558-48a3-b3a0-fe3759a925fc"
    ) in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_db_self_name_binding_removed():
    """story #2145(2026-07-24) — DATABASE_URL_DEV 자기이름 바인딩은 앱이 안 읽는 죽은 배선이었다
    (codex C-4·env-drift-guard 축④가 realtime-dev 라이브에서 실측 검출). 실 DB 접속은
    ${DB_SECRET_NAME}:DATABASE_URL(=DATABASE_URL env)로만 이뤄진다. 자기이름 키는 잉여 자격증명
    표면이라 dev·prod 모두 제거했다. 회귀가드: 어느 env 플랜에도 자기이름 바인딩이 없어야 한다."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "DATABASE_URL_DEV:DATABASE_URL_DEV" not in dev["SECRET_PAIRS"]
    assert "DATABASE_URL_PROD:DATABASE_URL_PROD" not in prod["SECRET_PAIRS"]
    # 정상 시크릿→env 바인딩(DATABASE_URL)은 보존
    assert "DATABASE_URL_DEV:DATABASE_URL " in dev["SECRET_PAIRS"] or dev["SECRET_PAIRS"].endswith("DATABASE_URL_DEV:DATABASE_URL")


def test_deploy_gce_github_oauth_client_wiring_removed():
    """story #2145(2026-07-24) — GitHub user-login OAuth(GITHUB_CLIENT_ID/SECRET)는 #2155에서
    제거됐다(prod users github_linked=0 실측 → 이관경로 불요). app.core.config.Settings에
    github_client_id/secret 필드가 없고 앱 코드 참조 0건 — deploy_realtime_gce.sh만 미완분으로
    이 배선을 잔존시키고 있었고 env-drift-guard 축④가 realtime-dev 라이브에서 검출했다.
    회귀가드: dev·prod 어느 플랜에도 GITHUB_CLIENT_ID/SECRET 배선이 없어야 한다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    dev = _resolve(_DEPLOY_GCE, "dev")
    for cfg in (prod, dev):
        assert "GITHUB_CLIENT_ID" not in cfg["SECRET_PAIRS"]
        assert "GITHUB_CLIENT_SECRET" not in cfg["SECRET_PAIRS"]
    # prod에 dev DB 시크릿 리터럴이 새지 않는 것(#2142 원 회귀가드)은 유지
    assert "DATABASE_URL_DEV" not in prod["SECRET_PAIRS"]


def test_deploy_gce_prod_no_github_oauth_client_of_any_suffix():
    """story #2145(2026-07-24, #2142 후속 정정) — GitHub user-login OAuth 자체가 #2155에서
    제거됐으므로 _PROD/_DEV 어느 접미의 GITHUB_CLIENT 배선도 prod 플랜에 없어야 한다
    (구 #2142 테스트는 _DEV 매핑을 '의도적'으로 고정했으나 로그인 제거로 무효)."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "GITHUB_CLIENT_ID_PROD" not in cfg["SECRET_PAIRS"]
    assert "GITHUB_CLIENT_SECRET_PROD" not in cfg["SECRET_PAIRS"]
    assert "GITHUB_CLIENT_ID_DEV" not in cfg["SECRET_PAIRS"]
    assert "GITHUB_CLIENT_SECRET_DEV" not in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_cron_secret_matches_live_cloud_run_binding():
    """story #2142(오르테가 gcloud 실측, 2026-07-23) — backend-prod Cloud Run은 CRON_SECRET을
    `cron-secret`(dev가 쓰는 이름)이 아니라 `CRON_SECRET_PROD`에서 fetch한다. 이전엔 env
    분기 없이 `cron-secret:CRON_SECRET`이 dev/prod 공용이라 존재는 해도 다른 값이 실렸다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    dev = _resolve(_DEPLOY_GCE, "dev")
    assert "CRON_SECRET_PROD:CRON_SECRET" in prod["SECRET_PAIRS"]
    assert "cron-secret:CRON_SECRET" in dev["SECRET_PAIRS"]


def test_deploy_gce_dev_secret_pairs_exact():
    """story #2145(2026-07-24) — dev SECRET_PAIRS 전체 고정(죽은 배선 3종 제거 반영):
    GITHUB_CLIENT_ID_DEV/SECRET_DEV(#2155 미완분)·DATABASE_URL_DEV 자기이름(codex C-4)이 빠진
    새 계약. 정상 시크릿→env 바인딩은 전부 보존."""
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert cfg["SECRET_PAIRS"] == (
        "DATABASE_URL_DEV:DATABASE_URL JWT_SECRET:JWT_SECRET GOOGLE_CLIENT_ID:GOOGLE_CLIENT_ID "
        "GOOGLE_CLIENT_SECRET:GOOGLE_CLIENT_SECRET RESEND_API_KEY:RESEND_API_KEY "
        "EMAIL_FROM:EMAIL_FROM github-webhook-secret:GITHUB_WEBHOOK_SECRET "
        "cron-secret:CRON_SECRET github-app-client-secret-dev:GITHUB_APP_CLIENT_SECRET "
        "github-app-private-key-dev:GITHUB_APP_PRIVATE_KEY "
        "github-app-state-secret-dev:GITHUB_APP_STATE_SECRET "
        "FIREBASE_BFF_INTERNAL_SECRET:FIREBASE_BFF_INTERNAL_SECRET"
    )


def test_deploy_gce_prod_redis_url_via_secret_not_plaintext():
    """story #2142 후속 발견(오르테가 지시, 2026-07-23) — prod AUTH 있는 Redis URL이
    PLAIN_ENV_SPEC 평문으로 인스턴스 메타데이터에 박히면 안 되고 SECRET_PAIRS로만 가야 한다."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "REDIS_URL_PROD:REDIS_URL" in cfg["SECRET_PAIRS"]
    assert "REDIS_URL=" not in cfg["PLAIN_ENV_SPEC"]


def test_deploy_gce_dev_redis_url_plaintext_unchanged():
    """dev: AUTH 없는 plain Memorystore IP 리터럴 — 이번 변경으로 한 글자도 안 바뀌어야 한다."""
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert "REDIS_URL=redis://10.164.120.243:6379" in cfg["PLAIN_ENV_SPEC"]
    assert "REDIS_URL" not in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_redis_url_env_override_ignored_for_secret_routing():
    """prod는 REDIS_URL 환경변수를 넘겨도(과거 실수 방지 목적) 여전히 시크릿 경로로만
    가야 한다 — 평문 우회 통로가 생기면 안 된다."""
    cfg = _resolve(_DEPLOY_GCE, "prod", extra={"REDIS_URL": "redis://leaked:leaked@1.2.3.4:6379"})
    assert "REDIS_URL_PROD:REDIS_URL" in cfg["SECRET_PAIRS"]
    assert "REDIS_URL=" not in cfg["PLAIN_ENV_SPEC"]
    assert "leaked" not in cfg["PLAIN_ENV_SPEC"]


def test_deploy_gce_prod_app_env_and_next_public_app_url_match_live_binding():
    """story #2142(오르테가 전수 3방향 diff 적발, 2026-07-23) — GCE 플랜과 라이브
    backend-prod env를 3방향 diff("GCE에만 있음"/"값 다름"/"prod에만 있음")했을 때
    세 번째 축("prod에 있는데 GCE엔 없음")에서 나온 것. APP_ENV/NEXT_PUBLIC_APP_URL은
    backend-prod엔 실재하지만 이 스크립트 작성 당시 dev에도 없어 분기 자체가 없었다 —
    이전 3건(dev값이 분기 밖에 남음)과 반대 방향(prod가 나중에 받은 값을 못 따라감).
    NEXT_PUBLIC_APP_URL은 auth.py/docs.py/discord_webhook.py 등 실제 backend 런타임
    코드 경로가 읽는다(repo grep 확認) — 장식이 아니다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "APP_ENV=prod" in prod["PLAIN_ENV_SPEC"]
    assert "NEXT_PUBLIC_APP_URL=https://app.sprintable.ai" in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_dev_has_no_app_env_or_next_public_app_url():
    """dev는 지금도 이 두 값이 라이브에 없다(describe 대조 확認) — 무회귀."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    assert "APP_ENV=" not in dev["PLAIN_ENV_SPEC"]
    assert "NEXT_PUBLIC_APP_URL=" not in dev["PLAIN_ENV_SPEC"]


def test_deploy_gce_prod_includes_cors_origins_intact():
    """story #2142 핫픽스(2026-07-23) — CORS_ORIGINS는 최초엔 콤마 분해 함정 때문에
    생략했으나, 그 소비부 자체를 _PLAIN_SEP(0x1F join) 기반 + `docker --env-file`로
    고친 뒤에는 값에 콤마가 있어도 안전하다. 요약 문자열이 아니라 **실제 생성되는
    env-file**에서 이 값이 하나의 온전한 줄로 나가는지 확認한다(부분 문자열 검사는
    콤마 절단 여부를 구분 못 함 — 원본이 3조각으로 쪼개져도 이어붙이면 부분 문자열
    검사는 통과해버린다)."""
    lines = _resolve_generated_env_lines("prod")
    assert (
        "CORS_ORIGINS=http://localhost:3000,http://localhost:3108,https://app.sprintable.ai"
        in lines
    ), "CORS_ORIGINS가 온전한 한 줄로 안 나갔음(콤마에서 쪼개졌을 가능성)"
    # 콤마 절단이 났다면 이런 조각난 줄들이 별도로 나타난다 — 존재하면 안 됨.
    assert "http://localhost:3108" not in lines
    assert "https://app.sprintable.ai" not in lines


def test_deploy_gce_prod_h1_merge_gate_allowlist_survives_env_file_generation():
    """story #2142 배포 함정 핫픽스(2026-07-23, 오르테가 자인) — 이 저장소가 실제로
    겪은 사고의 재발 방지 테스트. H1_MERGE_GATE_ORG_ALLOWLIST의 2-org 콤마 값이 옛
    `IFS=',' read -ra` 소비부에서 조각나 VM에는 `54bac162-...`(org 하나)만 실리고
    `588186bf-...`는 `=` 없는 쓰레기 인자가 되는 결함이 실제로 있었다(#2431 머지 後
    발견). PLAIN_ENV_SPEC 요약 문자열 검사(`test_deploy_gce_prod_h1_merge_gate_
    matches_live_two_org_allowlist`)는 이 결함을 못 잡았다 — 요약은 원본을 그대로
    이어붙인 것이라 부분 문자열은 항상 있었기 때문. 이 테스트는 **실제 생성된
    env-file**을 검증해 그 갭을 닫는다."""
    lines = _resolve_generated_env_lines("prod")
    assert (
        "H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091,"
        "588186bf-1558-48a3-b3a0-fe3759a925fc"
    ) in lines, "2-org 허용목록이 온전한 한 줄로 안 나갔음(콤마 절단 재발)"
    # 절단됐다면 두 번째 org가 "=" 없는 독립 줄(쓰레기 -e 인자)로 나타난다.
    assert "588186bf-1558-48a3-b3a0-fe3759a925fc" not in lines
    # 절단됐다면 첫 org만 있는 반쪽짜리 줄도 별도로 존재하게 된다.
    assert "H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091" not in lines


def test_deploy_gce_dev_env_file_generation_no_truncation():
    """dev도 같은 소비부를 타므로 무회귀 확認 — dev는 콤마 든 값이 없지만(현재), 생성된
    env-file의 줄 수가 PLAIN_ENV_SPEC의 엔트리 수와 정확히 일치해야 한다(하나라도
    쪼개지거나 합쳐지면 줄 수가 달라짐)."""
    lines = _resolve_generated_env_lines("dev")
    cfg = _resolve(_DEPLOY_GCE, "dev")
    expected_count = cfg["PLAIN_ENV_SPEC"].count("\x1f") + 1 if "\x1f" in cfg["PLAIN_ENV_SPEC"] else None
    # DRY_RUN 요약 출력 자체가 \x1f를 그대로 담고 있으므로(줄바꿈이 아니라 필드 값 문자로
    # 실림) 그 문자로 직접 개수를 셀 수 있다 — 있으면 그걸로, 없으면(구분자 표시가 안
    # 보이는 환경) 최소 27개 이상만 느슨히 확認.
    if expected_count is not None:
        assert len(lines) == expected_count
    else:
        assert len(lines) >= 27
    assert all("=" in line for line in lines), "쓰레기(= 없는) 줄이 섞여 있음 — 절단 의심"


def test_deploy_gce_prod_dev_only_flags_absent():
    """story #2142(오르테가 전수 3방향 diff 적발, 2026-07-23, 4번째 묶음) — 같은 뿌리
    (dev 라이브 리터럴이 env 분기 밖에 남음). BUILD_APP_METADATA_DEFALLBACK·
    LLM_GEMINI_MODEL/_LOCATION·FIREBASE_OAUTH_HANDOFF_ENABLED 전부 backend-prod에
    키 자체가 없다(describe 대조 확認) — FIREBASE_OAUTH_HANDOFF_ENABLED=1은 firebase
    내부 경로를 켜는 값이라 더 위험한 자리였다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    for key in ("BUILD_APP_METADATA_DEFALLBACK", "LLM_GEMINI_MODEL", "LLM_GEMINI_LOCATION",
                "FIREBASE_OAUTH_HANDOFF_ENABLED"):
        assert key not in prod["PLAIN_ENV_SPEC"], f"{key}가 prod 플랜에 실리면 안 됨"


def test_deploy_gce_dev_only_flags_unchanged():
    """dev는 이 4개 값 전부 현행 유지 — 무회귀(순서는 바뀔 수 있으나 값 자체는 그대로)."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    assert "BUILD_APP_METADATA_DEFALLBACK=true" in dev["PLAIN_ENV_SPEC"]
    assert "LLM_GEMINI_MODEL=gemini-3.1-pro-preview" in dev["PLAIN_ENV_SPEC"]
    assert "LLM_GEMINI_LOCATION=global" in dev["PLAIN_ENV_SPEC"]
    assert "FIREBASE_OAUTH_HANDOFF_ENABLED=1" in dev["PLAIN_ENV_SPEC"]


def test_deploy_gce_max_sse_connections_intentional_both_envs():
    """MAX_SSE_CONNECTIONS=500는 dev/prod 둘 다 동일 — dev값이 새어든 것이 아니라 이
    SSE 전용 GCE 스택 자체의 설계 의도(backend-prod는 REST와 캡을 공유하는 다른 성격의
    노드라 코드 기본값 100을 그대로 씀 — 그건 정상이고, 이 GCE 스택이 다른 것)."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "MAX_SSE_CONNECTIONS=500" in dev["PLAIN_ENV_SPEC"]
    assert "MAX_SSE_CONNECTIONS=500" in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_invalid_env_rejected():
    proc = subprocess.run(
        ["bash", _DEPLOY_GCE, "staging"],
        capture_output=True, text=True,
        env={**os.environ, "DRY_RUN": "1"},
    )
    assert proc.returncode != 0
    assert "[dev|prod]" in proc.stderr


# ── story #2180: FANOUT_WAKE_REDIS_ENABLED 가 SSOT 밖 손 값이 아니어야 한다 ──────

def test_deploy_gce_fanout_wake_redis_is_durable_true_without_caller_env():
    """story #2180(2026-07-25) — 이 저장소가 실제로 겪은 함정의 재발 방지.

    여태 `${FANOUT_WAKE_REDIS_ENABLED:-false}` 라서, dev 라이브의 `true` 는 #2122 라이브
    재측정 때 손으로 넣은 **caller env 값**이었다. 즉 스크립트를 그냥 돌리면 `false` 가
    나가므로 **다음 배포가 조용히 원복시키는** 상태였다(#2077 프론트 minScale 과 동형 —
    「라이브에 있는데 코드엔 없다」).

    이 테스트는 **caller env 를 비운 상태**로 스크립트를 돌려 durable 기본값을 검증한다 —
    `_resolve()` 가 `os.environ` 을 상속하므로, 명시적으로 지워야 「기본값」을 재는 것이 된다.
    (안 지우면 실행 환경에 그 변수가 우연히 있을 때 통과해버려 판별력이 0이 된다.)
    """
    for env_name in ("dev", "prod"):
        lines = _resolve_generated_env_lines_without(env_name, "FANOUT_WAKE_REDIS_ENABLED")
        assert "FANOUT_WAKE_REDIS_ENABLED=true" in lines, (
            f"[{env_name}] durable 기본값이 true 가 아니다 — caller env 없이 배포하면 "
            "크로스노드 wake 가 pg_notify 로만 나가는데 이 스택은 PG_LISTEN_ENABLED=false 라 "
            "듣는 프로세스가 0개다(#2122 에서 cross-node wake 0/2 재현)."
        )
        assert "FANOUT_WAKE_REDIS_ENABLED=false" not in lines


def test_deploy_gce_fanout_wake_assumption_pg_listen_is_still_false():
    """⚠️#2180 판단이 무너지는 조건을 고정한다.

    「true 여야 한다」는 근거는 **이 스택에서 PG LISTEN 을 아무도 안 듣는다**는 사실 하나에
    걸려 있다. PG_LISTEN_ENABLED 가 true 로 바뀌면 pg_notify 경로가 되살아나므로 그 근거가
    사라지고 #2180 을 **재판정**해야 한다. 그때 이 테스트가 실패해서 알려주는 것이 목적이다
    (#2178 에서 세운 「전제를 소스에 박고 pinning 으로 지킨다」와 같은 형태).
    """
    for env_name in ("dev", "prod"):
        lines = _resolve_generated_env_lines(env_name)
        assert "PG_LISTEN_ENABLED=false" in lines, (
            f"[{env_name}] PG_LISTEN_ENABLED 전제가 바뀌었다 — story #2180 의 "
            "FANOUT_WAKE_REDIS_ENABLED=true 판단을 재판정할 것."
        )


def test_deploy_gce_fanout_wake_caller_override_still_works():
    """durable 기본값을 못박되 **손 override 통로는 막지 않는다** — 위 형제 플래그
    (PRESENCE_*/SSE_LEASE_*)와 동일 규약. 롤백·실험 때 이 통로가 필요하다."""
    lines = _resolve_generated_env_lines(
        "dev", extra={"FANOUT_WAKE_REDIS_ENABLED": "false"}
    )
    assert "FANOUT_WAKE_REDIS_ENABLED=false" in lines


# ── story #2185: dev 스택이 «패리티 surface 아님»이라는 선언이 소스에 살아 있어야 한다 ──

def test_deploy_gce_declares_dev_is_not_a_parity_surface():
    """story #2185(2026-07-25) — 이 스크립트의 dev 스택은 지금 «prod 패리티 검증용»이
    아니다(경로에 없음·트래픽 0·이미지 3일 정체). 그 사실이 **소스에 적혀 있지 않으면**
    다음 사람이 "GCE 에서 확認했다"를 이 dev 스택 결과로 말하게 되고, 그건 거짓 안심이다.

    #2178 에서 세운 형태 그대로 — 판정이 기대는 전제를 소스에 박고 pinning 으로 지킨다.
    ⚠️이 테스트가 실패한다면 둘 중 하나다:
      (a) 선언을 지웠는데 사실은 그대로다  → 되돌릴 것
      (b) dev MIG 가 자동 유지되기 시작해 정말 패리티 surface 가 됐다 → 그러면 이 테스트도
          함께 지우는 것이 맞다(선언을 지우는 것까지가 그 작업의 일부).
    """
    source = open(_DEPLOY_GCE, encoding="utf-8").read()
    assert "패리티" in source, (
        "dev 스택이 패리티 surface 가 아니라는 선언이 사라졌다 — story #2185 참조"
    )
    assert "#2185" in source
    # 무너지는 조건까지 적혀 있어야 한다(선언만 있고 해제 조건이 없으면 영원히 산다).
    assert "무너지는 조건" in source


# ── provision_realtime_gclb.sh ───────────────────────────────────────────────

def test_provision_gclb_dev_targets_dev_resources():
    cfg = _resolve(_PROVISION_GCLB, "dev")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-dev"
    assert "3600" in cfg["BACKEND_SERVICE_NAME"]  # "(timeout=3600s, draining=120s)" 접미 확認


def test_provision_gclb_prod_targets_prod_resources():
    cfg = _resolve(_PROVISION_GCLB, "prod")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-prod"
    assert "3600" in cfg["BACKEND_SERVICE_NAME"]


def test_provision_gclb_prod_timeout_matches_dev():
    """⚠️이 스크립트의 존재 이유 — timeout=3600이 prod에서도 dev와 동일하게 유지되는지
    (BACKEND_TIMEOUT_SEC이 case 밖 공용 상수라 자동 충족되지만, 회귀 방지로 명시 검증)."""
    dev = _resolve(_PROVISION_GCLB, "dev")
    prod = _resolve(_PROVISION_GCLB, "prod")
    dev_timeout = dev["BACKEND_SERVICE_NAME"].split("timeout=")[1].split("s")[0]
    prod_timeout = prod["BACKEND_SERVICE_NAME"].split("timeout=")[1].split("s")[0]
    assert dev_timeout == prod_timeout == "3600"


def test_provision_gclb_dev_and_prod_are_separated():
    dev = _resolve(_PROVISION_GCLB, "dev")
    prod = _resolve(_PROVISION_GCLB, "prod")
    assert dev["MIG_NAME"] != prod["MIG_NAME"]
    assert dev["FW_RULE_NAME"] != prod["FW_RULE_NAME"]


def test_provision_gclb_invalid_env_rejected():
    proc = subprocess.run(
        ["bash", _PROVISION_GCLB, "staging"],
        capture_output=True, text=True,
        env={**os.environ, "DRY_RUN": "1"},
    )
    assert proc.returncode != 0
    assert "[dev|prod]" in proc.stderr


# ── story #2089 stage 3-a(2026-07-25, 오르테가군 지시): dev만 entrypoint 교체 ────────

def test_deploy_gce_dev_uses_realtime_main_entrypoint():
    """dev는 app.realtime_main:app(SSE router 둘만 마운트)으로 뜬다."""
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert cfg["UVICORN_APP_MODULE"] == "app.realtime_main:app"


def test_deploy_gce_prod_entrypoint_unchanged():
    """⭐핵심 AC — prod는 이번 단계에서 손대지 않는다. 기존 app.main:app 그대로인지
    명시 검증(변수 분리 리팩터 자체가 prod 값을 조용히 바꾸지 않았는지가 이 테스트의 목적)."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert cfg["UVICORN_APP_MODULE"] == "app.main:app"


def test_deploy_gce_dev_and_prod_entrypoints_differ():
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert dev["UVICORN_APP_MODULE"] != prod["UVICORN_APP_MODULE"]


def test_deploy_gce_dev_startup_script_actually_invokes_realtime_main():
    """요약 변수(UVICORN_APP_MODULE)뿐 아니라 실제 생성되는 startup-script의 docker run
    커맨드 라인 자체에 반영되는지 — #2142가 세운 관례(요약 문자열과 실제 산출물이 다를 수
    있다는 것)를 따라 startup-script 원문(GENERATED_UVICORN_CMD_LINE)에서 직접 확認한다."""
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert "uvicorn app.realtime_main:app" in cfg["GENERATED_UVICORN_CMD_LINE"]
    assert "--host 0.0.0.0" in cfg["GENERATED_UVICORN_CMD_LINE"]


def test_deploy_gce_prod_startup_script_still_invokes_main():
    """prod의 실제 startup-script 산출물도 기존 app.main:app 그대로인지 원문으로 확認."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "uvicorn app.main:app" in cfg["GENERATED_UVICORN_CMD_LINE"]
    assert "realtime_main" not in cfg["GENERATED_UVICORN_CMD_LINE"]
