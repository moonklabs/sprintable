"""story #3275([연결·판별자] 프로필 행 부재 self-heal, 2026-09-01 — 선생님 prod customer-zero
실사고 그라운딩) — `sync_agent_profile_presence`의 UPDATE가 `agent_project_profiles` 행 부재
시 조용히 0건이던 결함. heartbeat는 `team_members` 뷰의 grant-only 분기(런타임 컬럼 NULL)로
200 OK를 반환하는데 `first_connected_at`은 영원히 안 써져 "연결은 됐는데 체크리스트/CTA만
영구 위음성"이 재현됐다(발단 story #3197 — 그 스토리 본체의 `get_verified_map` OR 판별 로직은
불변, 이 결함은 그 판별자가 읽는 원천 write 한 층 위)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    import app.models  # noqa: F401

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent_without_profile(session):
    """team_members(agent, project_id 세팅) 만 만들고 agent_project_profiles 행은 **의도적으로
    안 만든다** — S4급 grant-only 갭(profile 없이 team_members 뷰에만 존재)의 실제 모양."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org.id, type="agent", name="Agent", is_active=True))
    await session.commit()
    session.add(TeamMember(id=member_id, org_id=org.id, project_id=project.id, type="agent", name="Agent"))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "member_id": member_id}


@pytest.mark.anyio
async def test_heartbeat_self_heals_missing_profile_and_stamps_first_connected_at():
    """핵심 pin — profile 행 없는 에이전트가 presence를 쓰면(heartbeat 동형) profile이
    self-heal로 만들어지고 first_connected_at이 즉시 채워진다. self-heal 제거 뮤테이션 시
    이 assert가 정확히 RED(테스트 자체가 profile row not found)가 된다."""
    from sqlalchemy import select

    from app.models.member import AgentProjectProfile
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_without_profile(s)

            # self-heal 전 — profile 행이 정말 0개인지 먼저 확認(전제 검증, 거짓양성 방지).
            pre = (await s.execute(
                select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
            )).scalar_one_or_none()
            assert pre is None

            from datetime import datetime, timezone
            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, seeded["member_id"], last_seen_at=now, agent_status="online")
            await s.commit()

            prof = (await s.execute(
                select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
            )).scalar_one()
            assert prof.project_id == seeded["project_id"]
            assert prof.agent_status == "online"
            assert prof.first_connected_at is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_second_heartbeat_does_not_move_first_connected_at():
    """COALESCE 불변식 무회귀 — self-heal로 만들어진 뒤에도 재기록 시 first_connected_at이
    최초 값 그대로 유지된다(재연결마다 갱신되면 "최초 연결" 의미가 무너진다)."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.models.member import AgentProjectProfile
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_without_profile(s)

            first_seen = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, seeded["member_id"], last_seen_at=first_seen, agent_status="online")
            await s.commit()

            second_seen = first_seen + timedelta(minutes=10)
            await sync_agent_profile_presence(s, seeded["member_id"], last_seen_at=second_seen, agent_status="online")
            await s.commit()

            prof = (await s.execute(
                select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
            )).scalar_one()
            assert prof.first_connected_at.replace(tzinfo=timezone.utc) == first_seen
            assert prof.last_seen_at.replace(tzinfo=timezone.utc) == second_seen
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_existing_profile_path_unaffected_no_duplicate_row():
    """무회귀 — profile이 이미 있는 정상 케이스(기존 동작)는 self-heal 분기를 안 타고, 중복
    행도 안 생긴다(정상 경로가 이 변경으로 흔들리지 않음을 고정)."""
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.models.member import AgentProjectProfile
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_without_profile(s)
            s.add(AgentProjectProfile(
                id=uuid.uuid4(), member_id=seeded["member_id"], project_id=seeded["project_id"],
            ))
            await s.commit()

            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, seeded["member_id"], last_seen_at=now, agent_status="online")
            await s.commit()

            rows = (await s.execute(
                select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].first_connected_at is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_orphan_member_id_logs_and_does_not_raise(caplog):
    """team_members 행 자체가 없는 member_id(고아) — self-heal 대상 밖. 예외 없이 조용히
    반환(무음이 아니라 로그로 신호, 회귀 시 크래시로 드러난다). 카디르 QA 보강(PR#3664 1차) —
    "예외 없음"만이 아니라 경고 로그가 실제로 발화하는지까지 assert한다."""
    import logging

    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from datetime import datetime, timezone
            with caplog.at_level(logging.WARNING, logger="app.services.agent_anchor_sync"):
                await sync_agent_profile_presence(
                    s, uuid.uuid4(), last_seen_at=datetime.now(timezone.utc), agent_status="online"
                )
            await s.commit()  # 예외 없이 끝나야 한다.
            assert any("presence write skipped" in r.message for r in caplog.records)
    finally:
        await engine.dispose()


async def _seed_team_member_only_no_member_row(session):
    """카디르 QA 실사고(PR#3664 1차) 재현 — `agent_project_profiles.member_id`의 실 FK
    부모는 `members`인데, `team_members`는 있고 `members`는 없는 상태(정상 생성 경로에선
    안 생기지만 test_2602_sse_lease_lifespan_reclaim.py::_seed_org_project_agent와 동형 —
    실 SSE 경로 agent_gateway.py:561이 이 상태의 에이전트로도 호출될 수 있음이 실측됨)."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    member_id = uuid.uuid4()
    session.add(TeamMember(id=member_id, org_id=org.id, project_id=project.id, type="agent", name="Agent"))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "member_id": member_id}


@pytest.mark.anyio
async def test_members_row_missing_skips_self_heal_without_fk_crash(caplog):
    """핵심 pin(카디르 QA 지적, PR#3664 1차 회귀 재발 방지) — team_members는 있는데 FK 실부모인
    members가 없으면, self-heal이 `ensure_agent_project_profile` INSERT를 시도해 FK 위반으로
    크래시하는 대신 조용히(로그로) 스킵해야 한다. 이 가드를 제거하는 뮤테이션 시 이 테스트가
    IntegrityError로 정확히 RED가 된다."""
    import logging
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.models.member import AgentProjectProfile
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_team_member_only_no_member_row(s)

            with caplog.at_level(logging.WARNING, logger="app.services.agent_anchor_sync"):
                await sync_agent_profile_presence(
                    s, seeded["member_id"], last_seen_at=datetime.now(timezone.utc), agent_status="online"
                )
            await s.commit()  # FK 위반 없이 끝나야 한다(과거 회귀: IntegrityError 그대로 전파).

            assert any("members row missing" in r.message for r in caplog.records)
            rows = (await s.execute(
                select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
            )).scalars().all()
            assert rows == []  # self-heal이 스킵됐으니 profile 행도 안 생겨야 한다.
    finally:
        await engine.dispose()
