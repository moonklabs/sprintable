"""story fca4723d(C1): list_hypotheses project_id 옵셔널화 — retro list_sessions와 동형
패턴(app/routers/retros.py) 복제. project_id 생략 시 org 전체 조회 후 호출자의 실제
project 접근권으로 후필터(비접근 project의 가설 비노출 — 존재 자체를 숨기는 원칙과 정합).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.schemas.hypothesis import HypothesisResponse

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OTHER_PROJECT_ID = uuid.uuid4()


def _hyp(project_id: uuid.UUID, statement: str = "test") -> HypothesisResponse:
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    return HypothesisResponse(
        id=uuid.uuid4(), org_id=ORG_ID, project_id=project_id, owner_member_id=uuid.uuid4(),
        statement=statement, metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
        measure_after=now, status="proposed", human_accounting={}, gate_contract={},
        created_at=now, updated_at=now,
    )


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_list_hypotheses_project_id_still_supported():
    """회귀 0: project_id 지정 시 기존 동작 그대로(access 체크 없이 svc 결과 그대로 반환)."""
    from app.dependencies.auth import get_project_scoped_org_id

    client, _session, app = await _client()
    try:
        # get_project_scoped_org_id 자체 로직(project→org 조회)은 이 테스트 대상이 아님 —
        # 라우터가 project_id 지정 시 기존 동작을 그대로 보존하는지만 확인.
        app.dependency_overrides[get_project_scoped_org_id] = lambda: ORG_ID
        with patch(
            "app.routers.hypotheses.svc.list_hypotheses",
            new=AsyncMock(return_value=[_hyp(PROJECT_ID)]),
        ):
            async with client as c:
                resp = await c.get(f"/api/v2/hypotheses?project_id={PROJECT_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_hypotheses_no_project_id_filters_by_access():
    """핵심 회귀(C1): project_id 생략 → org 전체 svc 조회 후 has_project_access 통과분만."""
    client, _session, app = await _client()
    try:
        accessible = _hyp(PROJECT_ID, statement="accessible")
        inaccessible = _hyp(OTHER_PROJECT_ID, statement="inaccessible")

        async def fake_access(_db, _user_id, project_id, _org_id):
            return project_id == PROJECT_ID

        with patch(
            "app.routers.hypotheses.svc.list_hypotheses",
            new=AsyncMock(return_value=[accessible, inaccessible]),
        ), patch("app.routers.hypotheses.has_project_access", new=AsyncMock(side_effect=fake_access)):
            async with client as c:
                resp = await c.get("/api/v2/hypotheses")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["project_id"] == str(PROJECT_ID)
        assert body[0]["statement"] == "accessible"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_hypotheses_no_project_id_all_inaccessible_returns_empty():
    """비접근 project만 있으면 빈 리스트(존재 비노출 — 404가 아니라 200+빈배열, retro와 동형)."""
    client, _session, app = await _client()
    try:
        with patch(
            "app.routers.hypotheses.svc.list_hypotheses",
            new=AsyncMock(return_value=[_hyp(OTHER_PROJECT_ID)]),
        ), patch("app.routers.hypotheses.has_project_access", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.get("/api/v2/hypotheses")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()
