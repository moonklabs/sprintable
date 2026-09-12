"""story #3697(Phase2·FE, 유나 design CHANGES 격상 2026-09-08) —
lint_channel_insight_metrics_drift.py의 정탐/오탐 회귀 가드. 합성 fixture로 짓는다(실물이
고쳐져도 이 테스트는 안 사라진다, story #3216 business-info 드리프트 가드와 동형)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_channel_insight_metrics_drift import (  # noqa: E402
    ChannelExtractionIncompleteError,
    EXPECTED_BACKEND_CHANNELS,
    extract_backend_declared_metrics,
    extract_frontend_declared_metrics,
    find_drift,
    main as lint_main,
)

BACKEND_PY_MATCHING = '''
CHANNEL_ADAPTERS: dict[str, ChannelAdapterConfig] = {
    "threads": ChannelAdapterConfig(
        authorize_url="https://threads.net/oauth/authorize",
        scope="threads_basic",
        insight_metrics=("views", "engagements"),
    ),
    "hosted_site": ChannelAdapterConfig(
        authorize_url="",
        kind="blog",
        insight_metrics=("views", "clicks"),
    ),
    "wordpress": ChannelAdapterConfig(
        authorize_url="",
        kind="blog",
    ),
}

if os.environ.get("SANDBOX_CHANNEL_ENABLED", "").strip().lower() == "true":
    CHANNEL_ADAPTERS["sandbox"] = ChannelAdapterConfig(
        authorize_url="",
        insight_metrics=(
            "impressions", "reach", "views", "engagements", "clicks", "spend", "conversions",
        ),
    )
'''

FRONTEND_TS_MATCHING = """
export const CHANNEL_DECLARED_METRICS: Record<string, readonly BoardMetric[]> = {
  threads: ['views', 'engagements'],
  hosted_site: ['views', 'clicks'],
  sandbox: ['impressions', 'reach', 'views', 'engagements', 'clicks', 'spend', 'conversions'],
};
"""

# BACKEND_PY_MATCHING이 실제로 선언한 채널 4개뿐(threads·hosted_site·wordpress·sandbox) —
# 합성 fixture 테스트는 실물의 19개 전부를 요구하지 않는다(find_drift의 expected_channels
# 문서 참고). 완전성 백스톱 자체는 아래 별도 테스트가 판다.
FIXTURE_EXPECTED_CHANNELS = frozenset({"threads", "hosted_site", "wordpress", "sandbox"})


def test_matching_files_report_zero_drift():
    assert find_drift(BACKEND_PY_MATCHING, FRONTEND_TS_MATCHING, expected_channels=FIXTURE_EXPECTED_CHANNELS) == []


def test_single_channel_mismatch_is_detected():
    """BE가 threads에 지표 하나를 더 선언했는데(예: clicks 추가) FE 미러가 안 따라오면
    threads 1건만 드리프트로 잡혀야 한다(다른 채널은 여전히 일치)."""
    changed_backend = BACKEND_PY_MATCHING.replace(
        'insight_metrics=("views", "engagements"),',
        'insight_metrics=("views", "engagements", "clicks"),',
    )
    drifted = find_drift(changed_backend, FRONTEND_TS_MATCHING, expected_channels=FIXTURE_EXPECTED_CHANNELS)
    assert len(drifted) == 1
    assert drifted[0][0] == "threads"
    assert sorted(drifted[0][1]) == ["clicks", "engagements", "views"]
    assert sorted(drifted[0][2]) == ["engagements", "views"]


def test_wordpress_empty_declaration_matches_fe_absence():
    """wordpress는 BE에 insight_metrics 자체가 없다(dataclass 기본값 빈 튜플) — FE 맵에도
    키가 아예 없는 게 정상 일치다(빈 배열=빈 배열)."""
    assert extract_backend_declared_metrics(BACKEND_PY_MATCHING)["wordpress"] == []
    assert "wordpress" not in extract_frontend_declared_metrics(FRONTEND_TS_MATCHING)
    assert find_drift(BACKEND_PY_MATCHING, FRONTEND_TS_MATCHING, expected_channels=FIXTURE_EXPECTED_CHANNELS) == []


def test_fe_missing_a_declared_channel_entirely_is_drift():
    """FE 맵에서 hosted_site를 통째로 빼먹으면(신규 채널 추가 후 FE 미러 갱신 누락과 동형
    사고) 드리프트로 잡혀야 한다 — «키 자체가 없다»가 «빈 배열」로 조용히 오인되면 안 된다."""
    frontend_missing_hosted_site = FRONTEND_TS_MATCHING.replace(
        "  hosted_site: ['views', 'clicks'],\n", ""
    )
    drifted = find_drift(BACKEND_PY_MATCHING, frontend_missing_hosted_site, expected_channels=FIXTURE_EXPECTED_CHANNELS)
    channels = [d[0] for d in drifted]
    assert "hosted_site" in channels


def test_metric_order_difference_is_not_drift():
    """선언 순서는 자구가 아니라 우연이다(집합 비교) — 같은 지표를 다른 순서로 적었다고
    드리프트로 잡으면 안 된다."""
    reordered_frontend = FRONTEND_TS_MATCHING.replace(
        "threads: ['views', 'engagements'],", "threads: ['engagements', 'views'],"
    )
    assert find_drift(BACKEND_PY_MATCHING, reordered_frontend, expected_channels=FIXTURE_EXPECTED_CHANNELS) == []


def test_conditional_sandbox_registration_is_still_extracted():
    """CHANNEL_ADAPTERS["sandbox"] = ChannelAdapterConfig(...)(dict 리터럴이 아니라 조건부
    런타임 등재) 형태도 정적 텍스트 스캔이라 SANDBOX_CHANNEL_ENABLED 값과 무관하게 잡힌다."""
    metrics = extract_backend_declared_metrics(BACKEND_PY_MATCHING)
    assert metrics["sandbox"] == [
        "impressions", "reach", "views", "engagements", "clicks", "spend", "conversions",
    ]


def test_mutation_removing_value_comparison_causes_missed_detection():
    """뮤테이션: find_drift가 항상 빈 리스트를 반환하게 하면 위 정탐 테스트가 깨져야
    한다 — 이 lint의 핵심 로직이 실제로 테스트에 의해 지켜지는지 자가 검증(story #2342
    lint·story #3216 business-info 가드와 동형 계약)."""
    import lint_channel_insight_metrics_drift as mod

    original = mod.find_drift
    try:
        mod.find_drift = lambda a, b, **kw: []
        changed_backend = BACKEND_PY_MATCHING.replace(
            'insight_metrics=("views", "engagements"),',
            'insight_metrics=("views", "engagements", "clicks"),',
        )
        assert mod.find_drift(changed_backend, FRONTEND_TS_MATCHING, expected_channels=FIXTURE_EXPECTED_CHANNELS) == [], "뮤테이션 후에는 탐지가 0이어야 정상"
    finally:
        mod.find_drift = original


def test_parser_missing_a_channel_fails_loud_not_silently_green():
    """⭐카디르 QA 실측(fails-silent 구멍 정정, PR#4049) — 파서가 threads를 못 읽게
    만들면(따옴표를 작은따옴표로 바꿔 정규식이 안 걸림) find_drift가 조용히
    "threads 없음=드리프트 대상 자체가 없음"으로 green을 내지 않고, 완전성 백스톱이
    즉시 예외를 던져야 한다(fails-silent → fails-closed)."""
    import pytest

    unreadable_backend = BACKEND_PY_MATCHING.replace(
        '"threads": ChannelAdapterConfig(', "'threads': ChannelAdapterConfig(",
    )
    assert "threads" not in extract_backend_declared_metrics(unreadable_backend), (
        "뮤테이션이 파서를 실제로 못 읽게 만들지 못함 — 정규식이 작은따옴표도 허용하게 바뀌었을 수 있음"
    )
    with pytest.raises(ChannelExtractionIncompleteError, match="threads"):
        find_drift(unreadable_backend, FRONTEND_TS_MATCHING, expected_channels=FIXTURE_EXPECTED_CHANNELS)


def test_expected_backend_channels_matches_real_channel_adapters_count():
    """EXPECTED_BACKEND_CHANNELS(19개, 손 유지)가 실물 channel_adapters.py와 지금 실제로
    맞는지 — 실물에 새 채널이 추가/삭제되면 이 테스트가 먼저 깨져 EXPECTED_BACKEND_
    CHANNELS를 갱신하라고 알린다(안 갱신하면 완전성 백스톱 자체가 항상 실패하게 되어
    누구도 못 지나칠 정도로 시끄럽다 — 조용히 stale해지지 않는다)."""
    import lint_channel_insight_metrics_drift as mod

    real_backend = mod.CHANNEL_ADAPTERS_PY_PATH.read_text(encoding="utf-8")
    real_channels = set(extract_backend_declared_metrics(real_backend).keys())
    assert real_channels == EXPECTED_BACKEND_CHANNELS


def test_ac_mutation_real_backend_source_triggers_red(monkeypatch):
    """⭐필수 pin(페드루 PO 明示 — "양성대조가 실제로 red 나야 사본↔사본 함정을 피한다") —
    실물 channel_adapters.py에서 실 채널(threads) 선언 튜플에 지표 하나를 몰래 추가하는
    뮤테이션을 가하면, 실물 channel-declared-metrics.ts(무변경) 대비 RED가 실제로 뜨는지
    실증한다(합성 fixture가 아니라 실 파일 콘텐츠 기반 — 이 테스트 자체가 사본↔사본이
    아니라 진짜 BE 소스를 읽는다)."""
    import lint_channel_insight_metrics_drift as mod

    real_backend = mod.CHANNEL_ADAPTERS_PY_PATH.read_text(encoding="utf-8")
    real_frontend = mod.CHANNEL_DECLARED_METRICS_TS_PATH.read_text(encoding="utf-8")

    # 착수 전제 확인 — 실물 두 파일이 지금 실제로 일치해야 이 뮤테이션 테스트가 의미 있다.
    assert mod.find_drift(real_backend, real_frontend) == [], (
        "실물 파일이 이미 불일치 상태 — 뮤테이션 테스트 전제 무효(먼저 정정 필요)"
    )

    mutated_backend_metrics = real_backend.replace(
        'insight_metrics=("views", "engagements"),',
        'insight_metrics=("views", "engagements", "clicks"),',
        1,
    )
    assert mutated_backend_metrics != real_backend, "뮤테이션 대상 문자열을 못 찾음 — 실물 파일 포맷이 바뀌었을 수 있음(threads insight_metrics 확認)"

    drifted = mod.find_drift(mutated_backend_metrics, real_frontend)
    assert len(drifted) == 1
    assert drifted[0][0] == "threads"
    assert "clicks" in drifted[0][1]
    assert "clicks" not in drifted[0][2]


def test_current_repo_files_pass_the_guard():
    """AC — 실물 두 파일이 지금 실제로 일치하는지(불일치였다면 이 스토리에서 FE 미러를
    정본에 맞춰 정정했어야 함)."""
    assert lint_main() == 0
