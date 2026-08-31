"""story #3259 AC4(런타임 축) — moonklabs org로 접속해도 경로·권한이 타 org와 동일함을
실측한다. 그리고 세션/메시지 API가 org 스코프를 실제로 강제하는지(교차 org 접근 차단)도 함께."""
from __future__ import annotations

import pytest

from tests.conftest import MOONKLABS_ORG_ID, OTHER_ORG_ID, make_token


@pytest.mark.parametrize("org_id", [MOONKLABS_ORG_ID, OTHER_ORG_ID], ids=["moonklabs", "other-org"])
async def test_session_create_symmetric_across_orgs(client, org_id):
    """moonklabs든 다른 org든 동일 코드 경로 — 200 응답·응답 org_id가 요청 org와 일치."""
    resp = await client.post("/api/v1/sessions", headers={"Authorization": f"Bearer {make_token(org_id)}"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["org_id"] == str(org_id)


async def test_moonklabs_gets_no_special_response_shape(client):
    """moonklabs와 임의 org의 세션 생성 응답이 org_id 필드값을 제외하곤 동형(특례 필드 없음)."""
    r1 = await client.post("/api/v1/sessions", headers={"Authorization": f"Bearer {make_token(MOONKLABS_ORG_ID)}"})
    r2 = await client.post("/api/v1/sessions", headers={"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"})
    keys1 = set(r1.json().keys())
    keys2 = set(r2.json().keys())
    assert keys1 == keys2


async def test_cross_org_session_access_returns_404_not_leaked(client):
    """org A가 만든 session_id를 org B(moonklabs 포함)가 조회 시도 — 404(존재 노출 없음)."""
    token_a = make_token(OTHER_ORG_ID)
    create = await client.post("/api/v1/sessions", headers={"Authorization": f"Bearer {token_a}"})
    session_id = create.json()["id"]

    token_moonklabs = make_token(MOONKLABS_ORG_ID)
    resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages",
        json={"content": "hello"},
        headers={"Authorization": f"Bearer {token_moonklabs}"},
    )
    assert resp.status_code == 404


async def test_missing_token_rejected():
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post("/api/v1/sessions")
    assert resp.status_code == 401
