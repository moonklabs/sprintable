"""story #2583 S1 — format_envelope_text() 핀 테스트 + 오호칭 봉쇄(AC2) 최소 렌더 계약.

같은 샘플 입력·같은 기댓값 문자열이 envelope-format.test.ts(TS side)에도 핀 고정돼
있다 — 이쪽 렌더 규칙(구분자·필드 순서·"unknown" 폴백)을 고치면 그쪽 테스트가 깨진다
(#2589에서 쓴 언어-경계 동기 가드 패턴 재사용). 배경: doc
2583-injection-envelope-recon-20260812 — 8개 커넥터 中 6개가 sender를 조립 단계에서
버리는 결함(댄 어윈 오호칭 사고와 동일 코드 경로)을 이 SDK 함수 하나로 봉쇄한다.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprintable_sse import MessageContext, format_envelope_text  # noqa: E402


def _ctx(**overrides) -> MessageContext:
    base = dict(
        content="", conversation_id="", sender_id="", sender_name="",
        event_id="e1", seq=1, is_backfill=False, images=[], attachments=[], raw={},
    )
    base.update(overrides)
    return MessageContext(**base)


def test_pinned_full_envelope():
    ctx = _ctx(
        content="안녕하세요",
        conversation_id="conv-abc-123",
        sender_name="송윤재",
        sender_type="human",
        event_kind="conversation.message_created",
        ts="2026-08-12T10:00:00Z",
    )
    expected = (
        "[conversation.message_created] 송윤재 (human) · conv=conv-abc-123 · "
        "ts=2026-08-12T10:00:00Z\n안녕하세요"
    )
    assert format_envelope_text(ctx) == expected


def test_missing_fields_render_as_unknown_not_fabricated():
    """AC1 정직 표기 — 값이 없으면 「unknown」이라고 명시. 빈칸으로 뭉개거나 그럴듯한
    값(예: 'agent'로 임의 추정)을 지어내지 않는다."""
    ctx = _ctx(content="본문만 있음", sender_name="누군가", conversation_id="conv-known")
    out = format_envelope_text(ctx)
    assert "unknown" in out  # sender_type/event_kind/ts 전부 미설정 → unknown
    assert out.count("unknown") == 3  # 세 필드(sender_type·event_kind·ts) 다 unknown, conv는 안 새어나감
    assert "conv=conv-known" in out  # 채워진 필드는 그대로 나옴 — unknown으로 안 덮임


def test_empty_sender_name_falls_back_to_id_then_unknown():
    """PO 리뷰(PR #2984) — sender_name만 다른 필드와 폴백이 비대칭이던 결함. 명시적으로
    빈 이름이 와도 헤더 이름칸이 빈 채 렌더되면 안 된다(오호칭 봉쇄 취지 위반)."""
    with_id = _ctx(content="x", sender_name="", sender_id="agent-42", conversation_id="c")
    assert format_envelope_text(with_id).startswith("[unknown] agent-42 (unknown)")

    without_id = _ctx(content="x", sender_name="", sender_id="", conversation_id="c")
    assert format_envelope_text(without_id).startswith("[unknown] unknown (unknown)")


def test_misaddressing_scenario_blocked_ac2():
    """story #2583 AC2 — 오호칭 시나리오 봉쇄: 같은 세션에 발신자만 바꿔 두 번 보내도
    렌더된 envelope에서 발신자가 명확히 갈린다(본문과 분리된 규격 필드). 댄 어윈 사고
    재현 형태 — 페드루(agent) 메시지 다음에 선생님(human) 메시지가 와도 두 번째 렌더가
    «直前 발신자»를 계승하지 않고 자기 자신의 sender를 정확히 싣는지 확인."""
    first = _ctx(
        content="통신점검", conversation_id="conv-1",
        sender_name="페드루 올리베이라", sender_type="agent",
        event_kind="conversation.message_created", ts="2026-08-12T09:00:00Z",
    )
    second = _ctx(
        content="이거 다시 봐줘", conversation_id="conv-1",
        sender_name="송윤재", sender_type="human",
        event_kind="conversation.message_created", ts="2026-08-12T09:05:00Z",
    )
    rendered_first = format_envelope_text(first)
    rendered_second = format_envelope_text(second)

    assert "페드루 올리베이라" in rendered_first and "(agent)" in rendered_first
    assert "송윤재" in rendered_second and "(human)" in rendered_second
    # 두 번째 렌더에 첫 번째 발신자 이름이 새어 들어가면(=계승) 오호칭 사고 재현.
    assert "페드루 올리베이라" not in rendered_second
    # 발신자 세그먼트가 헤더 첫 줄에 있고 본문(content)과 개행으로 분리 — 모델이 본문
    # 텍스트를 발신자로 오인할 여지 축소.
    header_line, body_line = rendered_second.split("\n", 1)
    assert "송윤재" in header_line
    assert body_line == "이거 다시 봐줘"
