"""story #2135(2026-07-24) 축④ "Settings 커버리지" — infra/check_env_drift.py의 신규 fail-fast
축 회귀가드. gcloud 라이브 접근 없이(Settings 필드 열거·allowlist 파싱은 순수 로컬 로직) 실행
가능한 부분만 고정한다 — gcloud describe 자체는 이 테스트 스코프 밖(오르테가 라이브 실측으로
이미 triage 완료, 2026-07-24).

핵심: 오르테가 라이브 실측(backend-dev, Cloud Run describe spec) 그대로 재현 — 그 10개 키 중
`DATABASE_URL_DEV` 딱 하나만 "Settings도 exempt도 아닌" 진짜 무효로 잡히고, 나머지 9개는
settings_exempt로 정확히 흡수되는지. 이게 이 스토리의 실제 산출물(등재 정확성)이라 이 대조가
가장 값있는 테스트다 — allowlist를 잘못 옮겨 적으면 이 테스트가 바로 잡는다.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load_check_env_drift():
    """infra/check_env_drift.py를 모듈로 로드 — infra/는 패키지가 아니라 파일 하나뿐이라
    importlib.util로 직접 spec 로드(sys.path 오염 없이)."""
    spec = importlib.util.spec_from_file_location(
        "check_env_drift", _INFRA_DIR / "check_env_drift.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_settings_field_env_keys_includes_known_fields():
    """sanity — Settings.model_fields 변환이 오늘 실제로 존재하는 필드를 잡는지."""
    mod = _load_check_env_drift()
    keys = mod._settings_field_env_keys()
    for expected in (
        "EVENT_BROKER_REDIS_CONSUME_ENABLED",  # story #2135 원본 사건의 정답 필드명.
        "FANOUT_WAKE_REDIS_ENABLED",  # 오늘 "무효 후보"로 재확認 요청됐다가 유효로 판정된 것.
        "PRESENCE_REDIS_ENABLED", "PRESENCE_ONLINE_REDIS_ENABLED", "SSE_LEASE_REDIS_ENABLED",
    ):
        assert expected in keys, f"{expected} missing from Settings field keys — {sorted(keys)[:20]}..."


def test_redis_consume_enabled_legacy_typo_is_not_a_settings_field():
    """story #2135 원본 결함 재현 — 옛 잘못된 키 이름(`REDIS_CONSUME_ENABLED`, env_prefix
    없이 접두만 빠진 형태)은 Settings 필드가 **아니어야** 정상이다(그게 바로 조용히 무시됐던
    이유). 이 값이 언젠가 실수로 필드에 추가되면 이 테스트가 그 사실 자체를 알린다(반대
    방향 회귀 — "이미 안 문제인데 이 테스트가 여전히 그걸 전제한다"를 잡기 위함)."""
    mod = _load_check_env_drift()
    keys = mod._settings_field_env_keys()
    assert "REDIS_CONSUME_ENABLED" not in keys


def test_settings_exempt_covers_the_nine_triaged_keys():
    """오르테가 라이브 triage(2026-07-24) 그대로 — exempt 목록에 9개 전부 있어야 한다."""
    mod = _load_check_env_drift()
    exempt = mod._load_settings_exempt()
    expected = {
        "CRON_SECRET", "EMAIL_FROM", "RESEND_API_KEY", "STORAGE_PROVIDER",
        "NEXT_PUBLIC_APP_URL", "LLM_GEMINI_LOCATION", "LLM_GEMINI_MODEL",
        "FASTAPI_URL", "MCP_PUBLIC_URL", "OPS_RESTART_TS",
    }
    missing = expected - set(exempt)
    assert not missing, f"exempt 목록에서 빠짐: {missing}"
    # 사유가 "os.getenv 직접"류로 뭉뚱그려지지 않고 실제 파일 경로를 담고 있는지(오르테가
    # 지적) — 대부분 .py가 직접 읽지만 OPS_RESTART_TS는 .sh(배포 스크립트)가 의도적으로
    # "안 읽는다"를 명시하는 케이스라 .py|.sh 둘 다 허용.
    for key in expected:
        assert ".py" in exempt[key] or ".sh" in exempt[key], (
            f"{key} 사유에 구체적 파일 경로가 없음: {exempt[key]!r}"
        )


def test_backend_dev_live_key_set_flags_only_database_url_dev():
    """⭐핵심 회귀가드 — 오르테가 라이브 실측(backend-dev, 10개 키) 그대로 재현.

    Settings 필드도 아니고 exempt도 아닌 것 = 딱 DATABASE_URL_DEV 하나여야 한다(진짜 무효
    배선, 어떤 코드도 안 읽음 — #2135 원본 발견). 나머지 9개는 exempt로 정확히 흡수돼야
    한다 — 하나라도 빠지면 이 테스트가 그 키를 지목해 FAIL한다."""
    mod = _load_check_env_drift()
    settings_keys = mod._settings_field_env_keys()
    exempt = set(mod._load_settings_exempt())

    # 오르테가 2026-07-24 라이브 실측(Cloud Run describe spec, backend-dev) 그대로.
    live_backend_dev_keys = {
        "CRON_SECRET", "EMAIL_FROM", "RESEND_API_KEY", "STORAGE_PROVIDER",
        "NEXT_PUBLIC_APP_URL", "LLM_GEMINI_LOCATION", "LLM_GEMINI_MODEL",
        "FASTAPI_URL", "MCP_PUBLIC_URL", "OPS_RESTART_TS",
        "DATABASE_URL_DEV",  # 유일한 진짜 무효.
    }
    unrecognized = live_backend_dev_keys - settings_keys - exempt
    assert unrecognized == {"DATABASE_URL_DEV"}, (
        f"기대: {{'DATABASE_URL_DEV'}}만 무효 — 실제: {unrecognized} "
        f"(exempt 목록이 어긋났거나 DATABASE_URL_DEV가 이미 정리됐을 수 있음)"
    )


def test_axis4_pass_is_visible_even_when_another_axis_fails(monkeypatch, capsys):
    """⭐라이브 실증(2026-07-24, 오르테가 지적)이 드러낸 갭 — 축①이 FAIL이면 축④가
    통과해도(=settings_coverage_report 비어있음) 그 사실이 출력에 전혀 안 보였다("돌긴
    했나"를 알 수 없는 상태). main()을 실행해 FAIL 종료(축①) 안에서도 "④...이상 없음"
    한 줄이 반드시 찍히는지 고정한다 — 오늘 반복된 "성공이 관측 안 되면 성공했는지
    모른다" 계열의 회귀가드."""
    mod = _load_check_env_drift()

    monkeypatch.setattr(mod, "_list_live_services", lambda: ["sprintable-realtime-dev"])
    monkeypatch.setattr(
        mod, "_live_env_entries",
        lambda service: [{"name": "DEBUG", "value": "false"}],
    )
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    # iac_keys를 빈 집합으로 고정 — DEBUG가 어느 IaC에도 선언 안 된 것처럼 만들어 축①만
    # 강제로 FAIL시킨다(DEBUG는 실 Settings 필드라 축④는 그대로 통과해야 정상).
    monkeypatch.setattr(mod, "_iac_covered_keys", lambda: set())

    exit_code = mod.main()

    assert exit_code == 1, "축①이 FAIL해야 하는 시나리오인데 통과함 — 테스트 전제 자체가 깨짐"
    out = capsys.readouterr().out
    assert "①키집합 대조" in out
    assert "sprintable-realtime-dev" in out and "DEBUG" in out
    assert "④Settings 커버리지" in out and "이상 없음" in out, (
        f"축①만 FAIL이고 축④는 통과인데 그 통과가 출력에 안 보임 — stdout:\n{out}"
    )


def test_settings_field_env_keys_works_without_pydantic_settings_importable(monkeypatch):
    """⭐라이브 실증(2026-07-24) 재현 — env-drift-guard.yml 워크플로는 backend 의존성
    (pydantic_settings 등)을 설치하지 않는다. `import app.core.config`를 실제로 태우면
    `ModuleNotFoundError`로 매일 00:00 크래시하는 가드가 나간다(실측된 그대로). static
    파싱은 이 import 자체를 안 하므로, `pydantic_settings`가 애초에 설치 안 돼 있어도
    (sys.modules에서 강제로 못 찾게 만들어 재현) 정상 동작해야 한다."""
    import builtins

    real_import = builtins.__import__

    def _blocking_import(name, *args, **kwargs):
        if name == "pydantic_settings" or name.startswith("pydantic_settings."):
            raise ModuleNotFoundError(f"No module named '{name}'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _blocking_import)
    mod = _load_check_env_drift()  # 모듈 자체 로드도 이 차단 안에서(위 실측과 동일 조건).
    keys = mod._settings_field_env_keys()
    # #2158: sse_transient_replay_enabled 필드 추가로 82→83(SSE_TRANSIENT_REPLAY_ENABLED 포함).
    # #1999(fresh 셀프호스트 온보딩 데드엔드 해소): require_verified_email_for_org_create 필드
    # 신설로 83→84 — 이메일 provider 미설정 셀프호스트에서 org 생성이 인증을 무조건 요구하던
    # 것을 완화하는 신규 설정(기본 True, 호스티드/prod 동작 불변). 이 가드가 설계대로 새
    # Settings 필드를 실제로 잡아낸 것 — 개수 자체가 늘어난 게 아니라 늘어난 게 정답이다.
    # #2451(§6 Phase3 read replica): database_url_read 필드 신설로 84→85(DATABASE_URL_READ 포함).
    # 미설정이면 primary 폴백·설정 시 read replica 라우팅. 가드가 신규 필드를 설계대로 잡은 것.
    # #2461(§6 봉합③ part2, PO 승인 2026-08-05): worker_db_pool_size/worker_db_max_overflow
    # 필드 신설로 85→87(WORKER_DB_POOL_SIZE·WORKER_DB_MAX_OVERFLOW 포함) — L2/배치워커 전용
    # worker_engine 풀 크기 설정. 가드가 신규 필드를 설계대로 잡은 것.
    # #2491(결제②-C0, PO 승인 2026-08-06): toss_payments_secret_key/toss_payments_client_key/
    # toss_payments_crypto_key/toss_merchant_id 필드 신설로 87→91(TOSS_PAYMENTS_SECRET_KEY·
    # TOSS_PAYMENTS_CLIENT_KEY·TOSS_PAYMENTS_CRYPTO_KEY·TOSS_MERCHANT_ID 포함) — TossAdapter
    # (story C1~) 원화 정기결제용 시크릿, polar_* 동형. 가드가 신규 필드를 설계대로 잡은 것.
    # #2492(결제②-C1, PO 승인 2026-08-07): org_billing_key_encryption_key 필드 신설로 91→92
    # (ORG_BILLING_KEY_ENCRYPTION_KEY 포함) — org_billing_keys.encrypted_billing_key를
    # 암복호화하는 MultiFernet 키(들, 회전 지원 콤마구분). 가드가 신규 필드를 설계대로 잡은 것.
    # #2495(결제②-C4, PO 승인 2026-08-07): toss_webhook_secret 필드 신설로 92→93
    # (TOSS_WEBHOOK_SECRET 포함) — TossAdapter.verify_webhook의 HMAC 서명 검증 시크릿,
    # polar_webhook_secret 동형. 가드가 신규 필드를 설계대로 잡은 것.
    # 핫픽스(2026-08-13, 선생님 직접 지시): agent_group_default_mentions 필드 신설로 93→94
    # (AGENT_GROUP_DEFAULT_MENTIONS 포함) — #2603 그룹챗 mentions 기본계약을 opt-in으로
    # 되돌리는 kill switch(기본 False). 가드가 신규 필드를 설계대로 잡은 것.
    # story #2626(2026-08-13, PO 승인): chain_escalation_notify_enabled 필드 은퇴로 95→94
    # (CHAIN_ESCALATION_NOTIFY_ENABLED 제거) — 무감독 연쇄 알림이 속도 기반 에피소드
    # 탐지+org별 설정(chain_escalation_org_config 테이블)으로 재설계되며, 글로벌 killswitch가
    # org-level enabled로 완전히 대체됐다(반쪽 은퇴 금지, PO 조건① — 필드·이 가드·테스트
    # patch 전부 같이 걷었다). 가드가 필드 제거도 정확히 잡은 것(드리프트 양방향 커버).
    assert "PRESENCE_REDIS_ENABLED" in keys and "SSE_TRANSIENT_REPLAY_ENABLED" in keys
    assert "REQUIRE_VERIFIED_EMAIL_FOR_ORG_CREATE" in keys
    assert "DATABASE_URL_READ" in keys
    assert "WORKER_DB_POOL_SIZE" in keys and "WORKER_DB_MAX_OVERFLOW" in keys
    assert "TOSS_PAYMENTS_SECRET_KEY" in keys and "TOSS_PAYMENTS_CLIENT_KEY" in keys
    assert "TOSS_PAYMENTS_CRYPTO_KEY" in keys and "TOSS_MERCHANT_ID" in keys
    assert "ORG_BILLING_KEY_ENCRYPTION_KEY" in keys
    assert "TOSS_WEBHOOK_SECRET" in keys
    assert "AGENT_GROUP_DEFAULT_MENTIONS" in keys
    assert "CHAIN_ESCALATION_NOTIFY_ENABLED" not in keys
    # story #2777(E-ADMIN-REDESIGN·결제 운영, 2026-08-18): admin_operator_audience/
    # admin_operator_allowlist(어드민 mutation SA ID-token 인가 레인) + deploy_env(prod
    # 하드가드가 읽는, 이 앱이 여태 전무했던 dev/prod 런타임 신호) 필드 신설로 94→97
    # (ADMIN_OPERATOR_AUDIENCE·ADMIN_OPERATOR_ALLOWLIST·DEPLOY_ENV 포함). 가드가 신규
    # 필드를 설계대로 잡은 것.
    assert "ADMIN_OPERATOR_AUDIENCE" in keys and "ADMIN_OPERATOR_ALLOWLIST" in keys
    assert "DEPLOY_ENV" in keys
    # story #2822(2026-08-20): gotenberg_service_url 필드 신설(office_conversion.py의
    # os.environ 직접읽기를 Settings SSOT 경유로 교체)로 97→98. 가드가 신규 필드를 설계대로 잡은 것.
    assert "GOTENBERG_SERVICE_URL" in keys
    assert len(keys) == 98
