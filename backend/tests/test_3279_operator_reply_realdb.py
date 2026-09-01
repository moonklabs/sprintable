"""story #3279(지원v1·후속) — deliver_operator_reply_for_gate의 Gate 역참조를 실 PG로
검증한다(story #3263 test_3263_support_escalation_events_realdb.py와 동형 스캐폴딩).
deliver_operator_reply 자체(HTTP 배달)는 test_3279_operator_reply.py가 이미 mock으로
커버 — 여기는 그 함수를 monkeypatch로 갈아치우고 "올바른 escalation_id로 호출됐는가"만
본다."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug: str, name: str):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=slug)
    session.add(org)
    await session.commit()
    return org.id


async def _seed_support_escalation_gate(session, *, org_id, escalation_id: uuid.UUID | None):
    """create_gate()를 직접 부르지 않고 Gate 행 자체의 실 컬럼만 심는다(member_id/role_id/
    project_id는 Gate 모델의 컬럼이 아니다 — create_gate() 서비스 함수의 파라미터일 뿐,
    다른 테이블/관계로 해소된다). 이 테스트는 게이트 *생성* 경로(test_3263가 이미 커버)가
    아니라 *역참조 조회* 경로만 겨냥한다."""
    from app.models.gate import Gate

    gate_id = uuid.uuid4()
    neutral_facts: dict = {}
    if escalation_id is not None:
        neutral_facts["support_escalation_id"] = str(escalation_id)
    gate = Gate(
        id=gate_id,
        org_id=org_id,
        work_item_id=gate_id,
        work_item_type="support_escalation",
        gate_type="support_escalation_review",
        status="pending",
        neutral_facts=neutral_facts,
    )
    session.add(gate)
    await session.commit()
    return gate_id


@pytest.mark.anyio
async def test_deliver_operator_reply_for_gate_resolves_escalation_id_and_delegates(monkeypatch):
    from app.services import operator_reply_delivery as mod

    engine, Session = await _session_factory()
    try:
        org_slug = f"org-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            org_id = await _seed_org(s, slug=org_slug, name="테스트 조직")
            escalation_id = uuid.uuid4()
            gate_id = await _seed_support_escalation_gate(s, org_id=org_id, escalation_id=escalation_id)

        monkeypatch.setattr("app.core.database.async_session_factory", Session)
        delegate = AsyncMock(return_value=True)
        monkeypatch.setattr(mod, "deliver_operator_reply", delegate)

        result = await mod.deliver_operator_reply_for_gate(gate_id=gate_id, content="답변 내용입니다.")

        assert result is True
        delegate.assert_awaited_once_with(escalation_id=escalation_id, content="답변 내용입니다.")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_deliver_operator_reply_for_gate_missing_escalation_id_skips(monkeypatch):
    """neutral_facts에 support_escalation_id가 없는(예: 다른 사유로 변조된) 게이트 —
    정직하게 스킵(False), 배달 함수는 아예 안 부른다."""
    from app.services import operator_reply_delivery as mod

    engine, Session = await _session_factory()
    try:
        org_slug = f"org-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            org_id = await _seed_org(s, slug=org_slug, name="테스트 조직")
            gate_id = await _seed_support_escalation_gate(s, org_id=org_id, escalation_id=None)

        monkeypatch.setattr("app.core.database.async_session_factory", Session)
        delegate = AsyncMock(return_value=True)
        monkeypatch.setattr(mod, "deliver_operator_reply", delegate)

        result = await mod.deliver_operator_reply_for_gate(gate_id=gate_id, content="x")

        assert result is False
        delegate.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_deliver_operator_reply_for_gate_unknown_gate_id_skips(monkeypatch):
    from app.services import operator_reply_delivery as mod

    engine, Session = await _session_factory()
    try:
        monkeypatch.setattr("app.core.database.async_session_factory", Session)
        delegate = AsyncMock(return_value=True)
        monkeypatch.setattr(mod, "deliver_operator_reply", delegate)

        result = await mod.deliver_operator_reply_for_gate(gate_id=uuid.uuid4(), content="x")

        assert result is False
        delegate.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_deliver_operator_reply_for_gate_non_support_escalation_gate_skips(monkeypatch):
    """work_item_type이 support_escalation이 아닌 게이트(예: doc 결재) — gate_id가 우연히
    맞아도 절대 배달하면 안 된다(오배달 방지 pin)."""
    from app.models.gate import Gate
    from app.services import operator_reply_delivery as mod

    engine, Session = await _session_factory()
    try:
        org_slug = f"org-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            org_id = await _seed_org(s, slug=org_slug, name="테스트 조직")
            gate_id = uuid.uuid4()
            s.add(Gate(
                id=gate_id, org_id=org_id, work_item_id=gate_id,
                work_item_type="doc", gate_type="doc_review", status="pending",
                neutral_facts={"support_escalation_id": str(uuid.uuid4())},
            ))
            await s.commit()

        monkeypatch.setattr("app.core.database.async_session_factory", Session)
        delegate = AsyncMock(return_value=True)
        monkeypatch.setattr(mod, "deliver_operator_reply", delegate)

        result = await mod.deliver_operator_reply_for_gate(gate_id=gate_id, content="x")

        assert result is False
        delegate.assert_not_awaited()
    finally:
        await engine.dispose()
