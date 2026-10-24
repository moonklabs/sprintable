"""story #4767 — deleting an account closes the computers the person confirmed, in an organization that stays.

Measured on dev (2026-10-24, fb5edcc6f): an admin M confirmed a Mac in an organization with another owner, then deleted the account.
M could no longer sign in, but M's device token still answered `relay/setup` 200, opened `relay/stream` 200 and wrote `relay/startable` 200 —
and the owner's «computers» list kept the computer (confirmed_by M, no name) as connected. Nothing in the account deletion touched
`desktop_setups` / `desktop_device_tokens`, and `device_for_token` never looked at who confirmed the device. (An organization that closes
with the account takes its computers with it by cascade — that case was already clean and stays so.)

Real PG, the real endpoints. Pins: the deletion closes the person's open computers like a disconnect (device token, keys, `revoked_reason`);
every device call then answers 401; the owner's list shows it disconnected and the connected count drops; a device row an OLDER deletion left
(no closer ran) is refused at authentication; other people's computers are untouched."""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

import pytest

from tests.test_4752_account_delete_realdb import _close, _world

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


async def _computer(w, org_id: uuid.UUID, confirmed_by: uuid.UUID, *, name: str = "Mac of someone") -> dict:
    """A handed-over computer the person confirmed: the setup row, its live device token, one agent made by the setup with one key."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey
    from app.models.desktop_relay import DesktopDeviceToken
    from app.models.desktop_setup import DesktopSetup
    from app.models.member import Member
    from app.models.project import Project
    from app.services.desktop_relay import TOKEN_PREFIX, _hash

    now = datetime.now(UTC)
    setup_id, agent_id, token = uuid.uuid4(), uuid.uuid4(), TOKEN_PREFIX + uuid.uuid4().hex
    async with w.Session() as s:
        project_id = (await s.execute(select(Project.id).where(Project.org_id == org_id))).scalars().first()
        s.add(Member(id=agent_id, org_id=org_id, type="agent", name="Setup Agent", is_active=True))
        await s.commit()
        s.add(DesktopSetup(
            id=setup_id, code_hash=uuid.uuid4().hex, code_challenge="c", device_name=name, expires_at=now, org_id=org_id, project_id=project_id,
            confirmed_by=confirmed_by, confirmed_at=now, exchanged_at=now, keys_issued=1,
            members=[{"stage": "Writer", "member_id": str(agent_id), "kind": "agent", "runtime": "claude"}],
        ))
        await s.commit()
        s.add(DesktopDeviceToken(id=uuid.uuid4(), setup_id=setup_id, token_hash=_hash(token)))
        s.add(ApiKey(
            id=uuid.uuid4(), team_member_id=agent_id, member_id=agent_id, key_prefix="sk_test", key_hash=uuid.uuid4().hex,
            desktop_setup_id=setup_id,
        ))
        await s.commit()
    return {"setup_id": setup_id, "agent_id": agent_id, "token": token}


async def _remote_control_on(w, org_id: uuid.UUID) -> None:
    await w.sql("UPDATE organizations SET remote_control_enabled_at = now() WHERE id = :o", o=org_id)


async def _relay(w, org_id: uuid.UUID, token: str) -> dict:
    h = {"X-Desktop-Device-Token": token, "X-Desktop-Org-Id": str(org_id)}
    return {
        "setup": (await w.client.get("/api/v2/desktop/relay/setup", headers=h)).status_code,
        "startable": (await w.client.put("/api/v2/desktop/relay/startable", headers=h, json={"startable": [], "seq": 1})).status_code,
        "sessions": (await w.client.put("/api/v2/desktop/relay/sessions", headers=h, json={"seq": 1, "sessions": []})).status_code,
    }


async def _row(w, setup_id: uuid.UUID) -> dict:
    from sqlalchemy import text

    async with w.Session() as s:
        r = (await s.execute(text(
            "SELECT revoked_at IS NOT NULL AS revoked, revoked_reason, revoked_by FROM desktop_setups WHERE id = :i"), {"i": setup_id})).one()
    return dict(r._mapping)


async def _live(w, sql: str, **kw) -> int:
    from sqlalchemy import text

    async with w.Session() as s:
        return int((await s.execute(text(sql), kw)).scalar_one())


async def test_01_the_deletion_closes_the_persons_computer_in_an_organization_that_stays():
    engine, w = await _world()
    try:
        # the organization has a second owner (`spare_owner`), so the deleted person does not close it
        uid, email, org_id = await w.person(org=True, name="Admin M")
        comp = await _computer(w, org_id, uid, name="Mac of M")
        await _remote_control_on(w, org_id)

        before = await _relay(w, org_id, comp["token"])
        assert before["setup"] == 200 and before["startable"] == 200 and before["sessions"] in (200, 422), before  # token accepted (422 = past auth, a body this test does not build)

        t = await w.tokens(email)
        assert (await w.delete(t)).status_code == 200

        # every device call is refused now (before: 200 / 200 / 422 — the measured defect)
        assert await _relay(w, org_id, comp["token"]) == {"setup": 401, "startable": 401, "sessions": 401}
        row = await _row(w, comp["setup_id"])
        assert row["revoked"] is True and row["revoked_reason"] == "account_deleted" and row["revoked_by"] == uid
        # the same things a disconnect does: the device token and the keys the setup handed out are gone, the agent it made stops
        assert await _live(w, "SELECT count(*) FROM desktop_device_tokens WHERE setup_id = :i AND revoked_at IS NULL", i=comp["setup_id"]) == 0
        assert await _live(w, "SELECT count(*) FROM agent_api_keys WHERE desktop_setup_id = :i AND revoked_at IS NULL", i=comp["setup_id"]) == 0
        assert await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=comp["agent_id"]) == 0
    finally:
        await _close(engine, w)


async def test_02_the_owners_list_and_the_connected_count_no_longer_carry_it():
    from app.services import remote_control

    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Admin M")
        comp = await _computer(w, org_id, uid, name="Mac of M")
        async with w.Session() as s:
            assert await remote_control.connected_setups(s, org_id) == 1
        await w.delete(await w.tokens(email))
        async with w.Session() as s:
            assert await remote_control.connected_setups(s, org_id) == 0, "a deleted person's computer is not a connected one"
        # the list still names it (history) but as disconnected, never as handed over under a person who no longer exists
        from app.models.desktop_setup import DesktopSetup
        from app.services.desktop_setup import setup_state

        async with w.Session() as s:
            assert setup_state(await s.get(DesktopSetup, comp["setup_id"])) == "disconnected"
    finally:
        await _close(engine, w)


async def test_03_other_peoples_computers_are_untouched():
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Admin M")
        other = await w.add_member(org_id, role="admin", name="Other Admin")
        mine = await _computer(w, org_id, uid, name="Mac of M")
        theirs = await _computer(w, org_id, other, name="Mac of Other")
        await _remote_control_on(w, org_id)

        await w.delete(await w.tokens(email))

        assert (await _relay(w, org_id, mine["token"]))["setup"] == 401
        assert (await _relay(w, org_id, theirs["token"]))["setup"] == 200
        assert (await _row(w, theirs["setup_id"]))["revoked"] is False
        assert await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=theirs["agent_id"]) == 1
    finally:
        await _close(engine, w)


async def test_04_a_row_an_older_deletion_left_is_refused_at_authentication():
    """AC3/AC4: the deletions before this story closed no computer. Their rows are still open — the device is refused because the person
    who confirmed it is gone (no cleanup job needed to make that true; the owner's list still shows them until closed by hand or by the SQL in the PR)."""
    engine, w = await _world()
    try:
        uid, _, org_id = await w.person(org=True, name="Admin M")
        comp = await _computer(w, org_id, uid)
        await _remote_control_on(w, org_id)
        assert (await _relay(w, org_id, comp["token"]))["setup"] == 200

        # an older deletion: the user row is closed, nothing else was touched
        await w.sql("UPDATE users SET is_active = false, deleted_at = now() WHERE id = :u", u=uid)

        assert await _relay(w, org_id, comp["token"]) == {"setup": 401, "startable": 401, "sessions": 401}
        assert (await _row(w, comp["setup_id"]))["revoked"] is False   # untouched: the refusal is the authentication's
        async with w.Session() as s:
            from app.services.desktop_relay import device_still_valid

            assert await device_still_valid(s, comp["setup_id"]) is False   # an open stream of such a device ends at its next check
    finally:
        await _close(engine, w)


async def test_05_a_person_who_is_alive_keeps_the_computer():
    """The guard must not refuse a living person's device (the negative control for the authentication check)."""
    engine, w = await _world()
    try:
        uid, _, org_id = await w.person(org=True, name="Admin M")
        comp = await _computer(w, org_id, uid)
        await _remote_control_on(w, org_id)
        assert (await _relay(w, org_id, comp["token"]))["setup"] == 200
        async with w.Session() as s:
            from app.services.desktop_relay import device_still_valid

            assert await device_still_valid(s, comp["setup_id"]) is True
    finally:
        await _close(engine, w)


async def test_06_an_organization_that_closes_with_the_account_is_still_clean():
    """The measured clean case (the sole owner): the organization goes, and its computers and tokens with it."""
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Sole Owner", spare_owner=False)
        comp = await _computer(w, org_id, uid)
        await _remote_control_on(w, org_id)
        await w.delete(await w.tokens(email))
        assert (await _relay(w, org_id, comp["token"]))["setup"] == 401
        assert await _live(w, "SELECT count(*) FROM desktop_setups WHERE id = :i", i=comp["setup_id"]) == 0
    finally:
        await _close(engine, w)


async def test_07_a_deletion_that_cannot_close_the_computers_fails_whole(monkeypatch):
    """Not swallowed (codex 4767 r1): a failure closing the computers rolls the deletion back — the account stays, nothing is half done, a retry can finish.
    Swallowing it would leave the keys the setup handed out alive for a deleted person."""
    from app.services import desktop_setup

    async def _boom(*a, **k):
        raise RuntimeError("closing broke")

    monkeypatch.setattr(desktop_setup, "close_setups_of_deleted_account", _boom)
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Admin M")
        comp = await _computer(w, org_id, uid)
        await _remote_control_on(w, org_id)
        with pytest.raises(RuntimeError):
            await w.delete(await w.tokens(email))
        assert (await w.row(uid))["deleted_at"] is None and (await w.row(uid))["is_active"] is True
        assert (await _row(w, comp["setup_id"]))["revoked"] is False
        assert (await _relay(w, org_id, comp["token"]))["setup"] == 200
    finally:
        await _close(engine, w)


async def test_08_a_confirmer_without_a_user_row_or_none_recorded_keeps_the_relay_contract():
    """4618's contract: the relay serves a setup whose confirmer is no known user and one with no confirmer recorded. Only a CLOSED or DELETED account refuses."""
    engine, w = await _world()
    try:
        _, _, org_id = await w.person(org=True, name="Admin M")
        unmapped = await _computer(w, org_id, uuid.uuid4())
        none_recorded = await _computer(w, org_id, uuid.uuid4())
        await w.sql("UPDATE desktop_setups SET confirmed_by = NULL WHERE id = :i", i=none_recorded["setup_id"])
        await _remote_control_on(w, org_id)
        assert (await _relay(w, org_id, unmapped["token"]))["setup"] == 200
        assert (await _relay(w, org_id, none_recorded["token"]))["setup"] == 200
    finally:
        await _close(engine, w)


async def test_09_a_code_the_person_confirmed_before_deleting_is_not_exchanged_after():
    """The confirm/delete race (codex 4767 r1): a setup confirmed but not yet exchanged when the account is deleted must not turn into keys and a
    device token. The real exchange endpoint, a code made through the public API."""
    import base64
    import hashlib
    import secrets

    engine, w = await _world()
    try:
        uid, _, org_id = await w.person(org=True, name="Admin M")
        uid2, _, org2 = await w.person(org=True, name="Alive")

        async def _confirmed_unexchanged(who: uuid.UUID, org: uuid.UUID) -> tuple[str, str]:
            verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            r = await w.client.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": "mac 4767"})
            assert r.status_code == 201, r.text
            body = r.json()
            await w.sql(
                "UPDATE desktop_setups SET org_id = :o, confirmed_by = :u, confirmed_at = now(), project_id = (SELECT id FROM projects WHERE org_id = :o LIMIT 1) WHERE id = :i",
                o=org, u=who, i=uuid.UUID(body["setup_id"]),
            )
            return body["code"], verifier

        gone_code, gone_verifier = await _confirmed_unexchanged(uid, org_id)
        alive_code, alive_verifier = await _confirmed_unexchanged(uid2, org2)
        await w.sql("UPDATE users SET is_active = false, deleted_at = now() WHERE id = :u", u=uid)   # deleted between the confirmation and the exchange

        refused = await w.client.post("/api/v2/desktop/setup-codes/exchange", json={"code": gone_code, "verifier": gone_verifier})
        assert refused.status_code >= 400 and "device_token" not in refused.text, refused.text
        assert (refused.json().get("error") or {}).get("code") == "code_used", refused.text
        # the control: a living person's confirmed code is not refused for that reason (it exchanges, or says the deployment has no address configured)
        control = await w.client.post("/api/v2/desktop/setup-codes/exchange", json={"code": alive_code, "verifier": alive_verifier})
        assert (control.json().get("error") or {}).get("code") != "code_used", control.text
    finally:
        await _close(engine, w)


async def test_10_a_person_with_several_computers_gets_all_of_them_closed():
    """Several open setups of one person (codex 4767 r2: their rows and their agents' rows are taken once, in the one order — no setup-by-setup locking)."""
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Admin M")
        comps = [await _computer(w, org_id, uid, name=f"Mac {i}") for i in range(3)]
        await _remote_control_on(w, org_id)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        for c in comps:
            assert (await _relay(w, org_id, c["token"]))["setup"] == 401
            assert (await _row(w, c["setup_id"]))["revoked_reason"] == "account_deleted"
            assert await _live(w, "SELECT count(*) FROM members WHERE id = :i AND is_active", i=c["agent_id"]) == 0
            assert await _live(w, "SELECT count(*) FROM agent_api_keys WHERE desktop_setup_id = :i AND revoked_at IS NULL", i=c["setup_id"]) == 0
    finally:
        await _close(engine, w)
