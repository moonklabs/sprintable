"""story #2623(P3 후속·전달계약) — notification_preferences admin override.

webhooks.py story 933248fa 패턴 그대로(새 설계 없음): GET/PUT 둘 다 `member_id` override
(제1 경고 — 선례가 PUT만 넣고 GET을 빠뜨려 재오픈된 이력, 이 스토리는 처음부터 동시에 연다)·
target != caller면 admin/owner 필수+무권한 403 명시·target은 caller의 검증된 org_id로
서버측 재해소(`_resolve_target_member_id`, webhooks.py 그대로 재사용)·agent mute 금지
룰은 대상(target) 기준."""
from __future__ import annotations

import os
import uuid

import pytest

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2623", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org, project


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name=name))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted"))
    await session.commit()
    return member_id


async def _seed_human(session, org_id, project_id, *, role="member"):
    """team_members는 실 migrated DB에선 VIEW라 직접 INSERT 불가 — anchor 경로로 시드."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role)
    session.add(om)
    await session.commit()
    session.add(Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="Human"))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=om.id,
        permission="granted", role=role,
    ))
    await session.commit()
    return user_id, om.id


def _agent_auth(agent_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
    )


def _human_auth(user_id, org_id, *, role="member"):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="human@test.com",
        claims={"app_metadata": {"org_id": str(org_id), "role": role}},
    )


async def _call_get(session, member_id, org_id, auth):
    from app.routers.notification_preferences import get_preferences
    return await get_preferences(member_id=member_id, db=session, auth=auth, org_id=org_id)


async def _call_put(session, member_id, org_id, auth, preferences):
    from app.routers.notification_preferences import PreferenceItem, UpsertPreferencesRequest, upsert_preferences
    return await upsert_preferences(
        body=UpsertPreferencesRequest(
            member_id=member_id,
            preferences=[PreferenceItem(**p) for p in preferences],
        ),
        db=session, auth=auth, org_id=org_id,
    )


# ── 무회귀 — member_id 미지정 시 self-service 기존 동작 그대로 ─────────────────
async def test_self_service_put_and_get_unaffected_no_member_id():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)

        async with Session() as s:
            put_result = await _call_put(
                s, None, org.id, _agent_auth(agent_id, org.id),
                [{"scope_type": "global", "channel": "sse", "level": "mentions"}],
            )
            assert put_result[0]["member_id"] == str(agent_id)

            get_result = await _call_get(s, None, org.id, _agent_auth(agent_id, org.id))
            assert len(get_result) == 1
            assert get_result[0]["level"] == "mentions"
    finally:
        await engine.dispose()


# ── 제1 경고 — write+read parity(admin PUT 즉시 admin GET에 보임) ────────────
async def test_admin_put_then_get_parity_no_reopen_regression():
    """webhooks.py story 933248fa의 재오픈 사고(PUT만 열고 GET 빠뜨림)가 여기서도
    재발하지 않는지 — 같은 member_id로 PUT 직후 GET하면 즉시 보여야 한다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            admin_user_id, admin_member_id = await _seed_human(s, org.id, project.id, role="admin")

        async with Session() as s:
            await _call_put(
                s, agent_id, org.id, _human_auth(admin_user_id, org.id, role="admin"),
                [{"scope_type": "global", "channel": "sse", "level": "mute"}],
            )
            get_result = await _call_get(
                s, agent_id, org.id, _human_auth(admin_user_id, org.id, role="admin"),
            )
            assert len(get_result) == 1
            assert get_result[0]["member_id"] == str(agent_id)
            assert get_result[0]["level"] == "mute"
    finally:
        await engine.dispose()


# ── 인가 — target != caller면 admin/owner 필수·무권한 403 ────────────────────
async def test_get_other_member_without_admin_role_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            plain_user_id, _ = await _seed_human(s, org.id, project.id, role="member")

        async with Session() as s:
            with pytest.raises(Exception) as ei:
                await _call_get(s, agent_id, org.id, _human_auth(plain_user_id, org.id, role="member"))
            assert getattr(ei.value, "status_code", None) == 403
    finally:
        await engine.dispose()


async def test_put_other_member_without_admin_role_403_and_nothing_written():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            plain_user_id, _ = await _seed_human(s, org.id, project.id, role="member")

        async with Session() as s:
            with pytest.raises(Exception) as ei:
                await _call_put(
                    s, agent_id, org.id, _human_auth(plain_user_id, org.id, role="member"),
                    [{"scope_type": "global", "channel": "sse", "level": "mute"}],
                )
            assert getattr(ei.value, "status_code", None) == 403

        async with Session() as s:
            from sqlalchemy import func, select
            from app.models.notification_preference import NotificationPreference
            count = (await s.execute(
                select(func.count()).select_from(NotificationPreference).where(
                    NotificationPreference.member_id == agent_id,
                )
            )).scalar_one()
            assert count == 0  # 침묵 caller-scope 강제 저장 안 됨(403이 실제로 막았다)
    finally:
        await engine.dispose()


async def test_owner_role_also_allowed():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            owner_user_id, _ = await _seed_human(s, org.id, project.id, role="owner")

        async with Session() as s:
            result = await _call_put(
                s, agent_id, org.id, _human_auth(owner_user_id, org.id, role="owner"),
                [{"scope_type": "global", "channel": "sse", "level": "mentions"}],
            )
            assert result[0]["member_id"] == str(agent_id)
    finally:
        await engine.dispose()


async def test_get_self_via_explicit_member_id_no_admin_check_needed():
    """member_id가 지정됐지만 resolve 결과가 caller 자신이면 admin 체크 자체가 안 걸린다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)

        async with Session() as s:
            result = await _call_get(s, agent_id, org.id, _agent_auth(agent_id, org.id))
            assert result == []  # 403 없이 정상 통과(그냥 자기 것 0건)
    finally:
        await engine.dispose()


# ── 대상 스코프 — 타 org member_id는 404(캐너 재해소가 이미 막음, 존재 비노출) ──
async def test_target_member_id_cross_org_404():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org1, project1 = await _seed_org_project(s)
            org2, project2 = await _seed_org_project(s)
            admin_user_id, _ = await _seed_human(s, org1.id, project1.id, role="admin")
            other_org_agent_id = await _seed_agent(s, org2.id, project2.id)

        async with Session() as s:
            with pytest.raises(Exception) as ei:
                await _call_get(
                    s, other_org_agent_id, org1.id, _human_auth(admin_user_id, org1.id, role="admin"),
                )
            assert getattr(ei.value, "status_code", None) == 404
    finally:
        await engine.dispose()


# ── agent mute 금지 룰 — 대상(target) 기준 ────────────────────────────────────
async def test_admin_override_agent_target_mute_conversation_still_blocked():
    """조건④ — caller(admin, 휴먼)가 아니라 target(agent)의 type으로 mute 금지 룰이 적용된다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            admin_user_id, _ = await _seed_human(s, org.id, project.id, role="admin")

        async with Session() as s:
            with pytest.raises(Exception) as ei:
                await _call_put(
                    s, agent_id, org.id, _human_auth(admin_user_id, org.id, role="admin"),
                    [{"scope_type": "conversation", "scope_id": str(uuid.uuid4()), "channel": "sse", "level": "mute"}],
                )
            assert getattr(ei.value, "status_code", None) == 400
    finally:
        await engine.dispose()


async def test_admin_override_human_target_mute_conversation_allowed():
    """대조군 — target이 human이면 같은 mute 설정이 막히지 않는다(agent 전용 룰)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            admin_user_id, _ = await _seed_human(s, org.id, project.id, role="admin")
            target_user_id, target_member_id = await _seed_human(s, org.id, project.id, role="member")

        async with Session() as s:
            result = await _call_put(
                s, target_member_id, org.id, _human_auth(admin_user_id, org.id, role="admin"),
                [{"scope_type": "conversation", "scope_id": str(uuid.uuid4()), "channel": "sse", "level": "mute"}],
            )
            assert result[0]["level"] == "mute"
    finally:
        await engine.dispose()
