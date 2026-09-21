"""story #4129([E-RECIPE-1 Phase 3] 에이전트 런타임 신원 heartbeat) realdb 검증.

AC2: heartbeat가 client_name/client_version/plugin_version/session_started_at을
agent_project_profiles.agent_config.runtime_identity(신규 컬럼 0, 마이그레이션 0)에 기록한다.
- 헤더/필드 없음 → null 유지(이전 값 보존 아님 — 이 호출의 정직한 스냅샷)
- 있음 → 저장
- 기존 agent_config의 다른 top-level 키는 무변(caller-set 임의 설정 보존)
- 재기동(새 session) → session_started_at 갱신 — 이 파일은 sync_agent_profile_presence의
  agent_config 쓰기만 검증(session 객체 생명주기 자체는 sprintable_mcp 쪽 별도 유닛테스트).

「재기동 필요」 배지 판단 — app.routers.team_members._org_max_plugin_version /
_plugin_version_sort_key가 조직 전체 agent 기준 최댓값을 정확히 뽑는지.
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

    org = Organization(id=uuid.uuid4(), name="Org4129", slug=f"org4129-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, agent_config: dict | None = None):
    from app.models.member import AgentProjectProfile, Member

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(
        id=uuid.uuid4(), member_id=member_id, project_id=project_id, agent_config=agent_config,
    ))
    await session.commit()
    return member_id


async def _get_agent_config(session, member_id) -> dict | None:
    from sqlalchemy import select

    from app.models.member import AgentProjectProfile

    row = (await session.execute(
        select(AgentProjectProfile.agent_config).where(AgentProjectProfile.member_id == member_id)
    )).scalar_one()
    return row


@pytest.mark.anyio
async def test_runtime_identity_written_and_preserves_other_agent_config_keys():
    """AC2 — 4필드 기록 + 기존 agent_config의 무관 키(예: user-set llm_model) 보존."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, project_id, agent_config={"llm_model": "opus"})

            await sync_agent_profile_presence(
                s, member_id,
                last_seen_at=None, agent_status=None,
                client_name="claude-code", client_version="2.1.0",
                plugin_version="0.1.4", session_started_at="2026-09-21T23:00:00+00:00",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["llm_model"] == "opus"  # 무관 top-level 키 보존
            assert cfg["runtime_identity"] == {
                "client_name": "claude-code",
                "client_version": "2.1.0",
                "plugin_version": "0.1.4",
                "session_started_at": "2026-09-21T23:00:00+00:00",
            }
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_presence_only_call_leaves_agent_config_untouched():
    """다른 콜사이트(agent_gateway.py 등)처럼 4필드 kwarg 자체를 안 보내면 agent_config 무변."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_agent(
                s, org_id, project_id,
                agent_config={"runtime_identity": {"plugin_version": "0.1.4"}},
            )

            await sync_agent_profile_presence(
                s, member_id, last_seen_at=datetime.now(timezone.utc), agent_status="online",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg == {"runtime_identity": {"plugin_version": "0.1.4"}}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_runtime_identity_snapshot_replaces_not_partial_merges():
    """AC2 — 이번 호출이 plugin_version을 안 실으면(예: stdio 콜사이트) null로 정직하게
    반영한다 — 이전 호출의 plugin_version을 조용히 보존하지 않는다(스냅샷 계약)."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, project_id)

            await sync_agent_profile_presence(
                s, member_id, last_seen_at=None, agent_status=None,
                client_name="claude-code", client_version="2.1.0",
                plugin_version="0.1.4", session_started_at="2026-09-21T23:00:00+00:00",
            )
            await s.commit()

            # 두 번째 호출(예: stdio 재호출) — plugin_version 없음(헤더 없는 전송)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=None, agent_status=None,
                client_name="claude-code", client_version="2.1.0",
                plugin_version=None, session_started_at="2026-09-21T23:00:00+00:00",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["runtime_identity"]["plugin_version"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_max_plugin_version_ignores_agents_without_one():
    """_org_max_plugin_version — plugin_version 없는 에이전트(None/누락)는 최댓값 계산에서
    제외되고, 있는 에이전트끼리만 semver-ish 비교(문자열 정렬 아님 — "0.1.10" > "0.1.9")."""
    from app.routers.team_members import _org_max_plugin_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_agent(s, org_id, project_id, agent_config=None)  # 값 자체 없음
            await _seed_agent(
                s, org_id, project_id,
                agent_config={"runtime_identity": {"plugin_version": "0.1.9"}},
            )
            await _seed_agent(
                s, org_id, project_id,
                agent_config={"runtime_identity": {"plugin_version": "0.1.10"}},
            )

            result = await _org_max_plugin_version(org_id, s)
            assert result == "0.1.10"  # 문자열 정렬이면 "0.1.9" > "0.1.10"으로 틀렸을 값
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_max_plugin_version_none_when_nobody_has_one():
    from app.routers.team_members import _org_max_plugin_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_agent(s, org_id, project_id, agent_config=None)

            result = await _org_max_plugin_version(org_id, s)
            assert result is None
    finally:
        await engine.dispose()
