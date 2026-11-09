"""story 4832 — the activation checklist of a local (embedded) install counts only the steps that are the person's own.

A local install has no sign-up: the app makes the account, its verified address and its organization on the first start, so three of the five steps are done before
the person has done anything. `get_activation_state` now names the steps its count is over (`applicable_steps`): hosted = all five (exactly as before), embedded =
`agent_connected` and `first_roundtrip`. `steps` keeps all five keys.

Real Postgres (the organization, the owner and their membership are read by the real queries); the two «did an agent connect / did a round trip happen» reads are
replaced so the count can be walked through its states without seeding conversations.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.user import User
from app.services import onboarding_activation as svc

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = "ee000000-0000-0000-0000-0000000004e1"
EMAIL = "story4832-owner@t.test"
FIVE = ["signed_up", "email_verified", "org_created", "agent_connected", "first_roundtrip"]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _wipe(s) -> None:
    for sql in [
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE email='{EMAIL}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s) -> User:
    user_id = str(uuid.uuid4())
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','story4832-o','free')"))
    await s.execute(text(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{user_id}','{EMAIL}','x','U',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{uuid.uuid4()}','{ORG}','{user_id}','owner')"))
    await s.commit()
    return (await s.execute(select(User).where(User.id == uuid.UUID(user_id)))).scalar_one()


def _mode(monkeypatch, *, embedded: bool, agent: bool = False, roundtrip: bool = False) -> None:
    monkeypatch.setattr(svc, "settings", SimpleNamespace(is_embedded=embedded))
    monkeypatch.setattr(svc, "is_org_agent_connected", AsyncMock(return_value=agent))
    monkeypatch.setattr(svc, "is_org_first_roundtrip_done", AsyncMock(return_value=roundtrip))


async def _state(monkeypatch, **kw) -> dict:
    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with Session() as s:
            await _wipe(s)
            try:
                user = await _seed(s)
                _mode(monkeypatch, **kw)
                return await svc.get_activation_state(s, user, requested_org_id=uuid.UUID(ORG))
            finally:
                await _wipe(s)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_embedded_first_run_counts_the_two_steps_that_are_the_persons_own(monkeypatch):
    st = await _state(monkeypatch, embedded=True)
    assert st["applicable_steps"] == ["agent_connected", "first_roundtrip"]
    assert (st["completed"], st["total"], st["all_complete"]) == (0, 2, False)
    # the five keys stay (the web's type does not change), and the three made by the app are true there — they are just not counted
    assert list(st["steps"]) == FIVE
    assert [st["steps"][k] for k in FIVE] == [True, True, True, False, False]


@pytest.mark.anyio
async def test_hosted_counts_all_five_exactly_as_before(monkeypatch):
    st = await _state(monkeypatch, embedded=False)
    assert st["applicable_steps"] == FIVE
    assert (st["completed"], st["total"], st["all_complete"]) == (3, 5, False)  # the same data as the embedded first run: sign-up, address and organization done
    assert list(st["steps"]) == FIVE


@pytest.mark.anyio
async def test_embedded_walks_0_1_2_of_2_and_completes_only_when_both_are_done(monkeypatch):
    one = await _state(monkeypatch, embedded=True, agent=True)
    assert (one["completed"], one["total"], one["all_complete"]) == (1, 2, False)
    only_roundtrip = await _state(monkeypatch, embedded=True, roundtrip=True)
    assert (only_roundtrip["completed"], only_roundtrip["total"], only_roundtrip["all_complete"]) == (1, 2, False)
    both = await _state(monkeypatch, embedded=True, agent=True, roundtrip=True)
    assert (both["completed"], both["total"], both["all_complete"]) == (2, 2, True)


@pytest.mark.anyio
async def test_hosted_completes_only_at_five_of_five(monkeypatch):
    both = await _state(monkeypatch, embedded=False, agent=True, roundtrip=True)
    assert (both["completed"], both["total"], both["all_complete"]) == (5, 5, True)
    only_agent = await _state(monkeypatch, embedded=False, agent=True)
    assert (only_agent["completed"], only_agent["total"], only_agent["all_complete"]) == (4, 5, False)


def test_the_local_steps_are_the_two_that_are_the_persons_own():
    assert svc.LOCAL_APPLICABLE_STEPS == ("agent_connected", "first_roundtrip")
