"""CI-gated 회귀가드 — remove_participation(DELETE /participation/{id})이 대상 participation의
story-project 접근권을 강제하는지 검증. `{id}` 뮤테이션 라우트는 ratchet 스캐너 사각(PROJECT_PARAM_RE가
story_id/project_id만 매치·id는 미매치)이라 add_feedback류처럼 consumer test로 CI에 영속화. realdb
아님(mock)이라 CI backend-test에서 실행. 가드 제거/우회 시 즉시 RED.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
PARTICIPATION_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_remove_participation_denies_when_no_access_to_target_story_project():
    """대상 participation의 story project 접근권이 없으면(has_project_access=False) 404이고
    repo.delete가 호출되지 않는다(삭제 미수행). ⭐가드가 대상 participation의 story의 project로
    검증하는지(has_project_access가 그 project_id로 호출) 확認 — `{id}` 뮤테이션이 대상 리소스의
    project를 검증하는 계약."""
    from app.main import app
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    p = MagicMock()
    p.story_id = STORY_ID
    # _assert_story_project_access 내부의 Story.project_id 조회가 PROJECT_ID를 반환하도록.
    story_res = MagicMock()
    story_res.scalar_one_or_none.return_value = PROJECT_ID
    sess = AsyncMock()
    sess.execute = AsyncMock(return_value=story_res)

    async def _db():
        yield sess

    async def _auth():
        return AuthContext(user_id=str(USER_ID), email="c@test", claims={"app_metadata": {"org_id": str(ORG_ID)}})

    async def _org():
        return ORG_ID

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    try:
        with (
            patch("app.routers.participation.ParticipationRepository.get", new_callable=AsyncMock, return_value=p),
            patch("app.routers.participation.ParticipationRepository.delete", new_callable=AsyncMock) as mdel,
            patch("app.routers.participation.has_project_access", new_callable=AsyncMock, return_value=False) as mhpa,
        ):
            async with _client(app) as c:
                resp = await c.delete(f"/api/v2/participation/{PARTICIPATION_ID}")
            assert resp.status_code == 404, resp.text
            mdel.assert_not_awaited()  # 삭제 미수행
            assert mhpa.await_count >= 1
            # 대상 participation의 story→project(PROJECT_ID)로 검증했는지(body/query 아님).
            assert mhpa.await_args.args[2] == PROJECT_ID
    finally:
        app.dependency_overrides.clear()
