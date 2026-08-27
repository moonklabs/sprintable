"""story #3115(2026-08-26, 승격 리드타임 단축) — 순서 조합 갭의 거울쌍.

story #2893 후속(PR#3357)이 고친 "참여가 링크보다 늦으면 gate가 영구 미생성"과 정확히 대칭인
갭: **링크가 참여보다 늦으면**(participation 먼저 등록돼 있는데 story-link만 늦게 생기는 순서)도
동일하게 gate가 영구 미생성이었다 — `POST /integrations/github/links`(explicit link, 사람이
action_required 안내를 보고 쓰는 그 API)가 `upsert_link` 후 재평가 훅을 전혀 안 불렀기 때문.

처방: `trigger_gate_creation_for_late_participation`(참여 쪽 기존 훅 — "story에 링크된 PR마다
gate 없으면 만든다"는 참여-불특정 일반 로직)을 `create_explicit_link`에도 그대로 재사용(새 규칙
발명 0). 이 파일은 test_2893_pr4_late_participation_gate_creation_realdb.py와 동일 하네스·
동일 패턴을 그대로 재사용해 "참여 선시딩 → 링크 후시딩" 순서로 정확히 거울 재현한다.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from tests.test_2893_gate_pr_scoped_isolation_realdb import (
    _seed_installation,
    _session_factory,
)
from tests.test_2893_pr4_late_participation_gate_creation_realdb import (
    _gates_for_story,
    _live_pr_patches,
)

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_org_project_story_with_participation(s):
    """참여를 story-link보다 먼저 시드한다(late-participation 테스트의 정확한 거울)."""
    from app.models.organization import Organization
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    s.add(project)
    await s.commit()
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress")
    s.add(story)
    await s.commit()
    role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="implementation", label="Impl", is_default=True)
    s.add(role)
    await s.commit()
    s.add(Participation(id=uuid.uuid4(), org_id=org.id, story_id=story.id, member_id=uuid.uuid4(), role_id=role.id))
    await s.commit()
    return org, project, story


@pytest.mark.anyio
async def test_explicit_link_endpoint_creates_missing_gate_when_participation_already_exists():
    """핵심 재현 — participation이 이미 있는 story에 뒤늦게 explicit link를 걸면(재오픈 없이)
    그 즉시 gate가 생겨야 한다."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, story = await _seed_org_project_story_with_participation(s)
            await _seed_installation(s, org, installation_id=680603)
            story_id = story.id

            from app.models.project import OrgMember
            from app.models.project_access import ProjectAccess
            from app.models.user import User

            caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(caller)
            await s.commit()
            caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
            s.add(caller_om)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
                permission="granted", role="member",
            ))
            await s.commit()
            caller_id = caller.id

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(caller_id), email="caller@test", claims={"app_metadata": {}})

        async def _org():
            return org.id

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            p1, p2, p3 = _live_pr_patches(head_sha="sha-late-link-1", ci_result="success")
            with p1, p2, p3:
                resp = await client.post(
                    "/api/v2/integrations/github/links",
                    json={
                        "story_id": str(story_id),
                        "repo_full_name": "moonklabs/sprintable",
                        "pr_number": 603,
                    },
                )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert len(gates) == 1, "explicit link 라우터도 게이트 생성 훅을 태워야 함(재오픈 불요)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_link_hook_noop_when_participation_still_missing():
    """음성대조 — participation이 아직 없으면(링크만 먼저 생김) 훅이 조용히 no-op해야 한다
    (evaluate_merge_gate 내부의 참여 요건이 여전히 막음 — 이 훅이 그 요건을 우회하면 안 됨).
    이후 참여가 생기면 기존 late-participation 훅이 이어받아 닫는다(#2893 계열과 순서 무관 합류)."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project, OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress")
            s.add(story)
            await s.commit()
            await _seed_installation(s, org, installation_id=680604)
            story_id = story.id

            caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(caller)
            await s.commit()
            caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
            s.add(caller_om)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
                permission="granted", role="member",
            ))
            await s.commit()
            caller_id = caller.id

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(caller_id), email="caller@test", claims={"app_metadata": {}})

        async def _org():
            return org.id

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            p1, p2, p3 = _live_pr_patches(head_sha="sha-late-link-2", ci_result="success")
            with p1, p2, p3:
                resp = await client.post(
                    "/api/v2/integrations/github/links",
                    json={
                        "story_id": str(story_id),
                        "repo_full_name": "moonklabs/sprintable",
                        "pr_number": 604,
                    },
                )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            gates = await _gates_for_story(s, story_id)
            assert gates == [], "참여가 없으면 게이트가 만들어지면 안 됨(요건 우회 금지)"
    finally:
        await engine.dispose()
