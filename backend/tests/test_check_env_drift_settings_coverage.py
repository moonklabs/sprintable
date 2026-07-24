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
