"""story #4799 — heartbeat가 prod에서 500: 에이전트 하나가 프로젝트 여럿에 놓여 agent_project_profiles 행이 여럿이면
`sync_agent_profile_presence`의 `one_or_none()`이 MultipleResultsFound로 터졌다(10-26 prod 시간당 1~13건 · 에이전트 둘).

다중 행은 정상이다 — (project_id, member_id) UNIQUE이고, project_access.py ensure · org_agent.py write_agent_project_placement가 프로젝트마다 행을 하나씩 만든다.
그래서 고침은 «행마다 자기 현재 값으로 병합해 자기 행만 쓴다»: 예외 없이 모든 행이 갱신되고, 한 행의 agent_config가 다른 행에 덮이지 않는다. 실 PG."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4129_runtime_identity_heartbeat_realdb import (  # noqa: F401 — fixtures + helpers
    _dispose_global_engine_after_test,
    _seed_agent,
    _seed_org_project,
    _session_factory,
    anyio_backend,
    pytestmark,
)


async def _second_project_row(session, org_id, member_id, agent_config=None, last_seen_at=None):
    from app.models.member import AgentProjectProfile
    from app.models.project import Project

    project = Project(id=uuid.uuid4(), org_id=org_id, name="P2")
    session.add(project)
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project.id, agent_config=agent_config, last_seen_at=last_seen_at))
    await session.commit()
    return project.id


async def _rows(session, member_id) -> dict:
    from sqlalchemy import select

    from app.models.member import AgentProjectProfile

    rows = (await session.execute(
        select(AgentProjectProfile.project_id, AgentProjectProfile.agent_config, AgentProjectProfile.last_seen_at, AgentProjectProfile.agent_status)
        .where(AgentProjectProfile.member_id == member_id)
    )).all()
    return {r.project_id: r for r in rows}


async def test_an_agent_in_two_projects_gets_its_runtime_identity_written_to_both_rows_without_raising():
    """핵심 pin — 두 행 + runtime identity가 든 heartbeat: 예외 0 · 두 행 모두 갱신 · 각 행의 «자기» agent_config 키는 그대로(한 행의 병합본이 다른 행을 덮지 않음)."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, p1 = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, p1, agent_config={"llm_model": "opus"})
            p2 = await _second_project_row(s, org_id, member_id, agent_config={"fakechat_note": "only-in-p2"})
            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, member_id, last_seen_at=now, agent_status="online", client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4")
            await s.commit()

            rows = await _rows(s, member_id)
            assert set(rows) == {p1, p2}
            for pid in (p1, p2):
                assert rows[pid].agent_status == "online"
                assert rows[pid].last_seen_at is not None
                identity = rows[pid].agent_config["runtime_identity"]
                assert (identity["client_name"], identity["client_version"], identity["plugin_version"]) == ("claude-code", "2.1.0", "0.1.4")
            # each row keeps ITS OWN keys: row 1's merged config is not written over row 2 (and the other way round)
            assert rows[p1].agent_config["llm_model"] == "opus" and "fakechat_note" not in rows[p1].agent_config
            assert rows[p2].agent_config["fakechat_note"] == "only-in-p2" and "llm_model" not in rows[p2].agent_config
    finally:
        await engine.dispose()


async def test_a_presence_only_call_updates_every_row_and_leaves_each_config_alone():
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, p1 = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, p1, agent_config={"llm_model": "opus"})
            p2 = await _second_project_row(s, org_id, member_id, agent_config={"k": "v"})
            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, member_id, last_seen_at=now, agent_status="online")
            await s.commit()
            rows = await _rows(s, member_id)
            assert all(rows[pid].agent_status == "online" and rows[pid].last_seen_at is not None for pid in (p1, p2))
            assert rows[p1].agent_config == {"llm_model": "opus"} and rows[p2].agent_config == {"k": "v"}
    finally:
        await engine.dispose()


async def test_each_row_decides_session_started_at_from_its_own_last_seen():
    """행마다 «재기동» 판정: 같은 신원 + 이 행의 last_seen이 idle 문턱 안 → 이 행의 이전 session_started_at 유지 · 문턱 밖인 행 → 이 호출 시각으로 교체."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, p1 = await _seed_org_project(s)
            now = datetime.now(timezone.utc)
            identity = {"client_name": "claude-code", "client_version": "2.1.0", "plugin_version": "0.1.4"}
            recent_start = (now - timedelta(minutes=10)).isoformat()
            old_start = (now - timedelta(hours=5)).isoformat()
            member_id = await _seed_agent(s, org_id, p1, agent_config={"runtime_identity": {**identity, "session_started_at": recent_start}}, last_seen_at=now - timedelta(minutes=5))
            p2 = await _second_project_row(s, org_id, member_id, agent_config={"runtime_identity": {**identity, "session_started_at": old_start}}, last_seen_at=now - timedelta(hours=2))
            await sync_agent_profile_presence(s, member_id, last_seen_at=now, agent_status="online", **identity)
            await s.commit()
            rows = await _rows(s, member_id)
            assert rows[p1].agent_config["runtime_identity"]["session_started_at"] == recent_start  # within the idle gap: kept
            assert rows[p2].agent_config["runtime_identity"]["session_started_at"] == now.isoformat()  # 2 h away: a new session
    finally:
        await engine.dispose()


async def test_an_agent_in_nine_projects_like_prod_s_widest_one_updates_all_nine_rows_each_keeping_its_own_config():
    """prod 모양(에이전트당 1~9행 — 둘 이상인 에이전트 26)의 가장 넓은 갈래: 9행 · 행마다 다른 agent_config 키."""
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, p1 = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, p1, agent_config={"own_key": 0})
            projects = [p1]
            for i in range(1, 9):
                projects.append(await _second_project_row(s, org_id, member_id, agent_config={"own_key": i}))
            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, member_id, last_seen_at=now, agent_status="online", client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4")
            await s.commit()
            rows = await _rows(s, member_id)
            assert len(rows) == 9
            for i, pid in enumerate(projects):
                cfg = rows[pid].agent_config
                assert cfg["own_key"] == i  # nobody else's config was written over this row
                assert cfg["runtime_identity"]["client_name"] == "claude-code"
                assert rows[pid].agent_status == "online" and rows[pid].last_seen_at is not None
    finally:
        await engine.dispose()


async def test_a_row_with_no_agent_config_among_populated_rows_gets_one_and_the_others_keep_theirs():
    from app.services.agent_anchor_sync import sync_agent_profile_presence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, p1 = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, p1, agent_config=None)  # this row has NULL agent_config
            p2 = await _second_project_row(s, org_id, member_id, agent_config={"k": "v"})
            now = datetime.now(timezone.utc)
            await sync_agent_profile_presence(s, member_id, last_seen_at=now, agent_status="online", client_name="claude-code", client_version="2.1.0", plugin_version="0.1.4")
            await s.commit()
            rows = await _rows(s, member_id)
            assert set(rows[p1].agent_config) == {"runtime_identity"}  # a fresh config for the NULL row, nothing borrowed from the other
            assert rows[p2].agent_config["k"] == "v" and rows[p2].agent_config["runtime_identity"]["client_name"] == "claude-code"
    finally:
        await engine.dispose()
