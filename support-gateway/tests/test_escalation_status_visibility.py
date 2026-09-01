"""story #3263 AC4 — 대화 레벨 에스컬레이션 상태 가시(무신호 금지). 턴 단위 `escalated`
배지(app/schemas.py MessageExchangeResponse)는 그 턴 하나의 순간신호일 뿐이라, 위젯을
닫았다 재오픈(GET /messages)하면 "사람에게 넘어갔다"는 사실이 조용히 사라지던 갭을 닫는다."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import SupportEscalation
from tests.conftest import OTHER_ORG_ID, make_token


async def test_never_escalated_conversation_status_is_none(client, fake_llm):
    fake_llm.classify_text = "inquiry"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    post_resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages", json={"content": "hi"}, headers=headers
    )
    assert post_resp.json()["escalation_status"] is None

    get_resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert get_resp.json()["escalation_status"] is None


async def test_empty_conversation_status_is_none(client, fake_llm):
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    body = resp.json()
    assert body["messages"] == []
    assert body["escalation_status"] is None


async def test_escalated_turn_surfaces_open_status_in_post_response(client, fake_llm):
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages", json={"content": "사람 바꿔주세요"}, headers=headers
    )
    body = resp.json()
    assert body["escalated"] is True
    assert body["escalation_status"] == "open"


async def test_escalation_status_survives_widget_reopen(client, fake_llm):
    """핵심 회귀 — 에스컬 턴이 지나간 뒤 재오픈(GET)에서도 상태가 그대로 보여야 한다."""
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "사람 바꿔주세요"}, headers=headers)

    get_resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert get_resp.json()["escalation_status"] == "open"


async def test_resolved_escalation_reflected_on_next_fetch(client, fake_llm, db_engine):
    """v1은 동기 왕복뿐(SSE/폴링 없음) — 해결 처리는 사람(PO)이 다른 경로(Gate 승인)로 DB를
    바꾸고, 위젯은 다음 재접속/재오픈 시점에 그 최신 상태를 반영한다(실시간 알림은 스코프 밖,
    페드루 PO에 스펙 공유 시 명시)."""
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "사람 바꿔주세요"}, headers=headers)

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db:
        escalation = (await db.execute(select(SupportEscalation))).scalars().one()
        escalation.status = "resolved"
        db.add(escalation)
        await db.commit()

    resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert resp.json()["escalation_status"] == "resolved"


async def test_latest_escalation_wins_over_earlier_resolved_one(client, fake_llm, db_engine):
    """재발 케이스 — 먼저 resolved된 에스컬 뒤에 새 open이 또 생기면 최신(open)이 이겨야
    한다(과거 이력에 안 눌린다)."""
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "첫 문의"}, headers=headers)

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db:
        escalation = (await db.execute(select(SupportEscalation))).scalars().one()
        escalation.status = "resolved"
        db.add(escalation)
        await db.commit()

    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "재발 문의"}, headers=headers)

    resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert resp.json()["escalation_status"] == "open"


async def test_open_escalation_still_wins_when_a_later_separate_one_gets_resolved(client, fake_llm, db_engine):
    """카디르 QA 지적(PR#3662, PR#3663과 동일 클래스 갭) — 위 테스트의 시간축 반대 케이스도
    pin 한다: open 행이 먼저 생기고, 그보다 나중에 생긴 별개 escalation이 resolved로
    마감돼도 여전히 open이 이겨야 한다. "가장 최근 1건의 status"로 잘못 구현했다면(과거
    _latest_escalation_status) 이 케이스에서 resolved를 반환해 RED가 된다 — "지금 열려있는
    게 하나라도 있는가"가 실제로 순서 무관임을 구조적으로 고정."""
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    # 1번째 에스컬(open으로 남는다) — 시각상 더 이르다.
    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "첫 문의"}, headers=headers)

    # 2번째 에스컬 — 시각상 더 나중이지만, 이 행만 resolved로 마감된다.
    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "두번째 문의"}, headers=headers)
    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db:
        escalations = (
            await db.execute(select(SupportEscalation).order_by(SupportEscalation.created_at.asc()))
        ).scalars().all()
        assert len(escalations) == 2
        later = escalations[-1]
        later.status = "resolved"
        db.add(later)
        await db.commit()

    resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert resp.json()["escalation_status"] == "open"
