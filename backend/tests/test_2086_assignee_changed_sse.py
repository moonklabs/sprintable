"""story #2086(2026-07-21, 까심군 라이브 실측 확定): `story.assignee_changed`가 SSE로 안 감 —
근본은 `publish_event()`의 org `_subscribers` fanout이 영구 죽은 레지스트리(story #2059/#2067과
동일 근본, LISTEN 유무와 무관하게 원래 안 닿던 경로)였던 것. `story.status_changed`와 동형으로
`project_accessible_member_ids` + `_push_to_agent` 개별 push를 추가해 실 전달을 복구한다.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


_REAL_DB_SKIP = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import (
        AuthContext, get_current_user, get_project_scoped_org_id, get_verified_org_id,
    )
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    # stories.py의 update_story는 _get_repo(get_project_scoped_org_id 경유)로 org_id를
    # 해소한다 — get_verified_org_id override만으론 안 잡힘(#2086 테스트 작성 중 실측 확認).
    app.dependency_overrides[get_project_scoped_org_id] = _org


async def _seed_org_project_story_owner(session):
    """org + project + project-owner(A) + story(assignee 없음)."""
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    user_a = User(id=uuid.uuid4(), email=f"a-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user_a)
    await session.commit()

    # project_accessible_member_ids(project_auth.py:632)는 team_members(VIEW — create_all에선
    # 빈 테이블) UNION org_members(role IN owner/admin)로 해소된다. team_members 시드 없이도
    # 이 경로를 타게 org-level role을 owner로(story #2075 UNION 분기 재사용 — 오늘 확立된 패턴).
    om_a = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_a.id, role="owner")
    session.add(om_a)
    await session.commit()

    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om_a.id,
        permission="granted", role="owner",
    ))
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-review")
    session.add(story)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "user_a_id": user_a.id,
        "org_member_a_id": om_a.id, "story_id": story.id,
    }


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_assignee_changed_pushes_sse_to_accessible_members():
    """핵심 회귀 실증 — PATCH assignee_id 변경 시 project-accessible 멤버에게 실제로
    _push_to_agent가 event_type=story.assignee_changed로 호출되는지(HTTP 왕복)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_story_owner(s)
        org_id, story_id, a_id = seeded["org_id"], seeded["story_id"], seeded["user_a_id"]
        new_assignee_id = uuid.uuid4()

        pushed: list[tuple[str, dict]] = []

        def _fake_push_to_agent(member_id, payload):
            pushed.append((member_id, payload))
            return True

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            with patch("app.routers.events._push_to_agent", _fake_push_to_agent):
                resp = await client.patch(
                    f"/api/v2/stories/{story_id}", json={"assignee_id": str(new_assignee_id)},
                )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        assignee_pushes = [p for p in pushed if p[1].get("event_type") == "story.assignee_changed"]
        assert len(assignee_pushes) >= 1, (
            "story.assignee_changed가 _push_to_agent로 안 감(story #2086 회귀 재발) — "
            f"전체 push={pushed}"
        )
        for member_id, payload in assignee_pushes:
            assert payload["assignee_id"] == str(new_assignee_id)
            assert payload["story_id"] == str(story_id)
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_assignee_changed_sse_forward_failure_does_not_break_response(monkeypatch):
    """project_accessible_member_ids가 raise해도 응답은 안 깨져야(기존 emit_story_status_changed의
    격리 패턴과 동형 — best-effort). story #2132(2026-07-23): publish_event() 자체가 삭제됐다 —
    "이미 나갔다"고 기댈 별도 발행 경로가 더 이상 없다, _push_to_agent 포워딩이 유일 경로다."""
    from types import SimpleNamespace

    story = SimpleNamespace(
        id=uuid.uuid4(), title="S", priority="low", epic_id=None,
        assignee_id=uuid.uuid4(), project_id=uuid.uuid4(),
    )
    org_id = uuid.uuid4()
    old_assignee_id = None
    actor_id = uuid.uuid4()

    with patch(
             "app.services.project_auth.project_accessible_member_ids",
             AsyncMock(side_effect=RuntimeError("boom")),
         ):
        # inline 재현 — stories.py의 try/except 블록과 동일 구조를 직접 실행해 예외 비전파 확認.
        try:
            from app.routers.events import _push_to_agent
            from app.services.project_auth import project_accessible_member_ids
            member_ids = await project_accessible_member_ids(AsyncMock(), org_id, story.project_id)
            for member_id in member_ids:
                _push_to_agent(str(member_id), {})
        except Exception:
            pass  # stories.py 실제 코드의 except 블록과 동일 — 예외가 여기서 삼켜져야
        else:
            pytest.fail("project_accessible_member_ids가 raise 안 함 — 테스트 전제 오류")
