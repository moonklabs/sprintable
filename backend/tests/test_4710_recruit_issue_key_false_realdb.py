"""story 4710 (Kadir · PO 06:11Z) — a hire that issues no key: `issue_key=False`.

The in-app hire (web «이 컴퓨터에서 시작») is followed by the desktop setup's MOVE of that agent, and that exchange makes the agent's key.
A key the hire handed to the browser would be one nobody uses — alive in dev tools / extensions / HAR files — and nothing revokes it if the
person closes the tab before the exchange. So the hire is made without one:

  1. `issue_key=False` on a key-less agent (create with defer_key_issuance) → no key row at all, the answer carries no plaintext.
  2. an agent that ALREADY has an active key keeps it (no rotate, no new plaintext) but the key is narrowed to the role's scope (G3).
  3. the default (`issue_key=True`) is the old behaviour — one key, role scope, plaintext once.
  4. end to end through the route function: `api_key` is null in the body and the mcp bundle holds no key.
  5. the move exchange afterwards makes exactly one key (the agent's only one) — covered by test_4576 / the setup tests; here: after a key-less
     hire, a later `issue_key=True` recruit creates the one key (nothing was left half-done).

Each test fails if the flag is ignored (the first three) or the narrowing is dropped (the second)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    from sqlalchemy import text as _text
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.role_template import RoleTemplate

    await session.execute(_text("SET session_replication_role = replica"))
    org = Organization(id=uuid.uuid4(), name="Acme", slug=f"acme-{uuid.uuid4().hex[:8]}")
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Main", slug="main")
    role = RoleTemplate(
        id=uuid.uuid4(), slug=f"backend-{uuid.uuid4().hex[:6]}", name="Backend Engineer", category="engineering",
        role_behaviors="백엔드 자율 운영 지침.",
        default_tool_groups=["stories", "tasks", "chat", "docs"],
        is_published=True,
    )
    session.add_all([org, project, role])
    await session.flush()
    return org, project, role


async def _keys(session, member_id):
    from sqlalchemy import select
    from app.models.api_key import ApiKey

    return list((await session.execute(select(ApiKey).where(ApiKey.team_member_id == member_id))).scalars().all())


async def _new_agent(session, org, project, *, defer: bool):
    from app.services.org_agent import create_org_level_agent

    member, key = await create_org_level_agent(
        session, org_id=org.id, created_by=None, name=f"Agent {uuid.uuid4().hex[:4]}",
        project_ids=[project.id], defer_key_issuance=defer,
    )
    await session.commit()
    return member, key


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_keyless_hire_makes_no_key_and_answers_no_plaintext():
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed(s)
            member, create_key = await _new_agent(s, org, project, defer=True)
            assert create_key is None and await _keys(s, member.id) == []

            result = await recruit_agent(
                s, agent_member=member, org_id=org.id, role_template=role, runtime="claude-code", actor_id=uuid.uuid4(), issue_key=False,
            )
            await s.commit()

            assert result["api_key_plaintext"] is None, "no plaintext leaves the hire"
            assert await _keys(s, member.id) == [], "no key row was made (not even a revoked one)"
            assert result["persona"] is not None and set(result["tool_allowlist"]) == set(role.default_tool_groups)  # the hire itself still happened
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_keyless_hire_keeps_an_existing_key_and_narrows_it_without_a_new_plaintext():
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed(s)
            member, create_key = await _new_agent(s, org, project, defer=False)  # an agent that already has its default (wide) key
            assert create_key
            before = await _keys(s, member.id)
            assert len(before) == 1 and before[0].revoked_at is None
            wide_scope = set(before[0].scope)
            assert wide_scope > set(role.default_tool_groups), "the starting key is wider than the role's scope"

            result = await recruit_agent(
                s, agent_member=member, org_id=org.id, role_template=role, runtime="claude-code", actor_id=uuid.uuid4(), issue_key=False,
            )
            await s.commit()

            assert result["api_key_plaintext"] is None
            after = await _keys(s, member.id)
            assert [k.id for k in after] == [before[0].id], "the same key — nothing rotated, nothing added"
            assert after[0].revoked_at is None
            assert set(after[0].scope) == set(role.default_tool_groups), "narrowed to the role's scope in place (G3)"
            # what a session already running on this key sees from its next request (auth reads the key row's scope per request, and the key is
            # not revoked): inside the role's groups still passes, a group outside it is now refused — the key itself keeps working (a rotate
            # would have ended it with a 401 instead)
            from app.services.mcp_toolset import path_allowed_for_scope

            assert path_allowed_for_scope("/api/v2/webhooks/x", sorted(wide_scope)) is True
            assert path_allowed_for_scope("/api/v2/conversations", after[0].scope) is True
            assert path_allowed_for_scope("/api/v2/webhooks/x", after[0].scope) is False
    finally:
        await engine.dispose()


async def _set_scope(session, key_id, scope):
    from sqlalchemy import update

    from app.models.api_key import ApiKey

    await session.execute(update(ApiKey).where(ApiKey.id == key_id).values(scope=scope))
    await session.commit()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_a_key_already_narrower_than_the_role_is_not_widened_and_every_active_key_is_narrowed_on_its_own():
    """Kadir/Didi 5127 review: `SET scope = role` would turn a `["docs"]` key into the role's four groups with the same plaintext."""
    from app.repositories.api_key import ApiKeyRepository
    from app.services.mcp_toolset import ALL_GROUPS
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed(s)
            member, create_key = await _new_agent(s, org, project, defer=False)
            assert create_key
            [wide] = await _keys(s, member.id)
            await _set_scope(s, wide.id, ["docs"])  # narrower than the role (stories, tasks, chat, docs)
            second, _plain = await ApiKeyRepository(s).create(team_member_id=member.id, scope=list(ALL_GROUPS), expires_at=None)
            await s.commit()

            await recruit_agent(
                s, agent_member=member, org_id=org.id, role_template=role, runtime="claude-code", actor_id=uuid.uuid4(), issue_key=False,
            )
            await s.commit()

            by_id = {k.id: k for k in await _keys(s, member.id)}
            assert set(by_id) == {wide.id, second.id}, "no key made, none revoked"
            assert by_id[wide.id].revoked_at is None and by_id[second.id].revoked_at is None
            assert by_id[wide.id].scope == ["docs"], "the narrower key stays ['docs'] — it is NOT widened to the role's scope"
            assert set(by_id[second.id].scope) == set(role.default_tool_groups), "the wide key is narrowed to the role's scope"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_a_key_with_nothing_in_common_with_the_role_is_revoked_the_others_are_narrowed_and_no_plaintext_moves():
    """The narrowest scope there is — no permission — cannot be a list (an empty list means «every group»), so that key is revoked (PO 10:3xZ)."""
    from sqlalchemy import select

    from app.models.agent_deployment import AgentAuditLog, AgentPersona
    from app.repositories.api_key import ApiKeyRepository
    from app.services.mcp_toolset import ALL_GROUPS
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed(s)
            member, create_key = await _new_agent(s, org, project, defer=False)
            assert create_key
            [disjoint] = await _keys(s, member.id)
            await _set_scope(s, disjoint.id, ["webhooks"])  # the role (stories, tasks, chat, docs) shares no group with it
            other, _plain = await ApiKeyRepository(s).create(team_member_id=member.id, scope=list(ALL_GROUPS), expires_at=None)
            await s.commit()

            result = await recruit_agent(
                s, agent_member=member, org_id=org.id, role_template=role, runtime="claude-code", actor_id=uuid.uuid4(), issue_key=False,
            )
            await s.commit()

            assert result["api_key_plaintext"] is None
            by_id = {k.id: k for k in await _keys(s, member.id)}
            assert set(by_id) == {disjoint.id, other.id}, "no key was made"
            assert by_id[disjoint.id].revoked_at is not None, "the key with nothing in common is revoked"
            assert by_id[other.id].revoked_at is None and set(by_id[other.id].scope) == set(role.default_tool_groups), "the other key is narrowed"
            assert (await s.execute(select(AgentPersona).where(AgentPersona.agent_id == member.id))).scalars().first() is not None, "the hire itself happened"
            rows = (await s.execute(select(AgentAuditLog).where(AgentAuditLog.agent_id == member.id))).scalars().all()
            assert [r.event_type for r in rows] == ["agent_key_revoked_no_common_scope"]
            assert rows[0].payload["api_key_id"] == str(disjoint.id) and rows[0].payload["key_scope"] == ["webhooks"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_default_still_issues_the_one_key_as_before():
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed(s)
            member, _ = await _new_agent(s, org, project, defer=True)

            result = await recruit_agent(
                s, agent_member=member, org_id=org.id, role_template=role, runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

            assert result["api_key_plaintext"]
            rows = await _keys(s, member.id)
            assert len(rows) == 1 and rows[0].revoked_at is None and set(rows[0].scope) == set(role.default_tool_groups)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_route_body_has_null_key_and_the_bundle_holds_no_key_then_a_later_default_hire_makes_the_one_key(monkeypatch):
    from unittest.mock import MagicMock

    import app.routers.agents as agents_mod
    from app.schemas.recruit import RecruitRequest

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed(s)
            member, _ = await _new_agent(s, org, project, defer=True)
            auth = MagicMock()
            auth.user_id = str(uuid.uuid4())

            async def _owner_ok(agent_id, session, org_id, user_id):  # the owner gate is not what this test is about (test_e_recruit_s16 covers it)
                return member

            async def _resolved(auth_, org_id, session):
                class _M:
                    id = uuid.uuid4()
                return _M()

            monkeypatch.setattr(agents_mod, "assert_agent_owner_mutable", _owner_ok)
            monkeypatch.setattr(agents_mod, "resolve_member_db_verified", _resolved)

            body = RecruitRequest(role_template_slug=role.slug, runtime="claude-code", issue_key=False)
            out = await agents_mod._recruit_agent_endpoint(member.id, body, None, session=s, auth=auth, org_id=org.id)
            assert out["api_key"] is None
            assert "AGENT_API_KEY" not in str(out["mcp_config"]), "the bundle holds no key"
            assert await _keys(s, member.id) == []

            body2 = RecruitRequest(role_template_slug=role.slug, runtime="claude-code")  # default: issue
            out2 = await agents_mod._recruit_agent_endpoint(member.id, body2, None, session=s, auth=auth, org_id=org.id)
            assert out2["api_key"]
            rows = await _keys(s, member.id)
            assert len(rows) == 1 and rows[0].revoked_at is None
    finally:
        await engine.dispose()
