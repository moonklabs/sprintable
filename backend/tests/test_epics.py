"""S14 AC5: Epic router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
EPIC_ID = uuid.uuid4()


def _mock_epic(status: str = "active") -> MagicMock:
    e = MagicMock()
    e.id = EPIC_ID
    e.org_id = ORG_ID
    e.project_id = PROJECT_ID
    e.assignee_id = None
    e.title = "Epic 1"
    e.status = status
    e.priority = "medium"
    e.description = None
    e.objective = None
    e.success_criteria = None
    e.target_sp = None
    e.target_date = None
    # E-BOARD-SCHEMA S1: outcome 필드
    e.success_hypothesis = None
    e.metric_definition = None
    e.measure_after = None
    e.outcome_status = "n_a"
    e.outcome_result = None
    # E1 S8b: 연결 가설 집계. MagicMock auto-attr이면 from_attributes ValidationError이라
    # 신규 필드를 명시 세팅(기본값 동형). _attach_hypothesis_aggregates가 덮어쓸 수 있음.
    e.hypothesis_count = 0
    e.risky_status = None
    # 0d4c89e8: 연결 스토리 집계. 동일 사유(MagicMock auto-attr 방지)로 명시 세팅.
    e.total_stories = 0
    e.done_stories = 0
    e.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    e.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return e


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


# ── GET list ──────────────────────────────────────────────────────────────────

def _agg_row(epic_id, cnt: int, risk_rank: int | None):
    """EpicRepository._attach_hypothesis_aggregates 집계 한 행(epic_id·cnt·risk_rank)."""
    row = MagicMock()
    row.epic_id = epic_id
    row.cnt = cnt
    row.risk_rank = risk_rank
    return row


def _story_agg_row(epic_id, total_stories: int, done_stories: int):
    """EpicRepository._attach_story_aggregates 집계 한 행(epic_id·total_stories·done_stories)."""
    row = MagicMock()
    row.epic_id = epic_id
    row.total_stories = total_stories
    row.done_stories = done_stories
    return row


def _paginated_execute(
    total: int, rows: list, agg_rows: list | None = None, story_rows: list | None = None
):
    """EpicRepository.list_paginated의 execute 순서를 모킹.

    1=count(scalar_one), 2=list(scalars().all()), 3=가설 집계(_attach_hypothesis.. → result.all()),
    4=스토리 집계(_attach_story.. → result.all()).
    """
    state = {"n": 0}

    async def _exec(stmt, *args, **kwargs):
        state["n"] += 1
        r = MagicMock()
        if state["n"] == 1:
            r.scalar_one.return_value = total
        elif state["n"] == 2:
            r.scalars.return_value.all.return_value = rows
        elif state["n"] == 3:
            r.all.return_value = agg_rows or []
        else:
            r.all.return_value = story_rows or []
        return r

    return _exec


@pytest.mark.anyio
async def test_list_epics_200():
    client, session, app = await _client()
    try:
        session.execute = _paginated_execute(1, [_mock_epic()])

        async with client as c:
            resp = await c.get("/api/v2/epics")

        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
        # 569f5316: 전체 카운트는 항상 헤더로 노출 → silent-truncation 불가
        assert resp.headers["X-Total-Count"] == "1"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_includes_hypothesis_aggregates():
    """E1 S8b: list 응답에 hypothesis_count + risky_status(최위험 환원)가 실린다."""
    client, session, app = await _client()
    try:
        # risk_rank 0 = falsified(최위험), 연결 가설 3
        session.execute = _paginated_execute(
            1, [_mock_epic()], agg_rows=[_agg_row(EPIC_ID, 3, 0)]
        )
        async with client as c:
            resp = await c.get("/api/v2/epics")
        assert resp.status_code == 200
        body = resp.json()
        assert body[0]["hypothesis_count"] == 3
        assert body[0]["risky_status"] == "falsified"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_zero_hypotheses_defaults_count0_risky_null():
    """E1 S8b additive: 연결 가설 0건이면 count 0 / risky None."""
    client, session, app = await _client()
    try:
        session.execute = _paginated_execute(1, [_mock_epic()], agg_rows=[])
        async with client as c:
            resp = await c.get("/api/v2/epics")
        assert resp.status_code == 200
        body = resp.json()
        assert body[0]["hypothesis_count"] == 0
        assert body[0]["risky_status"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_includes_story_aggregates():
    """0d4c89e8: list 응답에 total_stories/done_stories(단일쿼리 집계)가 실린다(E-HO-TRUST 9/11형)."""
    client, session, app = await _client()
    try:
        session.execute = _paginated_execute(
            1, [_mock_epic()], story_rows=[_story_agg_row(EPIC_ID, 11, 9)]
        )
        async with client as c:
            resp = await c.get("/api/v2/epics")
        assert resp.status_code == 200
        body = resp.json()
        assert body[0]["total_stories"] == 11
        assert body[0]["done_stories"] == 9
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_zero_stories_defaults_0_0():
    """0d4c89e8 additive: 연결 스토리 0건이면 total/done 0/0(회귀 0·payload bloat 없음)."""
    client, session, app = await _client()
    try:
        session.execute = _paginated_execute(1, [_mock_epic()], story_rows=[])
        async with client as c:
            resp = await c.get("/api/v2/epics")
        assert resp.status_code == 200
        body = resp.json()
        assert body[0]["total_stories"] == 0
        assert body[0]["done_stories"] == 0
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_limit_cursor_delegated():
    """limit/cursor 위임 + X-Total-Count/X-Next-Cursor 헤더."""
    client, session, app = await _client()
    try:
        session.execute = _paginated_execute(42, [_mock_epic()])

        async with client as c:
            resp = await c.get("/api/v2/epics?limit=50&cursor=2026-05-01T00:00:00%2B00:00")

        assert resp.status_code == 200
        assert resp.headers["X-Total-Count"] == "42"
        assert "X-Next-Cursor" in resp.headers
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_1000plus_not_silent():
    """1000+ 시뮬: 반환 페이지보다 total이 커도 헤더로 전체 카운트 노출(silent 잘림 아님)."""
    client, session, app = await _client()
    try:
        # 페이지엔 1건만, 전체는 1500건 → X-Total-Count로 호출자가 잘림을 인지
        session.execute = _paginated_execute(1500, [_mock_epic()])

        async with client as c:
            resp = await c.get("/api/v2/epics?limit=1")

        assert resp.status_code == 200
        assert resp.headers["X-Total-Count"] == "1500"
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_epics_invalid_cursor_400():
    """잘못된 cursor는 silent 무시 대신 400으로 명확히 거절."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get("/api/v2/epics?cursor=not-a-datetime")

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


# ── POST create ───────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_epic_201():
    client, session, app = await _client()
    try:
        epic = _mock_epic()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = epic

            async with client as c:
                resp = await c.post("/api/v2/epics", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Epic 1",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Epic 1"
    finally:
        app.dependency_overrides.clear()


# ── GET detail ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_epic_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_epic()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/epics/{EPIC_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(EPIC_ID)
    finally:
        app.dependency_overrides.clear()


# ── GET 404 ───────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_epic_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/epics/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── PATCH update ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_epic_200():
    client, session, app = await _client()
    try:
        # RC#2 D1': FE always-send 패턴 — status==current(미변경) 동봉 + 메타편집 → 무시·200.
        updated = _mock_epic("active")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/epics/{EPIC_ID}",
                                 json={"status": "active", "priority": "high"})  # status==current

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_epic_status_change_via_patch_rejected_422():
    """⭐RC#2 D1': generic PATCH 로 status **변경**(!=current) 시 422(전용 transition 강제)."""
    client, session, app = await _client()
    try:
        current = _mock_epic("active")  # current.status='active'
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = current
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.patch(f"/api/v2/epics/{EPIC_ID}", json={"status": "done"})  # 변경
        assert resp.status_code == 422
        assert "transition" in resp.text.lower()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_epic_status_null_rejected_422():
    """⭐RC#2 D1'(codex Critical1): explicit {status:null}도 presence-기반이라 422(null≠current·status
    null화 봉인). 구 validator(v is not None)는 null 통과 갭이었음."""
    client, session, app = await _client()
    try:
        current = _mock_epic("active")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = current
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.patch(f"/api/v2/epics/{EPIC_ID}", json={"status": None})
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ── DELETE ────────────────────────────────────────────────────────────────────

def _delete_execute(*, epic, is_admin: bool):
    """delete_epic execute 시퀀스 모킹.

    1) repo.get → 존재 검증(scalar_one_or_none=에픽)
    2) is_org_owner_or_admin → owner/admin 행 유무(scalar_one_or_none)
    3) repo.delete 내부 self.get → 다시 에픽(없으면 False→404)
    이후 cascade(dependency/label delete)는 영향 없음.
    """
    state = {"n": 0}

    async def _exec(stmt, *args, **kwargs):
        state["n"] += 1
        r = MagicMock()
        if state["n"] == 1:
            r.scalar_one_or_none.return_value = epic
        elif state["n"] == 2:
            r.scalar_one_or_none.return_value = 1 if is_admin else None
        elif state["n"] == 3:
            r.scalar_one_or_none.return_value = epic
        else:
            r.scalar_one_or_none.return_value = None
            r.rowcount = 0
        return r

    return _exec


@pytest.mark.anyio
async def test_delete_epic_owner_admin_200():
    """owner/admin 은 삭제 200."""
    client, session, app = await _client()
    try:
        session.execute = _delete_execute(epic=_mock_epic(), is_admin=True)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/epics/{EPIC_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_epic_non_admin_403():
    """비-admin(member/viewer) 은 삭제 403 — 권한 누수 차단."""
    client, session, app = await _client()
    try:
        session.execute = _delete_execute(epic=_mock_epic(), is_admin=False)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/epics/{EPIC_ID}")

        assert resp.status_code == 403
        assert "admin or owner" in resp.json()["error"]["message"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_epic_404_missing():
    """존재하지 않는 에픽은 authz 이전에 404."""
    client, session, app = await _client()
    try:
        session.execute = _delete_execute(epic=None, is_admin=True)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/epics/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── GET progress ──────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_epic_progress_200():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                # get epic
                result.scalar_one_or_none.return_value = _mock_epic()
            else:
                # progress aggregation
                row = MagicMock()
                row.total_stories = 4
                row.done_stories = 2
                row.total_sp = 20
                row.done_sp = 10
                result.one.return_value = row
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/epics/{EPIC_ID}/progress")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_stories"] == 4
        assert body["done_stories"] == 2
        assert body["completion_pct"] == 50
    finally:
        app.dependency_overrides.clear()
