"""story #2216 「전달누락 계열」 — `workflow_fallback_notify.py:54`(fallback_notify, E-DECISION-GATE
S12 Gap2: stuck handoff human fallback 통지)가 `TeamMember`(=team_members뷰, members ⋈
project_access INNER JOIN) 단독 조회로 통지 대상 human owner를 골랐다 — grant-only 휴먼
(project_access를 org_member_id 경유로만 가진 멤버)과 owner-floor org owner/admin(명시
project_access grant 없이 has_project_access의 admin_branch org-wide floor로만 이 프로젝트에
접근하는 멤버)이 이 뷰에 행이 없어 조용히 빠졌다 — stuck handoff가 나도 아무도 통지받지 못했다.

⛔이 결함 클래스는 403 같은 눈에 보이는 실패가 아니라 **아무 일도 안 일어나는 것**이라 —
「안 왔다」와 「애초에 알림 로직이 안 도는 상황」이 구별 안 된다(오르테가군 지적, 2026-07-27).
그래서 이 파일은 반드시 **양성대조**를 먼저 세운다: team_member 기반(project grant 有) 휴먼은
같은 이벤트에서 실제로 통지를 받는다는 것을 먼저 확認한 뒤(기존
`test_edg_s12be_recipient_fallback.py::test_fallback_notify_notifies_humans_and_idempotent`가
이미 이 축을 검증 — 무회귀 확인용으로 재사용), grant-only/owner-floor 휴먼이 못 받는 것을
본다 — 그래야 「누락」이 증명된다(#2216 team_members.py:338/sprints.py:424와 동형 규율).

처방: targets 집합에 has_project_access의 human_grant/owner-admin-floor 두 분기를 OrgMember.id
로 재현해 set 합집합 — dispatch_notification 자신이 이미 org_member.id 축 grant-only 휴먼
해소를 지원한다(E-MEMBER-SSOT AC2-2).

story 8236bbc3와 동형: create_all(+drop_all) 격리 스키마 전용(destructive_schema) — team_members
가 이 스키마에선 진짜 테이블이라 ORM TeamMember insert가 안전하다(공유 alembic-migrated
DB에서는 view라 금지, [[feedback_no_team_members_view_dml_in_tests]]).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema
_NOTIFY_TARGET_IDS = "app.services.notification_dispatch.dispatch_notification"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.event  # noqa: F401 — 단독 실행 시 create_all 순서 의존 회피(Base.metadata
    # 등록은 프로세스 전역 1회성이라, 전체 스위트에선 다른 파일이 먼저 등록해줘 우연히 통과하지만
    # 이 파일만 단독 실행하면 miss될 수 있다 — 명시 import로 순서 무관하게 함).
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _project(s, org):
    from app.models.project import Project
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    return proj


async def _team_member_human(s, org, proj, *, name="tm-owner"):
    from app.models.team import TeamMember
    mid = uuid.uuid4()
    s.add(TeamMember(id=mid, org_id=org, project_id=proj, type="human", name=name, is_active=True))
    await s.flush()
    return mid


async def _grant_only_human(s, org, proj):
    """project_access를 org_member_id 경유로만 가진 휴먼 — team_members 행 없음."""
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    om_id = uuid.uuid4()
    s.add(OrgMember(id=om_id, org_id=org, user_id=uuid.uuid4(), role="member"))
    await s.flush()
    s.add(ProjectAccess(id=uuid.uuid4(), project_id=proj, org_member_id=om_id, role="member", permission="granted"))
    await s.flush()
    return om_id


async def _owner_floor_admin(s, org):
    """org owner/admin — project_access grant 없이 org-wide floor로만 접근. team_members 행 없음."""
    from app.models.project import OrgMember
    om_id = uuid.uuid4()
    s.add(OrgMember(id=om_id, org_id=org, user_id=uuid.uuid4(), role="owner"))
    await s.flush()
    return om_id


async def _run_with_event(s, org, proj):
    from app.models.event import Event
    from app.models.team import TeamMember
    from app.models.workflow_line import WorkflowLineStepRun
    agent_id = uuid.uuid4()
    s.add(TeamMember(id=agent_id, org_id=org, project_id=proj, type="agent", name="에이전트A", is_active=True))
    await s.flush()
    ev = Event(org_id=org, project_id=proj, event_type="dispatched", source_entity_type="story",
               source_entity_id=uuid.uuid4(), recipient_id=agent_id, recipient_type="agent",
               payload={}, status="pending", recipient_seq=7)
    s.add(ev)
    await s.flush()
    story_id = uuid.uuid4()
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="story", entity_id=story_id,
        from_status="in-review", to_status="done", status="dispatched", mode="advisory_only",
        delivery_status="timed_out", event_id=ev.id, recipient_seq=7,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr)
    await s.flush()
    return sr, story_id


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_grant_only_and_owner_floor_get_notified_after_fix():
    """양성대조 축(team_member 기반 휴먼)은 기존 test_edg_s12be_recipient_fallback.py가 이미
    검증(target_count==1) — 여기선 grant-only + owner-floor가 fix 후 실제로 통지 대상에
    포함되는 것만 확認(결함이 있던 조건 그대로 재현 + 수정 확認)."""
    from app.services.workflow_fallback_notify import fallback_notify
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = await _project(s, org)
        sr, story_id = await _run_with_event(s, org, proj)
        tm_id = await _team_member_human(s, org, proj)  # 양성대조 축 — 무회귀 확인용
        grant_only_id = await _grant_only_human(s, org, proj)
        owner_floor_id = await _owner_floor_admin(s, org)
        await s.commit()

        with patch(_NOTIFY_TARGET_IDS, new=AsyncMock()) as notify:
            r = await fallback_notify(s, org, story_id, sr.id)

        assert r["status"] == "notified"
        assert notify.await_count == 1
        sent_ids = set(notify.await_args.kwargs["target_member_ids"])
        assert tm_id in sent_ids, "양성대조 축(같은 이벤트의 정상 team_member)까지 깨지면 다른 문제"
        assert grant_only_id in sent_ids, "grant-only 휴먼이 여전히 통지 대상에서 빠짐(전달누락 재발)"
        assert owner_floor_id in sent_ids, "owner-floor admin이 여전히 통지 대상에서 빠짐(전달누락 재발)"
        assert r["target_count"] == 3
    await engine.dispose()
