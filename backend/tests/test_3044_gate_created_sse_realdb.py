"""story #3044(PO 실사고 표본②, 2026-08-25 그라운딩+PO 실험 검증) — 결재함(approvals-queue.tsx)이
마운트 1회만 fetch하고 이후는 conversation.gate_resolved/gate_delegated 2종 SSE로만 갱신되는
구조라 "새 게이트가 생겼다"를 알리는 신호 자체가 없었다. notify_gate_created_to_recipients
(approval_delivery.py)가 그 3번째 신호를 신설한다 — 이 테스트는 그 신호가 실제로 Event
테이블에 심기는지(durable)·commit 성공 後에만 정확히 발화되는지(after_commit 훅, event_seq.py
의 _schedule_wake_after_commit과 동형 — test_2381_wake_after_commit_race_realdb.py의 검증
패턴 재사용)·id 공간 매핑 경계(team_members는 project_access 명시 grant가 있는 members 행만
— org_members 권위와 독립된 별개 id 공간)를 실 PG로 고정한다.

⚠️PO 정면 돌파 지시(2026-08-25) — notify_gate_created_to_recipients는 caller에게 반환값을
스레딩하지 않는다(-> None). 대신 event_seq.py와 동형으로 세션 자신의 after_commit 이벤트에
push를 예약한다 — dispatch_approval_request_cards의 8개 호출부(merge_verdict_gate.py·doc.py
포함) 전부가 caller 협조 없이 구조적으로 커버된다."""
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


async def test_notify_gate_created_inserts_durable_event_for_rostered_recipient():
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_rostered_member(s, org_id=org_id, project_id=project_id)
            gate_id = uuid.uuid4()

            result = await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=gate_id, recipient_ids=[member_id],
            )
            await s.commit()
            assert result is None, "caller 반환값 스레딩 없음(after_commit 훅으로 자체 예약)"

            from app.models.event import Event
            from sqlalchemy import select
            rows = (await s.execute(
                select(Event).where(Event.source_entity_id == gate_id, Event.event_type == "conversation.gate_created")
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].recipient_id == member_id
            assert rows[0].payload["gate_id"] == str(gate_id)
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

            await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=gate_id,
                recipient_ids=[rostered_id, admin_no_roster_id],
            )
            await s.commit()

            from app.models.event import Event
            from sqlalchemy import select
            rows = (await s.execute(
                select(Event.recipient_id).where(Event.source_entity_id == gate_id, Event.event_type == "conversation.gate_created")
            )).scalars().all()
            assert set(rows) == {rostered_id}, "roster 없는 org admin은 스킵되고 rostered 대상만 Event가 남는다"
    finally:
        await engine.dispose()


async def test_notify_gate_created_empty_recipients_no_crash():
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            result = await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=uuid.uuid4(), recipient_ids=[],
            )
            assert result is None
    finally:
        await engine.dispose()


async def test_push_fires_only_after_commit_not_before(monkeypatch):
    """event_seq.py의 test_2381 검증 패턴과 동형 — commit 前엔 push가 절대 안 나가고(다른
    커넥션에서 아직 안 보이는 row를 GET하러 보내는 레이스 방지), commit 성공 直後에 정확히
    한 번 나간다."""
    from app.services.approval_delivery import notify_gate_created_to_recipients
    import app.routers.events as events_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as seed_s:
            org_id, project_id = await _seed_org_project(seed_s)
            member_id = await _seed_rostered_member(seed_s, org_id=org_id, project_id=project_id)

        pushed: list[tuple[str, dict]] = []
        monkeypatch.setattr(events_mod, "_push_to_agent", lambda pid, payload: pushed.append((pid, payload)))
        # approval_delivery._fire_pending_gate_created_pushes는 `from app.routers.events import
        # _push_to_agent`를 발화 시점마다 late-import하므로, events_mod 속성을 바꾸는 것만으로
        # monkeypatch가 반영된다(test_2381의 gw_mod.wake_agent와 동일 원리).

        gate_id = uuid.uuid4()
        async with Session() as s:
            await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=gate_id, recipient_ids=[member_id],
            )
            assert pushed == [], "commit 前인데 이미 push가 나갔다 — 레이스 재발"
            await s.commit()

        assert len(pushed) == 1
        pid_str, payload = pushed[0]
        assert pid_str == str(member_id)
        assert payload["event_type"] == "conversation.gate_created"
        assert payload["gate_id"] == str(gate_id)
    finally:
        await engine.dispose()


async def test_evaluate_merge_gate_creates_gate_created_event_too():
    """PO 정면 돌파 검증(2026-08-25) — 원 표본(gate 2a14c177)이 정확히 이 경로(merge 게이트
    생성, merge_verdict_gate.py evaluate_merge_gate)였다. 이 파일 다른 함수들을 직접 호출하는
    대신 실제 진입점을 그대로 태워, after_commit 훅이 merge_verdict_gate.py를 단 1줄도 안
    건드리고도 실제로 커버함을 증명한다(caller 협조 불요 설계의 핵심 주장)."""
    from sqlalchemy import select
    from app.models.event import Event
    from app.models.hitl_config import OrgGatePolicy
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.team import TeamMember
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _session_factory()
    story_id, role_id = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)

            # 구현자(agent) — 상신자.
            implementer_id = uuid.uuid4()
            s.add(TeamMember(
                id=implementer_id, org_id=org_id, project_id=project_id, type="agent",
                name="디디", is_active=True,
            ))
            await s.commit()

            # 승인자 — OrgMember(role 판정용)+같은 id의 TeamMember(메시징 신원용), test_2118의
            # _seed_org_member와 동형(둘 다 필요한 이유는 이 파일 상단 id 공간 경계 설명 참고).
            from app.models.project import OrgMember
            approver_id = uuid.uuid4()
            s.add(OrgMember(id=approver_id, org_id=org_id, user_id=uuid.uuid4(), role="owner"))
            s.add(TeamMember(
                id=approver_id, org_id=org_id, project_id=project_id, type="human",
                name="approver", is_active=True,
            ))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org_id, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org_id, project_id=project_id, title="#3044 검증", status="in-review", story_points=3),
            ])
            s.add(OrgGatePolicy(org_id=org_id, posture="conservative"))
            await s.commit()
            s.add(Participation(id=uuid.uuid4(), org_id=org_id, story_id=story_id, member_id=implementer_id, role_id=role_id))
            await s.commit()

        async with Session() as s:
            decision = await evaluate_merge_gate(
                s, org_id, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.source_entity_id == decision.gate_id, Event.event_type == "conversation.gate_created",
                )
            )).scalars().all()
            assert len(rows) == 1, "merge_verdict_gate.py 경로도 conversation.gate_created가 심겨야 한다(정면 돌파)"
            assert rows[0].recipient_id == approver_id
    finally:
        await engine.dispose()


async def test_push_never_fires_on_rollback(monkeypatch):
    from app.services.approval_delivery import notify_gate_created_to_recipients
    import app.routers.events as events_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as seed_s:
            org_id, project_id = await _seed_org_project(seed_s)
            member_id = await _seed_rostered_member(seed_s, org_id=org_id, project_id=project_id)

        pushed: list[tuple[str, dict]] = []
        monkeypatch.setattr(events_mod, "_push_to_agent", lambda pid, payload: pushed.append((pid, payload)))

        async with Session() as s:
            await notify_gate_created_to_recipients(
                s, org_id=org_id, project_id=project_id, gate_id=uuid.uuid4(), recipient_ids=[member_id],
            )
            await s.rollback()

        assert pushed == [], "rollback된 트랜잭션에서 push가 발화되면 안 된다"
    finally:
        await engine.dispose()
