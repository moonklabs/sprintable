"""story 4782 — a switch (switch-org · switch-project) must not give a new 30-day refresh token to a session that was already ended.

Before: `_revoke_switching_session` never looked at how many rows its UPDATE ended. A refresh token that was already ended (a logout, «sign out everywhere else», an
administrator's removal) matched 0 rows and the handler went on; with no token sent it ended every live token (0 of them) and went on. `switch_project` / `switch_organization`
then stored and returned a fresh pair either way. So the access token left over after the revoke (up to 60 minutes) turned into a refresh token that lives 30 days.

Real PG, the real endpoints, two real sessions of one person in two organizations (and an administrator for the removal case).
Every «refused» check also counts the person's refresh-token rows before and after: a refused switch must leave no new row.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_PASSWORD = "pw-" + "4782"


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
    def __init__(self, app, Session, client, user_id, email, org1, org2, project1, project2, admin_email):
        self.app, self.Session, self.client = app, Session, client
        self.user_id, self.email, self.org1, self.org2 = user_id, email, org1, org2
        self.project1, self.project2, self.admin_email = project1, project2, admin_email

    async def login(self, email: str | None = None) -> dict:
        resp = await self.client.post("/api/v2/auth/token", json={"email": email or self.email, "password": _PASSWORD})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    async def refresh(self, rt: str):
        return await self.client.post("/api/v2/auth/refresh", json={"refresh_token": rt})

    async def switch(self, route: str, access: str, refresh: str | None, *, org=None, project=None):
        body: dict = {"org_id": str(org)} if route == "switch-org" else {"project_id": str(project)}
        if refresh is not None:
            body["refresh_token"] = refresh
        return await self.client.post(
            f"/api/v2/auth/{route}", json=body, headers={"Authorization": f"Bearer {access}"},
        )

    async def switch_to_org2(self, access: str, refresh: str | None):
        return await self.switch("switch-org", access, refresh, org=self.org2)

    async def switch_to_project2(self, access: str, refresh: str | None):
        return await self.switch("switch-project", access, refresh, project=self.project2)

    async def token_rows(self) -> int:
        from sqlalchemy import func, select

        from app.models.user import RefreshToken

        async with self.Session() as s:
            return (await s.execute(select(func.count()).select_from(RefreshToken).where(RefreshToken.user_id == self.user_id))).scalar_one()

    async def live_tokens(self) -> int:
        from sqlalchemy import func, select

        from app.models.user import RefreshToken

        async with self.Session() as s:
            return (await s.execute(select(func.count()).select_from(RefreshToken).where(
                RefreshToken.user_id == self.user_id, RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > datetime.now(timezone.utc),
            ))).scalar_one()


async def _world():
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
    user_id, admin_id = uuid.uuid4(), uuid.uuid4()
    email, admin_email = f"story4782-{user_id.hex[:8]}@test.com", f"story4782a-{admin_id.hex[:8]}@test.com"
    orgs, projects = [], []
    async with Session() as s:
        for uid, mail in ((user_id, email), (admin_id, admin_email)):
            s.add(User(id=uid, email=mail, hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True))
        await s.commit()
        for n in (1, 2):
            org = Organization(id=uuid.uuid4(), name=f"Org{n}", slug=f"o4782-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name=f"P{n}")
            s.add(project)
            if n == 1:  # a second project of org1: switch-project moves between projects of the session's own org
                project_b = Project(id=uuid.uuid4(), org_id=org.id, name="P1b")
                s.add(project_b)
            # org1: the person is an admin (reaches every project through the role, and an owner can still remove them); org2: owner
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="admin" if n == 1 else "owner",
                            created_at=datetime.now(timezone.utc) + timedelta(seconds=n)))
            if n == 1:
                s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=admin_id, role="owner",
                                created_at=datetime.now(timezone.utc) + timedelta(seconds=n)))
            await s.commit()
            orgs.append(org.id)
            projects.append(project.id)
        user = await s.get(User, user_id)
        user.last_org_id = orgs[0]
        admin = await s.get(User, admin_id)
        admin.last_org_id = orgs[0]
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
    return engine, _World(app, Session, client, user_id, email, orgs[0], orgs[1], projects[0], project_b.id, admin_email)


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


_SWITCHES = ["switch_to_org2", "switch_to_project2"]


async def _last_context(w: _World):
    from app.models.user import User

    async with w.Session() as s:
        user = await s.get(User, w.user_id)
        return user.last_org_id, user.last_project_id


async def _refused(w: _World, call, access: str, refresh: str | None, rows_before: int, *, why: str, code: str | None = "TOKEN_REVOKED"):
    context_before = await _last_context(w)
    resp = await call(access, refresh)
    assert resp.status_code == 401, f"{why}: expected 401, got {resp.status_code} {resp.text}"
    if code is not None:
        assert resp.json()["error"]["code"] == code, f"{why}: expected {code}, got {resp.text}"
    assert await w.token_rows() == rows_before, f"{why}: a refused switch left a new refresh token row"
    # `get_db` commits when the handler returns, a refusal included: the handler must refuse before it writes the person's last org / project
    assert await _last_context(w) == context_before, f"{why}: a refused switch moved the person's last org / project"
    return resp


# ── AC1: the access token that is left over after a revoke cannot switch ──────────────────────────────────────────────

@pytest.mark.parametrize("switch", _SWITCHES)
async def test_after_logout_the_leftover_access_and_the_logged_out_token_cannot_switch(switch):
    engine, w = await _world()
    try:
        a = await w.login()
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": a["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="logged-out token")
        assert await w.live_tokens() == 0
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_after_logout_the_leftover_access_alone_cannot_switch(switch):
    """no refresh token sent (the old web pod's shape, or a thief who has only the access token): the person has no live token at all — there is no session to switch."""
    engine, w = await _world()
    try:
        a = await w.login()
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": a["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], None, before, why="no token, nothing live")
        assert await w.live_tokens() == 0
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_after_logout_others_the_other_session_cannot_switch(switch):
    engine, w = await _world()
    try:
        a, b = await w.login(), await w.login()
        resp = await w.client.post(
            "/api/v2/auth/logout-others", json={"refresh_token": a["refresh_token"]},
            headers={"Authorization": f"Bearer {a['access_token']}"},
        )
        assert resp.status_code == 200 and resp.json()["data"]["kept_this"] is True, resp.text
        live_before = await w.live_tokens()
        assert live_before == 1  # only A lives
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), b["access_token"], b["refresh_token"], before, why="B after logout-others")
        assert await w.live_tokens() == live_before  # A was not touched either
        assert (await w.refresh(a["refresh_token"])).status_code == 200
    finally:
        await _close(engine, w)


async def test_after_an_administrator_removed_the_person_the_leftover_access_cannot_switch_org():
    """removal from org1 ends every token of the person (`_revoke_user_refresh_tokens`); the person still sits in org2 — the old access + old token must not open a new session there."""
    from sqlalchemy import select

    from app.models.project import OrgMember

    engine, w = await _world()
    try:
        member = await w.login()
        admin = await w.login(w.admin_email)
        async with w.Session() as s:
            seat = (await s.execute(select(OrgMember.id).where(OrgMember.org_id == w.org1, OrgMember.user_id == w.user_id))).scalar_one()
        resp = await w.client.delete(f"/api/v2/org-members/{seat}", headers={"Authorization": f"Bearer {admin['access_token']}"})
        assert resp.status_code == 200, resp.text
        assert await w.live_tokens() == 0
        before = await w.token_rows()
        await _refused(w, w.switch_to_org2, member["access_token"], member["refresh_token"], before, why="removed person's old token")
        await _refused(w, w.switch_to_org2, member["access_token"], None, before, why="removed person, no token sent")
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_after_a_password_change_the_leftover_access_cannot_switch_3649(switch):
    """already held by #3649 (`_is_session_stale_after_password_change`) and #4630 (a change ends every session) — measured here, not changed: the word is SESSION_INVALIDATED."""
    engine, w = await _world()
    try:
        a = await w.login()
        await asyncio.sleep(1.1)  # #3649 compares whole seconds: a change in the second the session began is not «after» it (#3750)
        resp = await w.client.patch(
            "/api/v2/auth/change-password", json={"current_password": _PASSWORD, "new_password": _PASSWORD + "-new"},
            headers={"Authorization": f"Bearer {a['access_token']}"},
        )
        assert resp.status_code == 200, resp.text
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="after a password change", code="SESSION_INVALIDATED")
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_every_token_ended_without_a_password_change_the_leftover_access_alone_cannot_switch(switch):
    """the shape of the first measurement (every token of the person ended: `revoked_at = expires_at = now`, no `password_set_at`): not a real password change, so only the token check can refuse it."""
    from sqlalchemy import update

    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        a, _b = await w.login(), await w.login()
        now = datetime.now(timezone.utc)
        async with w.Session() as s:
            await s.execute(update(RefreshToken).where(RefreshToken.user_id == w.user_id).values(revoked_at=now, expires_at=now))
            await s.commit()
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], None, before, why="all ended, no token sent")
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="all ended, own token sent")
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_token_that_a_switch_already_ended_cannot_switch_again(switch):
    """a switch ends the token it was given and returns a new one; the ended token (explicit revoke) is not a session to switch from — a repeat with it (a retry whose first answer was lost) gets no second pair."""
    engine, w = await _world()
    try:
        a = await w.login()
        first = await getattr(w, switch)(a["access_token"], a["refresh_token"])
        assert first.status_code == 200, first.text
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="repeat with the ended token", code="TOKEN_SUPERSEDED")
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_token_past_its_expiry_that_was_never_revoked_cannot_switch(switch):
    from sqlalchemy import update

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        a = await w.login()
        async with w.Session() as s:
            await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(a["refresh_token"]))
                            .values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
            await s.commit()
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="expired, never revoked")
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_token_ended_at_a_moment_later_than_this_requests_clock_cannot_switch(switch):
    """codex 4782 round 1: a request that ended the token while ours waited took its clock at ITS start — possibly later than ours — and an explicit end lowers `expires_at` to that moment. The row
    then looks «still ahead» to a straggler test that compares with our older `now`. An explicit end (`expires_at == revoked_at`) is never a rotation straggler, whatever the clocks say."""
    from sqlalchemy import update

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        a = await w.login()
        ended_at = datetime.now(timezone.utc) + timedelta(seconds=30)
        async with w.Session() as s:
            await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(a["refresh_token"]))
                            .values(revoked_at=ended_at, expires_at=ended_at))
            await s.commit()
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="ended at a later clock", code=None)
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_two_switches_crossing_with_the_same_token_get_one_new_pair(switch):
    """the same race for real: both requests present the one live token at once — one claims it, the other finds it ended (explicitly: not a rotation) and is refused. Repeated, because who
    takes the row first and whose clock is later is not ours to pick."""
    engine, w = await _world()
    try:
        for round_n in range(8):
            a = await w.login()
            before = await w.token_rows()
            first, second = await asyncio.gather(
                getattr(w, switch)(a["access_token"], a["refresh_token"]), getattr(w, switch)(a["access_token"], a["refresh_token"]),
            )
            codes = sorted([first.status_code, second.status_code])
            assert codes == [200, 401], f"round {round_n}: two crossing switches ended {codes}: {first.text} {second.text}"
            assert await w.token_rows() == before + 1, f"round {round_n}: more than one new refresh token came out of one session"
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_after_logout_a_rotated_predecessor_inside_its_old_window_cannot_switch(switch):
    """Kadir's lens on this PR (a survivor mutant): R0 -> R1 -> R2 by refresh, then the session logs out with R2. The logout closes the grace window of R1 and R0 (`expires_at` lowered to that moment while
    `revoked_at` stays recent), so each LOOKS like a rotation straggler by every field except `expires_at > now`. A switch with R1 or R0 must be refused and mint nothing; without that one condition the
    session that has just logged out buys a new 30-day pair."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        r2 = (await w.refresh(r1["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": r2["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        for name, old in (("R1 (right before)", r1), ("R0 (two back)", r0)):
            await _refused(w, getattr(w, switch), old["access_token"], old["refresh_token"], before, why=f"a window the logout closed: {name}", code=None)
        assert await w.live_tokens() == 0
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_late_switch_behind_two_switches_is_told_moved_on_like_the_late_refresh(switch):
    """the switch and the refresh read the SAME chain (story 4778's walk): A -> switch -> B -> switch -> C. The token A that left before the first answer landed is late, not dead — a switch with it is
    refused with TOKEN_SUPERSEDED (the client renews, it is not signed out), exactly the word the refresh with it gets. A walk that stopped at B (explicitly ended, with a successor) would call it REVOKED here."""
    engine, w = await _world()
    try:
        a = await w.login()
        first = await w.switch_to_project2(a["access_token"], a["refresh_token"])
        assert first.status_code == 200, first.text
        b = first.json()["data"]
        second = await w.switch_to_org2(b["access_token"], b["refresh_token"])
        assert second.status_code == 200, second.text
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="late switch behind two switches", code="TOKEN_SUPERSEDED")
        late = await w.refresh(a["refresh_token"])
        assert late.status_code == 401 and late.json()["error"]["code"] == "TOKEN_SUPERSEDED", late.text
        assert (await w.refresh(second.json()["data"]["refresh_token"])).status_code == 200  # the session's newest token lives on
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_late_switch_behind_two_switches_is_revoked_once_the_session_was_logged_out(switch):
    """the same chain, but the newest token was logged out: the session is over, the walk stops at that end (it moved nowhere) and a switch with the first token is REVOKED, as the refresh with it is."""
    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.switch_to_project2(a["access_token"], a["refresh_token"])).json()["data"]
        c = (await w.switch_to_org2(b["access_token"], b["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": c["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], a["refresh_token"], before, why="late switch, session logged out", code="TOKEN_REVOKED")
        late = await w.refresh(a["refresh_token"])
        assert late.status_code == 401 and late.json()["error"]["code"] == "TOKEN_REVOKED", late.text
    finally:
        await _close(engine, w)


# ── AC4: the other road that gives a new pair to a token that is not the live one ─────────────────────────────────────

async def test_after_logout_the_token_that_was_rotated_just_before_cannot_refresh():
    """plain logout ends only the token it is given. The token a refresh spent a moment ago (`revoked_at` set · `expires_at` left, the rotation grace window) is the logged-out session's
    own predecessor — `_revoke_other_sessions` closes such windows (logout-others · password change · removal), logout does not."""
    engine, w = await _world()
    try:
        a = await w.login()
        rotated = await w.refresh(a["refresh_token"])
        assert rotated.status_code == 200, rotated.text
        a2 = rotated.json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": a2["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        resp = await w.refresh(a["refresh_token"])  # the predecessor, inside its grace window
        assert resp.status_code == 401, f"the logged-out session forked a new pair from its predecessor: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
    finally:
        await _close(engine, w)


async def test_after_logout_every_predecessor_inside_the_grace_window_cannot_refresh():
    """two rotations inside the 180 s window leave TWO predecessors (a → b → c): logging c out closes the whole chain that leads to it, not only the token right before it."""
    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.refresh(a["refresh_token"])).json()["data"]
        c = (await w.refresh(b["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": c["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        for name, old in (("b (right before)", b), ("a (two back)", a)):
            resp = await w.refresh(old["refresh_token"])
            assert resp.status_code == 401, f"the logged-out session forked a new pair from its predecessor {name}: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
    finally:
        await _close(engine, w)


async def test_after_logout_a_predecessor_far_back_in_a_long_chain_cannot_refresh():
    """codex 4782 round 2: rotations are free inside the 180 s window, so whoever holds a token can make the chain as long as they like. The close follows the chain to its very first token (no hop cap):
    after 70 rotations the logged-out session's first token must not fork a new pair."""
    engine, w = await _world()
    try:
        first = await w.login()
        newest = first
        for _ in range(70):
            rotated = await w.refresh(newest["refresh_token"])
            assert rotated.status_code == 200, rotated.text
            newest = rotated.json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": newest["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        resp = await w.refresh(first["refresh_token"])
        assert resp.status_code == 401, f"the first token of a 70-hop chain forked a new pair after the logout: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
    finally:
        await _close(engine, w)


async def test_after_logout_a_predecessor_behind_a_switch_ended_hop_cannot_refresh():
    """the walk is bounded by TIME (`revoked_at` inside the rotation window), not by «the window is still open»: a → (refresh) → b → (switch) → c. `b` was ended by the switch, so its own window is
    CLOSED (`expires_at == revoked_at`) — but `a`, rotated a moment earlier, still has its window open. Logging `c` out must reach `a` THROUGH the closed `b`. A walk that stopped at the first
    closed hop (the shape «only follow rows whose window is open») would leave `a` able to fork a new pair."""
    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.refresh(a["refresh_token"])).json()["data"]
        c = (await w.switch_to_project2(b["access_token"], b["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": c["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        resp = await w.refresh(a["refresh_token"])
        assert resp.status_code == 401, f"the logged-out session forked a new pair from `a`, behind a switch-ended hop: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
    finally:
        await _close(engine, w)


async def test_after_logout_a_hop_stamped_a_little_early_by_a_slow_clock_does_not_end_the_walk():
    """codex 4782 round 5: `revoked_at` is stamped by whichever app pod ended the token, and pods' clocks differ. a (rotated, window open, stamped 170 s ago) -> b (ended by a switch on a pod whose clock
    is slow: stamped 185 s ago, i.e. OLDER than a) -> c. The time bound of the walk carries slack for exactly this: with the bare 180 s the walk would stop at `b` and `a` would stay open."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.refresh(a["refresh_token"])).json()["data"]
        c = (await w.switch_to_project2(b["access_token"], b["refresh_token"])).json()["data"]
        now = datetime.now(timezone.utc)
        async with w.Session() as s:
            await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(a["refresh_token"])).values(revoked_at=now - timedelta(seconds=170)))
            await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(b["refresh_token"])).values(revoked_at=now - timedelta(seconds=185), expires_at=now - timedelta(seconds=185)))
            await s.commit()
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": c["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        resp = await w.refresh(a["refresh_token"])
        assert resp.status_code == 401, f"a hop stamped early by a slow clock ended the walk: `a` forked a new pair after the logout: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
    finally:
        await _close(engine, w)


async def test_the_logout_walk_stops_at_the_first_row_older_than_the_window():
    """Kadir's lens (a survivor mutant): the time bound must hold on EVERY hop, not only the first — it is what keeps a logout's cost independent of how long a chain somebody made. a -> b -> c -> d by
    refresh; a and b were rotated an hour ago (rows aged by hand: `revoked_at` an hour back, their `expires_at` left ahead so that a touch would show), c a moment ago. Logging d out closes c's
    window and goes no further: a and b are not exploitable any more and are not touched."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select, update

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.refresh(a["refresh_token"])).json()["data"]
        c = (await w.refresh(b["refresh_token"])).json()["data"]
        d = (await w.refresh(c["refresh_token"])).json()["data"]
        now = datetime.now(timezone.utc)
        async with w.Session() as s:
            for old in (a, b):
                await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(old["refresh_token"])).values(revoked_at=now - timedelta(hours=1)))
            await s.commit()

        async def expires(token: dict):
            async with w.Session() as s:
                return (await s.execute(select(RefreshToken.expires_at).where(RefreshToken.token_hash == hash_token(token["refresh_token"])))).scalar_one()

        a_before, b_before = await expires(a), await expires(b)
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": d["refresh_token"]})).status_code == 200
        assert await expires(c) <= datetime.now(timezone.utc), "the recent predecessor's window was not closed"
        assert await expires(b) == b_before, "the walk went past the first row older than the window (b)"
        assert await expires(a) == a_before, "the walk went past the first row older than the window (a)"
    finally:
        await _close(engine, w)


async def test_a_logout_of_one_session_leaves_the_grace_window_of_another_session_open():
    """control: the chain closed is the logged-out session's own — another device's just-rotated token keeps its straggler window."""
    engine, w = await _world()
    try:
        a, other = await w.login(), await w.login()
        other2 = (await w.refresh(other["refresh_token"])).json()["data"]
        a2 = (await w.refresh(a["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": a2["refresh_token"]})).status_code == 200
        assert (await w.refresh(other["refresh_token"])).status_code == 200  # the other device's predecessor is still a straggler, as before
        assert other2["refresh_token"]
    finally:
        await _close(engine, w)


# ── controls: what must keep working (green before and after) ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_live_session_switches_as_before(switch):
    engine, w = await _world()
    try:
        a = await w.login()
        before = await w.token_rows()
        resp = await getattr(w, switch)(a["access_token"], a["refresh_token"])
        assert resp.status_code == 200, resp.text
        new = resp.json()["data"]
        assert await w.token_rows() == before + 1
        assert new["refresh_token"] != a["refresh_token"]
        assert (await w.refresh(new["refresh_token"])).status_code == 200  # the new token is a working session
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_token_a_refresh_rotated_a_moment_ago_still_switches(switch):
    """the rotation straggler: the old token was ended by a refresh rotation (`revoked_at` set, `expires_at` left) — not by anybody ending the session. Its switch is a normal one."""
    engine, w = await _world()
    try:
        a = await w.login()
        rotated = await w.refresh(a["refresh_token"])
        assert rotated.status_code == 200, rotated.text
        resp = await getattr(w, switch)(a["access_token"], a["refresh_token"])  # the access + the token the refresh just spent
        assert resp.status_code == 200, resp.text
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_switch_without_the_token_is_refused_even_while_the_person_has_a_live_session(switch):
    """the old web pod's fallback is gone (0 callers): no token sent = no session to switch from, whatever else the person holds live — and nobody else is signed out by the try."""
    engine, w = await _world()
    try:
        a, b = await w.login(), await w.login()
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], None, before, why="no token, another session lives")
        assert await w.live_tokens() == 2  # neither session was touched
        assert (await w.refresh(b["refresh_token"])).status_code == 200
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("switch", _SWITCHES)
async def test_a_token_of_another_person_or_an_unknown_token_cannot_switch(switch):
    engine, w = await _world()
    try:
        a = await w.login()
        other = await w.login(w.admin_email)  # the administrator's own live token
        before = await w.token_rows()
        await _refused(w, getattr(w, switch), a["access_token"], other["refresh_token"], before, why="another person's live token")
        await _refused(w, getattr(w, switch), a["access_token"], "not-a-token-at-all", before, why="an unknown token")
        assert (await w.refresh(other["refresh_token"])).status_code == 200  # the other person was not signed out by it
    finally:
        await _close(engine, w)
