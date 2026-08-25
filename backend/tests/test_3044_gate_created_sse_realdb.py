"""story #3044(PO 실사고 표본②, 2026-08-25 그라운딩+PO 실험 검증) — 결재함(approvals-queue.tsx)이
마운트 1회만 fetch하고 이후는 conversation.gate_resolved/gate_delegated 2종 SSE로만 갱신되는
구조라 "새 게이트가 생겼다"를 알리는 신호 자체가 없었다. notify_gate_created_to_recipients
(approval_delivery.py)가 그 3번째 신호를 신설한다 — 이 테스트는 그 신호가 실제로 Event 테이블에
심기는지(라이브 push의 durable backstop)와, id 공간 매핑 경계(team_members는 project_access
명시 grant가 있는 members 행만 — org_members 권위와 독립된 별개 id 공간)를 실 PG로 고정한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3044", slug=f"org3044-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_rostered_member(session, *, org_id, project_id):
    """team_members는 (0088 project-view 시절과 달리) 오늘은 실 base table이다(psql \\d 실측 —
    이 그라운딩 도중 발견: id PK+FK 실물, view 아님) — story #2604 _seed_human과 동형으로
    직접 INSERT한다. Event.recipient_id FK를 통과하는 유일한 형태."""
    from app.models.team import TeamMember

    member = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human",
        name="Rostered", is_active=True,
    )
    session.add(member)
    await session.commit()
    return member.id


async def _seed_org_admin_no_roster(session, *, org_id):
    """story #3044 실사고 재현 — org owner/admin이지만 이 프로젝트엔 members/project_access
    행이 없다(PO 실 계정 2fd14616과 동형 조건). OrgMember.id는 uuid4 자체 발급이라 members.id
    와 무관한 별개 id 공간 — team_members 뷰엔 존재하지 않는다."""
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"admin-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    admin_id = uuid.uuid4()
    session.add(OrgMember(id=admin_id, org_id=org_id, user_id=user_id, role="admin"))
    await session.commit()
    return admin_id


async def test_notify_gate_created_inserts_event_for_rostered_recipient():
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_rostered_member(s, org_id=org_id, project_id=project_id)
            gate_id = uuid.uuid4()

            pushes = await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=gate_id, recipient_ids=[member_id],
            )
            await s.commit()

            assert len(pushes) == 1
            pid_str, payload = pushes[0]
            assert pid_str == str(member_id)
            assert payload["event_type"] == "conversation.gate_created"
            assert payload["gate_id"] == str(gate_id)

            from app.models.event import Event
            from sqlalchemy import select
            rows = (await s.execute(
                select(Event).where(Event.source_entity_id == gate_id, Event.event_type == "conversation.gate_created")
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].recipient_id == member_id
    finally:
        await engine.dispose()


async def test_notify_gate_created_skips_org_admin_without_project_roster():
    """id 공간 매핑 경계(페드루 PO 요청) — org_members 권위(role floor)와 team_members
    메시징 신원(project_access 명시 grant)은 독립된 별개 공간. 이 recipient는 실제로 게이트를
    승인할 자격이 있어도(rule B org floor) Event FK를 만족 못 해 — 크래시 대신 조용히 스킵
    되고(로그만), 다른 정상 recipient는 영향받지 않는다(부분 실패 격리)."""
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            rostered_id = await _seed_rostered_member(s, org_id=org_id, project_id=project_id)
            admin_no_roster_id = await _seed_org_admin_no_roster(s, org_id=org_id)
            gate_id = uuid.uuid4()

            pushes = await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=gate_id,
                recipient_ids=[rostered_id, admin_no_roster_id],
            )
            await s.commit()

            pushed_ids = {p[0] for p in pushes}
            assert pushed_ids == {str(rostered_id)}, "roster 없는 org admin은 스킵되고 rostered 대상만 push"
    finally:
        await engine.dispose()


async def test_notify_gate_created_empty_recipients_returns_empty_no_crash():
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            pushes = await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=uuid.uuid4(), recipient_ids=[],
            )
            assert pushes == []
    finally:
        await engine.dispose()
