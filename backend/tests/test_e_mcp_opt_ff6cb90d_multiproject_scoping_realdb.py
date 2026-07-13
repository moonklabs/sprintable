"""E-MCP-OPT(story ff6cb90d·doc mcp-multiproject-scoping-design) — 실 PG.

①무인자 기본값 근본 판정(GET /api/v2/auth/me 신규 필드) + ③set_default_project(PATCH
/api/v2/auth/me/default-project) 실증. ②list_projects는 신규 BE 로직 0(기존 /api/v2/projects
그대로) — 별도 realdb 불요.
"""
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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _seed_agent_key(session, *, project_count: int):
    """org + N project + agent(Member+AgentProjectProfile+ProjectAccess, project_count개 프로젝트
    grant) + ApiKey(sk_live_ 원문 해시).

    두 결이 서로 다른 테이블을 본다(실측으로 확인) — AgentProjectProfile은 team_members VIEW
    backing(_resolve_api_key 레거시 기본 project_id 해소용), ProjectAccess(member_id, granted)는
    accessible_project_ids_in_org의 에이전트 grant 분기(18073a52) 소스 — 둘 다 시드해야 두 함수가
    일관되게 같은 프로젝트 집합을 본다."""
    from app.core.security import hash_token
    from app.models.api_key import ApiKey
    from app.models.member import AgentProjectProfile, Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    projects = [Project(id=uuid.uuid4(), org_id=org.id, name=f"P{i}") for i in range(project_count)]
    session.add_all(projects)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add_all([
        AgentProjectProfile(id=uuid.uuid4(), member_id=agent.id, project_id=p.id) for p in projects
    ])
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=p.id, member_id=agent.id, permission="granted")
        for p in projects
    ])
    await session.commit()

    raw_key = f"sk_live_{uuid.uuid4().hex}"
    session.add(ApiKey(
        id=uuid.uuid4(), team_member_id=agent.id, member_id=agent.id,
        key_prefix=raw_key[:12], key_hash=hash_token(raw_key), scope=["read", "write"],
    ))
    await session.commit()

    return {
        "org_id": org.id, "member_id": agent.id, "raw_key": raw_key,
        "project_ids": [p.id for p in projects],
    }


def _client_with_key(app, raw_key: str):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Bearer {raw_key}"},
    )


@pytest.mark.anyio
async def test_single_project_key_resolves_unambiguously_no_regression():
    """단일 프로젝트 키 — resolved_default_project_id=그 프로젝트·ambiguous=False(무회귀 핵심)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, project_count=1)
        app.dependency_overrides.clear()
        from app.dependencies.database import get_db

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise
        app.dependency_overrides[get_db] = _db
        client = _client_with_key(app, seeded["raw_key"])
        try:
            resp = await client.get("/api/v2/auth/me")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["resolved_default_project_id"] == str(seeded["project_ids"][0])
            assert body["is_project_ambiguous"] is False
            assert body["accessible_project_ids"] == [str(seeded["project_ids"][0])]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_multiproject_key_no_default_set_is_ambiguous_not_guessed():
    """멀티프로젝트 키 + default_project_id 미설정 — resolved=None+ambiguous=True(암묵 추측 금지).
    §0 핵심 발견(구 ORDER BY 임의값)의 회귀 방지 실증."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, project_count=3)

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise
        app.dependency_overrides[get_db] = _db
        client = _client_with_key(app, seeded["raw_key"])
        try:
            resp = await client.get("/api/v2/auth/me")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["resolved_default_project_id"] is None
            assert body["is_project_ambiguous"] is True
            assert set(body["accessible_project_ids"]) == {str(p) for p in seeded["project_ids"]}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_set_default_project_then_unambiguous_resolution():
    """set_default_project 성공 → /auth/me가 그 프로젝트로 즉시 해소(ambiguous=False)."""
    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, project_count=3)
        target = seeded["project_ids"][1]

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise
        app.dependency_overrides[get_db] = _db
        client = _client_with_key(app, seeded["raw_key"])
        try:
            patch_resp = await client.patch(
                "/api/v2/auth/me/default-project", json={"project_id": str(target)},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            body = patch_resp.json()
            assert body["resolved_default_project_id"] == str(target)
            assert body["is_project_ambiguous"] is False

            me_resp = await client.get("/api/v2/auth/me")
            assert me_resp.json()["resolved_default_project_id"] == str(target)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_set_default_project_rejects_inaccessible_project_403():
    """접근권 없는 프로젝트(다른 org) 지정 → 403·member.default_project_id 무변경(body-claimed 금지)."""
    from app.main import app
    from app.dependencies.database import get_db
    from app.models.organization import Organization
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, project_count=2)
            other_org = Organization(id=uuid.uuid4(), name="Other", slug=f"other-{uuid.uuid4().hex[:8]}")
            s.add(other_org)
            await s.commit()
            foreign_project = Project(id=uuid.uuid4(), org_id=other_org.id, name="Foreign")
            s.add(foreign_project)
            await s.commit()
            foreign_project_id = foreign_project.id

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise
        app.dependency_overrides[get_db] = _db
        client = _client_with_key(app, seeded["raw_key"])
        try:
            resp = await client.patch(
                "/api/v2/auth/me/default-project", json={"project_id": str(foreign_project_id)},
            )
            assert resp.status_code == 403, resp.text

            # 무변경 확認 — 여전히 ambiguous(설정 안 됨).
            me_resp = await client.get("/api/v2/auth/me")
            assert me_resp.json()["is_project_ambiguous"] is True
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_default_project_changed_event_emitted():
    """set_default_project 성공 시 member.default_project_changed(old/new) emit — 감사 가능성 실증."""
    from unittest.mock import MagicMock, patch as mock_patch

    from app.main import app
    from app.dependencies.database import get_db

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, project_count=2)
        target = seeded["project_ids"][0]

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise
        app.dependency_overrides[get_db] = _db
        client = _client_with_key(app, seeded["raw_key"])
        try:
            publish = MagicMock()
            with mock_patch("app.routers.events.publish_event", publish):
                resp = await client.patch(
                    "/api/v2/auth/me/default-project", json={"project_id": str(target)},
                )
                assert resp.status_code == 200, resp.text
            publish.assert_called_once()
            args, _ = publish.call_args
            assert args[1] == "member.default_project_changed"
            payload = args[2]
            assert payload["member_id"] == str(seeded["member_id"])
            assert payload["old_default_project_id"] is None
            assert payload["new_default_project_id"] == str(target)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
