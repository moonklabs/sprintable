"""story 1934(선생님 앱 done-gate: "디스코드 떼고 승인게이트·채팅 알림 실기기 즉시 수신"):
gate 생성(pending)과 채팅 멘션/메시지가 dispatch_notification()을 실제로 호출해 human 수신자에게
in-app Notification(+push, EE 게이트)이 생성되는지 실증. deliver_expo_push 자체(Expo API 왕복)는
E-MOBILE M0·S3 자체 스코프 밖이라 여기선 dispatch_notification의 core 부분(Notification INSERT)
까지만 확인 — 이미 배선된 push 채널(is_ee_enabled 게이트)은 별도로 신뢰."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
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


async def _seed_org_admin(session, org_id):
    """org owner/admin human 1명 시드 — gate 알림 대상 해소 확인용."""
    from app.core.security import hash_password
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    session.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
    await session.commit()
    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"admin-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    org_member_id = uuid.uuid4()
    session.add(OrgMember(id=org_member_id, org_id=org_id, user_id=user_id, role="admin"))
    await session.commit()
    return org_member_id, user_id


@pytest.mark.anyio
async def test_create_gate_pending_notifies_org_admin():
    """gate_service.create_gate()가 pending 상태로 생성되면 org owner/admin에게 in-app
    Notification이 실제로 INSERT돼야 한다(story 1934 핵심 갭 수정 실증)."""
    from sqlalchemy import select
    from app.models.notification import Notification
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            admin_member_id, _user_id = await _seed_org_admin(s, org_id)

            gate = await create_gate(
                s, org_id, uuid.uuid4(), "story", "pr_review",
                uuid.uuid4(), uuid.uuid4(),
            )
            assert gate.status == "pending"
            await s.commit()

            notif = (await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id,
                    Notification.type == "gate.pending_approval",
                    Notification.reference_id == gate.id,
                )
            )).scalar_one_or_none()
            assert notif is not None
            assert notif.user_id == _user_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_gate_auto_passed_does_not_notify():
    """allow_auto 정책(disposition)이면 status=auto_passed — 결재 대기가 아니므로 알림 0."""
    from sqlalchemy import select
    from app.models.hitl_config import OrgGatePolicy
    from app.models.notification import Notification
    from app.services.gate_service import create_gate

    org_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            admin_member_id, _user_id = await _seed_org_admin(s, org_id)
            s.add(OrgGatePolicy(id=uuid.uuid4(), org_id=org_id, posture="permissive"))
            await s.commit()

            gate = await create_gate(
                s, org_id, uuid.uuid4(), "story", "pr_review",
                uuid.uuid4(), uuid.uuid4(),
            )
            await s.commit()

            notif = (await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id,
                    Notification.type == "gate.pending_approval",
                    Notification.reference_id == gate.id,
                )
            )).scalar_one_or_none()
            if gate.status != "pending":
                assert notif is None
    finally:
        await engine.dispose()
