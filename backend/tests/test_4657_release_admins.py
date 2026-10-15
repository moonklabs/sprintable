"""story #4657 — one rule for who may release a flood block: the notice's recipients and the release check read the same function
(`release_admin_rows`: an org owner/admin whose person has an active, undeleted human members row). A zero result is said out loud
(`no_release_admin` on the open breaker's state), never left as a silent permanent block.

Real Postgres (destructive schema harness, same as test_2630). Mutation: if the notice reads only org_members again, the
inactive-admin test goes RED; if the release check drops the active-member clause, the same test goes RED.
"""
import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_2630_circuit_breaker import (
    _fakeredis_client,
    _realdb_session,
    _seed_agent,
    _seed_conversation,
    _seed_messages,
    _seed_org_project,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_person(session, org_id, *, role: str, anchor_active: bool) -> tuple[uuid.UUID, uuid.UUID]:
    """the production shape (story #4657): a users row, the org member of `role`, and its human members anchor with
    members.id = org member id (ensure_human_member writes the same). `anchor_active` False = a deactivated person.
    Returns (org_members.id, user_id)."""
    from sqlalchemy import text

    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"{user_id.hex[:8]}@test.local", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role)
    session.add(om)
    await session.commit()
    await session.execute(text(
        "INSERT INTO members (id, org_id, type, user_id, name, is_active) VALUES (:id, :org, 'human', :uid, :name, :active) "
        "ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, is_active = EXCLUDED.is_active"
    ), {"id": om.id, "org": org_id, "uid": user_id, "name": role, "active": anchor_active})
    await session.commit()
    return om.id, user_id


async def _seed_admin_person(session, org_id, *, role: str, member_active: bool) -> tuple[uuid.UUID, uuid.UUID]:
    return await _seed_person(session, org_id, role=role, anchor_active=member_active)


async def _seed_plain_member(session, org_id) -> None:
    await _seed_person(session, org_id, role="member", anchor_active=True)


async def _open_block(s, org_id, project_id) -> uuid.UUID:
    """an episode that opens the breaker (block mode, the default) and returns the conversation id."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    agent_id = await _seed_agent(s, org_id, project_id)
    conv_id = await _seed_conversation(s, org_id, project_id)
    await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)  # over the threshold (15)
    with patch("app.services.redis_shared.get_client", return_value=_fakeredis_client()), \
         patch("app.services.notification_dispatch.dispatch_notification", AsyncMock()):
        await evaluate_unsupervised_chain_episode(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
    return conv_id


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_notice_and_release_read_one_rule_inactive_admin_gets_neither():
    """an active owner may release and gets the notice; an admin whose human member row is inactive gets neither; a plain
    member gets neither. The notice recipients and may_release_circuit_breaker agree on every person."""
    from app.services.chain_escalation import may_release_circuit_breaker, release_admin_rows

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            owner_om, owner_user = await _seed_admin_person(s, org_id, role="owner", member_active=True)
            inactive_om, inactive_user = await _seed_admin_person(s, org_id, role="admin", member_active=False)
            await _seed_plain_member(s, org_id)

            rows = await release_admin_rows(s, org_id)
            assert [om for om, _u in rows] == [owner_om]
            assert await may_release_circuit_breaker(s, user_id=owner_user, org_id=org_id) is True
            assert await may_release_circuit_breaker(s, user_id=inactive_user, org_id=org_id) is False

            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=_fakeredis_client()), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                from app.services.chain_escalation import evaluate_unsupervised_chain_episode
                agent_id = await _seed_agent(s, org_id, project_id)
                conv_id = await _seed_conversation(s, org_id, project_id)
                await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)
                await evaluate_unsupervised_chain_episode(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
            dn.assert_awaited_once()
            assert dn.await_args.kwargs["target_member_ids"] == [owner_om]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_zero_release_admins_is_said_out_loud_and_nobody_is_noticed():
    """every owner/admin is inactive: the block still opens, no notice goes out (no one could press it), and the open breaker's
    state says nobody can release — the band shows the reason instead of «ask an admin»."""
    from app.services.chain_escalation import open_circuit_breaker_state

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_admin_person(s, org_id, role="owner", member_active=False)
            await _seed_admin_person(s, org_id, role="admin", member_active=False)

            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=_fakeredis_client()), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                from app.services.chain_escalation import evaluate_unsupervised_chain_episode
                agent_id = await _seed_agent(s, org_id, project_id)
                conv_id = await _seed_conversation(s, org_id, project_id)
                await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)
                await evaluate_unsupervised_chain_episode(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
            dn.assert_not_awaited()

            state = await open_circuit_breaker_state(s, conversation_id=conv_id, org_id=org_id, caller_user_id=None)
            assert state is not None
            assert state["can_release"] is False
            assert state["no_release_admin"] is True
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_with_an_active_admin_the_state_does_not_claim_zero():
    from app.services.chain_escalation import open_circuit_breaker_state

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            _om, owner_user = await _seed_admin_person(s, org_id, role="owner", member_active=True)
            conv_id = await _open_block(s, org_id, project_id)

            state = await open_circuit_breaker_state(s, conversation_id=conv_id, org_id=org_id, caller_user_id=owner_user)
            assert state is not None
            assert state["can_release"] is True
            assert state["no_release_admin"] is False
    finally:
        await engine.dispose()
