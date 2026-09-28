"""E-ORG-MULTI S4.2: Organization 삭제 UX 정리 — 백엔드 API 테스트.

AC1: 삭제 액션은 owner에게만 (admin/member 403)
AC2: GET /{id}/impact — Project/Member/Subscription 영향도 반환
AC3: 명시적 확인 입력(org name 재입력) 검증
AC4: confirmation 불일치 시 422
AC5: dev 환경 격리 검증
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
ORG_NAME = "Test Org"


def _resolved_human() -> MagicMock:
    """#2092 human-only 가드용 — resolve_member 반환값 mock."""
    m = MagicMock()
    m.type = "human"
    return m


def _stub_begin_nested(session: AsyncMock) -> None:
    """#2092(카디르 결함사냥 HIGH①) — delete_by_user가 get_impact()를
    `async with self.session.begin_nested():`로 감싸므로, 실 SQLAlchemy
    AsyncSession.begin_nested()와 동형(비동기 호출이 아니라 async-context-manager를
    "동기적으로" 반환)으로 session mock을 보강한다. 이거 없이 bare AsyncMock()이면
    session.begin_nested()가 코루틴을 반환해 `async with`가 TypeError로 깨진다."""
    nested_ctx = MagicMock()
    nested_ctx.__aenter__ = AsyncMock(return_value=nested_ctx)
    nested_ctx.__aexit__ = AsyncMock(return_value=False)
    session.begin_nested = MagicMock(return_value=nested_ctx)


def _mock_org() -> MagicMock:
    o = MagicMock()
    o.id = ORG_ID
    o.name = ORG_NAME
    o.slug = "test-org"
    o.plan = "free"
    o.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    o.updated_at = datetime(2026, 5, 20, tzinfo=timezone.utc)
    return o


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(user_id: uuid.UUID = USER_ID):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC2: GET /{id}/impact 진입점 ────────────────────────────────────────────

def test_impact_endpoint_exists():
    """GET /api/v2/organizations/{id}/impact 라우트 존재."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/organizations/{id}/impact" in paths


@pytest.mark.anyio
async def test_owner_can_get_impact():
    """owner → 200 + project/member/subscription 정보 반환."""
    client, session, app = await _client()
    try:
        from app.repositories.organization import OrgImpact
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.get_impact = AsyncMock(return_value=OrgImpact(
            project_count=3, member_count=5, has_active_subscription=False
        ))
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.get(f"/api/v2/organizations/{ORG_ID}/impact")

        assert resp.status_code == 200
        data = resp.json()
        assert data["project_count"] == 3
        assert data["member_count"] == 5
        assert data["has_active_subscription"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_non_owner_cannot_get_impact():
    """admin → impact 조회 403."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="admin")
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.get(f"/api/v2/organizations/{ORG_ID}/impact")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC1: DELETE — owner만 가능 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_owner_can_delete_with_correct_confirmation():
    """owner + 정확한 confirmation → 200."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": True})
        app.dependency_overrides[_get_repo] = lambda: mock_repo
        session.commit = AsyncMock()

        with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=_resolved_human())):
            async with client as c:
                resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": ORG_NAME})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_non_owner_delete_returns_403():
    """non-owner → delete_by_user forbidden → 403."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="admin")  # owner 아님 — human-only 체크 스킵
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": False, "reason": "forbidden"})
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": ORG_NAME})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_owner_cannot_delete_org_human_only():
    """#2092 — org owner 역할이어도 에이전트(non-human)면 403(human-only)."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": True})  # 도달하면 안 됨
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        agent_resolved = MagicMock()
        agent_resolved.type = "agent"
        with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=agent_resolved)):
            async with client as c:
                resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": ORG_NAME})

        assert resp.status_code == 403
        mock_repo.delete_by_user.assert_not_awaited()  # human-only에서 막혀 delete_by_user 자체를 안 부름
    finally:
        app.dependency_overrides.clear()


# ─── AC3+AC4: confirmation 불일치 422 ────────────────────────────────────────

@pytest.mark.anyio
async def test_wrong_confirmation_returns_422():
    """confirmation 불일치 → 422."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": False, "reason": "confirmation_mismatch"})
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=_resolved_human())):
            async with client as c:
                resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": "Wrong Name"})

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ─── #2092 AC1 — impact 재조회 실패 시 서버 거부 ─────────────────────────────

@pytest.mark.anyio
async def test_delete_rejected_when_impact_unavailable_and_no_override():
    """impact 재조회 실패 + confirm_without_impact 없음(기본 False) → 409(impact_unavailable)."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": False, "reason": "impact_unavailable"})
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=_resolved_human())):
            async with client as c:
                resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": ORG_NAME})

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_proceeds_with_explicit_override_when_impact_unavailable():
    """impact 재조회 실패 + confirm_without_impact=True → repo에 그 값이 그대로 전달돼 진행 허용."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": True})
        app.dependency_overrides[_get_repo] = lambda: mock_repo
        session.commit = AsyncMock()

        with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=_resolved_human())):
            async with client as c:
                resp = await c.request(
                    "DELETE", f"/api/v2/organizations/{ORG_ID}",
                    json={"confirmation": ORG_NAME, "confirm_without_impact": True},
                )

        assert resp.status_code == 200
        mock_repo.delete_by_user.assert_awaited_once()
        assert mock_repo.delete_by_user.await_args.kwargs["confirm_without_impact"] is True
    finally:
        app.dependency_overrides.clear()


# ─── Repository 메서드 검증 ──────────────────────────────────────────────────

def test_repo_has_get_impact():
    from app.repositories.organization import OrganizationRepository
    assert callable(getattr(OrganizationRepository, "get_impact", None))


def test_repo_has_delete_by_user():
    from app.repositories.organization import OrganizationRepository
    assert callable(getattr(OrganizationRepository, "delete_by_user", None))


def test_delete_by_user_checks_confirmation_in_source():
    """delete_by_user 소스에 confirmation 비교 로직 존재."""
    import inspect
    from app.repositories.organization import OrganizationRepository
    source = inspect.getsource(OrganizationRepository.delete_by_user)
    assert "confirmation" in source
    assert "org.name" in source


# ─── Schema 검증 ─────────────────────────────────────────────────────────────

def test_org_impact_response_fields():
    from app.schemas.organization import OrgImpactResponse
    fields = set(OrgImpactResponse.model_fields.keys())
    assert {"project_count", "member_count", "has_active_subscription"}.issubset(fields)


def test_delete_organization_schema():
    from app.schemas.organization import DeleteOrganization
    fields = set(DeleteOrganization.model_fields.keys())
    assert "confirmation" in fields
    assert "confirm_without_impact" in fields
    assert DeleteOrganization.model_fields["confirm_without_impact"].default is False


# ─── #2092 — delete_by_user 자체(mock session)로 impact 가드 직접 검증 ──────────

@pytest.mark.anyio
async def test_delete_by_user_rejects_when_impact_query_raises_and_no_override():
    """get_impact()가 예외를 던지면(=재조회 실패) confirm_without_impact 없이는 거부."""
    from app.repositories.organization import OrganizationRepository

    session = AsyncMock()
    _stub_begin_nested(session)
    repo = OrganizationRepository(session)
    repo.get_member_role = AsyncMock(return_value="owner")
    repo.get_impact = AsyncMock(side_effect=RuntimeError("db timeout"))
    # #2092 TOCTOU-fix(3차) — delete_by_user가 이제 repo.get() 대신 FOR UPDATE 락-SELECT를
    # session.execute로 직접 호출한다. scalar_one_or_none()이 org를 반환하게 stub.
    session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: _mock_org()))

    result = await repo.delete_by_user(org_id=ORG_ID, user_id=USER_ID, confirmation=ORG_NAME)

    assert result == {"ok": False, "reason": "impact_unavailable"}
    session.delete.assert_not_called()
    session.add.assert_not_called()


@pytest.mark.anyio
async def test_delete_by_user_proceeds_with_override_and_records_audit_note():
    """confirm_without_impact=True면 get_impact() 실패에도 진행하고, 감사로그에 note를 남긴다."""
    from app.models.deletion_audit import DeletionAuditLog
    from app.repositories.organization import OrganizationRepository

    session = AsyncMock()
    _stub_begin_nested(session)
    repo = OrganizationRepository(session)
    repo.get_member_role = AsyncMock(return_value="owner")
    repo.get_impact = AsyncMock(side_effect=RuntimeError("db timeout"))
    session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: _mock_org()))
    session.delete = AsyncMock()

    result = await repo.delete_by_user(
        org_id=ORG_ID, user_id=USER_ID, confirmation=ORG_NAME, confirm_without_impact=True,
    )

    assert result == {"ok": True}
    session.delete.assert_awaited_once()
    session.add.assert_called_once()
    audit_entry = session.add.call_args.args[0]
    assert isinstance(audit_entry, DeletionAuditLog)
    assert audit_entry.entity_type == "organization"
    assert audit_entry.entity_id == ORG_ID
    assert audit_entry.actor_id == USER_ID
    assert audit_entry.note is not None and "확認 없이" in audit_entry.note


@pytest.mark.anyio
async def test_delete_by_user_succeeds_normally_records_audit_without_note():
    """get_impact()가 정상 성공하면 confirm_without_impact 값과 무관하게 정상 진행 — note는 None."""
    from app.models.deletion_audit import DeletionAuditLog
    from app.repositories.organization import OrganizationRepository, OrgImpact

    session = AsyncMock()
    _stub_begin_nested(session)
    repo = OrganizationRepository(session)
    repo.get_member_role = AsyncMock(return_value="owner")
    repo.get_impact = AsyncMock(return_value=OrgImpact(project_count=1, member_count=2, has_active_subscription=False))
    session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: _mock_org()))
    session.delete = AsyncMock()

    result = await repo.delete_by_user(org_id=ORG_ID, user_id=USER_ID, confirmation=ORG_NAME)

    assert result == {"ok": True}
    audit_entry = session.add.call_args.args[0]
    assert isinstance(audit_entry, DeletionAuditLog)
    assert audit_entry.note is None


@pytest.mark.anyio
async def test_delete_by_user_rejects_when_impact_return_value_shows_active_subscription():
    """#2092 TOCTOU-fix(3차) — get_impact()가 예외 없이 성공해도, 그 반환값의
    has_active_subscription=True를 실제로 읽어 거부해야 한다(예전엔 반환값을 버려
    "에러 안 났나"만 봤다 — 재확認이 실은 재확認이 아니었다)."""
    from app.repositories.organization import OrganizationRepository, OrgImpact

    session = AsyncMock()
    _stub_begin_nested(session)
    repo = OrganizationRepository(session)
    repo.get_member_role = AsyncMock(return_value="owner")
    repo.get_impact = AsyncMock(
        return_value=OrgImpact(project_count=0, member_count=1, has_active_subscription=True)
    )
    session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: _mock_org()))
    session.delete = AsyncMock()

    result = await repo.delete_by_user(org_id=ORG_ID, user_id=USER_ID, confirmation=ORG_NAME)

    assert result == {"ok": False, "reason": "active_subscription"}
    session.delete.assert_not_called()
    session.add.assert_not_called()


def test_delete_by_user_locks_organization_row_for_update_in_source():
    """#2092 TOCTOU-fix(3차) — delete_by_user 소스에 organizations 행 FOR UPDATE 락이
    존재(checkout claim 경로와 그 행 위에서 직렬화하는 근본 메커니즘)."""
    import inspect
    from app.repositories.organization import OrganizationRepository
    source = inspect.getsource(OrganizationRepository.delete_by_user)
    assert "with_for_update" in source


def test_checkout_subscription_locks_organization_row_for_update_in_source():
    """#2092 TOCTOU-fix(3차) — checkout_subscription도 같은 org 행을 FOR UPDATE로
    잠근다(claim UPSERT 前) — organizations.py delete_by_user와 대칭."""
    import inspect
    from app.services.org_subscription_checkout import checkout_subscription
    source = inspect.getsource(checkout_subscription)
    assert "FOR UPDATE" in source
