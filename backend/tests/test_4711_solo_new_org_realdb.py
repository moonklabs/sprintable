"""story 4711 AC4 (PO 03:42Z) — `POST /desktop/setup-codes/confirm-solo-new-org`: a person with no organization starts the
three-step setup. The organization (named by the web — the screen no longer asks), the FOLDER's project, the one agent and the
person ↔ agent room are made in one transaction; the organization has exactly ONE project afterwards (no empty «first project»
beside the folder's). Refusals make nothing: an organization already · an app that did not say «solo» · the plan's agent limit
(rolls the organization back too). Real HTTP on a migrated PG."""
from __future__ import annotations

import pytest

from tests.test_4427_confirm_new_org_realdb import (  # noqa: F401 — fixtures used by name
    DEVICE,
    _addresses,
    _client,
    _confirm_new,
    _dispose_global_engine_after_test,
    _fresh_person_limits,
    _person,
    _pkce,
    _preset_body,
    _sql,
    anyio_backend,
    world,
)

ORG_NAME = "d4711 팀"


async def _solo_code(c, capabilities: list[str] | None = None) -> tuple[str, str]:
    verifier, challenge = _pkce()
    caps = ["solo"] if capabilities is None else capabilities
    r = await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": DEVICE, "capabilities": caps})
    assert r.status_code == 201, r.text
    return r.json()["code"], verifier


async def _confirm(c, code: str, who, **over):
    body = {"code": code, "runtime": "claude", "org_name": ORG_NAME, "project_name": "my-app", "workdir_hint": "my-app", **over}
    return await c.post("/api/v2/desktop/setup-codes/confirm-solo-new-org", json=body, headers=_person(who))


async def _made(who) -> dict:
    rows = await _sql(fetch=(
        "SELECT "
        "(SELECT count(*) FROM org_members WHERE user_id=:u AND deleted_at IS NULL),"
        "(SELECT count(*) FROM organizations WHERE name=:n),"
        "(SELECT count(*) FROM projects p JOIN organizations o ON o.id=p.org_id WHERE o.name=:n),"
        "(SELECT count(*) FROM members m JOIN organizations o ON o.id=m.org_id WHERE o.name=:n AND m.type='agent'),"
        "(SELECT count(*) FROM conversations c JOIN organizations o ON o.id=c.org_id WHERE o.name=:n),"
        "(SELECT count(*) FROM desktop_setups WHERE device_name=:d AND confirmed_at IS NOT NULL)"
    ), params={"u": str(who), "n": ORG_NAME, "d": DEVICE})
    memberships, orgs, projects, agents, rooms, confirmed = rows[0]
    return {"memberships": memberships, "orgs": orgs, "projects": projects, "agents": agents, "rooms": rooms, "confirmed": confirmed}


NOTHING = {"memberships": 0, "orgs": 0, "projects": 0, "agents": 0, "rooms": 0, "confirmed": 0}
ONE_OF_EACH = {"memberships": 1, "orgs": 1, "projects": 1, "agents": 1, "rooms": 1, "confirmed": 1}


@pytest.mark.anyio
async def test_a_new_customers_first_round_makes_one_organization_one_project_one_agent_and_its_room(world):
    who = await world.person()
    async with _client() as c:
        code, verifier = await _solo_code(c)
        r = await _confirm(c, code, who)
        assert r.status_code == 200, r.text
        got = r.json()
        assert set(got) == {"setup_id", "members", "project_id", "conversation_id", "org_id"}
        # the AC4 count: after a new customer's first round the organization has ONE project — the folder's
        assert await _made(who) == ONE_OF_EACH
        row = (await _sql(fetch="SELECT o.name, m.role FROM organizations o JOIN org_members m ON m.org_id=o.id WHERE o.id=:o AND m.user_id=:u",
                          params={"o": got["org_id"], "u": str(who)}))[0]
        assert row == (ORG_NAME, "owner")
        assert (await _sql(fetch="SELECT name FROM projects WHERE id=:p", params={"p": got["project_id"]}))[0][0] == "my-app"
        assert got["members"][0]["name"] == "Claude Code"
        # the room is the person's way in: a DM in the folder's project
        assert (await _sql(fetch="SELECT type, project_id::text FROM conversations WHERE id=:c", params={"c": got["conversation_id"]}))[0] == ("dm", got["project_id"])
        # the same person pressing again: what the code made, nothing twice
        again = await _confirm(c, code, who, org_name="다른 이름")
        assert (again.status_code, again.json()["org_id"], again.json()["conversation_id"]) == (200, got["org_id"], got["conversation_id"])
        assert await _made(who) == ONE_OF_EACH
        ex = await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": code, "verifier": verifier})
        assert ex.status_code == 200, ex.text
        assert (ex.json()["org_name"], ex.json()["setup_kind"], ex.json()["agents"][0]["name"]) == (ORG_NAME, "solo", "Claude Code")


@pytest.mark.anyio
async def test_refusals_make_nothing(world, monkeypatch):
    from fastapi import HTTPException

    from app.core.config import settings

    who = await world.person()
    has_org = await world.person()
    await world.org_with(has_org)
    async with _client() as c:
        code, _ = await _solo_code(c)
        r = await _confirm(c, code, has_org)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "has_organization"), r.text
        old, _ = await _solo_code(c, capabilities=[])
        r = await _confirm(c, old, who)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "app_cannot_solo"), r.text
        r = await _confirm(c, code, who, extra_field="x")
        assert r.status_code == 422, r.text  # extra=forbid: this path can only make a new organization
        assert await _made(who) == NOTHING

        # the plan's agent limit refuses AFTER the organization and the project were made: all of it goes
        async def limit(_db, _org):
            raise HTTPException(status_code=402, detail={"code": "PLAN_LIMIT_EXCEEDED", "limit": 0})

        async def project_allowed(_db, _org):
            return None

        monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
        monkeypatch.setattr("ee.plan_limits.check_agent_add_limit", limit)
        monkeypatch.setattr("app.services.org_project_create.check_project_create_allowed", project_allowed)
        r = await _confirm(c, code, who)
        assert r.status_code == 402, r.text
        assert await _made(who) == NOTHING


@pytest.mark.anyio
async def test_only_the_person_who_confirmed_gets_the_same_answer_again(world):
    """Kadir (5120 mutant `confirmed_by == user_id` removed lived): another signed-in person who knows an already-confirmed code must NOT
    get the organization, project and room ids it made — they get «already_confirmed» and nothing changes."""
    owner = await world.person()
    stranger = await world.person()
    async with _client() as c:
        code, _ = await _solo_code(c)
        first = await _confirm(c, code, owner)
        assert first.status_code == 200, first.text
        r = await _confirm(c, code, stranger)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "already_confirmed"), r.text
        for leaked in ("org_id", "project_id", "conversation_id", "members", "setup_id"):
            assert leaked not in r.text, f"{leaked} leaked to another person"
        assert await _made(stranger) == {**ONE_OF_EACH, "memberships": 0}  # the stranger belongs to nothing; the world holds what the owner's round made
        assert await _made(owner) == ONE_OF_EACH
        again = await _confirm(c, code, owner)  # the owner still gets the same answer
        assert (again.status_code, again.json()["org_id"]) == (200, first.json()["org_id"])


@pytest.mark.anyio
async def test_the_new_org_path_has_the_per_person_limit_shared_with_the_recipe_way(world):
    """Kadir (5120 mutant `limit off` lived): 3/hour per person on the way an organization is made — the solo path and the recipe path
    count in ONE bucket («desktop-confirm-new-org»); another person has their own count."""
    who = await world.person()
    someone_else = await world.person()
    async with _client() as c:
        body = await _preset_body(c, who)
        for _ in range(2):
            r = await _confirm(c, "x" * 40, who)  # a made-up code: 404, but counted
            assert r.status_code == 404, r.text
        await _confirm_new(c, "x" * 40, who, body)  # the recipe path counts in the same bucket
        r = await _confirm(c, "x" * 40, who)
        assert (r.status_code, r.json()["error"]["code"]) == (429, "RATE_LIMITED"), r.text
        assert int(r.headers["retry-after"]) > 0
        assert (await _confirm(c, "x" * 40, someone_else)).status_code == 404, "another person has their own count"
