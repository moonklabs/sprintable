"""story #4336(PO P2 09:08Z) — 발행 전 검사(preflight)의 **모든** 실패 종류가 본문(`preflight_error_facts`)을 가진다.

요청 때 걸리면 4xx 본문, 요청 때 통과했는데 워커에서 걸리면 `publication_commands.failure_detail` — 둘 다 이 한 함수에서 나온다. 예전엔
예산 · 할당량 · 글자 수만 본문이 있어 봉인 · 승인 · 일시 중지 · 연결 · 메타데이터 · 이어쓰기 실패는 워커 쪽에서 «왜 안 나갔는지»가
화면에 없었다.

종류 전수는 코드에서 뽑는다(AST): preflight 함수와 그 함수가 직접 부르는 도우미가 `raise`하는 예외 이름 전부가 아래 표에 있어야 한다.
preflight에 새 도우미 호출이 생기면 `_HELPERS_SCANNED` · `_CALLS_WITHOUT_PREFLIGHT_RAISE` 어느 쪽에도 없어 RED — 그 도우미가 던지는
예외를 표에 올리라는 신호다. (워커 저장 본문 == 요청 4xx 본문 실 DB 대조는 `test_3808_x_publish_budget.py`의 종류별 테스트.)
"""
from __future__ import annotations

import ast
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

_SERVICES = Path(__file__).resolve().parents[1] / "app" / "services"

# preflight가 직접 부르고, 그 안의 `raise`까지 훑는 도우미(이름 → 정의 파일).
_HELPERS_SCANNED = {
    "get_channel_post_draft": "channel_posts.py",
    "is_external_publish_paused": "external_publish_pause.py",
    "list_channel_post_draft_versions": "channel_posts.py",
    "check_generation_budget_or_raise": "generation_budget.py",
    "get_org_content_rules": "content_rules.py",
    "check_api_usage_budget_or_raise": "x_publish_budget.py",
    "get_api_usage_unit_cost_minor": "x_publish_budget.py",
    "_validate_thread_segments": "channel_posts.py",
    "_get_active_connection": "channel_posts.py",
    "_validate_text_length": "channel_posts.py",
    "_validate_youtube_metadata": "channel_posts.py",
    "get_channel_post_video_for_version": "channel_post_videos.py",
    "check_youtube_quota_or_raise": "youtube_quota.py",
}
# 이름으로 부르지만 preflight 실패를 던지지 않는 것(파이썬 내장 · SQL 조립 · 게이트 조회 · 복호화 · 링크 조립). 게이트 조회는 못 찾으면
# None을 돌려주고 preflight가 직접 `ExternalPublishGateNotApprovedError`를 던진다(아래 표에 있음).
_CALLS_WITHOUT_PREFLIGHT_RAISE = {
    "list", "len", "str", "sum", "select", "find_gate_slot_with_pr_fallback", "decrypt_for_use", "build_tagged_link",
}


def _function_node(path: Path, name: str) -> ast.AST:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in {path.name}")


def _raised_names(fn: ast.AST) -> set[str]:
    names = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call) and isinstance(node.exc.func, ast.Name):
            names.add(node.exc.func.id)
    return names


def _called_names(fn: ast.AST) -> set[str]:
    return {
        node.func.id for node in ast.walk(fn)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }


def _cases() -> dict[str, Exception]:
    from app.services.channel_posts import (
        ChannelConnectionNotActiveError,
        ChannelPostDraftNotFoundError,
        ChannelPostReapprovalRequiredError,
        ChannelPostSealMissingError,
        ChannelTextTooLongError,
        ChannelThreadSegmentLimitExceededError,
        ChannelThreadSegmentTooLongError,
        ChannelThreadUnsupportedError,
        ChannelYouTubeMetadataError,
        ExternalPublishGateNotApprovedError,
    )
    from app.services.external_publish_pause import ExternalPublishPausedError
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.youtube_quota import YouTubeQuotaExceededError

    some = uuid.uuid4()
    return {
        "ChannelPostDraftNotFoundError": ChannelPostDraftNotFoundError(some),
        "ExternalPublishPausedError": ExternalPublishPausedError(reason="maintenance"),
        "ExternalPublishGateNotApprovedError": ExternalPublishGateNotApprovedError(gate_id=some, status="pending"),
        "ChannelPostSealMissingError": ChannelPostSealMissingError(gate_id=some),
        "ChannelPostReapprovalRequiredError": ChannelPostReapprovalRequiredError(gate_id=some),
        "GenerationBudgetExceededError": GenerationBudgetExceededError(
            limit_minor=100, spent_minor=90, estimated_cost_minor=20, remaining_minor=10,
        ),
        "ChannelThreadUnsupportedError": ChannelThreadUnsupportedError(channel="threads"),
        "ChannelThreadSegmentLimitExceededError": ChannelThreadSegmentLimitExceededError(max_segments=10, current_count=11),
        "ChannelThreadSegmentTooLongError": ChannelThreadSegmentTooLongError(segment_number=2, max_length=280, current_length=300),
        "ChannelConnectionNotActiveError": ChannelConnectionNotActiveError(connection_id=some),
        "ChannelTextTooLongError": ChannelTextTooLongError(max_length=500, current_length=517),
        "ChannelYouTubeMetadataError": ChannelYouTubeMetadataError(field="title", reason="empty"),
        "YouTubeQuotaExceededError": YouTubeQuotaExceededError(
            limit_units=10000, spent_units=9000, estimated_units=1600, remaining_units=1000,
            reset_at=datetime(2026, 9, 27, 7, 0, tzinfo=UTC), reset_timezone="America/Los_Angeles",
        ),
    }


def test_every_exception_preflight_can_raise_is_in_the_table():
    """preflight와 직접 도우미가 `raise`하는 예외 이름 ⊆ 표. 새 도우미 호출은 두 목록 어느 쪽엔가 올라야 한다."""
    preflight = _function_node(_SERVICES / "channel_posts.py", "preflight_channel_post_publish")
    cases = _cases()
    calls = _called_names(preflight) - set(cases)
    unknown = calls - set(_HELPERS_SCANNED) - _CALLS_WITHOUT_PREFLIGHT_RAISE
    assert not unknown, f"preflight가 새로 부르는 도우미 — 던지는 예외를 표에 올리고 목록에 추가: {sorted(unknown)}"
    raised = set(_raised_names(preflight))
    for helper, file_name in _HELPERS_SCANNED.items():
        raised |= _raised_names(_function_node(_SERVICES / file_name, helper))
    missing = raised - set(cases)
    assert not missing, f"본문이 없는 preflight 실패 종류: {sorted(missing)}"
    # 표가 실제로 나오는 종류를 다 덮는지(스캔이 엉뚱하게 비어 공허하게 통과하지 않게 — 양성 대조).
    assert len(raised) >= 12, sorted(raised)


@pytest.mark.parametrize("name", sorted(_cases()))
def test_each_preflight_failure_has_a_body_in_both_languages(name):
    """모든 종류가 사실(코드 포함)을 가지고, 두 언어 본문 모두 JSON으로 저장 · 전송된다. 문장이 언어에 묶인 코드는 그 언어의 문장."""
    from app.services.publish_error_body import preflight_error_body, preflight_error_facts

    facts = preflight_error_facts(_cases()[name])
    assert facts is not None and isinstance(facts.get("code"), str), name
    json.dumps(facts)  # DB JSONB에 그대로 들어간다
    ko, en = preflight_error_body(facts, "ko"), preflight_error_body(facts, "en")
    assert ko["code"] == en["code"] == facts["code"]
    json.dumps(ko), json.dumps(en)
    if facts["code"].startswith("CHANNEL_THREAD_") or facts["code"] in ("YOUTUBE_METADATA_INVALID", "YOUTUBE_QUOTA_EXCEEDED"):
        assert ko["message"] != en["message"] and ko["message"] and en["message"], (ko, en)


def test_thread_codes_are_not_sent_and_the_sentences_carry_the_numbers():
    """이어쓰기 세 코드는 HTTP 호출 전 검사 — «확실히 안 나감» 부류(자동 재시도 · 나갔는지 모름 아님). 문장은 숫자를 싣는다."""
    from app.services import publication_command as pc
    from app.services.publish_error_body import preflight_error_body, preflight_error_facts

    cases = _cases()
    for key in ("ChannelThreadUnsupportedError", "ChannelThreadSegmentLimitExceededError", "ChannelThreadSegmentTooLongError"):
        assert pc.classify_failure_kind(preflight_error_facts(cases[key])["code"]) == "not_sent", key
    over = preflight_error_body(preflight_error_facts(cases["ChannelThreadSegmentLimitExceededError"]), "ko")
    assert over["message"] == "이 채널은 이어쓰기를 최대 10건까지 지원해요.", over
    too_long = preflight_error_body(preflight_error_facts(cases["ChannelThreadSegmentTooLongError"]), "en")
    assert "2" in too_long["message"] and "280" in too_long["message"] and "300" in too_long["message"], too_long
