"""story #3629(3627 클래스 전수, 페드루 PO 確定 2026-09-07) — 「휴먼」을 team_members
(type='human')로만 잇던 자리들이 org_member-only 휴먼(SSOT 전환 이후 org 다수, dev PO
Test Org 실물 모양)에서 조용히 빠졌는지 실측 회귀.

세팅 헬퍼는 test_2301_story_body_mentions_realdb.py·test_2288_command_center_gate_
type_waiting_realdb.py 재사용(app.main 1회 import 비용 분리 관례 그대로) — 다만 두 파일의
`_make_member`/`_make_human_member`는 OrgMember+Member(앵커) 둘 다 만드는 "정상 앵커됨"
휴먼이라, 이 스토리가 재현해야 하는 "team_members 행이 아예 없는" 갭 모양과 반대다.
`_make_org_member_only_human`이 그 갭 모양을 직접 만든다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_2301_story_body_mentions_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
)
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member, _setup_app_human

pytestmark = [
    # 페드루 PO CHANGES(2026-09-07, 3877/3878 전례) — command_center 테스트가 `app.main`의
    # 전역 엔진·실 HTTP 클라이언트를 거치는 신규 real-DB 파일이라 destructive_schema 짝(모듈
    # 마커+infra/destructive-schema-shard-weights.json 등재)이 요구된다 — 미등재면 샤드 가드가
    # 빨개진다.
    pytest.mark.destructive_schema,
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


async def _migrated_session_factory():
    """destructive_schema 마커의 autouse 리셋(conftest.py::_reset_schema_for_destructive_
    tests)이 매 테스트 前 스키마를 통째로 지운다 — test_2301의 `_session_factory`는 이미
    migrated 스키마가 있다는 전제(non-destructive 파일 전용)라 그대로 재사용하면 "relation
    ... does not exist"로 죽는다. create_all로 재건(idempotent — 이미 있으면 no-op)."""
    from app.core.database import Base
    import app.models  # noqa: F401

    engine, Session = await _session_factory()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, Session


async def _make_agent_only(session, org_id, project_id):
    """test_2288의 `_make_member(type_='agent')`는 OrgMember도 같이 만든다(그 파일 자신의
    편의 단축 — 실 에이전트는 org_members 행을 안 갖는다, org_members는 휴먼 전용 테이블).
    이 테스트는 정확히 그 구분을 검증해야 해서 실물 모양(Member+AgentProjectProfile만,
    OrgMember 0행)으로 직접 만든다."""
    from app.models.member import AgentProjectProfile, Member

    m = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name="Agent")
    session.add(m)
    await session.flush()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=m.id, project_id=project_id))
    await session.commit()
    return m.id


async def _make_org_member_only_human(session, org_id):
    """team_members(Member 앵커) 행이 아예 없는 SSOT-only 휴먼 — dev PO Test Org 실물
    모양(human TeamMember 0행·API 참여자는 org_member). org_members 딱 1행만 만든다."""
    from app.models.user import User
    from app.models.project import OrgMember

    user = User(id=uuid.uuid4(), email=f"story3629-{uuid.uuid4().hex[:8]}@t.test", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.commit()
    return om.id, user.id


# ─── member_resolver.py::filter_human_member_ids — 배치 조회 자체 ────────────


async def test_filter_human_member_ids_includes_org_member_only_and_legacy_team_member():
    """org_member-only 휴먼·legacy team_member(human) 휴먼 둘 다 포함, agent는 제외."""
    from app.services.member_resolver import filter_human_member_ids

    engine, Session = await _migrated_session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            om_human_id, _ = await _make_org_member_only_human(s, org.id)
            anchored_human_id, _ = await _make_member(s, org.id, project.id, type_="human")
            agent_id = await _make_agent_only(s, org.id, project.id)

            result = await filter_human_member_ids(
                {om_human_id, anchored_human_id, agent_id, uuid.uuid4()}, s,
            )
            assert result == {om_human_id, anchored_human_id}
    finally:
        await engine.dispose()


async def test_filter_human_member_ids_excludes_soft_deleted_org_member():
    """story #3629 후속(카디르 발견, #3627 클래스 공유) — soft-delete된 org_member는
    휴먼으로 인정하면 안 된다(뮤테이션: deleted_at 가드 제거 시 이 테스트가 RED여야
    가드가 실제로 뭘 잡는지 스스로 증명한다)."""
    from app.models.project import OrgMember
    from sqlalchemy import update
    from app.services.member_resolver import filter_human_member_ids

    engine, Session = await _migrated_session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            om_human_id, _ = await _make_org_member_only_human(s, org.id)
            await s.execute(
                update(OrgMember).where(OrgMember.id == om_human_id).values(deleted_at=datetime.now(timezone.utc))
            )
            await s.commit()

            result = await filter_human_member_ids({om_human_id}, s)
            assert result == set(), "soft-delete된 org_member는 휴먼으로 인정되면 안 된다"
    finally:
        await engine.dispose()


# ─── command_center.py — done 스토리 contribution 집계 ───────────────────────


async def test_command_center_overview_counts_org_member_only_assignee_as_human():
    """story #3629(command_center.py:~715, 그라운딩 확認) — Member.id==Story.assignee_id
    단독 조인은 org_member-only 휴먼 assignee를 조용히 unassigned로 떨어뜨렸다(members.id
    ==org_members.id 불변식은 migration 0075 백필 시점 한정 — SSOT 전환 이후 새 org_member
    는 members 앵커 행이 안 만들어진다). OrgMember도 LEFT JOIN해 human으로 보강."""
    from app.models.pm import Story
    from sqlalchemy import update
    from app.main import app

    engine, Session = await _migrated_session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            om_human_id, caller_user_id = await _make_org_member_only_human(s, org.id)
            story = await _make_story(s, org.id, project.id, title="Done by SSOT-only human")
            await s.execute(
                update(Story).where(Story.id == story.id).values(status="done", assignee_id=om_human_id)
            )
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        # overview()는 read-replica 축(get_read_db)을 쓴다(story #2451 §6 Phase3 A1) —
        # _setup_app_human은 get_db만 오버라이드하므로 여기서 같은 세션 팩토리로 추가.
        from app.dependencies.database import get_db, get_read_db
        app.dependency_overrides[get_read_db] = app.dependency_overrides[get_db]
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/overview")
            assert resp.status_code == 200, resp.text
            contribution = resp.json()["project_status"]["contribution"]
            assert contribution["human"] == 1
            assert contribution["unassigned"] == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
