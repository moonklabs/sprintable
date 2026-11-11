"""story #4888(UI-5 홈, 실물 측정 11-11) — 「오늘」 needs_me의 에이전트 «결정 요청»(agent_decision) 행이 제목 «» · 사유 null · 요청자 null로 나가 홈 행이 빈 글자로 뜨던 것.

일회용 dev 계정에 에이전트 키로 결정 요청 3건을 만들어 홈을 열어 보고서야 드러났다(질문 글은 게이트 `neutral_facts.question`에만 있고, 이 요청의 work item은 게이트 자신이라
`work_item_summary`가 없다). 고친 뒤: 제목 = question · 사유 = assumption · 요청자 = requested_by_member_id(이름은 기존 배치 조회). 추가 쿼리 0 — 이미 조회된 행에서 읽는다.

이 파일은 DB 없이(순수 도우미 + `_needs_me_from_gate_inbox`의 매핑, 가짜 행) — 되돌리면 RED. 실제 `GET /api/v2/today`로 같은 것을 한 번 더 보는 실 PG 시험은
`test_4888_today_decision_request_title_realdb.py`(destructive_schema 표식 · 샤드 무게 등록 규칙 때문에 따로 둔다).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.services import today_service
from app.services.today_service import _decision_request_fields

_NOW = datetime(2026, 11, 11, 19, 0, tzinfo=timezone.utc)


def test_fields_take_question_assumption_and_requester():
    rid = uuid.uuid4()
    q, a, r = _decision_request_fields({"question": "문구를 바꿔도 될까요?", "assumption": "문의가 많아서요", "requested_by_member_id": str(rid)})
    assert (q, a, r) == ("문구를 바꿔도 될까요?", "문의가 많아서요", rid)


def test_fields_are_stripped_and_blank_means_none():
    # 공백만 있는 글은 «있는 글»이 아니다 — 지어내지 않고 None(빈 제목의 대체 글은 화면 몫)
    q, a, r = _decision_request_fields({"question": "   ", "assumption": "\n", "requested_by_member_id": ""})
    assert (q, a, r) == (None, None, None)
    q, a, _ = _decision_request_fields({"question": "  질문  ", "assumption": " 가정 "})
    assert (q, a) == ("질문", "가정")


@pytest.mark.parametrize("facts", [None, {}, {"question": 7, "assumption": ["x"], "requested_by_member_id": 12}, {"requested_by_member_id": "not-a-uuid"}])
def test_fields_tolerate_missing_or_wrong_shapes(facts):
    # 옛 게이트 · 직접 만든 행: 던지지 않고 None 셋(요청 하나가 홈 전체를 깨뜨리지 않는다)
    assert _decision_request_fields(facts) == (None, None, None)


def test_fields_accept_a_uuid_object_as_requester():
    rid = uuid.uuid4()
    assert _decision_request_fields({"requested_by_member_id": rid})[2] == rid


def _gate_row(*, work_item_type, neutral_facts, summary_title=None, gate_type="agent_decision_request"):
    return SimpleNamespace(
        source="gate", id=uuid.uuid4(), gate_type=gate_type, work_item_type=work_item_type, work_item_id=uuid.uuid4(),
        work_item_summary=SimpleNamespace(title=summary_title) if summary_title is not None else None,
        neutral_facts=neutral_facts, created_at=_NOW, project_id=uuid.uuid4(),
    )


async def _run_gate_inbox(monkeypatch, rows):
    import app.routers.gates as gates_router
    import app.services.gate_service as gate_service

    async def _fake_inbox(**_kw):
        return rows

    async def _fake_posture(_session, _org_id):
        return "balanced"

    monkeypatch.setattr(gates_router, "list_gate_inbox", _fake_inbox)
    monkeypatch.setattr(gate_service, "get_org_posture", _fake_posture)
    monkeypatch.setattr(gate_service, "derive_risk_grade", lambda _posture, _gate_type: "low")
    monkeypatch.setattr(gate_service, "_is_recipe_external_publish_gate", lambda _r: False)
    return await today_service._needs_me_from_gate_inbox(None, uuid.uuid4(), None)  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_decision_request_row_carries_question_assumption_and_requester(monkeypatch):
    rid = uuid.uuid4()
    row = _gate_row(work_item_type="agent_decision", neutral_facts={"question": "가입 확인 단계를 건너뛰어도 될까요?", "assumption": "이탈이 가장 커서요", "requested_by_member_id": str(rid)})
    (item,) = await _run_gate_inbox(monkeypatch, [row])
    assert item["title"] == "가입 확인 단계를 건너뛰어도 될까요?"
    assert item["reason"] == "이탈이 가장 커서요"
    assert item["requested_by_member_id"] == rid  # 이름은 _resolve_needs_me의 기존 배치 조회가 채운다


@pytest.mark.anyio
async def test_decision_request_without_facts_stays_blank_not_invented(monkeypatch):
    row = _gate_row(work_item_type="agent_decision", neutral_facts={})
    (item,) = await _run_gate_inbox(monkeypatch, [row])
    assert item["title"] is None and item["reason"] is None
    assert "requested_by_member_id" not in item


@pytest.mark.anyio
async def test_an_existing_title_is_not_overwritten(monkeypatch):
    # work_item_summary가 이미 제목을 줬다면(다른 경로) 질문이 덮지 않는다
    row = _gate_row(work_item_type="agent_decision", neutral_facts={"question": "질문"}, summary_title="이미 있는 제목")
    (item,) = await _run_gate_inbox(monkeypatch, [row])
    assert item["title"] == "이미 있는 제목"


@pytest.mark.anyio
async def test_other_gate_types_are_untouched_even_with_a_question_key(monkeypatch):
    # 결정 요청만 이 규칙 — 다른 게이트(merge · doc …)의 neutral_facts에 우연히 question 키가 있어도 제목 · 사유를 바꾸지 않는다
    row = _gate_row(work_item_type="story", gate_type="merge", neutral_facts={"question": "내 글", "assumption": "내 가정", "requested_by_member_id": str(uuid.uuid4())})
    (item,) = await _run_gate_inbox(monkeypatch, [row])
    assert item["title"] is None and item["reason"] is None
    assert "requested_by_member_id" not in item


@pytest.mark.anyio
async def test_the_gate_inbox_is_not_queried_per_row(monkeypatch):
    # 추가 쿼리 0: 세션을 아예 안 주고(None) 돌려도 매핑이 끝난다 — 행 안의 neutral_facts만 읽는다
    rows = [_gate_row(work_item_type="agent_decision", neutral_facts={"question": f"질문 {i}"}) for i in range(5)]
    items = await _run_gate_inbox(monkeypatch, rows)
    assert [i["title"] for i in items] == [f"질문 {i}" for i in range(5)]


@pytest.fixture
def anyio_backend():
    return "asyncio"
