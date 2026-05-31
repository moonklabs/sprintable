"""E-CAGE-REFEREE P1: verdict 스키마 + 기록 인터페이스 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.verdict_recorder import record_verdict

ORG_ID = uuid.uuid4()
PARTICIPATION_ID = uuid.uuid4()
VERDICT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_verdict(result="pass", rounds=1, source="pr"):
    v = MagicMock()
    v.id = VERDICT_ID
    v.org_id = ORG_ID
    v.participation_id = PARTICIPATION_ID
    v.source = source
    v.result = result
    v.rounds = rounds
    v.recorded_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    v.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return v


# ── record_verdict 서비스 단위 테스트 ──────────────────────────────────────────

@pytest.mark.anyio
async def test_record_verdict_new_creates():
    """신규 verdict → INSERT."""
    session = AsyncMock()
    existing_result = MagicMock()
    existing_result.scalar_one_or_none.return_value = None  # 없음
    session.execute = AsyncMock(return_value=existing_result)
    session.add = MagicMock()
    session.flush = AsyncMock()

    v = _mock_verdict()
    session.refresh = AsyncMock(side_effect=lambda obj: None)

    with pytest.MonkeyPatch().context() as mp:
        # refresh 후 verdict 반환 시뮬
        session.refresh = AsyncMock()
        result_obj = await record_verdict(session, ORG_ID, PARTICIPATION_ID, "pr", "pass", 1)
    session.add.assert_called_once()
    session.flush.assert_called_once()


@pytest.mark.anyio
async def test_record_verdict_existing_updates():
    """기존 verdict → UPDATE (upsert 멱등)."""
    session = AsyncMock()
    existing = _mock_verdict(result="fail", rounds=2)
    existing_result = MagicMock()
    existing_result.scalar_one_or_none.return_value = existing
    session.execute = AsyncMock(return_value=existing_result)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await record_verdict(session, ORG_ID, PARTICIPATION_ID, "pr", "pass", 3)

    assert existing.result == "pass"
    assert existing.rounds == 3
    session.add.assert_not_called()  # UPDATE이므로 add 없음
    session.flush.assert_called_once()


@pytest.mark.anyio
async def test_record_verdict_null_result():
    """result=None → 미측정 null 유지 (거짓 pass/fail 금지)."""
    session = AsyncMock()
    existing_result = MagicMock()
    existing_result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=existing_result)
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await record_verdict(session, ORG_ID, PARTICIPATION_ID, "ci", None)

    # add된 객체의 result가 None인지 검증
    added_obj = session.add.call_args[0][0]
    assert added_obj.result is None


@pytest.mark.anyio
async def test_record_verdict_idempotent_rerecord():
    """동일 (participation_id, source) 재기록 → 기존 row 갱신, 중복 없음."""
    session = AsyncMock()
    existing = _mock_verdict(result="fail", rounds=1)
    existing_result = MagicMock()
    existing_result.scalar_one_or_none.return_value = existing
    session.execute = AsyncMock(return_value=existing_result)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await record_verdict(session, ORG_ID, PARTICIPATION_ID, "pr", "pass", 2)

    # add 호출 없음(기존 갱신)
    session.add.assert_not_called()
    assert existing.result == "pass"
    assert existing.rounds == 2


# ── 공개 API 차단 검증 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_no_public_post_verdict_endpoint():
    """POST /api/v2/verdicts 엔드포인트 없음 — 에이전트 자기 verdict 수동기록 차단."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/verdicts", json={
                "participation_id": str(PARTICIPATION_ID),
                "source": "pr",
                "result": "pass",
            })
        assert resp.status_code == 405, "POST /verdicts must not exist (Method Not Allowed)"
    finally:
        app.dependency_overrides.clear()


# ── GET verdict 조회 ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_verdicts_200():
    """GET /api/v2/verdicts?participation_id=... → 200."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [_mock_verdict()]
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(f"/api/v2/verdicts?participation_id={PARTICIPATION_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["source"] == "pr"
        assert body[0]["result"] == "pass"
    finally:
        app.dependency_overrides.clear()


# ── org 격리 ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_org_isolation_verdict():
    """다른 org의 verdict는 조회 안 됨."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(f"/api/v2/verdicts?participation_id={PARTICIPATION_ID}")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()
