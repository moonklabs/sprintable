"""E-GHAPP Bot-L.2-BE: PR↔story 링크 GET(list) / DELETE(unlink) endpoint 보안 단위(산티아고 게이트).

커버: GET org-scope + story 선검증(타 org/부재=generic 404 oracle 0)·org+story+미삭제 링크만 반환 ·
DELETE anti-IDOR(link.id AND org_id·타 org/부재/이미삭제=generic 404)·soft-delete(deleted_at).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_A = uuid.uuid4()
STORY_ID = uuid.uuid4()
LINK_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story(org_id=ORG_A):
    return MagicMock(id=STORY_ID, org_id=org_id)


def _link(org_id=ORG_A):
    return MagicMock(
        id=LINK_ID, org_id=org_id, story_id=STORY_ID, repo_full_name="org/repo", pr_number=7,
        link_source="explicit", confidence="high", evidence={"by": "explicit_api"},
        created_at=datetime(2026, 6, 22, tzinfo=timezone.utc), deleted_at=None,
    )


def _client_session(*, execute_results):
    """execute side_effect=execute_results(scalar 또는 list)·commit/flush mock."""
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.flush = AsyncMock()
    seq = []
    for v in execute_results:
        r = MagicMock()
        if isinstance(v, list):
            r.scalars.return_value.all.return_value = v
            r.scalar_one_or_none.return_value = None
        else:
            r.scalar_one_or_none.return_value = v
        seq.append(r)
    session.execute = AsyncMock(side_effect=seq + [MagicMock()])
    return session


async def _req(method, path, *, execute_results, org_id=ORG_A):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app

    session = _client_session(execute_results=execute_results)

    async def override_db():
        yield session

    fastapi_app.dependency_overrides[get_db] = override_db
    fastapi_app.dependency_overrides[get_verified_org_id] = lambda: org_id
    fastapi_app.dependency_overrides[get_current_user] = lambda: MagicMock(user_id=str(uuid.uuid4()))
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            resp = await c.request(method, path)
        return resp, session
    finally:
        fastapi_app.dependency_overrides.clear()


# ── GET list ──────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_list_links_same_org_returns_links():
    # execute: story(org_a) → has_project_access(truthy) → links([link]).
    # E-SECURITY SEC-S8 Y: project-scope 검증(has_project_access) 호출이 추가돼 시퀀스가 하나 늘었다.
    resp, _ = await _req("GET", f"/api/v2/integrations/github/links?story_id={STORY_ID}",
                         execute_results=[_story(ORG_A), 1, [_link(ORG_A)]])
    assert resp.status_code == 200
    body = resp.json()
    data = body.get("data", body)
    assert len(data["links"]) == 1
    assert data["links"][0]["repo_full_name"] == "org/repo" and data["links"][0]["confidence"] == "high"


@pytest.mark.anyio
async def test_list_links_cross_org_story_404_no_oracle():
    """타 org/부재 story → story 선검증 미스 → generic 404·링크 조회 0(oracle 0)."""
    resp, session = await _req("GET", f"/api/v2/integrations/github/links?story_id={STORY_ID}",
                               execute_results=[None])  # story scoped 미스.
    assert resp.status_code == 404
    assert session.execute.await_count == 1  # story 검증만 — 링크 조회 안 함.


# ── DELETE unlink ───────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_delete_link_same_org_soft_deletes():
    link = _link(ORG_A)
    resp, session = await _req("DELETE", f"/api/v2/integrations/github/links/{LINK_ID}",
                               execute_results=[link])
    assert resp.status_code == 200
    assert link.deleted_at is not None      # soft-delete.
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_delete_link_cross_org_404_no_oracle():
    """타 org/부재/이미삭제 link → `id AND org_id AND deleted_at IS NULL` 미스 → generic 404·commit 0."""
    resp, session = await _req("DELETE", f"/api/v2/integrations/github/links/{LINK_ID}",
                               execute_results=[None])  # 타 org → org-scoped 미스.
    assert resp.status_code == 404
    session.commit.assert_not_awaited()  # side-effect 0.
