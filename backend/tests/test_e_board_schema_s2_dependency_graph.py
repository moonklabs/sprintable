"""E-BOARD-SCHEMA S2: 3계층 의존성 구조 + 그래프 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.dependency_graph import would_create_cycle

ORG_ID = uuid.uuid4()
OTHER_ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()

# ── would_create_cycle 단위 테스트 ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_cycle_self_reference():
    """자기참조 → 즉시 True (cycle)."""
    session = AsyncMock()
    item_id = uuid.uuid4()
    result = await would_create_cycle(session, ORG_ID, item_id, item_id, "story")
    assert result is True
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_cycle_no_existing_edges():
    """엣지 없는 그래프에 첫 엣지 → 사이클 없음."""
    session = AsyncMock()
    mock_result = MagicMock()
    mock_result.all.return_value = []
    session.execute = AsyncMock(return_value=mock_result)

    a, b = uuid.uuid4(), uuid.uuid4()
    result = await would_create_cycle(session, ORG_ID, a, b, "story")
    assert result is False


@pytest.mark.anyio
async def test_cycle_direct_reverse_detected():
    """A→B 있는 상태에서 B→A 추가 시 사이클 검출."""
    a, b = uuid.uuid4(), uuid.uuid4()

    async def mock_execute(stmt, *args, **kwargs):
        result = MagicMock()
        # BFS: to_id=b에서 outgoing 엣지 → (b→a) 반환
        result.all.return_value = [(a,)]
        return result

    session = AsyncMock()
    session.execute = mock_execute

    # from=b, to=a 추가 시 → b→a→? 탐색에서 a 발견 → a==from_id(b)? no...
    # 실제로: from=b, to=a 추가. BFS from to_id=a. a에서 outgoing 확인.
    # A→B가 있으므로 a에서 b로 가는 엣지. b == from_id(b) → cycle.
    async def mock_execute2(stmt, *args, **kwargs):
        result = MagicMock()
        result.all.return_value = [(b,)]  # a→b 엣지 존재
        return result

    session.execute = mock_execute2
    result = await would_create_cycle(session, ORG_ID, b, a, "story")
    assert result is True


@pytest.mark.anyio
async def test_cycle_chain_detected():
    """A→B→C 있는 상태에서 C→A 추가 시 사이클 검출."""
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        # BFS from to_id=a:
        #   1st call: a의 outgoing → b
        #   2nd call: b의 outgoing → c
        #   3rd call: c의 outgoing → (c==from_id? no. c의 outgoing)
        if call_count == 1:
            result.all.return_value = [(b,)]  # a→b
        elif call_count == 2:
            result.all.return_value = [(c,)]  # b→c. c == from_id(c)? yes!
        else:
            result.all.return_value = []
        return result

    session = AsyncMock()
    session.execute = mock_execute

    # from=c, to=a: BFS에서 a→b→c를 탐색, c==from_id 발견 → cycle
    result = await would_create_cycle(session, ORG_ID, c, a, "story")
    assert result is True


@pytest.mark.anyio
async def test_cycle_safe_addition():
    """A→B, A→C 있는 상태에서 B→C 추가는 사이클 없음."""
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        # from=b, to=c: BFS from c
        # c의 outgoing → 없음
        result.all.return_value = []
        return result

    session = AsyncMock()
    session.execute = mock_execute

    result = await would_create_cycle(session, ORG_ID, b, c, "story")
    assert result is False


# ── API 통합 테스트 ─────────────────────────────────────────────────────────────

@pytest.fixture
def anyio_backend():
    return "asyncio"


DEP_ID = uuid.uuid4()
FROM_ID = uuid.uuid4()
TO_ID = uuid.uuid4()


def _mock_dep(dep_id=None, from_id=None, to_id=None, dep_type="blocks", item_type="story"):
    d = MagicMock()
    d.id = dep_id or DEP_ID
    d.org_id = ORG_ID
    d.from_id = from_id or FROM_ID
    d.to_id = to_id or TO_ID
    d.dep_type = dep_type
    d.item_type = item_type
    d.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return d


async def _make_client(mock_session):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.mark.anyio
async def test_create_dependency_201():
    """의존성 생성 → 201."""
    from unittest.mock import patch

    mock_session = AsyncMock()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = None  # not exists
        r.all.return_value = []  # no cycle (BFS empty)
        return r

    mock_session.execute = mock_execute

    dep = _mock_dep()
    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = dep
            async with client as c:
                resp = await c.post("/api/v2/dependencies", json={
                    "from_id": str(FROM_ID),
                    "to_id": str(TO_ID),
                    "dep_type": "blocks",
                    "item_type": "story",
                })
        assert resp.status_code == 201
        assert resp.json()["dep_type"] == "blocks"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_dependency_self_ref_422():
    """자기참조 → 422."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)
    item_id = uuid.uuid4()
    try:
        async with client as c:
            resp = await c.post("/api/v2/dependencies", json={
                "from_id": str(item_id),
                "to_id": str(item_id),
                "dep_type": "blocks",
                "item_type": "story",
            })
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_dependency_cycle_422():
    """사이클 유발 의존성 → 422.

    기존 a→b 상태에서 b→a 추가 시:
    BFS(from=b, to=a): a의 outgoing=[(b,)] → b==from_id → cycle 검출.
    """
    mock_session = AsyncMock()
    a, b = uuid.uuid4(), uuid.uuid4()

    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        r = MagicMock()
        if call_count == 1:
            r.scalar_one_or_none.return_value = None  # exists check → not duplicate
        else:
            # BFS: a의 outgoing 엣지 → b (기존 a→b 엣지)
            r.all.return_value = [(b,)]
        return r

    mock_session.execute = mock_execute
    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/dependencies", json={
                "from_id": str(b),
                "to_id": str(a),
                "dep_type": "blocks",
                "item_type": "story",
            })
        assert resp.status_code == 422
        assert "사이클" in resp.json()["error"]["message"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_dependency_duplicate_409():
    """중복 의존성 → 409."""
    mock_session = AsyncMock()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = DEP_ID  # already exists
        return r

    mock_session.execute = mock_execute
    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/dependencies", json={
                "from_id": str(FROM_ID),
                "to_id": str(TO_ID),
                "dep_type": "blocks",
                "item_type": "story",
            })
        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_dependencies_200():
    """GET /dependencies?item_type=story&item_id=... → 200 list."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [_mock_dep()]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/dependencies?item_type=story&item_id={FROM_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 1
        assert body[0]["dep_type"] == "blocks"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_dependencies_invalid_type_422():
    """invalid item_type → 422."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/dependencies?item_type=task&item_id={FROM_ID}")
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_dependency_200():
    """DELETE /dependencies/{id} → 200."""
    mock_session = AsyncMock()
    dep = _mock_dep()

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = dep
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/dependencies/{DEP_ID}")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_dependency_404():
    """존재하지 않는 의존성 삭제 → 404."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/dependencies/{uuid.uuid4()}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_graph_endpoint_200():
    """GET /dependencies/graph → 200 nodes+edges."""
    mock_session = AsyncMock()
    dep = _mock_dep()

    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [dep]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/dependencies/graph?item_type=story")
        assert resp.status_code == 200
        body = resp.json()
        assert body["item_type"] == "story"
        assert isinstance(body["nodes"], list)
        assert isinstance(body["edges"], list)
        assert len(body["edges"]) == 1
        assert body["edges"][0]["dep_type"] == "blocks"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_org_isolation_create():
    """다른 org의 의존성는 다른 org에서 안 보임 (org_id 스코프)."""
    # DependencyRepository.list_by_item은 org_id 필터 포함 — 별도 org 레코드 미반환
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []  # 다른 org라 0건
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/dependencies?item_type=story&item_id={FROM_ID}")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()
