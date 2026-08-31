"""story #3263(지원v1·5에스컬레이션) AC1/AC2 — POST /api/v2/support/escalation-events 실 PG
왕복. fail-closed 분기(설정 미비)는 test_3259_support_gateway_token.py가 이미 커버 — 여기는
실 게이트 생성 경로(org/project slug 해소·customer org 이름 조회·create_gate·standalone
anchor·_ALWAYS_MANUAL 등재)를 real PG로 검증한다."""
from __future__ import annotations

import os
import uuid

import pytest
from jose import jwt as jose_jwt

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

TEST_SECRET = "test-secret-padded-to-32-bytes-min"


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


async def _seed_project(session, org_id, *, slug: str):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name="P", slug=slug)
    session.add(project)
    await session.commit()
    return project.id


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session):
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    app.dependency_overrides[get_db] = _db


def _escalation_token(*, escalation_id, org_id, user_id, reason="classifier", detail="d", summary="s") -> str:
    from app.routers.support_gateway_token import ESCALATION_DELIVERY_AUD

    return jose_jwt.encode(
        {
            "aud": ESCALATION_DELIVERY_AUD,
            "escalation_id": str(escalation_id),
            "org_id": str(org_id),
            "user_id": str(user_id),
            "reason": reason,
            "detail": detail,
            "conversation_summary": summary,
        },
        TEST_SECRET,
        algorithm="HS256",
    )


@pytest.mark.anyio
async def test_creates_standalone_anchor_gate_under_target_org_and_project(monkeypatch):
    """티켓 초안=Gate. self-referencing anchor(gate.id==work_item_id)로 moonklabs org/project
    아래 생성되고, always-manual이라 status='pending'(자동 등재 금지 — org posture 무관)."""
    from app.core.config import settings
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        org_slug = f"moonklabs-t-{uuid.uuid4().hex[:8]}"
        project_slug = f"sprintable-t-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            target_org_id = await _seed_org(s, slug=org_slug, name="테스트 moonklabs")
            target_project_id = await _seed_project(s, target_org_id, slug=project_slug)
            customer_org_id = await _seed_org(s, slug=f"customer-{uuid.uuid4().hex[:8]}", name="고객사 A")

        monkeypatch.setattr(settings, "support_gateway_token_secret", TEST_SECRET)
        monkeypatch.setattr(settings, "support_escalation_target_org_slug", org_slug)
        monkeypatch.setattr(settings, "support_escalation_target_project_slug", project_slug)
        monkeypatch.setattr(settings, "support_escalation_requester_member_id", str(uuid.uuid4()))
        monkeypatch.setattr(settings, "support_escalation_approver_member_id", str(uuid.uuid4()))

        await _setup_app(app, Session)
        escalation_id = uuid.uuid4()
        token = _escalation_token(
            escalation_id=escalation_id, org_id=customer_org_id, user_id=uuid.uuid4(),
            reason="classifier", detail="인입 분류기가 사람 필요로 판정", summary="고객: 문의합니다",
        )

        async with _client_for(app) as ac:
            resp = await ac.post(
                "/api/v2/support/escalation-events", headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 201, resp.text
        gate_id = uuid.UUID(resp.json()["gate_id"])

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.work_item_id == gate.id, "self-referencing standalone anchor"
            assert gate.org_id == target_org_id, "moonklabs org에 생성 — 고객 org 아님"
            assert gate.work_item_type == "support_escalation"
            assert gate.gate_type == "support_escalation_review"
            assert gate.status == "pending", "always-manual — 자동 등재 금지"
            assert gate.neutral_facts["support_escalation_id"] == str(escalation_id)
            assert gate.neutral_facts["customer_org_name"] == "고객사 A"
            assert gate.neutral_facts["reason"] == "classifier"
            # 페드루 PO 조건② — 카드 본문에 실물이 실려야 한다("가서 보라" 스텁 금지).
            assert gate.neutral_facts["detail"] == "인입 분류기가 사람 필요로 판정"
            assert gate.neutral_facts["conversation_summary"] == "고객: 문의합니다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_target_org_not_found_fails_closed_503(monkeypatch):
    from app.core.config import settings
    from app.main import app

    engine, Session = await _session_factory()
    try:
        monkeypatch.setattr(settings, "support_gateway_token_secret", TEST_SECRET)
        monkeypatch.setattr(settings, "support_escalation_requester_member_id", str(uuid.uuid4()))
        monkeypatch.setattr(settings, "support_escalation_approver_member_id", str(uuid.uuid4()))
        monkeypatch.setattr(settings, "support_escalation_target_org_slug", f"nonexistent-{uuid.uuid4().hex}")

        await _setup_app(app, Session)
        token = _escalation_token(escalation_id=uuid.uuid4(), org_id=uuid.uuid4(), user_id=uuid.uuid4())

        async with _client_for(app) as ac:
            resp = await ac.post(
                "/api/v2/support/escalation-events", headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 503
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
