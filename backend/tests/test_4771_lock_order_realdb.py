"""story #4771 — one lock order for the paths that close a computer's rows: an organization delete used to take the agent KEY rows before the SETUP rows (its final
`DELETE FROM organizations` cascades to `desktop_setups`), while every live path (a disconnect, the account deletion's closer, a member removal, migrations 0463 / 0464) takes
the setup row first and its keys after — a deadlock pair whenever the two overlap (measured by the security lens on develop without any 4769 code: 3 + 1 of 20 randomly started
rounds).

Real PG, the real endpoints. Pins:
  01 the deterministic pair: a session that already holds the setup row (what a disconnect holds) and then updates the setup's keys, against an organization delete that started in
     between — with the keys-first order Postgres aborts one of them with a deadlock; with the one order the organization delete waits at the setup row, the holder finishes, and the
     delete completes (200);
  02 the lens' matrix: organization delete ‖ account deletion of a member who confirmed a computer ‖ the owner's disconnect of it ‖ the revoke of its agent's key, 20 rounds with
     random starts — no round ends in a deadlock or any 5xx, and an organization that was deleted leaves no live key behind;
  03 the same organization delete as the account deletion's closing of an organization (the sole owner deletes the account) loses nothing it used to do: the audit row, the seats,
     the keys, the setup rows (cascade) — so the new locks change what the delete takes first, never what it closes."""
from __future__ import annotations

import asyncio
import os
import random
import uuid

import pytest

from tests.test_4752_account_delete_realdb import _close, _world
from tests.test_4767_account_delete_closes_devices_realdb import _computer, _live

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


async def _org_name(w, org_id: uuid.UUID) -> str:
    from sqlalchemy import text

    async with w.Session() as s:
        return (await s.execute(text("SELECT name FROM organizations WHERE id = :o"), {"o": org_id})).scalar_one()


def _bearer(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _delete_org(w, tokens: dict, org_id: uuid.UUID, name: str):
    return await w.client.request("DELETE", f"/api/v2/organizations/{org_id}", headers=_bearer(tokens), json={"confirmation": name})


async def test_01_an_organization_delete_waits_at_the_setup_row_before_it_touches_a_key():
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    engine, w = await _world()
    try:
        _, owner_email, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        comp = await _computer(w, org_id, m)
        name = await _org_name(w, org_id)
        owner = await w.tokens(owner_email)

        holder = w.Session()
        async with holder:
            # what a disconnect (and the account deletion's closer, a removal, the migrations) holds first: the setup row …
            await holder.execute(text("SELECT id FROM desktop_setups WHERE id = :i FOR UPDATE"), {"i": comp["setup_id"]})
            deleting = asyncio.create_task(_delete_org(w, owner, org_id, name))
            await asyncio.sleep(1.5)   # the organization delete is now waiting somewhere: at the setup row (one order) or, with the keys first, at the cascade
            assert not deleting.done(), "the organization delete waits for the setup row held by the other transaction"
            try:
                # … and its next step: the keys the setup handed out
                await holder.execute(
                    text("UPDATE agent_api_keys SET revoked_at = now() WHERE desktop_setup_id = :i AND revoked_at IS NULL"), {"i": comp["setup_id"]},
                )
                await holder.commit()
            except DBAPIError as e:
                await holder.rollback()
                pytest.fail(f"deadlock between an organization delete (keys first) and a transaction that holds the setup row: {type(e.orig).__name__}")
        r = await asyncio.wait_for(deleting, timeout=30)
        assert r.status_code == 200, r.text
        assert await _live(w, "SELECT count(*) FROM desktop_setups WHERE id = :i", i=comp["setup_id"]) == 0, "the setup row went with the organization (cascade)"
    finally:
        await _close(engine, w)


async def test_01b_an_organization_delete_waits_at_the_agent_row_before_it_holds_a_setup_row():
    """The other half of the order: a disconnect (and an exchange, the closers) takes the agent MEMBER rows first and the setup rows after. A session that holds the agent row
    and then reaches for the setup row, against an organization delete that started in between: if the delete held the setup rows while it waited for the agent row (the
    cascade of its final DELETE), Postgres would abort one of them with a deadlock; with the agent rows first the delete waits there with nothing held and the holder finishes."""
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    engine, w = await _world()
    try:
        _, owner_email, org_id = await w.person(org=True, name="Owner")
        m = await w.add_member(org_id, role="admin", name="M")
        comp = await _computer(w, org_id, m)
        name = await _org_name(w, org_id)
        owner = await w.tokens(owner_email)

        holder = w.Session()
        async with holder:
            await holder.execute(text("SELECT id FROM members WHERE id = :a FOR UPDATE"), {"a": comp["agent_id"]})   # the agent row, first
            deleting = asyncio.create_task(_delete_org(w, owner, org_id, name))
            await asyncio.sleep(1.5)
            assert not deleting.done(), "the organization delete waits for the agent row held by the other transaction"
            try:
                await holder.execute(text("SELECT id FROM desktop_setups WHERE id = :i FOR UPDATE"), {"i": comp["setup_id"]})   # … then the setup row
                await holder.commit()
            except DBAPIError as e:
                await holder.rollback()
                pytest.fail(f"deadlock between an organization delete and a transaction that holds the agent row: {type(e.orig).__name__}")
        r = await asyncio.wait_for(deleting, timeout=30)
        assert r.status_code == 200, r.text
    finally:
        await _close(engine, w)


async def test_04_a_disconnect_whose_setup_row_went_with_its_organization_answers_not_found():
    """The row was read, then an organization delete committed (the setup went by cascade), then the disconnect took its lock and found nothing: that was a KeyError (a 500);
    it is «setup not found» (the route answers 404)."""
    from sqlalchemy import select, text

    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_setup

    engine, w = await _world()
    try:
        owner_uid, _, org_id = await w.person(org=True, name="Owner")
        comp = await _computer(w, org_id, owner_uid)
        async with w.Session() as s:
            found = (await s.execute(select(DesktopSetup).where(DesktopSetup.id == comp["setup_id"]))).scalar_one()
            await w.sql("DELETE FROM desktop_setups WHERE id = :i", i=comp["setup_id"])   # the cascade, committed by another transaction
            with pytest.raises(desktop_setup.DesktopSetupError) as e:
                await desktop_setup._disconnect_setup(s, found, org_id=org_id, revoked_by=owner_uid)
            assert e.value.code == "setup_not_found"
    finally:
        await _close(engine, w)


async def test_05_an_exchange_whose_setup_row_went_with_its_organization_is_not_a_500():
    """codex 4771 r1: the exchange indexed the locked rows directly, so a setup that an organization delete removed between its read and its lock was a KeyError (500), like the
    disconnect. A session holds the setup row, the exchange (a confirmed, not yet exchanged code) waits at its lock, the row is deleted and committed: the answer is 404 code_not_found."""
    import base64
    import hashlib
    import secrets

    from sqlalchemy import text

    engine, w = await _world()
    try:
        uid, _, org_id = await w.person(org=True, name="Owner")
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        r = await w.client.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": "mac 4771"})
        assert r.status_code == 201, r.text
        body = r.json()
        setup_id = uuid.UUID(body["setup_id"])
        await w.sql(
            "UPDATE desktop_setups SET org_id = :o, confirmed_by = :u, confirmed_at = now(), project_id = (SELECT id FROM projects WHERE org_id = :o LIMIT 1) WHERE id = :i",
            o=org_id, u=uid, i=setup_id,
        )
        holder = w.Session()
        async with holder:
            await holder.execute(text("SELECT id FROM desktop_setups WHERE id = :i FOR UPDATE"), {"i": setup_id})
            exchanging = asyncio.create_task(w.client.post("/api/v2/desktop/setup-codes/exchange", json={"code": body["code"], "verifier": verifier}))
            await asyncio.sleep(1.0)
            assert not exchanging.done(), "the exchange waits at the setup row"
            await holder.execute(text("DELETE FROM desktop_setups WHERE id = :i"), {"i": setup_id})
            await holder.commit()
        resp = await asyncio.wait_for(exchanging, timeout=20)
        assert resp.status_code == 404, (resp.status_code, resp.text[:200])
    finally:
        await _close(engine, w)


async def _round(w, rng: random.Random) -> dict:
    """One round of the lens' matrix on a fresh organization: the owner deletes the organization, the admin M (who confirmed a computer) deletes the account, the owner
    disconnects the computer and the owner revokes the key of its agent — all at once, each started after a random pause."""
    _, owner_email, org_id = await w.person(org=True, name="Owner")
    m = await w.add_member(org_id, role="admin", name="M")
    comp = await _computer(w, org_id, m)
    name = await _org_name(w, org_id)
    key_id = await _live_value(w, "SELECT id FROM agent_api_keys WHERE desktop_setup_id = :i", i=comp["setup_id"])
    owner = await w.tokens(owner_email)
    m_tokens = await w.tokens(f"story4752-m-{m.hex[:10]}@test.com")

    async def _later(coro_fn):
        await asyncio.sleep(rng.random() * 0.04)
        return await coro_fn()

    results = await asyncio.gather(
        _later(lambda: _delete_org(w, owner, org_id, name)),
        _later(lambda: w.client.post("/api/v2/account/delete", headers=_bearer(m_tokens))),
        _later(lambda: w.client.delete(f"/api/v2/desktop/setups/{comp['setup_id']}", headers=_bearer(owner))),
        _later(lambda: w.client.delete(f"/api/v2/agents/{comp['agent_id']}/api-keys/{key_id}", headers=_bearer(owner))),
        return_exceptions=True,
    )
    return {"org_id": org_id, "setup_id": comp["setup_id"], "results": results}


async def _live_value(w, sql: str, **kw):
    from sqlalchemy import text

    async with w.Session() as s:
        return (await s.execute(text(sql), kw)).scalar_one()


async def test_02_the_lens_matrix_ends_in_no_deadlock_and_no_5xx_in_20_random_rounds():
    engine, w = await _world()
    rng = random.Random(4771)
    try:
        bad: list[str] = []
        for i in range(20):
            rnd = await _round(w, rng)
            for label, res in zip(("org_delete", "account_delete", "disconnect", "key_revoke"), rnd["results"], strict=True):
                if isinstance(res, BaseException):
                    bad.append(f"round {i} {label}: {type(res).__name__}: {str(res)[:120]}")
                elif res.status_code >= 500:
                    bad.append(f"round {i} {label}: HTTP {res.status_code}")
            if await _live(w, "SELECT count(*) FROM organizations WHERE id = :o", o=rnd["org_id"]) == 0:
                assert await _live(w, "SELECT count(*) FROM desktop_setups WHERE id = :i", i=rnd["setup_id"]) == 0
        assert not bad, "\n".join(bad)
    finally:
        await _close(engine, w)


async def test_03_the_account_deletion_still_closes_the_organization_it_closed_before():
    engine, w = await _world()
    try:
        owner_uid, owner_email, org_id = await w.person(org=True, name="Sole Owner", spare_owner=False)   # nobody else is in it: it closes with the account
        comp = await _computer(w, org_id, owner_uid)
        tokens = await w.tokens(owner_email)
        r = await w.delete(tokens)
        assert r.status_code == 200, r.text
        assert await _live(w, "SELECT count(*) FROM organizations WHERE id = :o", o=org_id) == 0, "the organization closes with the account"
        assert await _live(w, "SELECT count(*) FROM desktop_setups WHERE id = :i", i=comp["setup_id"]) == 0, "its setup rows go with it (cascade)"
        assert await _live(w, "SELECT count(*) FROM org_members WHERE org_id = :o AND deleted_at IS NULL", o=org_id) == 0, "the seats are ended"
        assert await _live(w, "SELECT count(*) FROM agent_api_keys WHERE (member_id = :a OR team_member_id = :a) AND revoked_at IS NULL", a=comp["agent_id"]) == 0, "the keys are revoked"
        assert await _live(w, "SELECT count(*) FROM deletion_audit_logs WHERE org_id = :o AND entity_type = 'organization'", o=org_id) == 1, "one audit row"
    finally:
        await _close(engine, w)
