"""story #3999(3994/3997 후속) — 「시스템 발행」(runtime_type == 'system-publisher') 예약
멤버 대상 변이를 서버가 원자적으로 거부한다(409 SYSTEM_PUBLISHER_RESERVED, BE 사람 문장
0 — §3779). FE(3994/3997)는 이미 모든 진입점을 읽기 전용/제외로 막았지만, 직접 API 호출
우회는 서버가 정본이어야 한다.

AC1 census(코드 그라운딩, 이 파일이 고정하는 것):
- 키 발급/회전/폐기: POST /agents/{id}/api-keys · POST /api-keys/rotate ·
  DELETE /agents/{id}/api-keys/{key_id} → assert_agent_owner_mutable로 거부.
- PATCH /team-members/{id}(runtime_type·is_active·name·webhook_url 등 anchor-routed
  필드 전부) · DELETE /team-members/{id}(deactivate) · 아바타 3종
  (upload-url/confirm/delete) → assert_agent_owner_mutable로 거부.
- POST /agents/{id}/recruit — **AC1에서 새로 발견된 경로**: runtime_type을 직접
  변경하고(`apply_anchor_update`) persona+API 키까지 발급한다. `assert_agent_owner`만
  가드였고 예약 검사가 없었다 → assert_agent_owner_mutable로 거부.
- 메시지 정책 PUT/POST/DELETE(mode·allowlist add/remove) → assert_agent_owner_mutable.
- 프로젝트 접근 POST(grant)/DELETE(revoke)/PUT(role) →
  assert_member_id_not_system_publisher로 거부(회수는 team_members 뷰 3번째 UNION
  브랜치 투영 조건이 최소 1건 grant라 특히 중요 — events.py 주석 그대로).
- webhook PUT /config(관리자-타깃 분기) → assert_member_id_not_system_publisher.

읽기 경로(키 목록/로그·메시지 정책 조회·heartbeat/claim/unclaim 자기-스코프·connection-
verify 트리거)는 의도적으로 손 안 댐 — AC1 표에서 "허용(불필요)"로 근거와 함께 분류
(PR 본문 참고).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

from tests.test_2266_story_backlinks_realdb import (
    _client_for,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)
from tests.test_3687_members_org_scope_realdb import _make_agent_with_project_grant

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_org_owner(session, org_id):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="owner")
    session.add(om)
    await session.commit()
    return om.id, user.id


async def _set_runtime_type(session, member_id, runtime_type):
    from app.models.member import Member

    member = await session.get(Member, member_id)
    member.runtime_type = runtime_type
    await session.commit()


async def _setup(make_system_publisher: bool):
    """org+project+org owner(호출자)+에이전트(프로젝트 grant) 1건 준비. make_system_publisher면
    그 에이전트를 시스템 발행으로 표시(양성/음성 대조 공유 셋업)."""
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        _owner_member_id, owner_user_id = await _make_org_owner(s, org.id)
        agent_id = await _make_agent_with_project_grant(s, org.id, project.id, name="시스템 발행" if make_system_publisher else "일반 에이전트")
        if make_system_publisher:
            await _set_runtime_type(s, agent_id, "system-publisher")

    from app.main import app
    await _setup_app_human(app, Session, owner_user_id, org.id)
    client = _client_for(app)
    return engine, Session, app, client, org.id, project.id, agent_id


async def _member_row(Session, member_id):
    from app.models.member import Member
    async with Session() as s:
        return await s.get(Member, member_id)


# ── 키 발급/회전/폐기 ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_api_key_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.post(f"/api/v2/agents/{agent_id}/api-keys", json={"scope": None, "expires_at": None})
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "SYSTEM_PUBLISHER_RESERVED"

        from app.repositories.api_key import ApiKeyRepository
        async with Session() as s:
            keys = await ApiKeyRepository(s).list_by_member(agent_id)
        assert keys == [], "거부는 부작용 0 — 키가 실제로 생기면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_api_key_still_succeeds_for_normal_agent_regression():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(False)
    try:
        async with client as c:
            resp = await c.post(f"/api/v2/agents/{agent_id}/api-keys", json={"scope": None, "expires_at": None})
        assert resp.status_code == 201, resp.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_rotate_api_key_rejected_for_system_publisher():
    """create 자체가 막히므로, revoke_agent_api_key 경로가 아니라 직접 키를 심어(우회 시나리오
    재현) rotate 엔드포인트 자체의 독립 방어를 잰다."""
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        from app.repositories.api_key import ApiKeyRepository
        async with Session() as s:
            key, _pt = await ApiKeyRepository(s).create(team_member_id=agent_id, scope=None, expires_at=None)
            await s.commit()
            key_id = key.id

        async with client as c:
            resp = await c.post("/api/v2/api-keys/rotate", json={"api_key_id": str(key_id)})
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "SYSTEM_PUBLISHER_RESERVED"

        async with Session() as s:
            fresh = await ApiKeyRepository(s).get(key_id)
        assert fresh.revoked_at is None, "거부는 부작용 0 — 구키가 revoke되면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_api_key_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        from app.repositories.api_key import ApiKeyRepository
        async with Session() as s:
            key, _pt = await ApiKeyRepository(s).create(team_member_id=agent_id, scope=None, expires_at=None)
            await s.commit()
            key_id = key.id

        async with client as c:
            resp = await c.delete(f"/api/v2/agents/{agent_id}/api-keys/{key_id}")
        assert resp.status_code == 409, resp.text

        async with Session() as s:
            fresh = await ApiKeyRepository(s).get(key_id)
        assert fresh.revoked_at is None
    finally:
        await engine.dispose()


# ── PATCH/DELETE team-members ────────────────────────────────────────────


@pytest.mark.anyio
async def test_patch_runtime_type_rejected_for_system_publisher():
    """AC1 핵심 위협 — 런타임 변경 뒤 events.py가 두 번째 「시스템 발행」을 만드는 실 결함의
    원인 자체를 서버가 원천 차단한다."""
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{agent_id}", json={"runtime_type": "claude-code"})
        assert resp.status_code == 409, resp.text

        row = await _member_row(Session, agent_id)
        assert row.runtime_type == "system-publisher", "거부는 부작용 0 — runtime_type이 바뀌면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_is_active_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{agent_id}", json={"is_active": False})
        assert resp.status_code == 409, resp.text

        row = await _member_row(Session, agent_id)
        assert row.is_active is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_name_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{agent_id}", json={"name": "다른 이름"})
        assert resp.status_code == 409, resp.text

        row = await _member_row(Session, agent_id)
        assert row.name == "시스템 발행"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_still_succeeds_for_normal_agent_regression():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(False)
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{agent_id}", json={"runtime_type": "claude-code"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["runtime_type"] == "claude-code"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_deactivate_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/team-members/{agent_id}")
        assert resp.status_code == 409, resp.text

        row = await _member_row(Session, agent_id)
        assert row.is_active is True
    finally:
        await engine.dispose()


# ── 아바타 ────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_avatar_upload_url_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.post(
                f"/api/v2/team-members/{agent_id}/avatar/upload-url",
                json={"content_type": "image/png"},
            )
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_avatar_confirm_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.post(
                f"/api/v2/team-members/{agent_id}/avatar/confirm",
                json={"object_path": "avatars/x.png"},
            )
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_avatar_delete_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/team-members/{agent_id}/avatar")
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


# ── recruit(AC1 신규 발견 경로) ───────────────────────────────────────────


async def _seed_role_template(session, slug=None):
    slug = slug or f"3999-test-role-{uuid.uuid4().hex[:8]}"
    from app.models.role_template import RoleTemplate

    rt = RoleTemplate(
        id=uuid.uuid4(), slug=slug, name="Test Role", category="general",
        role_behaviors="test role behaviors", default_tool_groups=["core"],
        is_published=True,
    )
    session.add(rt)
    await session.commit()
    return rt


@pytest.mark.anyio
async def test_recruit_rejected_for_system_publisher():
    """AC1에서 새로 발견된 경로 — recruit이 runtime_type을 직접 바꾸고(apply_anchor_update)
    persona+API 키까지 발급한다. 거부 확認 + runtime_type·persona·키 셋 다 부작용 0."""
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        role_slug = f"3999-test-role-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            await _seed_role_template(s, slug=role_slug)

        async with client as c:
            resp = await c.post(
                f"/api/v2/agents/{agent_id}/recruit",
                json={"role_template_slug": role_slug, "runtime": "claude-code", "locale": "ko"},
            )
        assert resp.status_code == 409, resp.text

        row = await _member_row(Session, agent_id)
        assert row.runtime_type == "system-publisher", "거부는 부작용 0 — recruit이 runtime_type을 바꾸면 안 됨"

        from app.repositories.api_key import ApiKeyRepository
        async with Session() as s:
            keys = await ApiKeyRepository(s).list_by_member(agent_id)
        assert keys == [], "recruit 거부는 키도 발급하면 안 됨"
    finally:
        # story #3999(페드루 PO 지적, 2026-09-17) — realdb 오염 청소. RoleTemplate은
        # destructive_schema가 아니라 이 세션의 실 PG에 그대로 남아 test_e_recruit_s14
        # (전체 role_template 개수 카운트)·test_migration_0166(EN role_behaviors 전수)를
        # 깨뜨렸다 — global count/전수 검사에 기대는 다른 realdb 테스트를 오염시키지
        # 않도록 이 테스트가 만든 행은 반드시 지운다.
        from app.models.role_template import RoleTemplate
        async with Session() as s:
            rt = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.slug == role_slug)
            )).scalar_one_or_none()
            if rt is not None:
                await s.delete(rt)
                await s.commit()
        await engine.dispose()


@pytest.mark.anyio
async def test_recruit_still_succeeds_for_normal_agent_regression():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(False)
    try:
        role_slug = f"3999-test-role-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            await _seed_role_template(s, slug=role_slug)

        async with client as c:
            resp = await c.post(
                f"/api/v2/agents/{agent_id}/recruit",
                json={"role_template_slug": role_slug, "runtime": "claude-code", "locale": "ko"},
            )
        assert resp.status_code == 201, resp.text

        row = await _member_row(Session, agent_id)
        assert row.runtime_type == "claude-code"
    finally:
        # story #3999 — 위와 동일 청소(이번엔 recruit이 성공해 AgentPersona 행도 하나
        # 실제로 생겼다 — agent_id로 직접 찾는다, role_template_id는 config JSONB 안에
        # 있어(agent_persona.py의 config["role_template_id"] 마커 관례) 컬럼 조회가 아님).
        from app.models.agent_deployment import AgentPersona
        from app.models.role_template import RoleTemplate
        async with Session() as s:
            personas = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent_id)
            )).scalars().all()
            for p in personas:
                await s.delete(p)
            rt = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.slug == role_slug)
            )).scalar_one_or_none()
            if rt is not None:
                await s.delete(rt)
            await s.commit()
        await engine.dispose()


# ── 메시지 정책 ───────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_message_policy_mode_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.put(f"/api/v2/agents/{agent_id}/message-policy", json={"mode": "org_wide"})
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_message_policy_allowlist_add_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.post(
                f"/api/v2/agents/{agent_id}/message-policy/allowlist",
                json={"member_id": str(uuid.uuid4())},
            )
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_message_policy_allowlist_remove_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.delete(
                f"/api/v2/agents/{agent_id}/message-policy/allowlist/{uuid.uuid4()}",
            )
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


# ── 프로젝트 접근 ─────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_project_access_grant_rejected_for_system_publisher():
    """system-publisher가 이미 anchor project에 grant돼 있으니(셋업), 별도 프로젝트에
    새 grant를 시도하는 시나리오로 잰다."""
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with Session() as s:
            other_project = await _make_project(s, org_id, "Other Project")

        async with client as c:
            resp = await c.post(
                f"/api/v2/projects/{other_project.id}/access",
                json={"member_id": str(agent_id), "permission": "granted"},
            )
        assert resp.status_code == 409, resp.text

        from app.models.project_access import ProjectAccess
        from sqlalchemy import select
        async with Session() as s:
            rows = (await s.execute(
                select(ProjectAccess).where(
                    ProjectAccess.project_id == other_project.id, ProjectAccess.member_id == agent_id,
                )
            )).scalars().all()
        assert rows == [], "거부는 부작용 0 — grant 행이 생기면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_access_revoke_rejected_for_system_publisher():
    """team_members 뷰 3번째 UNION 브랜치 투영에 최소 1건 grant가 필요하다(events.py 주석) —
    회수는 특히 위험하므로 반드시 거부돼야 한다."""
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        from app.models.project_access import ProjectAccess
        from sqlalchemy import select
        async with Session() as s:
            record = (await s.execute(
                select(ProjectAccess).where(
                    ProjectAccess.project_id == project_id, ProjectAccess.member_id == agent_id,
                )
            )).scalars().one()
            record_id = record.id

        async with client as c:
            resp = await c.delete(f"/api/v2/projects/{project_id}/access/{record_id}")
        assert resp.status_code == 409, resp.text

        async with Session() as s:
            still_there = await s.get(ProjectAccess, record_id)
        assert still_there is not None, "거부는 부작용 0 — grant가 회수되면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_access_role_change_rejected_for_system_publisher():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.put(
                f"/api/v2/projects/{project_id}/access/{agent_id}/role",
                json={"role": "admin"},
            )
        assert resp.status_code == 409, resp.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_access_still_succeeds_for_normal_agent_regression():
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(False)
    try:
        async with Session() as s:
            other_project = await _make_project(s, org_id, "Other Project 2")

        async with client as c:
            resp = await c.post(
                f"/api/v2/projects/{other_project.id}/access",
                json={"member_id": str(agent_id), "permission": "granted"},
            )
        assert resp.status_code == 201, resp.text
    finally:
        await engine.dispose()


# ── webhook ───────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_webhook_upsert_rejected_for_system_publisher():
    """upsert_webhook_config는 DB role이 아니라 JWT app_metadata.role 클레임으로 admin/owner를
    가른다(자기 자신 외 타 멤버 설정 분기) — _setup_app_human의 기본 claims엔 role이 없어
    (기본값 'member') 이 엔드포인트만 role 클레임을 얹은 별도 auth override가 필요하다."""
    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        from app.dependencies.auth import AuthContext, get_current_user

        async with Session() as s:
            _admin_member_id, admin_user_id = await _make_org_owner(s, org_id)

        async def _admin_auth():
            return AuthContext(
                user_id=str(admin_user_id), email="admin@test",
                claims={"app_metadata": {"org_id": str(org_id), "role": "admin"}},
            )
        app.dependency_overrides[get_current_user] = _admin_auth

        async with client as c:
            resp = await c.put(
                "/api/v2/webhooks/config",
                json={"member_id": str(agent_id), "url": "https://example.com/hook", "project_id": str(project_id)},
            )
        assert resp.status_code == 409, resp.text

        from app.repositories.webhook_config import WebhookConfigRepository
        async with Session() as s:
            items = await WebhookConfigRepository(s, org_id).list(member_id=agent_id, project_id=project_id)
        assert items == [], "거부는 부작용 0 — webhook config가 생기면 안 됨"
    finally:
        await engine.dispose()


# ── AC3/AC4 — 자동 발행 무영향 + 두 번째 시스템 발행 미생성 ────────────────


@pytest.mark.anyio
async def test_runtime_change_rejection_does_not_spawn_second_system_publisher():
    """AC4 — 런타임 변경 거부 뒤 자동 발행 프로비저닝(_get_or_create_system_publisher)이
    두 번째 「시스템 발행」 멤버를 만들지 않는다(멤버 수 1 유지)."""
    from app.models.member import Member
    from sqlalchemy import select

    engine, Session, app, client, org_id, project_id, agent_id = await _setup(True)
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{agent_id}", json={"runtime_type": "claude-code"})
        assert resp.status_code == 409

        async with Session() as s:
            from app.routers.events import _get_or_create_system_publisher
            found = await _get_or_create_system_publisher(s, org_id)
            assert found.id == agent_id, "거부 뒤에도 기존 「시스템 발행」이 그대로 찾아져야(두 번째 생성 0)"

            count = (await s.execute(
                select(Member).where(
                    Member.org_id == org_id, Member.runtime_type == "system-publisher", Member.type == "agent",
                )
            )).scalars().all()
        assert len(count) == 1, f"시스템 발행 멤버 수는 1이어야(실제: {len(count)})"
    finally:
        await engine.dispose()
