"""story #4769 — removing a member from an organization closes the computers that person confirmed IN THAT organization.

Measured on dev (2026-10-24, c3d3698db): owner O removed the admin M (`DELETE /api/v2/org-members/{id}` → 200); M's account lived on (login 200), and M's old device
token still answered `relay/setup` 200 · `relay/startable` 200 · `relay/stream` 200 and the agent key the exchange had handed out still worked; O's «computers» list kept the
computer as handed over (the confirming person's name now null). The removal revoked sessions and closed the member, but touched no `desktop_setups`, and the 4767
authentication check (`users.is_active` / `deleted_at`) cannot see a seat that is gone while the account is alive.

Real PG, the real endpoints. Pins: the removal closes the person's open computers in that organization like a disconnect (token · keys · made agent · `revoked_reason`);
every device call then answers 401; the owner's list shows it disconnected and the connected count drops; the same person's computer in ANOTHER organization and an agent
a setup only attached are untouched; a removal that cannot close them fails whole; a row an OLDER removal left is refused at authentication; the exchange waits for an open
removal; migration 0464 closes the old rows completely and a second run changes nothing."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4752_account_delete_realdb import _close, _world
from tests.test_4767_account_delete_closes_devices_realdb import (
    _computer,
    _live,
    _relay,
    _remote_control_on,
    _row,
)

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


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.core.rate_limit import limiter
    monkeypatch.setattr(limiter, "enabled", False)


async def _seat(w, org_id: uuid.UUID, user_id: uuid.UUID) -> uuid.UUID:
    from sqlalchemy import text

    async with w.Session() as s:
        return (await s.execute(text("SELECT id FROM org_members WHERE org_id = :o AND user_id = :u"), {"o": org_id, "u": user_id})).scalar_one()


async def _join(w, org_id: uuid.UUID, user_id: uuid.UUID) -> None:
    from app.models.member import Member
    from app.models.project import OrgMember

    seat = uuid.uuid4()   # one id for the seat in org_members and the members anchor, as in the product
    async with w.Session() as s:
        s.add(OrgMember(id=seat, org_id=org_id, user_id=user_id, role="admin"))
        s.add(Member(id=seat, org_id=org_id, type="human", user_id=user_id, name="M elsewhere"))
        await s.commit()


async def _remove(w, owner_email: str, org_id: uuid.UUID, user_id: uuid.UUID):
    tokens = await w.tokens(owner_email)
    return await w.client.delete(f"/api/v2/org-members/{await _seat(w, org_id, user_id)}", headers={"Authorization": f"Bearer {tokens['access_token']}"})


async def test_01_the_removal_closes_the_persons_computer_and_only_that_organizations():
    engine, w = await _world()
    try:
        _, owner_email, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        # M's computer in this organization, an agent M's setup only attached, and M's computer in ANOTHER organization
        here = await _computer(w, org_id, m, name="Mac of M")
        _, _, other_org = await w.person(org=True, name="Other Owner")
        await _join(w, other_org, m)   # the same person, an active seat in ANOTHER organization
        there = await _computer(w, other_org, m, name="Mac of M elsewhere")
        await _remote_control_on(w, org_id)
        await _remote_control_on(w, other_org)
        assert (await _relay(w, org_id, here["token"]))["setup"] == 200 and (await _relay(w, other_org, there["token"]))["setup"] == 200

        r = await _remove(w, owner_email, org_id, m)
        assert r.status_code == 200, r.text

        assert await _relay(w, org_id, here["token"]) == {"setup": 401, "startable": 401, "sessions": 401}
        row = await _row(w, here["setup_id"])
        assert row["revoked"] is True and row["revoked_reason"] == "member_removed"
        assert await _live(w, "SELECT count(*) FROM desktop_device_tokens WHERE setup_id = :i AND revoked_at IS NULL", i=here["setup_id"]) == 0
        assert await _live(w, "SELECT count(*) FROM agent_api_keys WHERE desktop_setup_id = :i AND revoked_at IS NULL", i=here["setup_id"]) == 0
        assert await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=here["agent_id"]) == 0
        # the account lives on and its computer in the other organization is untouched
        assert (await w.login(f"story4752-m-{m.hex[:10]}@test.com")).status_code == 200
        assert (await _relay(w, other_org, there["token"]))["setup"] == 200
        assert (await _row(w, there["setup_id"]))["revoked"] is False
    finally:
        await _close(engine, w)


async def test_01b_an_attached_agent_stays_and_a_malformed_legacy_line_does_not_fail_the_removal():
    """codex 4769 r3: the live removal must (a) leave an agent the setup only ATTACHED running and (b) not fail whole over a malformed `member_id` in the setup's members line."""
    from app.models.member import Member

    engine, w = await _world()
    try:
        _, owner_email, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        comp = await _computer(w, org_id, m)
        attached = uuid.uuid4()
        async with w.Session() as s:
            s.add(Member(id=attached, org_id=org_id, type="agent", name="Attached Agent", is_active=True))
            await s.commit()
        await w.sql(
            "UPDATE desktop_setups SET members = members || CAST(:extra AS jsonb) WHERE id = :i",
            extra=f'[{{"kind": "agent", "member_id": "{attached}", "existing": true}}, {{"kind": "agent", "member_id": "not-a-uuid"}}]', i=comp["setup_id"],
        )
        assert (await _remove(w, owner_email, org_id, m)).status_code == 200
        assert (await _row(w, comp["setup_id"]))["revoked_reason"] == "member_removed"
        assert await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=comp["agent_id"]) == 0
        assert await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=attached) == 1
    finally:
        await _close(engine, w)


async def test_02_the_owners_view_no_longer_counts_it():
    from app.models.desktop_setup import DesktopSetup
    from app.services import remote_control
    from app.services.desktop_setup import setup_state

    engine, w = await _world()
    try:
        _, owner_email, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        comp = await _computer(w, org_id, m)
        async with w.Session() as s:
            assert await remote_control.connected_setups(s, org_id) == 1
        assert (await _remove(w, owner_email, org_id, m)).status_code == 200
        async with w.Session() as s:
            assert await remote_control.connected_setups(s, org_id) == 0
            assert setup_state(await s.get(DesktopSetup, comp["setup_id"])) == "disconnected"
    finally:
        await _close(engine, w)


async def test_03_a_removal_that_cannot_close_the_computers_fails_whole(monkeypatch):
    from app.services import desktop_setup

    async def _boom(*a, **k):
        raise RuntimeError("closing broke")

    monkeypatch.setattr(desktop_setup, "close_setups_of_removed_member", _boom)
    engine, w = await _world()
    try:
        _, owner_email, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        comp = await _computer(w, org_id, m)
        await _remote_control_on(w, org_id)
        with pytest.raises(RuntimeError):
            await _remove(w, owner_email, org_id, m)
        assert await _live(w, "SELECT count(*) FROM org_members WHERE org_id = :o AND user_id = :u AND deleted_at IS NULL", o=org_id, u=m) == 1   # the seat is still there
        assert await _live(w, "SELECT count(*) FROM members WHERE org_id = :o AND user_id = :u AND is_active", o=org_id, u=m) == 1
        assert (await _relay(w, org_id, comp["token"]))["setup"] == 200
    finally:
        await _close(engine, w)


async def test_04_a_row_an_older_removal_left_is_refused_at_authentication():
    """The removals before this story closed no computer: the seat row is soft-deleted, the device row is open. Authentication refuses it (and an open stream ends at
    its next check); a person with NO seat row at all keeps the 4618 contract."""
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_setup
    from app.services.desktop_relay import device_for_token, device_still_valid

    engine, w = await _world()
    try:
        _, _, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        stranger = uuid.uuid4()   # no users row, no seat: not judged
        comp = await _computer(w, org_id, m)
        unmapped = await _computer(w, org_id, stranger)
        await _remote_control_on(w, org_id)
        assert (await _relay(w, org_id, comp["token"]))["setup"] == 200 and (await _relay(w, org_id, unmapped["token"]))["setup"] == 200

        await w.sql("UPDATE org_members SET deleted_at = now() WHERE org_id = :o AND user_id = :u", o=org_id, u=m)   # an older removal: nothing else was touched

        assert await _relay(w, org_id, comp["token"]) == {"setup": 401, "startable": 401, "sessions": 401}
        assert (await _row(w, comp["setup_id"]))["revoked"] is False       # untouched: the refusal is the authentication's
        async with w.Session() as s:
            assert await device_still_valid(s, comp["setup_id"]) is False
            assert await device_for_token(s, comp["token"]) is None
            assert await desktop_setup.confirming_person_is_gone(s, await s.get(DesktopSetup, comp["setup_id"])) is True
        assert (await _relay(w, org_id, unmapped["token"]))["setup"] == 200
    finally:
        await _close(engine, w)


async def test_05_an_exchange_that_overlaps_an_open_removal_waits_for_it_and_finds_the_person_gone():
    """The removal takes the seat row FOR UPDATE first; the exchange takes the same row FOR SHARE (after the user row, before the member and setup rows). A removal held
    open by a second session makes the exchange wait, and when the removal commits the exchange refuses — it does not hand out a live key."""
    import asyncio
    import base64
    import hashlib
    import secrets

    from sqlalchemy import select, text

    from app.models.project import OrgMember

    engine, w = await _world()
    try:
        _, _, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        r = await w.client.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": "mac 4769"})
        body = r.json()
        setup_id = uuid.UUID(body["setup_id"])
        await w.sql(
            "UPDATE desktop_setups SET org_id = :o, confirmed_by = :u, confirmed_at = now(), project_id = (SELECT id FROM projects WHERE org_id = :o LIMIT 1) WHERE id = :i",
            o=org_id, u=m, i=setup_id,
        )
        seat = await _seat(w, org_id, m)
        async with w.Session() as removal:
            await removal.execute(select(OrgMember.id).where(OrgMember.id == seat).with_for_update())   # what `delete_org_member` does first
            exchange = asyncio.create_task(w.client.post("/api/v2/desktop/setup-codes/exchange", json={"code": body["code"], "verifier": verifier}))
            await asyncio.sleep(1.5)
            assert not exchange.done(), "the exchange must wait for the open removal"
            await removal.execute(text("UPDATE org_members SET deleted_at = now() WHERE id = :s"), {"s": seat})
            await removal.commit()
        resp = await asyncio.wait_for(exchange, 15)
        assert (resp.json().get("error") or {}).get("code") == "code_used", resp.text
        assert "device_token" not in resp.text
        assert await _live(w, "SELECT count(*) FROM desktop_device_tokens WHERE setup_id = :i", i=setup_id) == 0
    finally:
        await _close(engine, w)


def _migration_statements():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0464_close_computers_of_removed_members.py"
    spec = importlib.util.spec_from_file_location("m0464", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.STATEMENTS


async def test_06_the_migration_closes_what_older_removals_left_completely_and_twice_changes_nothing():
    from sqlalchemy import text

    from app.models.member import Member

    engine, w = await _world()
    try:
        _, _, org_id = await w.person(org=True, name="Owner")
        removed = await w.add_member(org_id, role="admin", name="Removed")
        alive = await w.add_member(org_id, role="admin", name="Alive")
        legacy = await _computer(w, org_id, removed, name="Legacy")
        mine = await _computer(w, org_id, alive, name="Alive Mac")
        _, _, other_org = await w.person(org=True, name="Other Owner")
        elsewhere = await _computer(w, other_org, removed, name="Removed person's Mac elsewhere")   # the same person, another organization: no removed seat there
        attached = uuid.uuid4()
        async with w.Session() as s:
            s.add(Member(id=attached, org_id=org_id, type="agent", name="Attached Agent", is_active=True))
            await s.commit()
        await w.sql(
            "UPDATE desktop_setups SET members = members || CAST(:line AS jsonb) WHERE id = :i",
            line=f'[{{"kind": "agent", "member_id": "{attached}", "existing": true}}]', i=legacy["setup_id"],
        )
        await w.sql("UPDATE org_members SET deleted_at = now() WHERE org_id = :o AND user_id = :u", o=org_id, u=removed)   # an older removal: the closer never ran

        async def _run():
            async with w.Session() as s:
                for statement in _migration_statements():
                    await s.execute(text(statement))
                await s.commit()

        async def _state():
            return {
                "legacy": await _row(w, legacy["setup_id"]),
                "tokens": await _live(w, "SELECT count(*) FROM desktop_device_tokens WHERE setup_id = :i AND revoked_at IS NULL", i=legacy["setup_id"]),
                "keys": await _live(w, "SELECT count(*) FROM agent_api_keys WHERE desktop_setup_id = :i AND revoked_at IS NULL", i=legacy["setup_id"]),
                "agent": await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=legacy["agent_id"]),
                "attached": await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=attached),
                "mine": await _row(w, mine["setup_id"]),
                "mine_agent": await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=mine["agent_id"]),
                "elsewhere": await _row(w, elsewhere["setup_id"]),
                "elsewhere_tokens": await _live(w, "SELECT count(*) FROM desktop_device_tokens WHERE setup_id = :i AND revoked_at IS NULL", i=elsewhere["setup_id"]),
            }

        await _run()
        first = await _state()
        assert first["legacy"] == {"revoked": True, "revoked_reason": "member_removed", "revoked_by": removed}
        assert (first["tokens"], first["keys"], first["agent"]) == (0, 0, 0)
        assert first["attached"] == 1, "an agent the setup only attached keeps running elsewhere"
        assert first["mine"]["revoked"] is False and first["mine_agent"] == 1
        assert first["elsewhere"]["revoked"] is False and first["elsewhere_tokens"] == 1, "the same person's computer in another organization is untouched"
        await _run()
        assert await _state() == first, "a second run changes nothing"
    finally:
        await _close(engine, w)


async def test_07_a_removal_and_a_deletion_of_the_same_person_do_not_deadlock():
    """codex 4769 r1: the account deletion used to reach the seat rows only after the setup rows, the removal takes the seat first — a deadlock pair when they overlap. Both now go
    user → seat → agent member rows → setup rows (the deletion locks the person's seats before its closer). A smoke test: several rounds of both at once; each must end with
    a normal answer (never a 500 from a deadlock abort) and no live key for the person. (A timing test: it does not claim a deterministic RED.)"""
    import asyncio

    engine, w = await _world()
    try:
        for _ in range(5):
            _, owner_email, org_id = await w.person(org=True, name="Owner")
            m = await w.add_member(org_id, role="admin", name="M")
            comp = await _computer(w, org_id, m)
            owner = await w.tokens(owner_email)
            m_tokens = await w.tokens(f"story4752-m-{m.hex[:10]}@test.com")
            seat = await _seat(w, org_id, m)
            removal = w.client.delete(f"/api/v2/org-members/{seat}", headers={"Authorization": f"Bearer {owner['access_token']}"})
            deletion = w.delete(m_tokens)
            r1, r2 = await asyncio.gather(removal, deletion, return_exceptions=True)
            for r in (r1, r2):
                assert not isinstance(r, Exception), r
                assert r.status_code < 500, r.text      # a deadlock abort would be a 500
            assert await _live(w, "SELECT count(*) FROM agent_api_keys WHERE desktop_setup_id = :i AND revoked_at IS NULL", i=comp["setup_id"]) == 0
            assert (await _row(w, comp["setup_id"]))["revoked"] is True
    finally:
        await _close(engine, w)
