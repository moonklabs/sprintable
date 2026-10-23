"""story #4752 — deleting the account really closes it, works without an organization, and the personal data goes after the grace period.

Seen live (2026-10-22, dev): a person with no organization got 403 «해당 조직의 멤버가 아닌» on POST /api/v2/account/delete; for a person WITH one the call answered 200 but the same password
still signed in (only the memberships had `deleted_at`) and the web's onboarding made them a new organization; nothing ever removed the personal data the copy promises
(«30일 유예 기간 후 모든 개인정보가 익명화돼요»). Real PG, the real endpoints.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_PASSWORD = "pw-" + "4752"


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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


class _World:
    def __init__(self, app, Session, client):
        self.app, self.Session, self.client = app, Session, client

    async def person(self, *, org: bool, name: str = "Real Name") -> tuple[uuid.UUID, str, uuid.UUID | None]:
        """A person who can sign in with a password; with an organization (as its owner, with a human member row carrying a name) or without any."""
        from app.core.security import hash_password
        from app.models.member import Member
        from app.models.organization import Organization
        from app.models.project import OrgMember, Project
        from app.models.user import User

        uid = uuid.uuid4()
        email = f"story4752-{uid.hex[:10]}@test.com"
        org_id = None
        async with self.Session() as s:
            s.add(User(id=uid, email=email, hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True,
                       display_name=name))
            await s.commit()
            if org:
                o = Organization(id=uuid.uuid4(), name=f"Org-{uid.hex[:6]}", slug=f"o4752-{uuid.uuid4().hex[:8]}")
                s.add(o)
                await s.commit()
                s.add(Project(id=uuid.uuid4(), org_id=o.id, name="P"))
                seat = uuid.uuid4()   # one id for the seat: the org_members row and the members anchor row share it, as in the product
                s.add(OrgMember(id=seat, org_id=o.id, user_id=uid, role="owner"))
                s.add(Member(id=seat, org_id=o.id, type="human", user_id=uid, name=name, avatar_url="https://x/avatar.png", handle="real-handle"))
                await s.commit()
                u = await s.get(User, uid)
                u.last_org_id = o.id
                await s.commit()
                org_id = o.id
        return uid, email, org_id

    async def login(self, email: str):
        return await self.client.post("/api/v2/auth/token", json={"email": email, "password": _PASSWORD})

    async def tokens(self, email: str) -> dict:
        r = await self.login(email)
        assert r.status_code == 200, r.text
        return r.json()["data"]

    async def delete(self, tokens: dict):
        return await self.client.post("/api/v2/account/delete", headers={"Authorization": f"Bearer {tokens['access_token']}"})

    async def row(self, uid: uuid.UUID) -> dict:
        from sqlalchemy import text
        async with self.Session() as s:
            r = (await s.execute(text(
                "SELECT email, hashed_password, display_name, google_id, totp_secret, totp_enabled, signup_utm_source, is_active, deleted_at, anonymized_at FROM users WHERE id = :i"),
                {"i": uid})).one()
        return dict(r._mapping)

    async def sql(self, q: str, **kw):
        from sqlalchemy import text
        async with self.Session() as s:
            res = await s.execute(text(q), kw)
            await s.commit()
            return res


async def _world():
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.main import app
    from tests.conftest import override_db_and_read

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return engine, _World(app, Session, client)


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


async def test_01_a_person_with_no_organization_can_delete_the_account_and_is_closed_at_once():
    engine, w = await _world()
    try:
        uid, email, _ = await w.person(org=False)
        t = await w.tokens(email)
        r = await w.delete(t)
        assert r.status_code == 200, r.text          # before: 403 «해당 조직의 멤버가 아닌»
        assert r.json() == {"ok": True, "grace_period_days": 30}
        row = await w.row(uid)
        assert row["is_active"] is False and row["deleted_at"] is not None and row["anonymized_at"] is None
        # closed: the password no longer signs in (the same answer as a wrong password — nothing says «this account was deleted»), the session is over, the old access token is dead
        wrong = await w.client.post("/api/v2/auth/token", json={"email": email, "password": "not-the-password"})
        gone = await w.login(email)
        assert gone.status_code == wrong.status_code == 401 and gone.json() == wrong.json()
        assert (await w.client.post("/api/v2/auth/refresh", json={"refresh_token": t["refresh_token"]})).status_code == 401
        assert (await w.client.get("/api/v2/organizations", headers={"Authorization": f"Bearer {t['access_token']}"})).status_code == 401
    finally:
        await _close(engine, w)


async def test_02_a_person_with_an_organization_is_closed_too_not_just_their_memberships():
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True)
        t = await w.tokens(email)
        assert (await w.delete(t)).status_code == 200
        row = await w.row(uid)
        assert row["is_active"] is False and row["deleted_at"] is not None
        res = await w.sql("SELECT (SELECT count(*) FROM org_members WHERE user_id = :u AND deleted_at IS NULL) AS om, (SELECT count(*) FROM members WHERE user_id = :u AND deleted_at IS NULL) AS m", u=uid)
        assert tuple(res.one()) == (0, 0)             # the memberships are closed as before
        assert (await w.login(email)).status_code == 401   # before: 200 — and the onboarding made the person a new organization
        # the organization row itself is not touched here (what happens to an organization that loses its last owner is its own rule — story 4752, not this change)
        assert (await w.sql("SELECT count(*) FROM organizations WHERE id = :o", o=org_id)).scalar_one() == 1
    finally:
        await _close(engine, w)


async def test_03_it_is_only_ever_the_callers_own_account_and_only_once():
    engine, w = await _world()
    try:
        a_uid, a_email, _ = await w.person(org=False)
        b_uid, b_email, _ = await w.person(org=True)
        ta, tb = await w.tokens(a_email), await w.tokens(b_email)
        assert (await w.delete(ta)).status_code == 200
        assert (await w.row(b_uid))["is_active"] is True and (await w.login(b_email)).status_code == 200   # the other person is untouched
        # the deleted account's own old token cannot press it again (its sessions ended), and a fresh call under its id answers 404 like an id that is no account
        from app.dependencies.auth import AuthContext, get_current_user
        w.app.dependency_overrides[get_current_user] = lambda: AuthContext(user_id=str(a_uid), email=a_email, claims={})
        again = await w.client.post("/api/v2/account/delete")
        assert again.status_code == 404
        w.app.dependency_overrides[get_current_user] = lambda: AuthContext(user_id=str(uuid.uuid4()), email=None, claims={})  # an agent key names a member, not a user
        assert (await w.client.post("/api/v2/account/delete")).status_code == 404
        w.app.dependency_overrides.pop(get_current_user, None)
        assert (await w.delete(tb)).status_code == 200
    finally:
        await _close(engine, w)


async def test_04_a_human_api_key_cannot_delete_the_account():
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True)
        from app.dependencies.auth import AuthContext, get_current_user
        w.app.dependency_overrides[get_current_user] = lambda: AuthContext(
            user_id=str(uid), email=None, org_id=str(org_id),
            claims={"sub": str(uid), "app_metadata": {"org_id": str(org_id), "human_api_key_id": str(uuid.uuid4()), "actor_type": "human"}})
        r = await w.client.post("/api/v2/account/delete")
        assert r.status_code == 403
        w.app.dependency_overrides.pop(get_current_user, None)
        assert (await w.row(uid))["is_active"] is True
    finally:
        await _close(engine, w)


async def _purge(w: _World, **kw) -> int:
    from app.services.account_purge import purge_deleted_accounts
    async with w.Session() as s:
        n = await purge_deleted_accounts(s, **kw)
        await s.commit()
        return n


async def test_05_after_the_grace_period_the_personal_data_is_anonymized_and_what_was_written_stays():
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Real Name")
        old, old_email, _ = await w.person(org=True, name="Old Name")
        young, young_email, _ = await w.person(org=True, name="Young Name")
        live, live_email, _ = await w.person(org=True, name="Live Name")
        for u in (uid, old, young):
            assert (await w.delete(await w.tokens({uid: email, old: old_email, young: young_email}[u]))).status_code == 200
        for u in (uid, old, young, live):   # the personal data a person accumulates (set after the sign-in: a second factor would ask for a code at the login)
            await w.sql("UPDATE users SET google_id = :g, github_id = :h, apple_id = :a, totp_secret = 'SECRETSECRET', totp_enabled = true, signup_utm_source = 'ad' WHERE id = :u",
                        u=u, g=f"g-{u.hex}", h=f"h-{u.hex}", a=f"a-{u.hex}")
            await w.sql("INSERT INTO auth_migrations (user_id, state, firebase_uid) VALUES (:u, 'legacy', :f) ON CONFLICT (user_id) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid", u=u, f=f"fb-{u.hex}")
        await w.sql("UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = :u", u=uid)
        await w.sql("UPDATE users SET deleted_at = now() - interval '45 days' WHERE id = :u", u=old)
        await w.sql("UPDATE users SET deleted_at = now() - interval '29 days' WHERE id = :u", u=young)
        await w.sql("INSERT INTO auth_identities (id, user_id, issuer, subject, provider_id, provider_subject, email_at_link) VALUES (gen_random_uuid(), :u, 'iss', :s, 'google.com', 'gsub', :e)", u=uid, s=f"sub-{uid.hex}", e=email)
        assert await _purge(w) == 2                               # only the two past their 30 days
        row = await w.row(uid)
        assert row["email"].startswith(f"deleted-{uid}-") and row["email"].endswith("@deleted.invalid") and row["email"] != email   # unguessable (a random part): nobody can register it beforehand
        assert row["hashed_password"] == "" and row["display_name"] is None
        ids = (await w.sql("SELECT u.github_id, u.apple_id, m.firebase_uid FROM users u JOIN auth_migrations m ON m.user_id = u.id WHERE u.id = :u", u=uid)).one()
        assert tuple(ids) == (None, None, None)
        # …while the migration row stays: its cut-off keeps every old access token dead
        assert (await w.sql("SELECT auth_valid_after IS NOT NULL FROM auth_migrations WHERE user_id = :u", u=uid)).scalar_one() is True
        assert row["google_id"] is None and row["totp_secret"] is None and row["totp_enabled"] is False and row["signup_utm_source"] is None
        assert row["is_active"] is False and row["anonymized_at"] is not None and row["deleted_at"] is not None
        mem = (await w.sql("SELECT name, avatar_url, handle FROM members WHERE user_id = :u AND type = 'human'", u=uid)).one()
        assert tuple(mem) == ("탈퇴한 사용자", None, None)
        assert (await w.sql("SELECT count(*) FROM auth_identities WHERE user_id = :u", u=uid)).scalar_one() == 0
        assert (await w.sql("SELECT count(*) FROM refresh_tokens WHERE user_id = :u", u=uid)).scalar_one() == 0
        assert (await w.sql("SELECT count(*) FROM users WHERE id = :u", u=uid)).scalar_one() == 1      # the row stays: what the person wrote points at its id
        # the young deletion (29 days) and a live account are untouched
        assert (await w.row(young))["email"] == young_email and (await w.row(young))["anonymized_at"] is None
        assert (await w.row(live))["display_name"] == "Live Name" and (await w.row(live))["is_active"] is True
        assert (await w.sql("SELECT name FROM members WHERE user_id = :u AND type = 'human'", u=young)).scalar_one() == "Young Name"
        # idempotent: the same accounts are not taken twice
        assert await _purge(w) == 0
        # and the anonymized account can still not sign in with its old address
        assert (await w.login(email)).status_code == 401
    finally:
        await _close(engine, w)


async def test_06_the_purge_is_bounded_and_a_held_row_is_left_for_the_next_run():
    engine, w = await _world()
    try:
        ids = []
        for _ in range(5):
            uid, email, _ = await w.person(org=False)
            assert (await w.delete(await w.tokens(email))).status_code == 200
            await w.sql("UPDATE users SET deleted_at = now() - interval '40 days' WHERE id = :u", u=uid)
            ids.append(uid)
        got = [await _purge(w, batch=2), await _purge(w, batch=2), await _purge(w, batch=2), await _purge(w, batch=2)]
        assert got == [2, 2, 1, 0], got
        # a row another transaction holds is skipped (not waited for), and the next run takes it
        held, held_email, _ = await w.person(org=False)
        assert (await w.delete(await w.tokens(held_email))).status_code == 200
        await w.sql("UPDATE users SET deleted_at = now() - interval '40 days' WHERE id = :u", u=held)
        from sqlalchemy import text
        async with w.Session() as holder:
            await holder.execute(text("SELECT id FROM users WHERE id = :u FOR UPDATE"), {"u": held})
            assert await _purge(w) == 0
            await holder.rollback()
        assert await _purge(w) == 1
    finally:
        await _close(engine, w)


async def test_07_the_cron_road_is_the_schedulers_and_runs_the_purge(monkeypatch):
    from app.routers import cron as cron_module

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")
    engine, w = await _world()
    try:
        uid, email, _ = await w.person(org=False)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        await w.sql("UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = :u", u=uid)
        url = "/api/v2/internal/cron/account-purge"
        assert (await w.client.post(url)).status_code == 401
        assert (await w.client.post(url, headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await w.row(uid))["anonymized_at"] is None
        r = await w.client.post(url, headers={"Authorization": "Bearer test-cron-secret"})
        assert r.status_code == 200 and r.json()["data"]["purged"] >= 1, r.text
        assert (await w.row(uid))["anonymized_at"] is not None
    finally:
        await _close(engine, w)


async def test_08_the_purge_takes_only_what_the_deletion_stamped_never_a_live_person_whose_membership_is_gone_or_who_was_deactivated_by_someone_else():
    """Kadir's lens (PO 5764): the job's target is `users.deleted_at` and nothing else — migration 0460 backfills nothing (the columns start NULL), and an organization admin who removes a
    person from the organization, or a deactivation that is not a deletion, never makes the person a purge target."""
    engine, w = await _world()
    try:
        removed, removed_email, _ = await w.person(org=True, name="Removed Name")
        deactivated, deact_email, _ = await w.person(org=False, name="Deactivated Name")
        pre, pre_email, _ = await w.person(org=True, name="Pre Name")
        # an admin removed the person from the organization (what the old deletion did, without any deletion by the person): the person lives, the membership is closed
        await w.sql("UPDATE org_members SET deleted_at = now() - interval '90 days' WHERE user_id = :u", u=removed)
        await w.sql("UPDATE members SET deleted_at = now() - interval '90 days', is_active = false WHERE user_id = :u", u=removed)
        # a deactivation that is not the person's deletion (no `deleted_at`)
        await w.sql("UPDATE users SET is_active = false WHERE id = :u", u=deactivated)
        # an account with both new columns NULL — what every account is right after migration 0460 (no backfill; the migration itself is measured by Kadir's probe, not here)
        assert (await w.row(pre))["deleted_at"] is None and (await w.row(pre))["anonymized_at"] is None
        await _purge(w)   # (the count is not asserted: the database is shared with other tests — what matters is that none of THESE three is touched, below)
        for u, n in ((removed, "Removed Name"), (deactivated, "Deactivated Name"), (pre, "Pre Name")):
            r = await w.row(u)
            assert r["display_name"] == n and r["anonymized_at"] is None and r["email"].startswith("story4752-")
        assert (await w.sql("SELECT name FROM members WHERE user_id = :u AND type = 'human'", u=removed)).scalar_one() == "Removed Name"
        # …and the first run after the migration finds no target at all (no backfill): only the deletion makes one
        assert (await w.sql("SELECT count(*) FROM users WHERE deleted_at IS NOT NULL AND anonymized_at IS NULL AND id = ANY(CAST(:ids AS uuid[]))", ids=[removed, deactivated, pre])).scalar_one() == 0
    finally:
        await _close(engine, w)


async def test_09_a_deleted_account_is_not_a_mail_candidate_the_onboarding_reminder_skips_it():
    """Kadir's lens on 5187 (PO 5765): a person who deleted the account must not be mailed. The onboarding reminder picks people by their SIGN-UP time (no organization membership
    in the way), so it is the road that kept a deleted person on its list; the other recipient queries go through an open membership, which the deletion closes."""
    from app.services.onboarding_activation import find_reminder_candidates

    engine, w = await _world()
    try:
        live, live_email, _ = await w.person(org=False)
        gone, gone_email, _ = await w.person(org=False)
        for u in (live, gone):
            await w.sql("UPDATE users SET created_at = now() - interval '30 hours' WHERE id = :u", u=u)

        async def candidates() -> set:
            async with w.Session() as s:
                return {u.id for u in await find_reminder_candidates(s)}

        assert {live, gone} <= await candidates()            # both are due before the deletion
        assert (await w.delete(await w.tokens(gone_email))).status_code == 200
        got = await candidates()
        assert live in got and gone not in got               # the deleted account is out, the live one stays
        # anonymized later: still out
        await w.sql("UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = :u", u=gone)
        assert await _purge(w) >= 1
        assert gone not in await candidates()
    finally:
        await _close(engine, w)


async def test_10_the_mac_link_mail_is_not_sent_to_a_deleted_account():
    """Codex on the lens fix: `/desktop/mac-link-mail` read the user by id without `is_active`. Its callers hold a live session (a deleted account's tokens are cut off), so this is the same answer
    if one slips through — a stale-auth request for a deleted account is 404 and nothing is sent."""
    from unittest.mock import patch

    from app.dependencies.auth import AuthContext, get_current_user

    engine, w = await _world()
    try:
        uid, email, _ = await w.person(org=False)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        w.app.dependency_overrides[get_current_user] = lambda: AuthContext(user_id=str(uid), email=email, claims={"sub": str(uid)})
        with patch("app.services.email.send_email") as sent:
            r = await w.client.post("/api/v2/desktop/mac-link-mail")
        w.app.dependency_overrides.pop(get_current_user, None)
        assert r.status_code == 404, r.text
        sent.assert_not_called()
    finally:
        await _close(engine, w)


async def test_11_after_the_deletion_no_push_goes_to_the_persons_device_and_the_token_is_gone_after_the_purge():
    """Kadir's K8 on 5187 (PO 5768): the deleted person's phone kept getting pushes — `select_active_devices` (the one function both push senders use) returned the device (default branch:
    org + member + device.is_active, nothing about the person), and the token row outlived the purge. A device registered with the person (`user_id`) and one not backfilled (`user_id` NULL,
    tied by the member id) are closed at the deletion and deleted by the purge; another person's device is untouched; a device of a CLOSED SEAT is never selected."""
    from app.core.config import settings
    from ee.services.push_targets import select_active_devices

    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Push Receiver")
        other, _other_email, other_org = await w.person(org=True, name="Other Receiver")
        mid = (await w.sql("SELECT id FROM members WHERE user_id = :u AND type = 'human'", u=uid)).scalar_one()
        omid = (await w.sql("SELECT id FROM members WHERE user_id = :u AND type = 'human'", u=other)).scalar_one()
        t_user, t_member, t_other, t_closed = (f"ExponentPushToken[k8-{uid.hex[:10]}-{n}]" for n in ("u", "m", "o", "c"))
        ins = ("INSERT INTO push_devices (id, org_id, member_id, user_id, expo_push_token, platform, is_active) "
               "VALUES (gen_random_uuid(), :o, :m, :u, :t, 'ios', true)")
        await w.sql(ins, o=org_id, m=uuid.uuid4(), u=uid, t=t_user)      # tied to the person only by `user_id` (its member id is not one of the person's seats)
        await w.sql(ins, o=org_id, m=mid, u=None, t=t_member)            # not backfilled: tied to the person only by its member
        await w.sql(ins, o=other_org, m=omid, u=other, t=t_other)

        async def selected(by_user: bool, member=None) -> int:
            old = settings.push_devices_by_user
            settings.push_devices_by_user = by_user
            try:
                async with w.Session() as s:
                    org, seat = (org_id, mid) if member is None else (other_org, member)
                    return len(await select_active_devices(s, org, [seat]))
            finally:
                settings.push_devices_by_user = old

        assert await selected(False) == 1 and await selected(True) == 2   # live: by member 1 (flag off, the default) · by person 2 (flag on)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        assert await selected(False) == 0 and await selected(True) == 0   # before: 1 with the flag off (the default)
        active = (await w.sql("SELECT count(*) FROM push_devices WHERE expo_push_token IN (:a, :b) AND is_active", a=t_user, b=t_member)).scalar_one()
        assert active == 0                                                # closed in the deletion's own transaction (by user_id AND by member)
        assert (await w.sql("SELECT is_active FROM push_devices WHERE expo_push_token = :t", t=t_other)).scalar_one() is True   # another person's phone untouched
        assert await selected(False, omid) == 1                           # …and still selected
        # a SEAT that is closed (a person removed from the organization — not a deletion): its device row is still active, yet no push is selected for it
        # (the in-app list and the webhooks already skip it)
        await w.sql(ins, o=other_org, m=omid, u=None, t=t_closed)
        await w.sql("UPDATE members SET is_active = false WHERE id = :m", m=omid)        # how an admin's removal closes the anchor row: `is_active` (deleted_at stays NULL) …
        await w.sql("UPDATE org_members SET deleted_at = now() WHERE id = :m", m=omid)   # … and the org_members row of the same seat id
        assert (await w.sql("SELECT is_active FROM push_devices WHERE expo_push_token = :t", t=t_closed)).scalar_one() is True
        assert await selected(False, omid) == 0 and await selected(True, omid) == 0
        await w.sql("UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = :u", u=uid)
        assert await _purge(w) >= 1
        gone = (await w.sql("SELECT count(*) FROM push_devices WHERE expo_push_token IN (:a, :b)", a=t_user, b=t_member)).scalar_one()
        assert gone == 0                                                  # the token outlives nothing — by user_id (t_user) and by member (t_member)
        assert (await w.sql("SELECT count(*) FROM push_devices WHERE expo_push_token IN (:a, :b)", a=t_other, b=t_closed)).scalar_one() == 2
    finally:
        await _close(engine, w)
