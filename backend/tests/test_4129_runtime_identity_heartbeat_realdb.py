"""story #4129([E-RECIPE-1 Phase 3] 에이전트 런타임 신원 heartbeat) realdb 검증.

AC2: heartbeat가 client_name/client_version/plugin_version을
agent_project_profiles.agent_config.runtime_identity(신규 컬럼 0, 마이그레이션 0)에 기록한다.
- 필드 없음 → null 유지(이전 값 보존 아님 — 이 호출의 정직한 스냅샷)
- 있음 → 저장
- 기존 agent_config의 다른 top-level 키는 무변(caller-set 임의 설정 보존)

CHANGES-1(PO 리뷰, PR#4507) — session_started_at은 호출자가 실어 보내는 값이 아니라
sync_agent_profile_presence가 이전 저장값과 비교해 직접 계산한다: 신원(client_name·
client_version·plugin_version)이 이전과 같고 이전 last_seen_at이 idle 문턱(30분, S2-3
presence_status와 공유하는 _IDLE_THRESHOLD) 안이면 이전 session_started_at을 유지, 그
밖(신원 변경 또는 30분 넘는 공백)이면 이 호출 시각으로 교체한다. "MCP 서버 프로세스가
언제 이 세션 객체를 처음 봤나"가 아니다 — 호스팅 MCP 재배포마다(세션 객체 전부 리셋)
모든 에이전트의 값이 초기화되는 첫 구현의 오정보를 이 계약이 고친다.

「재기동 필요」 배지 판단 — app.routers.team_members._org_max_plugin_version /
_plugin_version_sort_key가 조직 전체 agent 기준 최댓값을 정확히 뽑는지.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed_agent(session, org_id, project_id, agent_config: dict | None = None, last_seen_at=None):
    from app.models.member import AgentProjectProfile, Member

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(
        id=uuid.uuid4(), member_id=member_id, project_id=project_id, agent_config=agent_config,
        last_seen_at=last_seen_at,
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
    """AC2 — 3필드 기록(+ BE가 계산한 session_started_at) + 기존 agent_config의 무관 키
    (예: user-set llm_model) 보존. 최초 heartbeat라 이전 신원이 없으니 session_started_at은
    이 호출 시각(now)으로 새로 채워진다."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, project_id, agent_config={"llm_model": "opus"})

            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(
                s, member_id,
                last_seen_at=now, agent_status="online",
                client_name="claude-code", client_version="2.1.0",
                plugin_version="0.1.4",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["llm_model"] == "opus"  # 무관 top-level 키 보존
            identity = cfg["runtime_identity"]
            assert identity["client_name"] == "claude-code"
            assert identity["client_version"] == "2.1.0"
            assert identity["plugin_version"] == "0.1.4"
            assert identity["session_started_at"] == now.isoformat()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_presence_only_call_leaves_agent_config_untouched():
    """다른 콜사이트(agent_gateway.py 등)처럼 신원 kwarg 자체를 안 보내면 agent_config 무변."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

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
                s, member_id, last_seen_at=datetime.now(timezone.utc), agent_status="online",
                client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4",
            )
            await s.commit()

            # 두 번째 호출(예: stdio 재호출) — plugin_version 없음(헤더 없는 전송)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=datetime.now(timezone.utc), agent_status="online",
                client_name="claude-code", client_version="2.1.0", plugin_version=None,
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["runtime_identity"]["plugin_version"] is None
    finally:
        await engine.dispose()


# ─── CHANGES-1(PO 리뷰, PR#4507) — session_started_at "재기동" 판정 3건 ───────────

@pytest.mark.anyio
async def test_consecutive_heartbeat_same_identity_keeps_session_started_at():
    """연속 heartbeat + 새 세션 객체(MCP 서버 재배포 등)여도 신원 동일·idle 문턱 안이면
    이전 session_started_at을 그대로 유지한다 — 재배포마다 세션이 리셋되는 오정보 재발 방지 핵심 pin."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, project_id)

            first_call_at = datetime.now(timezone.utc)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=first_call_at, agent_status="online",
                client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4",
            )
            await s.commit()
            first_started_at = (await _get_agent_config(s, member_id))["runtime_identity"]["session_started_at"]

            # 5분 뒤 재호출(idle 30분 문턱 안), 동일 신원 — MCP 서버가 그새 재배포돼 ctx.session이
            # 새 객체가 됐더라도(story #4129 BE는 그 신호를 아예 안 받는다) 영향 없어야 한다.
            second_call_at = first_call_at + timedelta(minutes=5)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=second_call_at, agent_status="online",
                client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["runtime_identity"]["session_started_at"] == first_started_at
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_31_minute_gap_replaces_session_started_at():
    """idle 문턱(30분)을 넘는 공백 뒤 돌아오면 session_started_at을 이 호출 시각으로 교체한다
    — «끊겼다가 돌아옴»이 진짜 재기동 신호(신원은 동일해도)."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            stale_last_seen = datetime.now(timezone.utc) - timedelta(minutes=31)
            member_id = await _seed_agent(
                s, org_id, project_id,
                agent_config={"runtime_identity": {
                    "client_name": "claude-code", "client_version": "2.1.0", "plugin_version": "0.1.4",
                    "session_started_at": stale_last_seen.isoformat(),
                }},
                last_seen_at=stale_last_seen,
            )

            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=now, agent_status="online",
                client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["runtime_identity"]["session_started_at"] == now.isoformat()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_identity_change_replaces_session_started_at_even_within_idle():
    """idle 문턱 안(연속 heartbeat)이라도 client_version만 바뀌면(플러그인 업데이트 후 재기동
    등) session_started_at을 교체한다 — 신원 변경 자체가 재기동 신호."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)

            first_call_at = datetime.now(timezone.utc)
            member_id = await _seed_agent(s, org_id, project_id)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=first_call_at, agent_status="online",
                client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4",
            )
            await s.commit()
            first_started_at = (await _get_agent_config(s, member_id))["runtime_identity"]["session_started_at"]

            # 1분 뒤(idle 문턱 한참 안), client_version만 바뀜
            second_call_at = first_call_at + timedelta(minutes=1)
            await sync_agent_profile_presence(
                s, member_id, last_seen_at=second_call_at, agent_status="online",
                client_name="claude-code", client_version="2.2.0", plugin_version="0.1.4",
            )
            await s.commit()

            cfg = await _get_agent_config(s, member_id)
            assert cfg["runtime_identity"]["session_started_at"] != first_started_at
            assert cfg["runtime_identity"]["session_started_at"] == second_call_at.isoformat()
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
