"""story #4217(critical) — `/me/memberships`가 projectSlug(가산 필드)를 돌려준다. 셸이 클라이언트 이동 뒤 현재 URL
`/{ws}/{proj}`의 프로젝트를 이 목록에서 slug→id로 풀어 현재 프로젝트로 쓴다(공유 레이아웃 서버 prop은 옛 값) — 이 필드가
빠지면 셸이 서버 prop 보조로만 돌아가 클라이언트 이동 뒤 옛 프로젝트 헤더·쓰기가 다시 생긴다."""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_memberships_select_and_return_project_slug():
    from app.routers.me import get_my_memberships

    rows = [
        SimpleNamespace(project_id=str(uuid.uuid4()), project_name="Project Beta", project_slug="beta", org_id="org-a"),
        SimpleNamespace(project_id=str(uuid.uuid4()), project_name="Project Charlie", project_slug="charlie", org_id="org-a"),
    ]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=rows)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()), claims={"app_metadata": {"org_id": str(uuid.uuid4())}})

    result = await get_my_memberships(session=session, auth=auth)

    sql = str(session.execute.await_args.args[0])
    assert "p.slug AS project_slug" in sql and "p.org_id::text AS org_id" in sql
    assert result == [
        {"projectId": rows[0].project_id, "projectName": "Project Beta", "projectSlug": "beta", "orgId": "org-a"},
        {"projectId": rows[1].project_id, "projectName": "Project Charlie", "projectSlug": "charlie", "orgId": "org-a"},
    ]
