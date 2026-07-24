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
