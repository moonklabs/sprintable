"""story #4772 — the request authentication must not trust the organization named in a signed token without asking whether the person is still a live member of it.

Measured by the security lens (PR 5217, real PG, the real removal endpoint): with an `X-Org-Id` header the request authentication checks the organization's membership; WITHOUT the header
(`_resolve_verified_org_id`) it trusted the JWT's `app_metadata.org_id` as it was — so a token naming the organization someone had just been removed from kept reading its people lists
(team-members · members) until the access token expired, about an hour: the removal ends refresh tokens only.

The judgement now lives in the request authentication itself (`get_current_user`, JWT and Firebase, the SSE variant too): a signed token's organization-scoped claims (`org_id` ·
`project_id` · `project_ids` · `role`) are dropped from the request's view of the token when the person has no live seat in the organization it names — because ~12 routers read those
claims themselves (not through `get_verified_org_id`), and `require_admin` read `role` from them.

Real PG, the real endpoints. Pins:
  01 the removed person's OLD access token (taken before the removal, naming that organization): before the removal the reads answer 200; right after it team-members · members ·
     stories · projects answer 403 — no organization name, no people in the body — and the same person's other organization (a live seat) answers 200 for the token that names it;
  02 the answer follows the removal on the very next request (no cache outlives it) and a person who is later re-seated reads again with a fresh token;
  03 a request carrying `X-Org-Id` keeps answering as before (the same judgement as without the header);
  04 an agent key is not asked again (its organization is read from its member row in this very request) — its calls keep answering 200."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4752_account_delete_realdb import _close, _world
from tests.test_4769_member_removal_closes_devices_realdb import _join, _remove

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


def _bearer(tokens: dict, org: uuid.UUID | None = None) -> dict:
    h = {"Authorization": f"Bearer {tokens['access_token']}"}
    if org is not None:
        h["X-Org-Id"] = str(org)
    return h


async def _project_of(w, org_id: uuid.UUID) -> uuid.UUID:
    from sqlalchemy import text

    async with w.Session() as s:
        return (await s.execute(text("SELECT id FROM projects WHERE org_id = :o LIMIT 1"), {"o": org_id})).scalar_one()


async def _switch_to(w, tokens: dict, org_id: uuid.UUID) -> dict:
    """The tokens of the same person naming `org_id` (what the web does when someone changes organization)."""
    r = await w.client.post(
        "/api/v2/auth/switch-org", headers=_bearer(tokens), json={"org_id": str(org_id), "refresh_token": tokens.get("refresh_token")},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def _reads(w, tokens: dict, org_id: uuid.UUID, project_id: uuid.UUID, *, header: bool = False) -> dict:
    h = _bearer(tokens, org_id if header else None)
    out = {}
    for label, path in (
        ("team_members", f"/api/v2/team-members?project_id={project_id}"),
        ("members", "/api/v2/members"),
        ("stories", f"/api/v2/stories?project_id={project_id}"),
        ("project", f"/api/v2/projects/{project_id}"),
    ):
        r = await w.client.get(path, headers=h)
        out[label] = r.status_code
        if r.status_code == 403:
            assert str(org_id) not in r.text and "name" not in r.text.lower().replace("해당 조직의 멤버가 아닌", ""), f"{label}: a refusal must not carry the organization or its people: {r.text[:200]}"
    return out


async def _two_organizations(w):
    """O owns org X; M is an admin of X and also an admin of org Y (owned by P) — M's old token names X, a second token names Y."""
    _, owner_email, org_x = await w.person(org=True, name="Owner X")
    _, _, org_y = await w.person(org=True, name="Owner Y")
    m = await w.add_member(org_x, role="admin", name="M")
    await _join(w, org_y, m)
    # M is placed in a project of each organization, so the `projects` claim of a token carries an entry per organization (the control for "nothing of the one they left")
    for org in (org_x, org_y):
        await w.sql(
            "INSERT INTO project_access (id, project_id, org_member_id, member_id, permission) "
            "SELECT gen_random_uuid(), (SELECT id FROM projects WHERE org_id = :o LIMIT 1), om.id, om.id, 'granted' FROM org_members om WHERE om.org_id = :o AND om.user_id = :u",
            o=org, u=m,
        )
    m_email = f"story4752-m-{m.hex[:10]}@test.com"
    tokens = await w.tokens(m_email)
    tok_x = await _switch_to(w, tokens, org_x)
    tok_y = await _switch_to(w, tok_x, org_y)
    tok_x_again = await _switch_to(w, tok_y, org_x)
    return owner_email, org_x, org_y, m, m_email, tok_x_again, tok_y


async def test_01_a_token_that_names_an_organization_the_person_left_reads_nothing_of_it():
    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        px, py = await _project_of(w, org_x), await _project_of(w, org_y)
        before = await _reads(w, tok_x, org_x, px)
        assert before["team_members"] == 200 and before["members"] == 200, before

        r = await _remove(w, owner_email, org_x, m)
        assert r.status_code == 200, r.text

        after = await _reads(w, tok_x, org_x, px)
        assert after == {"team_members": 403, "members": 403, "stories": 403, "project": 403}, after
        # the other organization (a live seat) answers for the token that names it
        other = await _reads(w, tok_y, org_y, py)
        assert other["team_members"] == 200 and other["members"] == 200, other
    finally:
        await _close(engine, w)


async def test_02_the_refusal_comes_on_the_very_next_request_and_a_reseated_person_reads_again():
    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        px = await _project_of(w, org_x)
        H = _bearer(tok_x)
        assert (await w.client.get("/api/v2/members", headers=H)).status_code == 200
        assert (await _remove(w, owner_email, org_x, m)).status_code == 200
        assert (await w.client.get("/api/v2/members", headers=H)).status_code == 403, "no cache keeps answering for a person who was just removed"
        # re-seated (the same seat row is undone): a token naming the organization reads again
        await w.sql("UPDATE org_members SET deleted_at = NULL WHERE org_id = :o AND user_id = :u", o=org_x, u=m)
        await w.sql("UPDATE members SET is_active = true WHERE org_id = :o AND user_id = :u", o=org_x, u=m)
        assert (await w.client.get("/api/v2/members", headers=H)).status_code == 200
        assert px
    finally:
        await _close(engine, w)


async def test_02b_the_routes_that_read_the_claims_themselves_and_the_role_claim_are_closed_too():
    """The probe on the first version of the fix found `GET /hitl/policy`, `GET /hitl/requests` and `GET /agent-routing-rules` answering 200 to the removed person's old token (they read
    org_id and project_id from the claims themselves). With the judgement in the request authentication they answer 403, `require_admin` no longer sees `role: admin`, and the person's own
    identity (`/auth/me`, `/me/memberships`) and a switch to an organization they are in still work."""
    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        probes = (
            "/api/v2/hitl/policy", "/api/v2/hitl/requests", "/api/v2/agent-routing-rules", "/api/v2/agent-personas?agent_id=" + str(uuid.uuid4()),
            "/api/v2/agent-deployments", "/api/v2/hitl/policy",
        )
        H = _bearer(tok_x)
        before = {p: (await w.client.get(p, headers=H)).status_code for p in probes}
        assert before["/api/v2/hitl/policy"] == 200 and before["/api/v2/agent-routing-rules"] == 200, before
        before_admin = (await w.client.get("/api/v2/mcp/toolset-catalog", headers=H)).status_code
        assert (await _remove(w, owner_email, org_x, m)).status_code == 200
        for p in probes:
            r = await w.client.get(p, headers=H)
            assert r.status_code in (400, 403), (p, r.status_code, r.text[:160])
        # a route that reads ONLY the `role` claim (`require_admin`, no organization lookup): answers 200 to the admin before the removal, 403 after — the removed admin is no longer an admin
        assert before_admin == 200, before_admin
        r = await w.client.get("/api/v2/mcp/toolset-catalog", headers=H)
        assert r.status_code == 403, (r.status_code, r.text[:160])
        r = await w.client.get("/api/v2/org-members", headers=H)
        assert r.status_code in (400, 403), r.status_code
        # …but the person is still themselves
        assert (await w.client.get("/api/v2/auth/me", headers=H)).status_code == 200
        assert (await w.client.get("/api/v2/me/memberships", headers=H)).status_code == 200
        r = await w.client.post("/api/v2/auth/switch-org", headers=H, json={"org_id": str(org_y), "refresh_token": tok_x.get("refresh_token")})
        assert r.status_code == 200, r.text
    finally:
        await _close(engine, w)


async def test_02c_the_event_stream_does_not_open_for_the_removed_person():
    """The SSE variant of the request authentication (`get_current_user_streaming`) has its own JWT branch: a removed person's old token must not open `/events/stream` for the
    organization it names. A stream that opens never answers, so the request is bounded: before the removal the timeout IS the proof that it opened (a person in the organization,
    `member_id` = their seat, as the endpoint requires for a JWT session); after it, an answer is."""
    import asyncio

    from tests.test_4769_member_removal_closes_devices_realdb import _seat

    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        seat = await _seat(w, org_x, m)
        url = f"/api/v2/events/stream?member_id={seat}"
        try:
            r = await asyncio.wait_for(w.client.get(url, headers=_bearer(tok_x)), timeout=6)
            pytest.fail(f"the control stream did not open before the removal: {r.status_code} {r.text[:160]}")
        except asyncio.TimeoutError:
            pass   # opened (and is still open): the stream never answers
        assert (await _remove(w, owner_email, org_x, m)).status_code == 200
        try:
            r = await asyncio.wait_for(w.client.get(url, headers=_bearer(tok_x)), timeout=6)
        except asyncio.TimeoutError:
            pytest.fail("the event stream opened for a person who was removed from the organization the token names")
        assert r.status_code in (400, 403, 404), (r.status_code, r.text[:160])
    finally:
        await _close(engine, w)


async def test_02d_both_request_authentications_drop_the_claims_of_an_organization_the_person_left():
    """`get_current_user` and its SSE variant `get_current_user_streaming` each have their own JWT branch; each is called here with the removed person's real old token. The
    organization-scoped claims are gone and `org_left` names the organization; a person who still has the seat keeps every claim. (The event stream is also closed by other checks, so
    this is the direct pin of the streaming branch.)"""
    import types

    from fastapi.security import HTTPAuthorizationCredentials

    from app.dependencies.auth import get_current_user, get_current_user_streaming

    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        creds_x = HTTPAuthorizationCredentials(scheme="Bearer", credentials=tok_x["access_token"])
        creds_y = HTTPAuthorizationCredentials(scheme="Bearer", credentials=tok_y["access_token"])

        def _request():
            return types.SimpleNamespace(state=types.SimpleNamespace(), headers={})

        for fn in (get_current_user, get_current_user_streaming):
            kept = await fn(credentials=creds_x, x_agent_api_key=None, **({"x_mcp_transport": None} if fn is get_current_user else {}), request=_request())
            meta = kept.claims["app_metadata"]
            assert meta.get("org_id") == str(org_x) and meta.get("org_left") is None, (fn.__name__, meta)
            assert [p for p in meta.get("projects", []) if p.get("org_id") == str(org_x)], ("the control token must carry the projects of the organization", fn.__name__, meta.get("projects"))
        assert (await _remove(w, owner_email, org_x, m)).status_code == 200
        for fn in (get_current_user, get_current_user_streaming):
            extra = {"x_mcp_transport": None} if fn is get_current_user else {}
            gone = await fn(credentials=creds_x, x_agent_api_key=None, **extra, request=_request())
            meta = gone.claims["app_metadata"]
            assert not any(k in meta for k in ("org_id", "project_id", "project_ids", "role")), (fn.__name__, meta)
            assert meta.get("org_left") == str(org_x) and gone.org_id is None, (fn.__name__, meta, gone.org_id)
            # the per-project list: nothing of the organization they left, the organization they are still in stays
            assert not [p for p in meta.get("projects", []) if p.get("org_id") == str(org_x)], (fn.__name__, meta.get("projects"))
            live = await fn(credentials=creds_y, x_agent_api_key=None, **extra, request=_request())
            assert live.claims["app_metadata"].get("org_id") == str(org_y) and live.org_id == str(org_y), (fn.__name__, live.claims)
    finally:
        await _close(engine, w)


async def test_02e_a_persons_own_api_key_is_judged_like_a_token():
    """A `hu_live_` key reads its member row in the request («active», not «still seated»): an OLDER removal (the seat soft-deleted, the anchor left active) kept it working. The same
    judgement now applies to it: with the seat gone the organization-scoped claims are dropped and an organization route answers 403; while the seat is live it answers 200."""
    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        r = await w.client.post("/api/v2/me/api-keys", headers=_bearer(tok_x), json={"name": "k4772", "expires_at": None})
        assert r.status_code == 201, r.text
        key = r.json()["api_key"]
        K = {"Authorization": f"Bearer {key}"}
        assert (await w.client.get("/api/v2/members", headers=K)).status_code == 200
        # an older removal: the seat is ended and nothing else is touched (the anchor stays active)
        await w.sql("UPDATE org_members SET deleted_at = now() WHERE org_id = :o AND user_id = :u", o=org_x, u=m)
        r = await w.client.get("/api/v2/members", headers=K)
        assert r.status_code == 403, (r.status_code, r.text[:160])
    finally:
        await _close(engine, w)


async def test_03_with_the_header_the_judgement_is_the_same():
    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
        px = await _project_of(w, org_x)
        assert (await _reads(w, tok_y, org_x, px, header=True))["members"] == 200   # live seat in X, a token that names Y, the header names X
        assert (await _remove(w, owner_email, org_x, m)).status_code == 200
        assert (await _reads(w, tok_y, org_x, px, header=True))["members"] == 403
        assert (await _reads(w, tok_x, org_x, px, header=True))["members"] == 403
    finally:
        await _close(engine, w)


async def test_04_an_agent_key_is_not_asked_again():
    """The agent's organization is read from its member row in the very request (`_resolve_api_key`), not from a signed claim that can be old — it keeps answering 200, and costs no second look."""
    engine, w = await _world()
    try:
        _, owner_email, org_x = await w.person(org=True, name="Owner X")
        project = await _project_of(w, org_x)
        owner = await w.tokens(owner_email)
        H = _bearer(owner, org_x)
        r = await w.client.post("/api/v2/agents", headers=H, json={"name": "Agent 4772", "scope_mode": "projects", "project_ids": [str(project)]})
        assert r.status_code == 201, r.text
        agent_id = r.json()["id"]
        r = await w.client.post(f"/api/v2/agents/{agent_id}/api-keys", headers=H, json={"expires_at": None})
        assert r.status_code == 201, r.text
        plaintext = r.json()["api_key"]
        r = await w.client.get("/api/v2/members", headers={"Authorization": f"Bearer {plaintext}"})
        assert r.status_code == 200, r.text
    finally:
        await _close(engine, w)
