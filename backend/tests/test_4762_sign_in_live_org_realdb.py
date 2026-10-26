"""story 4762 — signing in follows the same live-org rule as a refresh.

Before: `login` (and the OAuth callback) built the token with `_build_app_metadata(user, session)`, which scopes to `user.last_org_id` without asking whether the
person is still a member of it. A person removed from org A who is still in org B signed in with an A claim: `GET /api/v2/me` answered 404
`membership_elsewhere`, the web layout sent them to the sign-in, and the next sign-in gave the same claim — a loop with no way out. The sign-in now uses
`_sign_in_session_context` (= `_refresh_session_context` with no session org): `last_org_id` while it is a live membership, else the oldest live org, else a
claim without an org.

Real PG, the real endpoints, a person with two orgs.
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

_PASSWORD = "pw-" + "4762"


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
    def __init__(self, app, Session, client, user_id, email, orgs, projects):
        self.app, self.Session, self.client = app, Session, client
        self.user_id, self.email, self.orgs, self.projects = user_id, email, orgs, projects

    async def login(self) -> dict:
        resp = await self.client.post("/api/v2/auth/token", json={"email": self.email, "password": _PASSWORD})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    async def leave(self, org_id) -> None:
        from sqlalchemy import update

        from app.models.project import OrgMember

        async with self.Session() as s:
            await s.execute(update(OrgMember).where(OrgMember.user_id == self.user_id, OrgMember.org_id == org_id)
                            .values(deleted_at=datetime.now(timezone.utc)))
            await s.commit()

    async def last_org_id(self):
        from app.models.user import User

        async with self.Session() as s:
            return (await s.get(User, self.user_id)).last_org_id


def _org_claim(tokens: dict) -> str | None:
    from app.core.security import decode_jwt
    return (decode_jwt(tokens["access_token"]).get("app_metadata") or {}).get("org_id")


async def _world(org_count: int = 2, last_org_index: int = 0):
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.security import hash_password
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User
    from tests.conftest import override_db_and_read

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    user_id = uuid.uuid4()
    email = f"story4762-{user_id.hex[:8]}@test.com"
    orgs = []
    projects = []
    async with Session() as s:
        s.add(User(id=user_id, email=email, hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True))
        await s.commit()
        for n in range(1, org_count + 1):
            org = Organization(id=uuid.uuid4(), name=f"Org{n}", slug=f"o4762-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project_id = uuid.uuid4()
            s.add(Project(id=project_id, org_id=org.id, name=f"P{n}"))
            projects.append(project_id)
            # owner: project access through the org role (team_members is a read-only view)
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="owner",
                            created_at=datetime.now(timezone.utc) + timedelta(seconds=n)))
            await s.commit()
            orgs.append(org.id)
        user = await s.get(User, user_id)
        user.last_org_id = orgs[last_org_index]
        await s.commit()

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
    return engine, _World(app, Session, client, user_id, email, orgs, projects)


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


async def test_sign_in_after_leaving_the_last_org_lands_in_the_org_the_person_is_still_in():
    """removed from A (last_org_id = A), still in B → the sign-in carries B, not A (the loop the web layout's membership_elsewhere redirect would otherwise run)."""
    engine, w = await _world()
    try:
        a, b = w.orgs
        assert _org_claim(await w.login()) == str(a)  # control: a live last_org_id is kept
        await w.leave(a)
        tokens = await w.login()
        assert _org_claim(tokens) == str(b)
        # the session is usable: /me answers for that org instead of 404 membership_elsewhere
        me = await w.client.get("/api/v2/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
        assert me.status_code == 200, me.text
    finally:
        await _close(engine, w)


async def test_sign_in_keeps_a_live_last_org_even_when_it_is_not_the_oldest():
    engine, w = await _world(last_org_index=1)
    try:
        assert _org_claim(await w.login()) == str(w.orgs[1])
    finally:
        await _close(engine, w)


async def test_sign_in_with_several_live_orgs_and_a_stale_last_org_takes_the_oldest_live_one():
    """the refresh rule: `live_orgs[0]` (oldest membership first)."""
    engine, w = await _world(org_count=3, last_org_index=2)
    try:
        await w.leave(w.orgs[2])
        assert _org_claim(await w.login()) == str(w.orgs[0])
    finally:
        await _close(engine, w)


async def test_sign_in_with_no_live_org_left_carries_no_org_claim_and_clears_the_stale_last_org():
    """every membership left → the state of a new sign-up (no claim → /me answers `no_membership`, the onboarding path), never a departed org."""
    engine, w = await _world()
    try:
        for org in w.orgs:
            await w.leave(org)
        tokens = await w.login()
        assert not _org_claim(tokens)
        assert await w.last_org_id() is None
    finally:
        await _close(engine, w)


async def test_a_membership_orphaned_by_a_deleted_org_is_not_a_landing_place_for_a_sign_in():
    """org_members.org_id has no foreign key: a hard-deleted org can leave a membership row with deleted_at NULL (same case as the refresh test in 4400)."""
    from sqlalchemy import delete

    from app.models.organization import Organization

    engine, w = await _world()
    try:
        async with w.Session() as s:
            await s.execute(delete(Organization).where(Organization.id == w.orgs[0]))
            await s.commit()
        assert _org_claim(await w.login()) == str(w.orgs[1])
    finally:
        await _close(engine, w)


async def test_the_oauth_callback_lands_in_the_org_the_person_is_still_in_executed(monkeypatch):
    """the OAuth callback road, executed end to end (the provider exchange is faked): removed from A (last_org_id = A), still in B → the sign-in names B."""
    from unittest.mock import AsyncMock

    import app.routers.auth as auth_router
    from app.core.security import create_oauth_state_token

    engine, w = await _world()
    try:
        a, b = w.orgs
        await w.leave(a)
        monkeypatch.setattr(auth_router, "_exchange_oauth_code_for_userinfo", AsyncMock(return_value=(f"g-{w.user_id.hex}", w.email, True)))
        resp = await w.client.post("/api/v2/auth/oauth/callback", json={
            "provider": "google", "code": "c", "state": create_oauth_state_token("google"), "tos_accepted": True,
        })
        assert resp.status_code == 200, resp.text
        assert _org_claim(resp.json()["data"]) == str(b)
    finally:
        await _close(engine, w)


async def test_a_closed_seat_with_the_member_anchor_and_grant_still_active_carries_no_claim(monkeypatch):
    """the `{}` guard of the no-live-org branch (Kadir lens): the seat (org_members) is closed but the members anchor and the project grant are still active — `_build_app_metadata`
    alone would resolve the old org from them; the guard returns an empty claim instead, so the sign-in never names the org the person has no seat in."""
    from sqlalchemy import text

    from app.core.config import settings
    from app.models.member import Member

    # the default (flag off): `_build_app_metadata` finds the still-active anchor and resolves the old org, so it is the guard that keeps the claim empty. (With the flag on it returns `{}` earlier.)
    monkeypatch.setattr(settings, "build_app_metadata_defallback", False)
    engine, w = await _world(org_count=1)
    try:
        org = w.orgs[0]
        async with w.Session() as s:
            seat = (await s.execute(text("SELECT id FROM org_members WHERE org_id = :o AND user_id = :u"), {"o": org, "u": w.user_id})).scalar_one()
            s.add(Member(id=seat, org_id=org, type="human", user_id=w.user_id, name="M"))  # the anchor: same id as the seat
            await s.commit()
            await s.execute(text(
                "INSERT INTO project_access (id, project_id, org_member_id, member_id, permission, role, color, can_manage_members, access_source) "
                "VALUES (:i, :p, :om, :m, 'granted', 'member', '#3385f8', false, 'direct')"),
                {"i": uuid.uuid4(), "p": w.projects[0], "om": seat, "m": seat})
            await s.commit()
        await w.leave(org)  # the seat is closed; the anchor and the grant are not
        tokens = await w.login()
        assert not _org_claim(tokens)
        assert await w.last_org_id() is None  # `_build_app_metadata` wrote the departed org back; the guard clears it again
    finally:
        await _close(engine, w)


async def test_switch_project_with_a_token_of_an_org_the_person_has_left_is_refused_even_with_the_anchor_and_grant_active():
    """codex lens: the access token's own org A was left (the seat is closed) but the members anchor and the grant are still active — `has_project_access` lets that through, so the
    route itself must require a live seat in the token's org before it mints a token naming it."""
    from sqlalchemy import text

    from app.models.member import Member

    engine, w = await _world(org_count=1)
    try:
        org = w.orgs[0]
        tokens = await w.login()
        assert _org_claim(tokens) == str(org)
        async with w.Session() as s:
            seat = (await s.execute(text("SELECT id FROM org_members WHERE org_id = :o AND user_id = :u"), {"o": org, "u": w.user_id})).scalar_one()
            s.add(Member(id=seat, org_id=org, type="human", user_id=w.user_id, name="M"))
            await s.commit()
            await s.execute(text(
                "INSERT INTO project_access (id, project_id, org_member_id, member_id, permission, role, color, can_manage_members, access_source) "
                "VALUES (:i, :p, :om, :m, 'granted', 'member', '#3385f8', false, 'direct')"),
                {"i": uuid.uuid4(), "p": w.projects[0], "om": seat, "m": seat})
            await s.commit()
        await w.leave(org)
        resp = await w.client.post(
            "/api/v2/auth/switch-project",
            json={"project_id": str(w.projects[0]), "refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "NOT_MEMBER"
    finally:
        await _close(engine, w)


async def test_switch_project_with_a_claimless_token_is_refused_even_with_a_leftover_anchor_and_grant():
    """codex lens: a person whose last seat was closed signs in claim-less (the guard), but a members anchor + project grant are still active. A claim-less token has no org to switch a
    project in: `switch-project` must not let that leftover row mint a token naming the org (the live-seat check needs an org to check)."""
    from sqlalchemy import text

    from app.models.member import Member

    engine, w = await _world(org_count=1)
    try:
        org = w.orgs[0]
        async with w.Session() as s:
            seat = (await s.execute(text("SELECT id FROM org_members WHERE org_id = :o AND user_id = :u"), {"o": org, "u": w.user_id})).scalar_one()
            s.add(Member(id=seat, org_id=org, type="human", user_id=w.user_id, name="M"))
            await s.commit()
            await s.execute(text(
                "INSERT INTO project_access (id, project_id, org_member_id, member_id, permission, role, color, can_manage_members, access_source) "
                "VALUES (:i, :p, :om, :m, 'granted', 'member', '#3385f8', false, 'direct')"),
                {"i": uuid.uuid4(), "p": w.projects[0], "om": seat, "m": seat})
            await s.commit()
        await w.leave(org)
        tokens = await w.login()  # claim-less: no live org
        assert not _org_claim(tokens)
        resp = await w.client.post(
            "/api/v2/auth/switch-project",
            json={"project_id": str(w.projects[0]), "refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 403, resp.text
    finally:
        await _close(engine, w)


async def test_switch_org_does_not_accept_a_seat_in_an_organization_that_no_longer_exists():
    """codex lens: `org_members.org_id` has no foreign key — a hard-deleted organization can leave a live seat row. switch-org uses the same «live» predicate as `_live_org_ids`
    (the organization must still exist), so it cannot mint a token naming an organization that is gone."""
    from sqlalchemy import delete

    from app.models.organization import Organization

    engine, w = await _world()
    try:
        a, b = w.orgs
        tokens = await w.login()
        async with w.Session() as s:
            await s.execute(delete(Organization).where(Organization.id == b))
            await s.commit()
        resp = await w.client.post(
            "/api/v2/auth/switch-org",
            json={"org_id": str(b), "refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "NOT_ORG_MEMBER"
    finally:
        await _close(engine, w)


async def test_switch_project_names_the_callers_session_org_never_the_one_last_used_elsewhere():
    """Kadir lens: the person holds a token for org A, another session left `users.last_org_id` = B, and the person was removed from B. `switch-project` for a project of A used to
    build its claim from `last_org_id` → a new token naming the org they LEFT (the request auth trusts the JWT org when no X-Org-Id is sent). The claim now follows the caller's org."""
    from sqlalchemy import update

    from app.models.user import User

    engine, w = await _world()
    try:
        a, b = w.orgs
        tokens = await w.login()
        assert _org_claim(tokens) == str(a)  # the session token names A
        async with w.Session() as s:  # another session used B last, then the person is removed from B
            await s.execute(update(User).where(User.id == w.user_id).values(last_org_id=b))
            await s.commit()
        await w.leave(b)
        resp = await w.client.post(
            "/api/v2/auth/switch-project",
            json={"project_id": str(w.projects[0]), "refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 200, resp.text
        new = resp.json()["data"]
        assert _org_claim(new) == str(a)
        assert _org_claim(new) != str(b)
        assert await w.last_org_id() == a  # the stale pointer is repaired as a side effect
        # the departed org is not readable with a header either (the membership check): 403
        denied = await w.client.get("/api/v2/org-members", headers={"Authorization": f"Bearer {new['access_token']}", "X-Org-Id": str(b)})
        assert denied.status_code == 403, denied.text
    finally:
        await _close(engine, w)


# ── mutations: each re-opens the defect ────────────────────────────────────────

async def test_mutation_sign_in_that_trusts_last_org_id_again_issues_the_departed_org(monkeypatch):
    from app.routers import auth as auth_module

    async def _trusting(user, session):
        return await auth_module._build_app_metadata(user, session)

    monkeypatch.setattr(auth_module, "_sign_in_session_context", _trusting)
    engine, w = await _world()
    try:
        await w.leave(w.orgs[0])
        tokens = await w.login()
        # the pre-4762 defect: the token names the org the person LEFT, not the one they are still in
        assert _org_claim(tokens) == str(w.orgs[0])
    finally:
        await _close(engine, w)


def test_every_sign_in_road_uses_the_one_helper():
    """login, the OAuth callback and the native OAuth hand-off build their claim in ONE place; a new sign-in road that calls `_build_app_metadata` again is the
    defect back. (`register` is a brand-new person with no last_org_id — it stays on `_build_app_metadata`.)"""
    import inspect

    from app.routers import auth as auth_module
    from app.routers import auth_firebase_internal as handoff_module

    for fn, call in (
        (auth_module.login, "_sign_in_session_context(user, session)"),
        (auth_module.oauth_callback, "_sign_in_session_context(user, session)"),
        (handoff_module.consume_oauth_handoff, "_sign_in_session_context(user, db)"),
    ):
        src = inspect.getsource(fn)
        assert call in src, fn.__name__
        assert "_build_app_metadata(" not in src, fn.__name__
