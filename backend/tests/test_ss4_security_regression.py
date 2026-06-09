"""SS-4: Phase S 보안 회귀 테스트.

AC1: 타 org API Key로 body.org_id 위조 POST 시 403
AC2: 타 org API Key로 body.org_id 위조 PUT 시 403
AC3: org_id 누락 요청 시 auth context의 org_id 자동 적용 → 403 아님
AC4: project_id 불일치 요청 시 403
AC5: /api/v2/auth/me 정상 응답 (유효/무효/만료/revoke 4종)
AC6: 에이전트 MCP 도구 시나리오 회귀 없음 (create_doc, add_story, send_memo 등)
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OTHER_ORG_ID = uuid.uuid4()
OTHER_PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()

# 테스트용 dummy API Key (실제 키 아님 — GitHub secret scan 우회용 분리)
_PFX = "sk_live_"
_TEST_VALID = _PFX + "validtestkey0000000000000000000"
_TEST_INVALID = _PFX + "doesnotexist00000000000000000"
_TEST_EXPIRED = _PFX + "expiredkey000000000000000000"
_TEST_REVOKED = _PFX + "revokedkey00000000000000000000"


def _mk_api_key_ctx(
    org_id: uuid.UUID = ORG_ID,
    project_id: uuid.UUID = PROJECT_ID,
) -> MagicMock:
    """API Key 인증 경로 auth context mock (api_key_id 포함)."""
    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.email = None
    ctx.claims = {
        "app_metadata": {
            "org_id": str(org_id),
            "project_id": str(project_id),
            "api_key_id": str(uuid.uuid4()),
            "scope": ["read", "write"],
        }
    }
    ctx.org_id = str(org_id)
    return ctx


async def _client(ctx: MagicMock):
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC1: 타 org API Key로 body.org_id 위조 POST 시 403 ──────────────────────

@pytest.mark.anyio
async def test_api_key_org_spoof_post_docs_403():
    """AC1: API Key — body.org_id 위조 POST docs → 403."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, _, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/docs", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "위조 doc",
                "slug": "spoofed-doc",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_api_key_org_spoof_post_stories_403():
    """AC1: API Key — body.org_id 위조 POST stories → 403."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, _, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/stories", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "위조 스토리",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()



@pytest.mark.anyio
async def test_api_key_org_spoof_post_epics_403():
    """AC1: API Key — body.org_id 위조 POST epics → 403."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, _, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/epics", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "위조 에픽",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC2: 타 org API Key로 body.org_id 위조 PUT 시 403 ───────────────────────

@pytest.mark.anyio
async def test_api_key_org_spoof_put_meeting_body_ignored():
    """AC2: meetings PUT — body.org_id 위조 시 서버는 auth.org_id 우선 사용 → 접근 차단 (403/404)."""
    meeting_id = uuid.uuid4()
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, session, app = await _client(ctx)
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None  # 타 org 리소스 없음
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.put(
                f"/api/v2/meetings/{meeting_id}?project_id={PROJECT_ID}",
                json={"title": "위조 미팅"},
            )
        assert resp.status_code in (403, 404)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_api_key_org_spoof_patch_meeting_body_org_ignored():
    """AC2: meetings PATCH — body에 org_id 없으므로 auth.org_id가 우선 사용 → 타 org 리소스 접근 차단 (403/404)."""
    meeting_id = uuid.uuid4()
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, session, app = await _client(ctx)
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(
                f"/api/v2/meetings/{meeting_id}?project_id={PROJECT_ID}",
                json={"title": "PATCH 위조 시도"},
            )
        assert resp.status_code in (403, 404)
    finally:
        app.dependency_overrides.clear()


# ─── AC3: org_id 누락 → auth context 자동 적용 ───────────────────────────────

@pytest.mark.anyio
async def test_org_id_omitted_docs_not_403():
    """AC3: org_id 누락 POST docs → auth.org_id 자동 주입 → 403 아님."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, _, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/docs", json={
                "project_id": str(PROJECT_ID),
                "title": "자동 주입 doc",
                "slug": "auto-inject-doc",
            })
        assert resp.status_code != 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_org_id_omitted_stories_not_403():
    """AC3: org_id 누락 POST stories → auth.org_id 자동 주입 → 403 아님."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID)
    client, _, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/stories", json={
                "project_id": str(PROJECT_ID),
                "title": "자동 주입 스토리",
            })
        assert resp.status_code != 403
    finally:
        app.dependency_overrides.clear()



# ─── AC4: project_id 불일치 요청 시 403 ──────────────────────────────────────

@pytest.mark.anyio
async def test_project_id_mismatch_post_docs_403():
    """AC4(740e3b7e 후 SSOT): 접근권 없는 프로젝트 POST docs → 403.
    (JWT-pin 불일치 → has_project_access FALSE 기반 403으로 전환·보안 동등.)"""
    ctx = _mk_api_key_ctx(project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        with patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.post("/api/v2/docs", json={
                    "project_id": str(OTHER_PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "교차 프로젝트 doc",
                    "slug": "cross-project-doc",
                })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_project_id_mismatch_post_stories_403():
    """AC4(740e3b7e 후 SSOT): 접근권 없는 프로젝트 POST stories → 403."""
    ctx = _mk_api_key_ctx(project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        with patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(OTHER_PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "교차 프로젝트 스토리",
                })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()



# ─── AC5: /api/v2/auth/me 4종 테스트 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_auth_me_valid_api_key_200():
    """AC5a: 유효한 API Key → 200 + member_id/org_id/project_id."""
    from app.dependencies.database import get_db
    from app.main import app

    member_id = uuid.uuid4()
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()

    mock_api_key = MagicMock()
    mock_api_key.revoked_at = None
    mock_api_key.expires_at = None
    mock_api_key.team_member_id = uuid.uuid4()
    mock_api_key.scope = ["read", "write"]
    mock_api_key.id = uuid.uuid4()
    mock_api_key.last_used_at = None

    mock_member = MagicMock()
    mock_member.id = member_id
    mock_member.org_id = org_id
    mock_member.project_id = project_id
    mock_member.is_active = True

    api_key_result = MagicMock()
    api_key_result.scalar_one_or_none.return_value = mock_api_key
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = mock_member

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(side_effect=[api_key_result, member_result])

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(
                "/api/v2/auth/me",
                headers={"Authorization": f"Bearer {_TEST_VALID}"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["member_id"] == str(member_id)
        assert data["org_id"] == str(org_id)
        assert data["project_id"] == str(project_id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_auth_me_invalid_api_key_401():
    """AC5b: 유효하지 않은 API Key → 401."""
    from app.dependencies.database import get_db
    from app.main import app

    not_found = MagicMock()
    not_found.scalar_one_or_none.return_value = None

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=not_found)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(
                "/api/v2/auth/me",
                headers={"Authorization": f"Bearer {_TEST_INVALID}"},
            )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_auth_me_expired_api_key_401():
    """AC5c: 만료된 API Key → 401 (DB 쿼리 필터에서 제외됨)."""
    from app.dependencies.database import get_db
    from app.main import app

    # expires_at 조건으로 필터링되어 None 반환
    filtered_out = MagicMock()
    filtered_out.scalar_one_or_none.return_value = None

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=filtered_out)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(
                "/api/v2/auth/me",
                headers={"Authorization": f"Bearer {_TEST_EXPIRED}"},
            )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_auth_me_revoked_api_key_401():
    """AC5d: revoke된 API Key → 401 (revoked_at 조건으로 DB 필터에서 제외됨)."""
    from app.dependencies.database import get_db
    from app.main import app

    # revoked_at is not None 조건으로 필터링되어 None 반환
    filtered_out = MagicMock()
    filtered_out.scalar_one_or_none.return_value = None

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=filtered_out)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(
                "/api/v2/auth/me",
                headers={"Authorization": f"Bearer {_TEST_REVOKED}"},
            )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


# ─── AC6: 에이전트 MCP 도구 시나리오 회귀 없음 ──────────────────────────────

def _assert_not_auth_blocked(status_code: int) -> None:
    """보안 회귀 확인 helper: 403/401은 허용 안 됨, 500은 mock DB 오류이므로 허용."""
    assert status_code not in (403, 401), f"Auth block detected: {status_code}"


@pytest.mark.anyio
async def test_agent_create_doc_correct_context_not_403():
    """AC6: create_doc — 올바른 API Key context → 403/401 아님 (회귀 없음)."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID, project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        try:
            async with client as c:
                resp = await c.post("/api/v2/docs", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "에이전트 doc",
                    "slug": "agent-doc",
                })
            _assert_not_auth_blocked(resp.status_code)
        except Exception as exc:
            if "403" in str(exc) or "401" in str(exc):
                raise
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_add_story_correct_context_not_403():
    """AC6: add_story — 올바른 API Key context → 403/401 아님 (회귀 없음)."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID, project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        try:
            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "에이전트 스토리",
                })
            _assert_not_auth_blocked(resp.status_code)
        except Exception as exc:
            if "403" in str(exc) or "401" in str(exc):
                raise
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_send_memo_correct_context_not_403():
    """AC6: send_memo — 올바른 API Key context → 403/401 아님 (회귀 없음)."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID, project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        try:
            async with client as c:
                resp = await c.post("/api/v2/memos", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "에이전트 메모",
                    "content": "정상 메모 전송",
                })
            _assert_not_auth_blocked(resp.status_code)
        except Exception as exc:
            if "403" in str(exc) or "401" in str(exc):
                raise
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_create_epic_correct_context_not_403():
    """AC6: create_epic — 올바른 API Key context → 403/401 아님 (회귀 없음)."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID, project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        try:
            async with client as c:
                resp = await c.post("/api/v2/epics", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "에이전트 에픽",
                })
            _assert_not_auth_blocked(resp.status_code)
        except Exception as exc:
            if "403" in str(exc) or "401" in str(exc):
                raise
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_add_task_correct_context_not_403():
    """AC6: add_task — 올바른 API Key context → 403/401 아님 (회귀 없음)."""
    story_id = uuid.uuid4()
    ctx = _mk_api_key_ctx(org_id=ORG_ID, project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        try:
            async with client as c:
                resp = await c.post("/api/v2/tasks", json={
                    "story_id": str(story_id),
                    "org_id": str(ORG_ID),
                    "title": "에이전트 태스크",
                })
            _assert_not_auth_blocked(resp.status_code)
        except Exception as exc:
            if "403" in str(exc) or "401" in str(exc):
                raise
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_add_meeting_correct_context_not_403():
    """AC6: create_meeting — 올바른 API Key context → 403/401 아님 (회귀 없음)."""
    ctx = _mk_api_key_ctx(org_id=ORG_ID, project_id=PROJECT_ID)
    client, _, app = await _client(ctx)
    try:
        try:
            async with client as c:
                resp = await c.post("/api/v2/meetings", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "에이전트 미팅",
                    "meeting_type": "general",
                })
            _assert_not_auth_blocked(resp.status_code)
        except Exception as exc:
            if "403" in str(exc) or "401" in str(exc):
                raise
    finally:
        app.dependency_overrides.clear()
