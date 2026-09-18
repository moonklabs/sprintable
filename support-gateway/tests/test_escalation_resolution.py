"""story #183fe7a5(지원v1·후속) — 게이트 해소 동기화 착지점
(POST /api/v1/internal/escalation-resolution) 엔드투엔드. test_operator_replies.py와 동형
스캐폴딩 — 실 에스컬레이션(고객 턴→SupportEscalation 생성)을 먼저 만들고, 그 escalation_id로
동기화 토큰을 보내 status가 'open'→'resolved'로 실제 바뀌는지 확認한다."""
from __future__ import annotations

import uuid

import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import SupportEscalation
from app.token_verify import ESCALATION_RESOLUTION_AUD
from tests.conftest import OTHER_ORG_ID, TEST_TOKEN_SECRET, make_token


def _resolution_token(escalation_id: uuid.UUID, resolution: str, *, secret: str = TEST_TOKEN_SECRET) -> str:
    return jwt.encode(
        {"aud": ESCALATION_RESOLUTION_AUD, "escalation_id": str(escalation_id), "resolution": resolution},
        secret,
        algorithm="HS256",
    )


async def _create_escalation(client, fake_llm, db_engine) -> uuid.UUID:
    fake_llm.classify_text = "needs_human"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages", json={"content": "사람 필요해요"}, headers=headers
    )
    conversation_id = uuid.UUID(resp.json()["customer_message"]["conversation_id"])

    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db_session:
        escalation = (
            await db_session.execute(
                select(SupportEscalation).where(SupportEscalation.conversation_id == conversation_id)
            )
        ).scalars().one()
        assert escalation.status == "open"  # 양성대조 — 착수 전 실제로 open인지 먼저 확認.
        return escalation.id


async def _escalation_status(db_engine, escalation_id: uuid.UUID) -> str:
    async with async_sessionmaker(db_engine, expire_on_commit=False)() as db_session:
        escalation = await db_session.get(SupportEscalation, escalation_id)
        return escalation.status


async def test_approve_resolution_marks_escalation_resolved(client, fake_llm, db_engine):
    """⭐AC1 pin — 이 스토리의 핵심 계약. 착수 전엔 실측상 이 값이 절대 'resolved'가 될
    방법이 없었다(코드 전수: status='resolved' 기록 자리 0건, 스토리 발견 사실)."""
    escalation_id = await _create_escalation(client, fake_llm, db_engine)

    token = _resolution_token(escalation_id, "approved")
    resp = await client.post(
        "/api/v1/internal/escalation-resolution", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 204, resp.text

    assert await _escalation_status(db_engine, escalation_id) == "resolved"


async def test_reject_resolution_also_marks_escalation_resolved(client, fake_llm, db_engine):
    """⭐AC2 pin — reject도 approve와 동일하게 위젯 배너를 정리한다(설계 결정, 모듈
    docstring 참고: 두 판정 다 "사람이 이 문의를 처리 대상으로 받아 갔다"는 동일 사실)."""
    escalation_id = await _create_escalation(client, fake_llm, db_engine)

    token = _resolution_token(escalation_id, "rejected")
    resp = await client.post(
        "/api/v1/internal/escalation-resolution", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 204, resp.text

    assert await _escalation_status(db_engine, escalation_id) == "resolved"


async def test_resolution_unknown_escalation_id_returns_404(client):
    token = _resolution_token(uuid.uuid4(), "approved")
    resp = await client.post(
        "/api/v1/internal/escalation-resolution", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 404


async def test_resolution_invalid_token_rejected(client):
    resp = await client.post(
        "/api/v1/internal/escalation-resolution", headers={"Authorization": "Bearer garbage"}
    )
    assert resp.status_code == 401


async def test_resolution_wrong_secret_rejected(client):
    token = _resolution_token(uuid.uuid4(), "approved", secret="not-the-real-secret-padded-32-bytes")
    resp = await client.post(
        "/api/v1/internal/escalation-resolution", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


async def test_resolution_operator_reply_token_cross_kind_rejected(client):
    """교차토큰 방어 — operator-reply용 토큰(aud 다름)을 이 엔드포인트에 보내면 401."""
    from app.token_verify import OPERATOR_REPLY_AUD

    token = jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(uuid.uuid4()), "content": "wrong endpoint"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    resp = await client.post(
        "/api/v1/internal/escalation-resolution", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


async def test_resolution_is_idempotent_on_repeat_delivery(client, fake_llm, db_engine):
    """재시도/중복 배달(operator_reply_delivery.py 계약의 "재시도" 여지와 동형) — 두 번
    보내도 에러 없이 그대로 resolved 유지."""
    escalation_id = await _create_escalation(client, fake_llm, db_engine)
    token = _resolution_token(escalation_id, "approved")

    for _ in range(2):
        resp = await client.post(
            "/api/v1/internal/escalation-resolution", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 204

    assert await _escalation_status(db_engine, escalation_id) == "resolved"
