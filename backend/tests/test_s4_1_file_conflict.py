"""S4-1: 파일 단위 충돌 감지 + 경고 알림 검증.

AC1: POST /team-members/{id}/file-lock — 파일 lock 등록
AC2: POST /team-members/{id}/file-unlock — 파일 lock 해제
AC3: 동일 파일 다른 멤버 lock 시 conflict warning 반환
AC4: conflict 시 file_conflict 이벤트 발행
AC5: MCP 도구 sprintable_lock_files / sprintable_unlock_files 등록
AC6: GET /api/v2/file-locks — 활성 lock 목록
AC7: unclaim 시 file lock 자동 해제
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
OTHER_MEMBER_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()


# ─── 충돌 감지 단위 테스트 ────────────────────────────────────────────────────

def test_conflict_info_shape():
    """AC3: ConflictInfo 모델 필드 확인."""
    from app.routers.file_locks import ConflictInfo
    ci = ConflictInfo(
        file_path="src/foo.py",
        locked_by_member_id=str(OTHER_MEMBER_ID),
        locked_at=datetime.now(timezone.utc),
    )
    assert ci.file_path == "src/foo.py"
    assert ci.locked_by_member_id == str(OTHER_MEMBER_ID)


def test_release_all_file_locks_exists():
    """AC7: release_all_file_locks 헬퍼 존재."""
    from app.routers.file_locks import release_all_file_locks
    import inspect
    assert inspect.iscoroutinefunction(release_all_file_locks)


# ─── AC5: MCP 도구 등록 확인 ─────────────────────────────────────────────────

def test_mcp_lock_files_in_tool_defs():
    """AC5: sprintable_lock_files 도구 등록."""
    from sprintable_mcp.server import _TOOL_DEFS
    names = [t[0] for t in _TOOL_DEFS]
    assert "sprintable_lock_files" in names


def test_mcp_unlock_files_in_tool_defs():
    """AC5: sprintable_unlock_files 도구 등록."""
    from sprintable_mcp.server import _TOOL_DEFS
    names = [t[0] for t in _TOOL_DEFS]
    assert "sprintable_unlock_files" in names


# ─── migration 확인 ──────────────────────────────────────────────────────────

def test_migration_0040_exists():
    """file_locks migration 파일 존재."""
    from pathlib import Path
    p = Path(__file__).parent.parent / "alembic/versions/0040_add_file_locks.py"
    assert p.exists()


def test_migration_0040_revision():
    """revision=0040, down_revision=0039."""
    from pathlib import Path
    content = (Path(__file__).parent.parent / "alembic/versions/0040_add_file_locks.py").read_text()
    assert 'revision = "0040"' in content
    assert 'down_revision = "0039"' in content
    assert "file_locks" in content


# ─── 엔드포인트 통합 테스트 ─────────────────────────────────────────────────

@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
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

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _mock_member():
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.type = "agent"
    m.name = "TestAgent"
    m.role = "member"
    m.user_id = None
    m.avatar_url = None
    m.agent_config = None
    m.is_active = True
    m.color = "#3385f8"
    m.agent_role = None
    m.runtime_type = None  # E-CHAT-CMD S1b: 신규 필드 — mock 명시(from_attributes ValidationError 방지)
    m.created_by = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 19, tzinfo=timezone.utc)
    m.last_seen_at = None
    m.active_story_id = None
    m.agent_status = None
    m.active_story = None
    return m


def _resolved(member_id: uuid.UUID):
    """S17: resolve_member() 반환 mock — self-scope 검증 대상 caller 신원."""
    from app.services.member_resolver import ResolvedMember

    return ResolvedMember(
        id=member_id, user_id=None, name="TestAgent", type="agent",
        role="member", org_id=ORG_ID, project_id=PROJECT_ID,
    )


@pytest.mark.anyio
async def test_file_lock_no_conflict_200():
    """AC1: 충돌 없을 때 200 + warning=null."""
    client, session, app = await _client()
    try:
        member = _mock_member()

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalars.return_value.first.return_value = member  # get member
            else:
                result.scalars.return_value.all.return_value = []  # no conflicts
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.add = MagicMock()

        with patch("app.routers.file_locks.resolve_member", new_callable=AsyncMock,
                   return_value=_resolved(MEMBER_ID)):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                    json={"file_paths": ["src/foo.py"]},
                )

        assert resp.status_code == 200
        body = resp.json()
        assert body["locked"] is True
        assert body["warning"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_file_lock_403_when_caller_is_different_member():
    """S17(산티아고 SME MUST②): self-scope — 자기 자신이 아닌 member 명의로 lock 시도 시 403."""
    client, session, app = await _client()
    try:
        member = _mock_member()
        result = MagicMock()
        result.scalars.return_value.first.return_value = member
        session.execute = AsyncMock(return_value=result)

        with patch("app.routers.file_locks.resolve_member", new_callable=AsyncMock,
                   return_value=_resolved(OTHER_MEMBER_ID)):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                    json={"file_paths": ["src/foo.py"]},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_file_lock_404_when_member_not_in_caller_org():
    """S17(산티아고 SME MUST②): member 조회가 org_id로 스코프됨 — 타 org member_id는 404."""
    client, session, app = await _client()
    try:
        result = MagicMock()
        result.scalars.return_value.first.return_value = None  # org 필터로 미발견
        session.execute = AsyncMock(return_value=result)

        async with client as c:
            resp = await c.post(
                f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                json={"file_paths": ["src/foo.py"]},
            )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_file_lock_with_conflict_warning():
    """AC3: 충돌 있을 때 warning 필드 포함."""
    client, session, app = await _client()
    try:
        member = _mock_member()

        conflict_lock = MagicMock()
        conflict_lock.file_path = "src/foo.py"
        conflict_lock.member_id = OTHER_MEMBER_ID
        conflict_lock.locked_at = datetime(2026, 5, 19, 10, 0, 0, tzinfo=timezone.utc)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalars.return_value.first.return_value = member
            else:
                result.scalars.return_value.all.return_value = [conflict_lock]
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.add = MagicMock()

        with patch("app.routers.file_locks.publish_event"), \
             patch("app.routers.file_locks.fire_webhooks", new_callable=AsyncMock), \
             patch("app.routers.file_locks.resolve_member", new_callable=AsyncMock,
                   return_value=_resolved(MEMBER_ID)):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                    json={"file_paths": ["src/foo.py"]},
                )

        assert resp.status_code == 200
        body = resp.json()
        assert body["locked"] is True
        assert body["warning"] is not None
        assert len(body["warning"]) == 1
        assert body["warning"][0]["file_path"] == "src/foo.py"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_file_unlock_200():
    """AC2: file-unlock → 200 (S17: 이제 member 존재/org+self-scope 확인 후 UPDATE)."""
    client, session, app = await _client()
    try:
        member = _mock_member()

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalars.return_value.first.return_value = member  # get member
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()

        with patch("app.routers.file_locks.resolve_member", new_callable=AsyncMock,
                   return_value=_resolved(MEMBER_ID)):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/file-unlock",
                    json={"file_paths": ["src/foo.py"]},
                )

        assert resp.status_code == 200
        assert resp.json()["unlocked"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_file_unlock_403_when_caller_is_different_member():
    """S17(산티아고 SME MUST①): self-scope — 타 member 명의 lock을 임의로 해제하지 못하게.

    이전엔 이 엔드포인트가 member 조회/소유 확인 전혀 없이 path member_id 만 믿고 UPDATE했다
    (org 필터도 없어 임의 member 락을 아무나 해제 가능한 구조 — 산티아고 SME MUST①의 핵심 갭).
    """
    client, session, app = await _client()
    try:
        member = _mock_member()
        result = MagicMock()
        result.scalars.return_value.first.return_value = member
        session.execute = AsyncMock(return_value=result)

        with patch("app.routers.file_locks.resolve_member", new_callable=AsyncMock,
                   return_value=_resolved(OTHER_MEMBER_ID)):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/file-unlock",
                    json={"file_paths": ["src/foo.py"]},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_file_unlock_404_when_member_not_in_caller_org():
    """S17(산티아고 SME MUST①): member 조회가 org_id로 스코프됨 — 타 org member_id는 404."""
    client, session, app = await _client()
    try:
        result = MagicMock()
        result.scalars.return_value.first.return_value = None
        session.execute = AsyncMock(return_value=result)

        async with client as c:
            resp = await c.post(
                f"/api/v2/team-members/{MEMBER_ID}/file-unlock",
                json={"file_paths": ["src/foo.py"]},
            )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── S17 SHOULD: file_paths 상한·path 정규화 ─────────────────────────────────

def test_normalize_path_strips_dot_slash_and_dedupes_slashes():
    from app.routers.file_locks import _normalize_path

    assert _normalize_path("./src/foo.py") == "src/foo.py"
    assert _normalize_path("src//foo.py") == "src/foo.py"
    assert _normalize_path("././src/foo.py") == "src/foo.py"
    assert _normalize_path("src/foo.py") == "src/foo.py"


def test_file_lock_body_normalizes_paths_and_caps_count():
    from app.routers.file_locks import FileLockBody, _MAX_FILE_PATHS_PER_REQUEST

    body = FileLockBody(file_paths=["./src/foo.py", "src//bar.py"])
    assert body.file_paths == ["src/foo.py", "src/bar.py"]

    with pytest.raises(ValueError, match="exceeds max"):
        FileLockBody(file_paths=["f.py"] * (_MAX_FILE_PATHS_PER_REQUEST + 1))


@pytest.mark.anyio
async def test_file_lock_rejects_over_max_paths_422():
    client, session, app = await _client()
    try:
        from app.routers.file_locks import _MAX_FILE_PATHS_PER_REQUEST

        async with client as c:
            resp = await c.post(
                f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                json={"file_paths": [f"f{i}.py" for i in range(_MAX_FILE_PATHS_PER_REQUEST + 1)]},
            )

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ─── S17 RC②(까심 델타): 빈 path 거부 + project 힌트 결정성 ────────────────────

@pytest.mark.parametrize("raw", ["", ".", "./", ".//", "  ", "././"])
def test_normalize_reduces_to_empty_is_rejected(raw):
    from app.routers.file_locks import _validate_paths

    with pytest.raises(ValueError, match="empty path"):
        _validate_paths([raw])


def test_file_lock_body_rejects_empty_after_normalization():
    from app.routers.file_locks import FileLockBody
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        FileLockBody(file_paths=["./"])


@pytest.mark.anyio
async def test_file_lock_rejects_path_that_normalizes_to_empty_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post(
                f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                json={"file_paths": ["src/foo.py", "././"]},
            )
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_caller_project_hint_reads_app_metadata_project_id():
    from app.dependencies.auth import AuthContext
    from app.routers.file_locks import _caller_project_hint

    pid = uuid.uuid4()
    auth = AuthContext(user_id=str(uuid.uuid4()), email=None,
                        claims={"app_metadata": {"project_id": str(pid)}})
    assert _caller_project_hint(auth) == pid


def test_caller_project_hint_none_when_absent_or_invalid():
    from app.dependencies.auth import AuthContext
    from app.routers.file_locks import _caller_project_hint

    assert _caller_project_hint(
        AuthContext(user_id=str(uuid.uuid4()), email=None, claims={"app_metadata": {}})
    ) is None
    assert _caller_project_hint(
        AuthContext(user_id=str(uuid.uuid4()), email=None,
                    claims={"app_metadata": {"project_id": "not-a-uuid"}})
    ) is None


@pytest.mark.anyio
async def test_file_lock_uses_project_hint_to_scope_member_query():
    """S17 RC②(까심 델타 MED): X-Project-Id/active project 컨텍스트가 있으면 member 조회가
    그 project로 결정적으로 좁혀지는지 — 쿼리에 project_id 필터가 실제로 걸렸는지 stmt 검사."""
    client, session, app = await _client()
    try:
        member = _mock_member()
        hint_project = member.project_id
        captured_stmts = []

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            captured_stmts.append(stmt)
            result = MagicMock()
            if call_count == 1:
                result.scalars.return_value.first.return_value = member
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.add = MagicMock()

        with patch("app.routers.file_locks.resolve_member", new_callable=AsyncMock,
                   return_value=_resolved(MEMBER_ID)), \
             patch("app.routers.file_locks._caller_project_hint", return_value=hint_project) as hint_mock:
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/file-lock",
                    json={"file_paths": ["src/foo.py"]},
                )

        assert resp.status_code == 200
        hint_mock.assert_called_once()
        # member-fetch stmt (first captured) must reference project_id in its WHERE (compiled contains column name)
        assert "project_id" in str(captured_stmts[0])
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_file_locks_200():
    """AC6: GET /api/v2/file-locks → 목록 반환."""
    client, session, app = await _client()
    try:
        lock = MagicMock()
        lock.id = uuid.uuid4()
        lock.member_id = MEMBER_ID
        lock.story_id = None
        lock.file_path = "src/foo.py"
        lock.locked_at = datetime(2026, 5, 19, 10, 0, 0, tzinfo=timezone.utc)

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [lock]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/file-locks")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["file_path"] == "src/foo.py"
    finally:
        app.dependency_overrides.clear()
