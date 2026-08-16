"""story #373cfaa1: doc 결재 상신 시 alarm 중복(gate.pending_approval + doc_approval_requested)
제거 — realdb 핀. create_gate()의 generic "gate.pending_approval" 벨과 doc.py
_notify_doc_approval_requested()의 doc 전용 "doc_approval_requested" 벨이 같은 org owner/admin
대상에 동시 발화하던 결함(judgment 989e26d8-9491-4816-8148-bdecf69a04eb 참조) — create_gate(notify=False)
로 generic 벨을 끄고 doc 전용 알림만 남긴다.

mutation-kill: doc.py의 notify=False 인자를 빼면 아래 테스트들의 assert가 2건으로 RED가 된다."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

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


async def _seed_org_project_admin(session, org_id, project_id):
    from app.core.security import hash_password
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    session.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
    await session.commit()
    session.add(Project(id=project_id, org_id=org_id, name="P"))
    await session.commit()
    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"admin-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    admin_member_id = uuid.uuid4()
    session.add(OrgMember(id=admin_member_id, org_id=org_id, user_id=user_id, role="admin"))
    await session.commit()
    return admin_member_id, user_id


async def _seed_requester(session, org_id):
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"req-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=user_id, role="member"))
    await session.commit()
    return member_id


@pytest.mark.anyio
async def test_doc_submit_notifies_approver_exactly_once():
    """draft→pending 최초 상신: approver(admin)에게 Notification 정확히 1건(doc_approval_requested)
    — gate.pending_approval 은 0건(중복 제거 실증)."""
    from app.models.doc import Doc
    from app.models.notification import Notification
    from app.services.doc import transition_doc
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _admin_member_id, admin_user_id = await _seed_org_project_admin(s, org_id, project_id)
            requester_id = await _seed_requester(s, org_id)
            doc = Doc(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="설계",
                      slug=f"s-{uuid.uuid4().hex[:10]}", status="draft", content="")
            s.add(doc)
            await s.commit()

            caller = ResolvedMember(id=requester_id, user_id=uuid.uuid4(), name="req",
                                     type="human", role="member", org_id=org_id)
            out = await transition_doc(s, org_id, caller, doc.id, "pending")
            await s.commit()
            assert out.status == "pending"

            rows = (await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id,
                    Notification.user_id == admin_user_id,
                )
            )).scalars().all()
            types = [n.type for n in rows]
            assert types == ["doc_approval_requested"], types  # gate.pending_approval 중복 0건
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_resubmit_after_reject_notifies_approver_exactly_once():
    """반려 후 재상신(rejected→pending reopen): create_gate() 내부 _reopen_rejected_gate()가
    별도 발화 지점이라 최초상신과 다른 경로 — 여기서도 신규 Notification이 정확히 1건이어야 한다."""
    from app.models.doc import Doc
    from app.models.gate import Gate, set_gate_status
    from app.models.notification import Notification
    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE, transition_doc
    from app.services.member_resolver import ResolvedMember
    from datetime import datetime, timezone

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _admin_member_id, admin_user_id = await _seed_org_project_admin(s, org_id, project_id)
            requester_id = await _seed_requester(s, org_id)
            doc = Doc(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="설계",
                      slug=f"s-{uuid.uuid4().hex[:10]}", status="draft", content="")
            s.add(doc)
            await s.commit()

            caller = ResolvedMember(id=requester_id, user_id=uuid.uuid4(), name="req",
                                     type="human", role="member", org_id=org_id)
            await transition_doc(s, org_id, caller, doc.id, "pending")
            await s.commit()

            before_count = len((await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id, Notification.user_id == admin_user_id,
                )
            )).scalars().all())

            gate = (await s.execute(
                select(Gate).where(
                    Gate.org_id == org_id, Gate.work_item_id == doc.id,
                    Gate.work_item_type == DOC_GATE_WORK_ITEM_TYPE, Gate.gate_type == DOC_GATE_TYPE,
                )
            )).scalar_one()
            set_gate_status(gate, "rejected", now=datetime.now(timezone.utc))
            doc.status = "draft"
            await s.commit()

            await transition_doc(s, org_id, caller, doc.id, "pending")
            await s.commit()

            rows = (await s.execute(
                select(Notification).where(
                    Notification.org_id == org_id, Notification.user_id == admin_user_id,
                )
            )).scalars().all()
            new_types = [n.type for n in rows][before_count:]
            assert new_types == ["doc_approval_requested"], new_types
    finally:
        await engine.dispose()
