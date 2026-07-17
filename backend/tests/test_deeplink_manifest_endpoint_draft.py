"""story #1951 (E-MOBILE P1a-S1) DRAFT fixture — GET /api/v2/deeplink-manifest 서빙 엔드포인트.

PO 재정(3자 검토 스코프 확장)으로 이번 스토리에 추가된 런타임 API. mcp.py의
/api/v2/mcp/manifest 테스트 패턴(test_e_mcp_s2_toolset.py)을 그대로 따른다 — 이 파일도
draft(3자 검토 전 로컬 실행 확인용)이고, CI 정식 편입은 story #1952 스코프.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.dependencies.auth import AuthContext, get_current_user
from app.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _override_auth():
    return AuthContext(
        user_id=str(uuid.uuid4()),
        email=None,
        claims={"app_metadata": {}},
        org_id=str(uuid.uuid4()),
    )


@pytest.mark.anyio
async def test_deeplink_manifest_endpoint_returns_200_with_schema_version_and_lookup_key():
    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/deeplink-manifest")
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 200
    body = resp.json()

    assert body["schema_version"] == 1
    assert isinstance(body["version_policy"], str) and body["version_policy"]
    assert isinstance(body["entries"], list) and len(body["entries"]) == 33

    # 미르코 point ②: lookup_key = f"{type}:{entity_type}" (구분자 ":") 서빙 시점 파생.
    story_entry = next(
        e for e in body["entries"]
        if e["app"]["type"] == "dispatched" and e["app"]["entity_type"] == "story"
    )
    assert story_entry["lookup_key"] == "dispatched:story"

    # entity_type=None인 단일-타겟 엔트리도 콜론 포함 형태로 파생돼야 한다(빈 두번째 절).
    gate_entry = next(e for e in body["entries"] if e["app"]["type"] == "gate.pending_approval")
    assert gate_entry["lookup_key"] == "gate.pending_approval:"

    # 미르코 point ①: nested 구조(app/payload/channel) + snake_case 유지 확인.
    assert set(story_entry.keys()) >= {"lookup_key", "app", "payload", "channel"}
    assert "parent_tab" in story_entry["app"]
    assert "required_payload" in story_entry["payload"]
    assert "channel_grade" in story_entry["channel"]


@pytest.mark.anyio
async def test_deeplink_manifest_endpoint_requires_auth():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/api/v2/deeplink-manifest")
    assert resp.status_code in (401, 403)
