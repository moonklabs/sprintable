"""story #4772 — the request authentication must not trust the organization named in a signed token without asking whether the person is still a live member of it.

Measured by the security lens (PR 5217, real PG, the real removal endpoint): with an `X-Org-Id` header the request authentication checks the organization's membership; WITHOUT the header
(`_resolve_verified_org_id`) it trusted the JWT's `app_metadata.org_id` as it was — so a token naming the organization someone had just been removed from kept reading its people lists
(team-members · members) until the access token expired, about an hour: the removal ends refresh tokens only.

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
