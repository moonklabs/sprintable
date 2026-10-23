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

    async def person(self, *, org: bool, name: str = "Real Name", spare_owner: bool = True) -> tuple[uuid.UUID, str, uuid.UUID | None]:
        """A person who can sign in with a password; with an organization (as its owner, with a human member row carrying a name) or without any.

        `spare_owner` (default on): the organization also has a second, active owner — so the person is NOT its only owner and the account deletion (rule A: a sole owner is blocked, AC4)
        lets them go. The tests of the rule itself pass `spare_owner=False`."""
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
                if spare_owner:
                    await self.add_member(org_id, role="owner", name="Spare Owner")
        return uid, email, org_id

    async def add_member(self, org_id: uuid.UUID, *, role: str, name: str = "Teammate", active: bool = True, removed: bool = False) -> uuid.UUID:
        """Another person in the organization (one seat id in org_members and members, as in the product); returns the user id."""
        from app.core.security import hash_password
        from app.models.member import Member
        from app.models.project import OrgMember
        from app.models.user import User

        uid = uuid.uuid4()
        async with self.Session() as s:
            s.add(User(id=uid, email=f"story4752-m-{uid.hex[:10]}@test.com", hashed_password=hash_password(_PASSWORD), is_active=active, email_verified=True, display_name=name))
            await s.commit()
            seat = uuid.uuid4()
            s.add(OrgMember(id=seat, org_id=org_id, user_id=uid, role=role, deleted_at=datetime.now(timezone.utc) if removed else None))   # `removed`: the seat was closed (an admin took the person out)
            s.add(Member(id=seat, org_id=org_id, type="human", user_id=uid, name=name))
            await s.commit()
        return uid

    async def add_agent(self, org_id: uuid.UUID, name: str = "Bot Agent") -> uuid.UUID:
        """An agent member of the organization (a `members` row of type agent — org_members is human-only, so it is nobody's «other person»)."""
        from app.models.member import Member

        mid = uuid.uuid4()
        async with self.Session() as s:
            s.add(Member(id=mid, org_id=org_id, type="agent", name=name))
            await s.commit()
        return mid

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
        assert tuple(mem) == (None, None, None)   # no name text on the server: a marker (`ResolvedMember.departed`) and the screens word it (story #3779)
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


async def test_12_an_anonymized_person_reaches_the_screens_as_a_marker_not_as_a_sentence():
    """story #3779 (the guard on 5187): the server carries no «탈퇴한 사용자» text. After the purge the member's name is NULL and the resolver — both of its branches —
    answers `departed=True` with `name=None` (a real, resolved member); a live person stays `departed=False`, and the person is `departed` only after the purge (not at the deletion)."""
    from app.core.config import settings
    from app.services.member_resolver import lookup_members_by_ids

    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Leaving Person")
        other, _e, other_org = await w.person(org=True, name="Staying Person")
        mid = (await w.sql("SELECT id FROM members WHERE user_id = :u AND type = 'human'", u=uid)).scalar_one()
        omid = (await w.sql("SELECT id FROM members WHERE user_id = :u AND type = 'human'", u=other)).scalar_one()

        async def look(shadow: bool):
            old = settings.member_ssot_resolver_shadow
            settings.member_ssot_resolver_shadow = shadow
            try:
                async with w.Session() as s:
                    return await lookup_members_by_ids({mid, omid}, s)
            finally:
                settings.member_ssot_resolver_shadow = old

        for shadow in (False, True):
            got = await look(shadow)
            assert (got[mid].departed, got[omid].departed) == (False, False)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        await w.sql("UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = :u", u=uid)
        assert await _purge(w) >= 1
        for shadow in (False, True):
            got = await look(shadow)
            assert got[mid].departed is True and got[mid].name is None and got[mid].resolved is True, shadow
            assert got[omid].departed is False and got[omid].name == "Staying Person", shadow
    finally:
        await _close(engine, w)


async def test_13_the_participant_payload_carries_the_departed_marker():
    """story #3779/#4752: the chat participants payload (`_fetch_conversation_participants`) hands the resolver's `departed` to the screens — they word «탈퇴한 사용자 / Deleted user» in their own locale."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from app.routers.conversations import _fetch_conversation_participants
    from app.services.member_resolver import ResolvedMember

    conv, gone, here = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    org = uuid.uuid4()
    resolved = {
        gone: ResolvedMember(id=gone, user_id=uuid.uuid4(), name=None, type="human", role="member", org_id=org, departed=True),
        here: ResolvedMember(id=here, user_id=uuid.uuid4(), name="Here", type="human", role="member", org_id=org),
    }

    class Db:
        calls = 0

        async def execute(self, _stmt):
            Db.calls += 1
            rows = [SimpleNamespace(conversation_id=conv, member_id=gone), SimpleNamespace(conversation_id=conv, member_id=here)] if Db.calls == 1 else []
            return SimpleNamespace(all=lambda: rows)

    async def fake_lookup(ids, _db):
        return resolved

    with patch("app.routers.conversations.lookup_members_by_ids", fake_lookup):
        out = (await _fetch_conversation_participants([conv], Db()))[conv]
    by_id = {p["member_id"]: p for p in out}
    assert by_id[str(gone)]["departed"] is True and by_id[str(gone)]["name"] is None and by_id[str(gone)]["resolved"] is True
    assert by_id[str(here)]["departed"] is False


async def test_14_the_by_person_push_branch_skips_a_closed_seat_too():
    """PO 5770 (Kadir's note on the K8 fix): with `push_devices_by_user` on, the branch that selects by the PERSON looked only at `org_members.deleted_at`, so a seat closed on the `members` side
    (`members.is_active = false`, as an admin's removal does) with a live `org_members` row still got the push. Both branches use the same «closed» now."""
    from app.core.config import settings
    from ee.services.push_targets import select_active_devices

    engine, w = await _world()
    try:
        uid, _email, org_id = await w.person(org=True, name="Removed On One Side")
        mid = (await w.sql("SELECT id FROM members WHERE user_id = :u AND type = 'human'", u=uid)).scalar_one()
        await w.sql("INSERT INTO push_devices (id, org_id, member_id, user_id, expo_push_token, platform, is_active) VALUES (gen_random_uuid(), :o, :m, :u, :t, 'ios', true)",
                    o=org_id, m=mid, u=uid, t=f"ExponentPushToken[k14-{uid.hex[:10]}]")

        async def selected() -> int:
            old = settings.push_devices_by_user
            settings.push_devices_by_user = True
            try:
                async with w.Session() as s:
                    return len(await select_active_devices(s, org_id, [mid]))
            finally:
                settings.push_devices_by_user = old

        assert await selected() == 1                                                     # live
        await w.sql("UPDATE members SET is_active = false WHERE id = :m", m=mid)        # closed on the members side only; org_members.deleted_at stays NULL
        assert (await w.sql("SELECT deleted_at IS NULL FROM org_members WHERE id = :m", m=mid)).scalar_one() is True
        assert await selected() == 0
    finally:
        await _close(engine, w)



async def _org_exists(w, org_id) -> bool:
    return bool((await w.sql("SELECT count(*) FROM organizations WHERE id = :o", o=org_id)).scalar_one())


async def test_15_an_organization_with_nobody_else_in_it_closes_with_the_account_whatever_the_role():
    """story #4752 AC4 (PO rule, revised): when nobody else is active in an organization it CLOSES with the account (the owner's organization delete, no typed name) — else the web's onboarding
    would make a new one on every deletion and a person who uses it alone could never leave. Whatever the person's role there; a co-member whose own account is not active, or whose seat is
    closed, is nobody. Another person's organization is untouched."""
    engine, w = await _world()
    try:
        # ① alone as the owner
        uid, email, org_id = await w.person(org=True, name="Alone Owner", spare_owner=False)
        agent_id = await w.add_agent(org_id)                                                 # an agent is not «another person»: it neither takes the organization over nor owns it
        stranger, _e, stranger_org = await w.person(org=True, name="Someone Else", spare_owner=False)
        r = await w.delete(await w.tokens(email))
        assert r.status_code == 200, r.text
        assert not await _org_exists(w, org_id)                                              # the organization closed with the account
        assert (await w.sql("SELECT count(*) FROM members WHERE id = :m", m=agent_id)).scalar_one() == 0   # …and its agent went with it
        assert await _org_exists(w, stranger_org)                                            # another person's organization is untouched
        assert (await w.sql("SELECT count(*) FROM deletion_audit_logs WHERE entity_id = :o AND actor_id = :u", o=org_id, u=uid)).scalar_one() == 1   # the closing is on the record, as an owner's delete is
        assert (await w.sql("SELECT count(*) FROM org_members WHERE org_id = :o AND deleted_at IS NULL", o=org_id)).scalar_one() == 0
        # ② a co-owner whose ACCOUNT is not active, and one whose SEAT was closed, are nobody: still alone
        uid2, email2, org2 = await w.person(org=True, name="Alone With Ghosts", spare_owner=False)
        await w.add_member(org2, role="owner", name="Dead Account", active=False)
        await w.add_member(org2, role="member", name="Removed Seat", removed=True)
        assert (await w.delete(await w.tokens(email2))).status_code == 200 and not await _org_exists(w, org2)
        # ③ alone, but only an admin there (the owner's seat was closed): the role does not matter
        admin_uid, admin_email, _o = await w.person(org=False, name="Lone Admin")
        _x, _xe, org3 = await w.person(org=True, name="Gone Owner", spare_owner=False)
        await w.sql("UPDATE org_members SET deleted_at = now() WHERE org_id = :o AND role = 'owner'", o=org3)
        await w.sql("INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid(), :o, :u, 'admin')", o=org3, u=admin_uid)
        assert (await w.delete(await w.tokens(admin_email))).status_code == 200 and not await _org_exists(w, org3)
    finally:
        await _close(engine, w)


async def test_16_the_only_owner_of_an_organization_that_has_other_people_cannot_leave_until_it_is_handed_over():
    """AC4 (PO rule): other active people are in the organization and the person is its only active owner → 409 `ORG_BLOCKS_ACCOUNT_DELETE` (the organizations by name, `reason`
    `other_members`) and NOTHING changes (the organization stays, the person can still sign in). Another active owner, or being no owner there, or no organization → not blocked."""
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Only Owner", spare_owner=False)
        await w.add_member(org_id, role="member", name="Teammate")
        r = await w.delete(await w.tokens(email))
        assert r.status_code == 409, r.text
        err = r.json()["error"]
        assert err["code"] == "ORG_BLOCKS_ACCOUNT_DELETE"
        assert [(o["id"], o["reason"]) for o in err["orgs"]] == [(str(org_id), "other_members")] and err["orgs"][0]["name"].startswith("Org-")
        row = await w.row(uid)
        assert row["is_active"] is True and row["deleted_at"] is None and await _org_exists(w, org_id)
        assert (await w.sql("SELECT count(*) FROM org_members WHERE user_id = :u AND deleted_at IS NULL", u=uid)).scalar_one() == 1
        assert (await w.login(email)).status_code == 200
        # a second owner whose own ACCOUNT is not active does not count as an owner who stays: with an active teammate in it, the person is still the only owner
        uid_g, email_g, org_g = await w.person(org=True, name="Owner With Ghost Co-owner", spare_owner=False)
        await w.add_member(org_g, role="owner", name="Dead Account Owner", active=False)
        await w.add_member(org_g, role="member", name="Active Teammate")
        assert (await w.delete(await w.tokens(email_g))).status_code == 409
        # handing the organization over (a second owner) lets the person go; the organization stays with its owner
        await w.sql("UPDATE org_members SET role = 'owner' WHERE org_id = :o AND role = 'member' AND deleted_at IS NULL", o=org_id)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        assert await _org_exists(w, org_id)
        assert (await w.sql("SELECT count(*) FROM org_members WHERE org_id = :o AND role = 'owner' AND deleted_at IS NULL", o=org_id)).scalar_one() == 1
        # an admin of a populated organization (not its owner): not blocked, the organization stays
        admin_uid, admin_email, _o = await w.person(org=False, name="Plain Admin")
        owner_uid, _oe, org5 = await w.person(org=True, name="Org Owner", spare_owner=False)
        await w.sql("INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid(), :o, :u, 'admin')", o=org5, u=admin_uid)
        assert (await w.delete(await w.tokens(admin_email))).status_code == 200 and await _org_exists(w, org5)
    finally:
        await _close(engine, w)


async def test_17_an_organization_with_a_subscription_that_would_close_with_the_account_blocks_it():
    """AC4: the person is alone in an organization that has an active subscription → 409 (`reason` active_subscription: cancel it first); nothing closes, the person stays. Once the
    subscription is not active the account goes and the organization closes with it. (A populated organization with a subscription is the other_members case, not this one.)"""
    from app.models.org_subscription import OrgSubscription

    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Pays Alone", spare_owner=False)
        async with w.Session() as s:
            s.add(OrgSubscription(id=uuid.uuid4(), org_id=org_id, tier="pro", status="active"))
            await s.commit()
        r = await w.delete(await w.tokens(email))
        assert r.status_code == 409
        assert [(o["id"], o["reason"]) for o in r.json()["error"]["orgs"]] == [(str(org_id), "active_subscription")]
        assert (await w.row(uid))["is_active"] is True and await _org_exists(w, org_id)
        await w.sql("UPDATE org_subscriptions SET status = 'canceled' WHERE org_id = :o", o=org_id)
        assert (await w.delete(await w.tokens(email))).status_code == 200 and not await _org_exists(w, org_id)
    finally:
        await _close(engine, w)


async def test_18_the_preview_names_what_would_close_and_what_would_block():
    """The confirmation window shows it before «삭제 확인»: `closing` (they close with the account) and `blocked` (with the reason). Read only — nothing is changed."""
    engine, w = await _world()
    try:
        uid, email, alone_org = await w.person(org=True, name="Previewer", spare_owner=False)
        await w.add_agent(alone_org)                                                         # one person + an agent: the agent does not make it «populated»
        tokens = await w.tokens(email)

        async def preview():
            r = await w.client.get("/api/v2/account/delete-preview", headers={"Authorization": f"Bearer {tokens['access_token']}"})
            assert r.status_code == 200, r.text
            return r.json()

        p = await preview()
        assert [o["id"] for o in p["closing"]] == [str(alone_org)] and p["blocked"] == []
        sub_uid, sub_email, sub_org = await w.person(org=True, name="Pays", spare_owner=False)
        from app.models.org_subscription import OrgSubscription
        async with w.Session() as s2:
            s2.add(OrgSubscription(id=uuid.uuid4(), org_id=sub_org, tier="pro", status="active"))
            await s2.commit()
        r = await w.client.get("/api/v2/account/delete-preview", headers={"Authorization": f"Bearer {(await w.tokens(sub_email))['access_token']}"})
        assert r.json()["closing"] == [] and [(o["id"], o["reason"]) for o in r.json()["blocked"]] == [(str(sub_org), "active_subscription")]
        await w.add_member(alone_org, role="member", name="Joins")
        p = await preview()
        assert p["closing"] == [] and [(o["id"], o["reason"]) for o in p["blocked"]] == [(str(alone_org), "other_members")]
        assert await _org_exists(w, alone_org) and (await w.row(uid))["is_active"] is True        # nothing changed by looking
        # not signed in as a person with an account: an API key / unknown id gets nothing
        r = await w.client.get("/api/v2/account/delete-preview")
        assert r.status_code in (401, 403)
    finally:
        await _close(engine, w)


async def test_19_someone_who_joined_after_the_plan_stops_the_closing_of_an_organization():
    """codex on 5189: the plan saw nobody else, then somebody joined (an accepted invite does not take the organization lock). The closing looks again under the row lock and refuses —
    `members_joined` — instead of deleting an organization that now has people in it."""
    from app.repositories.organization import OrganizationRepository

    engine, w = await _world()
    try:
        uid, _email, org_id = await w.person(org=True, name="Alone Then Joined", spare_owner=False)
        await w.add_member(org_id, role="member", name="Joined Late")
        async with w.Session() as s:
            res = await OrganizationRepository(s).delete_for_account_closure(org_id, uid)
            await s.rollback()
        assert res == {"ok": False, "reason": "members_joined"}, res
        assert await _org_exists(w, org_id)
    finally:
        await _close(engine, w)
