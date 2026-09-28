"""story #4397 — a push device belongs to a person: user_id on the row, sending by person (behind a setting), a session-less
unregister, dead tokens switched off by token, and the 0418 backfill. Real PG.
"""
from __future__ import annotations

import contextlib
import os
import uuid

import httpx
import pytest
from fastapi import FastAPI
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models.push_device import PushDevice
from app.repositories.push_device import PushDeviceRepository
from ee.routers import push_devices as router_module
from ee.services import expo_push

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@contextlib.asynccontextmanager
async def _env(monkeypatch):
    """Two orgs (A · B), a person U in both, a person V only in A. Session factories pointed at the test DB."""
    from app.core import database

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False, class_=AsyncSession)
    monkeypatch.setattr(database, "async_session_factory", Session)
    ids = {k: uuid.uuid4() for k in ("org_a", "org_b", "u", "v", "om_u_a", "om_u_b", "om_v_a")}
    async with Session() as s:
        for org in ("org_a", "org_b"):
            await s.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ids[org]}','O','o-{ids[org].hex[:12]}','free')"
            ))
        for user in ("u", "v"):
            await s.execute(text(
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
                f"VALUES ('{ids[user]}','{ids[user].hex[:8]}@s4397.test','x','U',true,true,0,false,0)"
            ))
        for om, org, user in (("om_u_a", "org_a", "u"), ("om_u_b", "org_b", "u"), ("om_v_a", "org_a", "v")):
            await s.execute(text(
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{ids[om]}','{ids[org]}','{ids[user]}','member')"
            ))
        await s.commit()
    try:
        yield Session, ids
    finally:
        async with Session() as s:
            for q in (
                f"DELETE FROM push_devices WHERE org_id IN ('{ids['org_a']}','{ids['org_b']}')",
                f"DELETE FROM member_identity_aliases WHERE org_id IN ('{ids['org_a']}','{ids['org_b']}')",
                f"DELETE FROM members WHERE org_id IN ('{ids['org_a']}','{ids['org_b']}')",
                f"DELETE FROM org_members WHERE org_id IN ('{ids['org_a']}','{ids['org_b']}')",
                f"DELETE FROM organizations WHERE id IN ('{ids['org_a']}','{ids['org_b']}')",
                f"DELETE FROM users WHERE id IN ('{ids['u']}','{ids['v']}')",
            ):
                await s.execute(text(q))
            await s.commit()
        await eng.dispose()


def _token() -> str:
    return f"ExponentPushToken[{uuid.uuid4().hex}]"


async def _register(Session, org_id, member_id, user_id, token) -> PushDevice:
    async with Session() as s:
        device = await PushDeviceRepository(s, org_id).upsert(
            member_id=member_id, user_id=user_id, expo_push_token=token, apns_device_token=None, platform="android",
            device_id=None, app_version="1.0",
        )
        await s.commit()
        return device


async def _targets(Session, org_id, member_ids, muted=None) -> list[str]:
    async with Session() as s:
        found = await expo_push._fetch_expo_push_targets(s, org_id, member_ids, muted_member_ids=muted)
    return sorted(t["expo_push_token"] for t in found)


# ─── registration ────────────────────────────────────────────────────────────────────────────────────────────────


async def test_register_stores_the_person_and_an_account_switch_overwrites_it(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        device = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        assert device.user_id == ids["u"]
        again = await _register(Session, ids["org_a"], ids["om_v_a"], ids["v"], token)  # another account on the same phone
        assert again.id == device.id and again.user_id == ids["v"] and again.member_id == ids["om_v_a"]


# ─── sending by person (setting) ─────────────────────────────────────────────────────────────────────────────────


async def test_by_person_a_device_registered_in_org_a_gets_org_b_notifications(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)  # U last opened the app in org A
        monkeypatch.setattr(settings, "push_devices_by_user", True)
        assert await _targets(Session, ids["org_b"], [ids["om_u_b"]]) == [token]
        assert await _targets(Session, ids["org_a"], [ids["om_u_a"]]) == [token]


async def test_setting_off_keeps_the_old_selection(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        monkeypatch.setattr(settings, "push_devices_by_user", False)
        assert await _targets(Session, ids["org_b"], [ids["om_u_b"]]) == []
        assert await _targets(Session, ids["org_a"], [ids["om_u_a"]]) == [token]


async def test_rows_without_a_person_are_still_reached_the_old_way(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        await _register(Session, ids["org_b"], ids["om_u_b"], None, token)  # not backfilled
        monkeypatch.setattr(settings, "push_devices_by_user", True)
        assert await _targets(Session, ids["org_b"], [ids["om_u_b"]]) == [token]
        assert await _targets(Session, ids["org_a"], [ids["om_u_a"]]) == []


async def test_org_boundary_someone_outside_the_org_never_gets_it(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        v_token = _token()
        await _register(Session, ids["org_a"], ids["om_v_a"], ids["v"], v_token)  # V is only in org A
        monkeypatch.setattr(settings, "push_devices_by_user", True)
        # an org B notification for U must not reach V; nor may a member id of org A passed with org B pull anyone in
        assert await _targets(Session, ids["org_b"], [ids["om_u_b"]]) == []
        assert await _targets(Session, ids["org_b"], [ids["om_v_a"]]) == []


async def test_a_muted_member_is_still_filtered_out(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        monkeypatch.setattr(settings, "push_devices_by_user", True)
        assert await _targets(Session, ids["org_b"], [ids["om_u_b"]], muted={ids["om_u_b"]}) == []


async def test_targets_carry_device_id_and_platform_for_receipts(monkeypatch):
    """PO 18:42Z ① — the selection returns rows, so the sender still records its ok tickets by device (4396)."""
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        device = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        monkeypatch.setattr(settings, "push_devices_by_user", True)
        async with Session() as s:
            found = await expo_push._fetch_expo_push_targets(s, ids["org_b"], [ids["om_u_b"]])
        assert found == [{"expo_push_token": token, "id": device.id, "platform": "android"}]


async def test_a_late_receipt_for_another_orgs_notification_switches_off_the_device(monkeypatch):
    """PO 18:42Z ① — switch on: an org B notification reached U's device homed in org A. Its DeviceNotRegistered receipt
    must switch that device off (the receipt's org is B); a device registered again since the push stays on."""
    from ee.services import expo_receipts

    async with _env(monkeypatch) as (Session, ids):
        monkeypatch.setattr(settings, "push_devices_by_user", True)
        gone = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], _token())
        sent_at = gone.last_seen_at.timestamp() + 1
        assert await expo_receipts._deactivate_devices(ids["org_b"], [(gone.id, sent_at)]) == 1
        token = _token()
        back = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        push_time = back.last_seen_at.timestamp() + 0.001
        import asyncio
        await asyncio.sleep(0.05)
        await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)  # registered again after the push
        assert await expo_receipts._deactivate_devices(ids["org_b"], [(back.id, push_time)]) == 0


async def test_even_with_the_switch_off_rows_without_an_expo_token_are_never_selected(monkeypatch):
    """PO 18:42Z ② — the one change that applies with the switch off too: a macOS row (APNs token, no Expo token) used to be
    selected by the Expo sender and became a `"to": null` message. The Expo selection now requires an Expo token."""
    async with _env(monkeypatch) as (Session, ids):
        monkeypatch.setattr(settings, "push_devices_by_user", False)
        async with Session() as s:
            await PushDeviceRepository(s, ids["org_a"]).upsert(
                member_id=ids["om_u_a"], user_id=ids["u"], expo_push_token=None,
                apns_device_token=uuid.uuid4().hex + uuid.uuid4().hex, platform="macos", device_id=None, app_version="1.0",
            )
            await s.commit()
        assert await _targets(Session, ids["org_a"], [ids["om_u_a"]]) == []


async def test_a_dead_token_is_switched_off_whichever_org_the_row_is_homed_in(monkeypatch):
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        device = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        async with Session() as s:
            await expo_push._finalize_expo_push_dead_tokens(s, ids["org_b"], [token])  # found while sending for org B
            await s.commit()
        async with Session() as s:
            assert (await s.execute(select(PushDevice.is_active).where(PushDevice.id == device.id))).scalar_one() is False


# ─── session-less unregister ─────────────────────────────────────────────────────────────────────────────────────


def _app(Session):
    from tests.conftest import override_db_and_read

    async def db():
        async with Session() as s:
            yield s
            await s.commit()

    app = FastAPI()
    app.include_router(router_module.router, prefix="/api/v2/push")
    app.dependency_overrides[router_module._require_ee] = lambda: None
    override_db_and_read(app, db)
    return app


async def _post_unregister(app, body, headers=None):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        return await client.post("/api/v2/push/devices/unregister", json=body, headers=headers or {})


async def test_unregister_switches_off_and_always_answers_204(monkeypatch):
    monkeypatch.setattr(router_module, "_unregister_limiter", MovingWindowRateLimiter(MemoryStorage()))
    async with _env(monkeypatch) as (Session, ids):
        token = _token()
        device = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        app = _app(Session)
        for body in ({"expo_push_token": token}, {"expo_push_token": token}, {"expo_push_token": _token()}):
            res = await _post_unregister(app, body)  # known · already off · unknown → the same answer
            assert res.status_code == 204 and res.content == b""
        async with Session() as s:
            assert (await s.execute(select(PushDevice.is_active).where(PushDevice.id == device.id))).scalar_one() is False
        # never turns anything on: registering again is the only way back
        again = await _register(Session, ids["org_a"], ids["om_u_a"], ids["u"], token)
        assert again.is_active is True


@pytest.mark.parametrize("body", [
    {"expo_push_token": "not-a-token"},
    {"expo_push_token": "ExponentPushToken[a]", "member_id": str(uuid.uuid4())},
    {},
])
async def test_unregister_rejects_a_bad_body(monkeypatch, body):
    monkeypatch.setattr(router_module, "_unregister_limiter", MovingWindowRateLimiter(MemoryStorage()))
    async with _env(monkeypatch) as (Session, _ids):
        assert (await _post_unregister(_app(Session), body)).status_code == 422


async def test_unregister_cap_is_per_real_client_ip(monkeypatch):
    """PO 18:10Z ① — behind Cloudflare → Cloud Run the socket peer is the front end; the key is CF-Connecting-IP (then the
    first X-Forwarded-For entry), so different callers are counted apart."""
    monkeypatch.setattr(router_module, "_unregister_limiter", MovingWindowRateLimiter(MemoryStorage()))
    async with _env(monkeypatch) as (Session, _ids):
        app = _app(Session)
        body = {"expo_push_token": _token()}
        for _ in range(router_module.UNREGISTER_PER_HOUR):
            assert (await _post_unregister(app, body, {"cf-connecting-ip": "203.0.113.1"})).status_code == 204
        over = await _post_unregister(app, body, {"cf-connecting-ip": "203.0.113.1"})
        assert over.status_code == 429 and over.headers["Retry-After"] == "3600"
        assert (await _post_unregister(app, body, {"cf-connecting-ip": "203.0.113.2"})).status_code == 204
        assert (await _post_unregister(app, body, {"x-forwarded-for": "198.51.100.7, 10.0.0.1"})).status_code == 204


def test_client_ip_prefers_cf_then_first_forwarded_entry():
    from starlette.requests import Request

    def req(headers):
        return Request({"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers], "client": ("10.1.1.1", 1)})

    assert router_module.client_ip(req([("cf-connecting-ip", "203.0.113.9"), ("x-forwarded-for", "1.1.1.1")])) == "203.0.113.9"
    assert router_module.client_ip(req([("x-forwarded-for", "198.51.100.7, 10.0.0.1")])) == "198.51.100.7"
    assert router_module.client_ip(req([])) == "10.1.1.1"


# ─── 0418 backfill ───────────────────────────────────────────────────────────────────────────────────────────────


async def test_backfill_resolves_the_person_from_all_four_sources_and_leaves_agents_empty(monkeypatch):
    """PO 18:42Z ③ — the backfill does not require the device's org to match the member's org: the column is the *person*
    (member → user), and a person's device may be homed in any of their orgs, so member → user is all it needs."""
    import importlib.util
    import pathlib

    path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0418_push_devices_user_id.py"
    spec = importlib.util.spec_from_file_location("m0418", path)
    m0418 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m0418)

    async with _env(monkeypatch) as (Session, ids):
        org = ids["org_a"]
        deleted_om, human_member, alias_id, agent_member = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            await s.execute(text(
                # a former member of org B (V is not a member there any more — (org_id, user_id) is unique even when deleted)
                f"INSERT INTO org_members (id,org_id,user_id,role,deleted_at) VALUES ('{deleted_om}','{ids['org_b']}','{ids['v']}','member',now())"
            ))
            await s.execute(text(f"INSERT INTO members (id,org_id,type,user_id) VALUES ('{human_member}','{org}','human','{ids['u']}')"))
            await s.execute(text(f"INSERT INTO members (id,org_id,type) VALUES ('{agent_member}','{org}','agent')"))
            await s.execute(text(
                "INSERT INTO member_identity_aliases (alias_id,member_id,org_id,alias_source) "
                f"VALUES ('{alias_id}','{human_member}','{org}','human_team_member')"
            ))
            await s.commit()
        rows = {
            "live": ids["om_u_a"], "deleted": deleted_om, "members_human": human_member, "alias": alias_id,
            "agent": agent_member, "unknown": uuid.uuid4(),
        }
        device_ids = {}
        for name, member_id in rows.items():
            device_ids[name] = (await _register(Session, org, member_id, None, _token())).id
        async with Session() as s:
            await s.execute(text(m0418._BACKFILL))
            await s.commit()
            got = {
                name: (await s.execute(select(PushDevice.user_id).where(PushDevice.id == did))).scalar_one()
                for name, did in device_ids.items()
            }
        assert got == {
            "live": ids["u"], "deleted": ids["v"], "members_human": ids["u"], "alias": ids["u"], "agent": None, "unknown": None,
        }
