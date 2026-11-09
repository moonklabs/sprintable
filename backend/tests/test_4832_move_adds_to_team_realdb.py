"""story 4832 — «옮기면 프로젝트 팀에도 들어가요»: a MOVE row may ask `add_to_team` for an agent that is not on the project's team yet (real HTTP · migrated PG).

Before: the move refused a team-less agent (`agent_not_in_project`) and the page made the person press «프로젝트 팀에 넣기» first (the access route, a separate request).
Now one confirmation does both — and nothing about WHO may do it or WHICH agents may be put there got wider:
  * only a row that ASKS for it, and only a MOVE (a recipe / solo confirmation still refuses); a body without the field (an older page) behaves as before;
  * the grant is `grant_agent_project_access` — the access route's own function: the who-may-do-it rule inside it (`can_manage_project_access`), the active-agent /
    same-organization / reserved-publisher checks, an existing grant untouched; it never commits — the confirmation commits once, so a confirmation that fails
    leaves no access behind;
  * the confirmed event names WHO was added (`added_to_team` + `added_agent_ids`);
  * the access route answers as before (201 · 409 · 403 · 400 · 404), now through the same function.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    _ASYNC,
    ORG,
    OWNER,
    PLAIN,
    PROJ,
    _client,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import (  # noqa: F401 — fixtures used by name
    INACTIVE,
    NOT_IN_PROJECT,
    OTHER_ORG_AGENT,
    OWNER_TM,
    attachable,
)
from tests.test_4576_move_setup_realdb import EXISTING, _move, _move_code, _recipe_attach, movable  # noqa: F401 — fixtures used by name

NO_RUNTIME_OUTSIDE = uuid.UUID("d4832000-0000-0000-0000-000000000001")
PUBLISHER = uuid.UUID("d4832000-0000-0000-0000-000000000002")


def _ask(*agent_ids: uuid.UUID, ask: set[uuid.UUID] | None = None) -> dict:
    """a move body; the agents in `ask` carry `add_to_team: true`"""
    ask = set(agent_ids) if ask is None else ask
    return {"project_id": str(PROJ), "roles": [{"role": "Agent", "agent_id": str(a), **({"add_to_team": True} if a in ask else {})} for a in agent_ids]}


async def _grants(member_id: uuid.UUID) -> int:
    return (await _sql(fetch=f"SELECT count(*) FROM project_access WHERE project_id='{PROJ}' AND member_id='{member_id}'"))[0][0]


async def _profiles(member_id: uuid.UUID) -> int:
    return (await _sql(fetch=f"SELECT count(*) FROM agent_project_profiles WHERE project_id='{PROJ}' AND member_id='{member_id}'"))[0][0]


@pytest.fixture
async def outsiders(movable):
    await _sql(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active,runtime_type) VALUES "
        f"('{NO_RUNTIME_OUTSIDE}','{ORG}',NULL,'agent','NoRuntimeOutside',true,NULL),"
        f"('{PUBLISHER}','{ORG}',NULL,'agent','Publisher',true,'system-publisher')",
    )
    yield


@pytest.mark.anyio
async def test_one_confirmation_puts_the_agent_on_the_team_and_moves_it_and_the_event_names_who(outsiders):
    async with _client() as c:
        assert (await _grants(NOT_IN_PROJECT), await _profiles(NOT_IN_PROJECT)) == (0, 0)
        code, _, setup_id = await _move_code(c, "d4832 headline")
        r = await _confirm(c, code, body=_ask(NOT_IN_PROJECT))
        assert r.status_code == 200, r.text
        assert [m["member_id"] for m in r.json()["members"]] == [str(NOT_IN_PROJECT)]
    assert (await _grants(NOT_IN_PROJECT), await _profiles(NOT_IN_PROJECT)) == (1, 1)  # the flag not honoured → 422 and 0 rows → fails
    assert (await _sql(fetch=f"SELECT permission FROM project_access WHERE project_id='{PROJ}' AND member_id='{NOT_IN_PROJECT}'"))[0][0] == "granted"
    meta = (await _sql(fetch=f"SELECT meta FROM onboarding_events WHERE session_id='{setup_id}' AND event='desktop_setup_confirmed'"))[0][0]
    assert (meta["flow"], meta["added_to_team"], meta["added_agent_ids"], meta["agents"]) == ("desktop_move", 1, [str(NOT_IN_PROJECT)], 1)


@pytest.mark.anyio
async def test_an_agent_already_on_the_team_is_left_alone_and_the_event_says_nobody_was_added(outsiders):
    async with _client() as c:
        before = (await _grants(EXISTING), await _profiles(EXISTING))
        code, _, setup_id = await _move_code(c, "d4832 already")
        r = await _confirm(c, code, body=_ask(EXISTING))
        assert r.status_code == 200, r.text
    assert (await _grants(EXISTING), await _profiles(EXISTING)) == before  # no second row
    meta = (await _sql(fetch=f"SELECT meta FROM onboarding_events WHERE session_id='{setup_id}' AND event='desktop_setup_confirmed'"))[0][0]
    assert (meta["added_to_team"], meta["added_agent_ids"]) == (0, [])


@pytest.mark.anyio
async def test_only_the_agent_that_asked_is_added_and_only_a_move_honours_it(outsiders):
    async with _client() as c:
        code, _, setup_id = await _move_code(c, "d4832 mixed")
        # NOT_IN_PROJECT asks; EXISTING is on the team (no ask needed)
        r = await _confirm(c, code, body=_ask(EXISTING, NOT_IN_PROJECT, ask={NOT_IN_PROJECT}))
        assert r.status_code == 200, r.text
    meta = (await _sql(fetch=f"SELECT meta FROM onboarding_events WHERE session_id='{setup_id}' AND event='desktop_setup_confirmed'"))[0][0]
    assert meta["added_agent_ids"] == [str(NOT_IN_PROJECT)]


@pytest.mark.anyio
async def test_without_the_ask_the_move_refuses_as_before_and_nothing_is_added(outsiders):
    async with _client() as c:
        code, _, _ = await _move_code(c, "d4832 no ask")
        r = await _confirm(c, code, body=_move(NOT_IN_PROJECT))  # an older page: no field
        assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_in_project"), r.text
        r = await _confirm(c, code, body=_ask(NOT_IN_PROJECT, ask=set()))  # the field's absence
        assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_in_project"), r.text
    assert await _grants(NOT_IN_PROJECT) == 0
    assert (await _sql(fetch="SELECT confirmed_at FROM desktop_setups WHERE device_name='d4832 no ask'"))[0][0] is None


@pytest.mark.anyio
async def test_the_ask_does_not_widen_who_may_confirm_or_which_agents_qualify(outsiders):
    human_before = await _grants(OWNER_TM)  # the organization's own person is already on the team: what matters is that the ask adds nothing
    async with _client() as c:
        code, _, _ = await _move_code(c, "d4832 refusals")
        cases = [
            (_ask(OTHER_ORG_AGENT), (404, "agent_not_found")),        # another organization's agent
            (_ask(uuid.uuid4()), (404, "agent_not_found")),            # no such agent
            (_ask(NO_RUNTIME_OUTSIDE), (404, "agent_not_found")),      # a runtime the desktop cannot run
            (_ask(PUBLISHER), (404, "agent_not_found")),               # the reserved system publisher is no desktop agent
            (_ask(INACTIVE), (404, "agent_not_found")),                # a stopped agent
            (_ask(OWNER_TM), (404, "agent_not_found")),              # a human member's id is no agent
        ]
        for body, want in cases:
            r = await _confirm(c, code, body=body)
            assert (r.status_code, r.json()["error"]["code"]) == want, (body, r.text)
        r = await _confirm(c, code, who=PLAIN, body=_ask(NOT_IN_PROJECT))  # an org member who is not an admin
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_org_admin"), r.text
    for agent in (OTHER_ORG_AGENT, NO_RUNTIME_OUTSIDE, PUBLISHER, INACTIVE, NOT_IN_PROJECT):
        assert await _grants(agent) == 0, agent
    assert await _grants(OWNER_TM) == human_before
    assert (await _sql(fetch="SELECT confirmed_at FROM desktop_setups WHERE device_name='d4832 refusals'"))[0][0] is None


@pytest.mark.anyio
async def test_a_confirmation_that_fails_after_the_grant_leaves_no_access_behind(outsiders):
    """the grant is flushed (the move re-reads it) but not committed: the second row's refusal rolls the first one's grant back"""
    async with _client() as c:
        code, _, _ = await _move_code(c, "d4832 rollback")
        r = await _confirm(c, code, body=_ask(NOT_IN_PROJECT, OTHER_ORG_AGENT))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "agent_not_found"), r.text
    assert (await _grants(NOT_IN_PROJECT), await _profiles(NOT_IN_PROJECT)) == (0, 0)  # a commit inside the grant → 1 row stays → fails
    assert (await _sql(fetch="SELECT confirmed_at FROM desktop_setups WHERE device_name='d4832 rollback'"))[0][0] is None


@pytest.mark.anyio
async def test_a_recipe_confirmation_still_refuses_a_team_less_agent_even_when_the_row_says_add_to_team(outsiders):
    async with _client() as c:
        code, _, _ = await _move_code(c, "d4832 recipe")
        body = _recipe_attach(NOT_IN_PROJECT)
        body["roles"][0]["add_to_team"] = True
        r = await _confirm(c, code, body=body)
        assert (r.status_code, r.json()["error"]["code"]) == (422, "agent_not_in_project"), r.text
    assert await _grants(NOT_IN_PROJECT) == 0


@pytest.mark.anyio
async def test_the_grant_function_asks_the_rule_itself_not_only_its_caller(outsiders):
    """the who-may-do-it rule is inside `grant_agent_project_access`: a caller that skipped its own check still cannot put an agent on a team"""
    from app.services.project_agent_grant import ALREADY_GRANTED, NOT_ALLOWED, AgentGrantRefused, grant_agent_project_access

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            with pytest.raises(AgentGrantRefused) as plain:
                await grant_agent_project_access(s, project_id=PROJ, member_id=NOT_IN_PROJECT, by_user_id=PLAIN)
            assert plain.value.reason == NOT_ALLOWED
            await s.rollback()
            with pytest.raises(AgentGrantRefused) as dup:
                await grant_agent_project_access(s, project_id=PROJ, member_id=EXISTING, by_user_id=OWNER)
            assert dup.value.reason == ALREADY_GRANTED
            await s.rollback()
            record = await grant_agent_project_access(s, project_id=PROJ, member_id=NOT_IN_PROJECT, by_user_id=OWNER)
            assert record.member_id == NOT_IN_PROJECT
            await s.rollback()  # never committed by the function: the caller decides
    finally:
        await eng.dispose()
    assert await _grants(NOT_IN_PROJECT) == 0


@pytest.mark.anyio
async def test_the_access_route_answers_as_before_through_the_same_function(outsiders):
    human_before = await _grants(OWNER_TM)
    async with _client() as c:
        url = f"/api/v2/projects/{PROJ}/access"
        post = lambda who, member: c.post(url, json={"member_id": str(member)}, headers=_person(who, ORG))  # noqa: E731
        r = await post(OWNER, NOT_IN_PROJECT)
        assert r.status_code == 201, r.text
        assert (r.json()["member_id"], r.json()["org_member_id"], r.json()["permission"], r.json()["project_id"]) == (str(NOT_IN_PROJECT), None, "granted", str(PROJ))
        assert await _profiles(NOT_IN_PROJECT) == 1
        # the sentences are the route's own (they were its answers before this story); the envelope around them is the app's, so the text is looked for, not its shape
        r = await post(OWNER, NOT_IN_PROJECT)
        assert r.status_code == 409 and "Access record already exists" in r.text, r.text
        r = await post(PLAIN, NO_RUNTIME_OUTSIDE)
        assert r.status_code == 403 and "owner or admin role required" in r.text, r.text
        for member in (OTHER_ORG_AGENT, INACTIVE, OWNER_TM, uuid.uuid4()):
            r = await post(OWNER, member)
            assert r.status_code == 400 and "member_id must be an active agent in the project's org" in r.text, (member, r.text)
        r = await post(OWNER, PUBLISHER)
        assert r.status_code == 409 and "SYSTEM_PUBLISHER_RESERVED" in r.text, r.text
        r = await c.post(f"/api/v2/projects/{uuid.uuid4()}/access", json={"member_id": str(NOT_IN_PROJECT)}, headers=_person(OWNER, ORG))
        assert r.status_code == 404 and "Project not found" in r.text, r.text
        r = await c.post(url, json={"member_id": str(EXISTING), "org_member_id": str(uuid.uuid4())}, headers=_person(OWNER, ORG))
        assert r.status_code == 422, r.text  # exactly one of the two ids
        r = await c.post(url, json={"member_id": str(EXISTING), "permission": "denied"}, headers=_person(OWNER, ORG))
        assert r.status_code == 400 and "permission must be 'granted'" in r.text, r.text
    for agent in (OTHER_ORG_AGENT, INACTIVE, PUBLISHER, NO_RUNTIME_OUTSIDE):
        assert await _grants(agent) == 0, agent
    assert await _grants(OWNER_TM) == human_before


@pytest.mark.anyio
async def test_two_confirmations_that_both_add_the_same_agent_never_end_in_a_500_and_leave_one_grant_and_one_name(outsiders):
    """the unique (project, member) index stops a second row; the loser of the race must read the agent as already on the team (a savepoint, not a poisoned transaction or a 500)"""
    import asyncio

    async with _client() as c:
        codes = [await _move_code(c, f"d4832 race {i}") for i in range(2)]
        results = await asyncio.gather(*[_confirm(c, code, body=_ask(NOT_IN_PROJECT)) for code, _, _ in codes])
    assert sorted(r.status_code for r in results) == [200, 200], [r.text for r in results]  # an unhandled IntegrityError → a 500 → fails
    assert (await _grants(NOT_IN_PROJECT), await _profiles(NOT_IN_PROJECT)) == (1, 1)
    metas = [(await _sql(fetch=f"SELECT meta FROM onboarding_events WHERE session_id='{sid}' AND event='desktop_setup_confirmed'"))[0][0] for _, _, sid in codes]
    assert sorted(m["added_to_team"] for m in metas) == [0, 1]  # only the confirmation that wrote the grant names the agent
    assert sorted(len(m["added_agent_ids"]) for m in metas) == [0, 1]


@pytest.mark.anyio
async def test_the_grant_function_reads_a_lost_race_as_already_granted(outsiders):
    """the function itself: a unique-index conflict after its own check passes is `already_granted`, and the caller's session stays usable"""
    from sqlalchemy import select

    from app.models.project_access import ProjectAccess
    from app.services.project_agent_grant import ALREADY_GRANTED, AgentGrantRefused, grant_agent_project_access

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as winner, async_sessionmaker(eng)() as loser:
            # the loser passes the «no grant yet» read first, then the winner commits, then the loser inserts: the unique index is what refuses it
            real_execute = loser.execute
            state = {"won": False}

            async def execute(stmt, *a, **kw):
                result = await real_execute(stmt, *a, **kw)
                if not state["won"] and "FROM project_access" in str(stmt):
                    state["won"] = True
                    await grant_agent_project_access(winner, project_id=PROJ, member_id=NOT_IN_PROJECT, by_user_id=OWNER)
                    await winner.commit()
                return result

            loser.execute = execute  # type: ignore[method-assign]
            with pytest.raises(AgentGrantRefused) as lost:
                await grant_agent_project_access(loser, project_id=PROJ, member_id=NOT_IN_PROJECT, by_user_id=OWNER)
            assert lost.value.reason == ALREADY_GRANTED
            loser.execute = real_execute  # type: ignore[method-assign]
            assert (await loser.execute(select(ProjectAccess.id).where(ProjectAccess.member_id == NOT_IN_PROJECT))).all()  # the session is still usable
            await loser.rollback()
    finally:
        await eng.dispose()
    assert await _grants(NOT_IN_PROJECT) == 1
