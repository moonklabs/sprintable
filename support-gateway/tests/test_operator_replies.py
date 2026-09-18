"""story #3279(지원v1·후속) — 운영자 회신 착지점(POST /api/v1/internal/operator-replies)
엔드투엔드. 실 에스컬레이션(고객 턴→SupportEscalation 생성)을 먼저 만들고, 그 escalation_id를
운영자 회신 토큰에 실어 보내 SupportMessage(role='operator')로 적재되는지 확認한다."""
from __future__ import annotations

import uuid

import jwt
from sqlalchemy import select

from app.config import settings
from app.models import SupportEscalation, SupportMessage
from app.token_verify import OPERATOR_REPLY_AUD
from tests.conftest import OTHER_ORG_ID, TEST_TOKEN_SECRET, make_token


def _operator_reply_token(escalation_id: uuid.UUID, content: str, *, secret: str = TEST_TOKEN_SECRET) -> str:
    return jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(escalation_id), "content": content},
        secret,
        algorithm="HS256",
    )


async def _create_escalated_conversation(client, fake_llm, db_engine):
    """고객 턴 하나로 실 SupportEscalation 행을 만들고 그 id를 돌려준다(합성 mock이 아니라
    handle_turn의 실 classifier→escalation_task 경로를 태운다, test_admin_metrics.py 관례)."""
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages", json={"content": "사람 필요해요"}, headers=headers
    )
    conversation_id = uuid.UUID(resp.json()["customer_message"]["conversation_id"])

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db_session:
        escalation = (
            await db_session.execute(
                select(SupportEscalation).where(SupportEscalation.conversation_id == conversation_id)
            )
        ).scalars().one()
        return escalation.id, conversation_id, session_id, headers


async def test_operator_reply_lands_in_the_escalated_conversation(client, fake_llm, db_engine):
    escalation_id, conversation_id, session_id, headers = await _create_escalated_conversation(
        client, fake_llm, db_engine
    )

    token = _operator_reply_token(escalation_id, "안녕하세요, 확인 후 답변드립니다.")
    resp = await client.post(
        "/api/v1/internal/operator-replies", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role"] == "operator"
    assert body["content"] == "안녕하세요, 확인 후 답변드립니다."
    assert body["conversation_id"] == str(conversation_id)

    # 고객 쪽 GET 이력 조회에도 그대로 보인다(별도 렌더 축은 story #3279 후속 FE 몫이지만,
    # 데이터 자체는 이미 이 왕복으로 도달해 있어야 한다).
    history = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    contents = [m["content"] for m in history.json()["messages"]]
    assert "안녕하세요, 확인 후 답변드립니다." in contents

    from sqlalchemy.ext.asyncio import async_sessionmaker

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db_session:
        operator_messages = (
            await db_session.execute(select(SupportMessage).where(SupportMessage.role == "operator"))
        ).scalars().all()
        assert len(operator_messages) == 1
        assert operator_messages[0].org_id == OTHER_ORG_ID


async def test_operator_reply_lands_even_when_conversation_already_ended(client, fake_llm, db_engine):
    """story #3276과의 상호작용 pin — 상담이 종료된 뒤에도 운영자 회신은 그대로 적재된다
    (읽기전용은 "고객의 새 발화"만 막는 개념, 왕복 마무리는 막지 않는다)."""
    escalation_id, conversation_id, session_id, headers = await _create_escalated_conversation(
        client, fake_llm, db_engine
    )
    end_resp = await client.post(
        f"/api/v1/sessions/{session_id}/conversations/{conversation_id}/end", headers=headers
    )
    assert end_resp.status_code == 200

    token = _operator_reply_token(escalation_id, "종료 후에도 도달하는 회신")
    resp = await client.post(
        "/api/v1/internal/operator-replies", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 201, resp.text


async def test_operator_reply_unknown_escalation_id_returns_404(client):
    token = _operator_reply_token(uuid.uuid4(), "존재하지 않는 escalation")
    resp = await client.post(
        "/api/v1/internal/operator-replies", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 404


async def test_operator_reply_invalid_token_rejected(client):
    resp = await client.post(
        "/api/v1/internal/operator-replies", headers={"Authorization": "Bearer garbage"}
    )
    assert resp.status_code == 401


async def test_operator_reply_wrong_secret_rejected(client):
    token = _operator_reply_token(uuid.uuid4(), "wrong secret", secret="not-the-real-secret-padded-32-bytes")
    resp = await client.post(
        "/api/v1/internal/operator-replies", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401
