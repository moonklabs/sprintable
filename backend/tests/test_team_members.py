"""S21 AC: TeamMember router + repository 단위 테스트 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


def _mock_member(is_active: bool = True, type_: str = "human") -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.user_id = None
    m.type = type_
    m.name = "Alice"
    m.role = "member"
    m.avatar_url = None
    m.agent_config = None
    m.is_active = is_active
    m.color = "#3385f8"
    m.agent_role = None
    m.runtime_type = None  # E-CHAT-CMD S1b: 신규 필드 — mock 명시(from_attributes ValidationError 방지)
    m.created_by = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    # S2-1: presence 필드
    m.last_seen_at = None
    m.active_story_id = None
    m.agent_status = None
    m.can_manage_members = False
    # S2-4: active_story inject용 (None으로 고정)
    m.active_story = None
    return m


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
async def test_list_team_members_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_member()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/team-members?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["color"] == "#3385f8"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_filter_by_type_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_member(type_="agent")]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/team-members?project_id={PROJECT_ID}&type=agent")

        assert resp.status_code == 200
        assert resp.json()[0]["type"] == "agent"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_team_member_201():
    client, session, app = await _client()
    try:
        # fakechat_port 쿼리 응답 mock
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = None  # _resolve_actor → non-agent
        mock_result.all.return_value = []  # fakechat_port 쿼리 → 기존 포트 없음
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=None)), \
             patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.services.notification_preference_defaults.insert_default_preferences", new_callable=AsyncMock), \
             patch("app.repositories.api_key.ApiKeyRepository.create", new_callable=AsyncMock) as mock_api_key:
            agent_mock = _mock_member(type_="agent")
            agent_mock.name = "TestBot"
            mock_create.return_value = agent_mock
            mock_api_key.return_value = (MagicMock(), "sk_test_xxx")

            async with client as c:
                resp = await c.post("/api/v2/team-members", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "type": "agent",
                    "name": "TestBot",
                })

        assert resp.status_code == 201
        assert resp.json()["name"] == "TestBot"
        # 8d02d5e8: 온보딩 에이전트 키 scope = list(ALL_GROUPS) 명시(레거시 None 아님·툴그룹 모델 일관)
        from app.services.mcp_toolset import ALL_GROUPS
        assert mock_api_key.call_args.kwargs.get("scope") == list(ALL_GROUPS)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_team_member_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        # AC3-4 2-2: repo.get은 뷰 multi-row 방어로 scalars().first() 사용
        mock_result.scalars.return_value.first.return_value = _mock_member()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/team-members/{MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_team_member_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = None  # AC3-4 2-2: get→scalars().first()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/team-members/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_team_member_200():
    """S19(#2): human 경로가 self-or-org-admin 게이트를 통과해야 진행 — org-admin caller로 mock."""
    client, session, app = await _client()
    try:
        updated = _mock_member()
        updated.color = "#ff0000"
        mock_result = MagicMock()
        # AC3-4 2-2: PATCH = repo.get(scalars().first()) → apply_anchor_update → expire → repo.get
        mock_result.scalars.return_value.first.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)
        session.expire = MagicMock()  # sync 메서드(AsyncMock 코루틴 경고 회피)

        with patch("app.routers.team_members._is_org_admin", AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.patch(f"/api/v2/team-members/{MEMBER_ID}", json={"color": "#ff0000"})

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_team_member_403_when_not_self_or_admin():
    """S19(#2 MUST): human 대상이 본인도 org-admin도 아닌 caller가 수정 시 403."""
    client, session, app = await _client()
    try:
        target = _mock_member()
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = target
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.routers.team_members._is_org_admin", AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.patch(f"/api/v2/team-members/{MEMBER_ID}", json={"color": "#ff0000"})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_team_member_self_can_edit_profile_fields():
    """산티아고 Phase A SME (c): self가 프로필 필드(color 등)만 건드리면 org-admin 없이도 통과."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    self_user_id = uuid.uuid4()
    updated = _mock_member()
    updated.user_id = self_user_id
    updated.color = "#ff0000"

    mock_result = MagicMock()
    mock_result.scalars.return_value.first.return_value = updated
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.expire = MagicMock()

    ctx = MagicMock()
    ctx.user_id = str(self_user_id)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.patch(f"/api/v2/team-members/{MEMBER_ID}", json={"color": "#ff0000"})
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_team_member_self_403_when_escalating_role():
    """산티아고 Phase A SME (c) MUST: self가 자기 role/can_manage_members/is_active/agent_config를
    스스로 바꾸는 건 권한상승이라 org-admin 없이는 403 — 이전엔 self 경로가 전 필드를 허용했다."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    self_user_id = uuid.uuid4()
    target = _mock_member()
    target.user_id = self_user_id

    mock_result = MagicMock()
    mock_result.scalars.return_value.first.return_value = target
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_result)

    ctx = MagicMock()
    ctx.user_id = str(self_user_id)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    try:
        with patch("app.routers.team_members._is_org_admin", AsyncMock(return_value=False)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.patch(
                    f"/api/v2/team-members/{MEMBER_ID}", json={"role": "admin"},
                )
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_deactivate_team_member_200():
    """DELETE → soft deactivate (is_active=False). S19(#3): org-admin caller로 mock."""
    client, session, app = await _client()
    try:
        active_member = _mock_member(is_active=True)
        inactive_member = _mock_member(is_active=False)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count <= 2:
                result.scalar_one_or_none.return_value = active_member
            else:
                result.scalar_one_or_none.return_value = inactive_member
            result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        with patch("app.routers.team_members._is_org_admin", AsyncMock(return_value=True)):
            async with client as c:
                resp = await c.delete(f"/api/v2/team-members/{MEMBER_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["deactivated"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_deactivate_team_member_403_when_not_self_or_admin():
    """S19(#3 MUST): human 대상이 본인도 org-admin도 아닌 caller가 deactivate 시 403."""
    client, session, app = await _client()
    try:
        active_member = _mock_member(is_active=True)
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = active_member
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.routers.team_members._is_org_admin", AsyncMock(return_value=False)):
            async with client as c:
                resp = await c.delete(f"/api/v2/team-members/{MEMBER_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_deactivate_not_found_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = None  # AC3-4 2-2: deactivate→get→scalars().first()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.delete(f"/api/v2/team-members/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── 1bc9fbae ⑤: webhook_url DROP — apply_anchor_update 무시 검증 ───────────────

@pytest.mark.anyio
async def test_apply_anchor_update_webhook_url_dropped():
    """1bc9fbae ⑤ cutover: webhook_url 은 _PROFILE_FIELDS 에서 제거됨(canonical=webhook_configs).
    PATCH 에 webhook_url 만 있으면 m_set/a_set/p_set 전부 비어 UPDATE execute 0회(에이전트 포함)."""
    from app.repositories.team_member import TeamMemberRepository

    for type_ in ("human", "agent"):
        session = AsyncMock()
        repo = TeamMemberRepository(session, ORG_ID)
        member = _mock_member(type_=type_)

        await repo.apply_anchor_update(member, {"webhook_url": "https://example.com/wh"})

        assert session.execute.await_count == 0


# ─── standup-dup fix: org-level team_members DISTINCT ON(id) dedup ──────────────

@pytest.mark.anyio
async def test_list_org_level_distinct_on_id():
    """team_members 뷰(0088 projection·members⋈project_access)는 멀티프로젝트 멤버가
    per-project N행 → org-level(project_id 미필터)은 DISTINCT ON(id)로 멤버 1행만(unique)."""
    from sqlalchemy.dialects import postgresql

    from app.repositories.team_member import TeamMemberRepository

    captured = []

    async def cap(q, *args, **kwargs):
        captured.append(q)
        r = MagicMock()
        r.scalars.return_value.all.return_value = []
        return r

    session = AsyncMock()
    session.execute = cap
    repo = TeamMemberRepository(session, ORG_ID)

    # org-level: project_id 미필터 → DISTINCT ON 적용(멤버 dedup)
    await repo.list()
    org_sql = str(captured[-1].compile(dialect=postgresql.dialect()))
    assert "DISTINCT ON" in org_sql

    # project-scoped: project당 1행이라 dedup 불요(무회귀)
    await repo.list(project_id=PROJECT_ID)
    proj_sql = str(captured[-1].compile(dialect=postgresql.dialect()))
    assert "DISTINCT ON" not in proj_sql
