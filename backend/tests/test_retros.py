"""S24 AC: Retro router + repository 단위 테스트 (7건 이상).

#1801 까심 QA HIGH(same-org cross-project IDOR) fix 후: `_require_retro_project_access`가 모든
session-scoped 라우트에서 `has_project_access`를 호출하므로, 기존 테스트는 그 호출을 명시
patch해야 한다(패치 안 하면 진짜 session.execute가 한 번 더 끼어들어 call-count 기반 mock
순번이 밀림 — 광역 mock 공유 함정. [[feedback_shared_flow_query_breaks_broad_mock]])."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OTHER_PROJECT_ID = uuid.uuid4()
SESSION_ID = uuid.uuid4()
ITEM_ID = uuid.uuid4()
VOTER_ID = uuid.uuid4()


def _mock_session(phase: str = "collect", project_id: uuid.UUID = PROJECT_ID) -> MagicMock:
    s = MagicMock()
    s.id = SESSION_ID
    s.org_id = ORG_ID
    s.project_id = project_id
    s.sprint_id = None
    s.created_by = None
    s.title = "Sprint 3 Retro"
    s.phase = phase
    s.items = []
    s.actions = []
    s.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return s


def _mock_item() -> MagicMock:
    i = MagicMock()
    i.id = ITEM_ID
    i.session_id = SESSION_ID
    i.author_id = None
    i.category = "good"
    i.text = "팀워크 좋았는"
    i.vote_count = 2
    i.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return i


def _mock_action() -> MagicMock:
    a = MagicMock()
    a.id = uuid.uuid4()
    a.session_id = SESSION_ID
    a.assignee_id = None
    a.title = "CI 속도 개선"
    a.status = "open"
    a.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return a


def _mock_vote() -> MagicMock:
    v = MagicMock()
    v.id = uuid.uuid4()
    v.item_id = ITEM_ID
    v.voter_id = VOTER_ID
    v.created_at = datetime(2026, 4, 29, tzinfo=timezone.utc)
    return v


def _allow_project_access():
    """has_project_access를 True로 patch(router-local import 경로) — session-scope pre-check용."""
    return patch("app.routers.retros.has_project_access", new=AsyncMock(return_value=True))


def _deny_project_access():
    return patch("app.routers.retros.has_project_access", new=AsyncMock(return_value=False))


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
async def test_list_retro_sessions_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_session()]
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["phase"] == "collect"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_retro_sessions_no_project_id_filters_by_access():
    """project_id 생략 시 org 전체가 아니라 has_project_access 통과분만 반환(#1801 스윕)."""
    client, session, app = await _client()
    try:
        accessible = _mock_session(project_id=PROJECT_ID)
        inaccessible = _mock_session(project_id=OTHER_PROJECT_ID)
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [accessible, inaccessible]
        session.execute = AsyncMock(return_value=mock_result)

        async def fake_access(_db, _user_id, project_id, _org_id):
            return project_id == PROJECT_ID

        with patch("app.routers.retros.has_project_access", new=AsyncMock(side_effect=fake_access)):
            async with client as c:
                resp = await c.get("/api/v2/retros")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["project_id"] == str(PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_retro_sessions_cross_project_403():
    client, session, app = await _client()
    try:
        with _deny_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros?project_id={OTHER_PROJECT_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_retro_session_201():
    client, session, app = await _client()
    try:
        with (
            _allow_project_access(),
            patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_create.return_value = _mock_session()

            async with client as c:
                resp = await c.post("/api/v2/retros", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Sprint 3 Retro",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Sprint 3 Retro"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_retro_session_cross_project_403():
    """body.project_id를 검증 없이 신뢰하면 무권한 project에 session을 심을 수 있던 mutation IDOR."""
    client, session, app = await _client()
    try:
        with _deny_project_access():
            async with client as c:
                resp = await c.post("/api/v2/retros", json={
                    "project_id": str(OTHER_PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "무단 생성 시도",
                })

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_with_items_200():
    """GET /{id} → items + actions nested."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        with _allow_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(SESSION_ID)
        assert "items" in body
        assert "actions" in body
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/retros/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_retro_session_cross_project_403():
    """#1801 계열 — session은 org 내에 존재하나 caller가 그 project에 접근권 없음 → 403(404 아님)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_advance_phase_200():
    """collect → group 순차 전이."""
    client, session, app = await _client()
    try:
        collect_session = _mock_session("collect")
        group_session = _mock_session("group")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            # call 1 = _require_retro_project_access pre-check, call 2 = set_phase() 내부 get()
            # (둘 다 현재 phase="collect" 세션이어야 current_idx 계산이 맞음) — call 3+ = update() 내부 get().
            if call_count <= 2:
                result.scalar_one_or_none.return_value = collect_session
            else:
                result.scalar_one_or_none.return_value = group_session
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.patch(f"/api/v2/retros/{SESSION_ID}/phase", json={"phase": "group"})

        assert resp.status_code == 200
        assert resp.json()["phase"] == "group"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_item_201():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = _mock_session() if call_count == 1 else _mock_item()
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()
        session.add = MagicMock()

        with (
            _allow_project_access(),
            patch("app.repositories.retro.RetroItemRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_create.return_value = _mock_item()

            async with client as c:
                resp = await c.post(f"/api/v2/retros/{SESSION_ID}/items", json={
                    "category": "good",
                    "text": "팀워크 좋았는",
                })

        assert resp.status_code == 201
        assert resp.json()["category"] == "good"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_item_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroItemRepository.delete_from_session",
                new_callable=AsyncMock,
            ) as mock_delete,
        ):
            mock_delete.return_value = True

            async with client as c:
                resp = await c.delete(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}")

        assert resp.status_code == 200
        mock_delete.assert_awaited_once_with(SESSION_ID, ITEM_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_item_wrong_session_404():
    """item_id가 실존해도 session_id 소속이 아니면 404(2차 IDOR 방어 — parent session 접근권만으론 불충분)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroItemRepository.delete_from_session",
                new_callable=AsyncMock,
            ) as mock_delete,
        ):
            mock_delete.return_value = False  # 타 session 소속 item

            async with client as c:
                resp = await c.delete(f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_duplicate_409():
    """중복 투표 → 409."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            # call1 = _require_retro_project_access, call2 = _require_item_in_session, call3+ = 중복투표 체크
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            elif call_count == 2:
                result.scalar_one_or_none.return_value = _mock_item()
            else:
                result.scalar_one_or_none.return_value = _mock_vote()  # 이미 존재
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.post(
                    f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote?voter_id={VOTER_ID}"
                )

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_vote_item_wrong_session_404():
    """item_id가 session 소속이 아니면 투표도 404(2차 IDOR 방어)."""
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = _mock_session()
            else:
                result.scalar_one_or_none.return_value = None  # item이 이 session 소속 아님
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.post(
                    f"/api/v2/retros/{SESSION_ID}/items/{ITEM_ID}/vote?voter_id={VOTER_ID}"
                )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_action_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        updated_action = _mock_action()
        updated_action.status = "done"

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroActionRepository.update_in_session",
                new_callable=AsyncMock,
            ) as mock_update,
        ):
            mock_update.return_value = updated_action

            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/actions/{updated_action.id}",
                    json={"status": "done"},
                )

        assert resp.status_code == 200
        assert resp.json()["status"] == "done"
        mock_update.assert_awaited_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_action_cross_project_403():
    """#1801 원 적출 지점 — parent session이 caller 무권한 project 소속이면 403."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session(project_id=OTHER_PROJECT_ID)
        session.execute = AsyncMock(return_value=mock_result)

        with _deny_project_access():
            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/actions/{uuid.uuid4()}",
                    json={"status": "done"},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_action_wrong_session_404():
    """action_id가 실존해도 session_id 소속이 아니면 404(2차 IDOR 방어)."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_session()
        session.execute = AsyncMock(return_value=mock_result)

        with (
            _allow_project_access(),
            patch(
                "app.repositories.retro.RetroActionRepository.update_in_session",
                new_callable=AsyncMock,
            ) as mock_update,
        ):
            mock_update.return_value = None  # 타 session 소속 action

            async with client as c:
                resp = await c.patch(
                    f"/api/v2/retros/{SESSION_ID}/actions/{uuid.uuid4()}",
                    json={"status": "done"},
                )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_export_markdown_200():
    client, session, app = await _client()
    try:
        retro_session = _mock_session("closed")
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = retro_session
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        with _allow_project_access():
            async with client as c:
                resp = await c.get(f"/api/v2/retros/{SESSION_ID}/export")

        assert resp.status_code == 200
        assert "Sprint 3 Retro" in resp.text
        assert "# " in resp.text
    finally:
        app.dependency_overrides.clear()
