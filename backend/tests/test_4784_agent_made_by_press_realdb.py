"""story 4784 — the agent a solo start makes is made by the person's «만들기» on what they saw: the name they typed, the role they wrote,
the folder's name they picked (real HTTP · migrated PG).

AC2 (the server half): `confirm-solo` takes `agent_name` · `agent_role` · `folder_name` (all optional on the wire — a page from before
still starts with the program's name). A typed name is the agent's name; one an active agent already has is `409 agent_name_taken`
with the free name and NOTHING made (no agent, no project, no room — the person sees the free name and presses again); a blank
role is no role; a blank or control-character name is refused. The first line of the new room says why the person is here —
«에이전트를 만들었어요 · 이름 · 도구 · 폴더» — from the person, written once (a replay writes none), and it asks nothing of the agent.
AC5 (name taken): the answer a card can show."""
from __future__ import annotations

import uuid

import pytest

from tests.test_4711_solo_setup_realdb import (  # noqa: F401 — fixtures and helpers used by name
    _confirm_solo,
    _solo_code,
    _state,
    solo,
)
from tests.test_4711_solo_setup_realdb import (  # noqa: F401
    _live_keys,
    _plain_key,
    attachable,
)
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401
    EVENT_TOKENS,
    EXISTING,
    ORG,
    OWNER,
    PLAIN,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _exchange,
    _person,
    _pkce,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)


async def _lines(conversation_id: str) -> list[tuple]:
    return await _sql(fetch=(
        f"SELECT content, sender_id::text, metadata FROM conversation_messages WHERE conversation_id='{conversation_id}' ORDER BY created_at"
    ))


@pytest.mark.anyio
async def test_the_person_names_the_agent_gives_it_a_role_and_the_room_opens_with_why(solo):
    async with _client() as c:
        before = await _state()
        code, _, _ = await _solo_code(c, "d4784 typed")
        r = await _confirm_solo(c, code, {
            "runtime": "codex", "project_name": "my-app", "agent_name": "  Reviewer  ", "agent_role": " 코드 리뷰어 ", "folder_name": "my-app",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        (member,) = body["members"]
        assert member["name"] == "Reviewer"  # what they typed (trimmed), not «Codex»
        name = (await _sql(fetch=f"SELECT name FROM members WHERE id='{member['member_id']}'"))[0][0]
        roles = await _sql(fetch=f"SELECT agent_role FROM agent_project_profiles WHERE member_id='{member['member_id']}'")
        assert name == "Reviewer" and [r[0] for r in roles] == ["코드 리뷰어"]  # the role rides the agent's profile in the folder's project
        # the room's first line: from the person, once, naming the agent · the tool · the folder — and asking nothing of the agent
        (line,) = await _lines(body["conversation_id"])
        content, sender, meta = line
        assert content == "에이전트를 만들었어요 · 이름 Reviewer · 도구 Codex · 폴더 my-app"
        assert sender != member["member_id"] and sender is not None
        assert meta["activation"] == {"audience": [], "kind": "agent_created", "expects_response": False}
        assert (await _state())["agents"] == before["agents"] + 1
        # confirming again answers the same and writes no second line
        again = await _confirm_solo(c, code, {"runtime": "codex", "project_name": "my-app", "agent_name": "Reviewer"})
        assert (again.status_code, again.json()["conversation_id"]) == (200, body["conversation_id"])
        assert len(await _lines(body["conversation_id"])) == 1


@pytest.mark.anyio
async def test_a_page_from_before_still_starts_with_the_programs_name_and_the_room_still_says_why(solo):
    async with _client() as c:
        code, _, _ = await _solo_code(c, "d4784 old page")
        r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "old-app"})
        assert r.status_code == 200, r.text
        assert r.json()["members"][0]["name"] == "Claude Code"
        assert [x[0] for x in await _sql(fetch=f"SELECT agent_role FROM agent_project_profiles WHERE member_id='{r.json()['members'][0]['member_id']}'")] == [None]
        (line,) = await _lines(r.json()["conversation_id"])
        assert line[0] == "에이전트를 만들었어요 · 이름 Claude Code · 도구 Claude Code"  # no folder name sent: the line has none


@pytest.mark.anyio
async def test_a_taken_name_makes_nothing_and_names_the_free_one(solo):
    async with _client() as c:
        first, _, _ = await _solo_code(c, "d4784 first")
        ok = await _confirm_solo(c, first, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Helper"})
        assert ok.status_code == 200, ok.text
        before = await _state()
        code, verifier, _ = await _solo_code(c, "d4784 second")
        # case and spacing do not make a different name (the same rule the program names use)
        for typed in ("Helper", "  helper ", "HELPER"):
            r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "taken-app", "agent_name": typed})
            assert r.status_code == 409, (typed, r.text)
            error = r.json()["error"]
            assert (error["code"], error["suggested_name"]) == ("agent_name_taken", f"{typed.strip()} 2"), r.text  # numbered from what they typed
            assert await _state() == before  # no agent, no project (the folder's), no room
        assert (await _sql(fetch="SELECT confirmed_at FROM desktop_setups WHERE device_name='d4784 second'"))[0][0] is None
        # the person presses again with the free name: it goes through on the same code
        again = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "taken-app", "agent_name": "Helper 2"})
        assert again.status_code == 200, again.text
        assert again.json()["members"][0]["name"] == "Helper 2"


@pytest.mark.anyio
async def test_a_blank_role_is_no_role_and_a_blank_or_control_name_is_refused(solo):
    async with _client() as c:
        before = await _state()
        code, _, _ = await _solo_code(c, "d4784 refusals")
        for bad in ({"agent_name": "   "}, {"agent_name": "a\nb"}, {"agent_name": "x" * 61}, {"agent_role": "r\tr"}, {"agent_role": "r" * 201}, {"folder_name": "f\nf"}):
            r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "bad-app", **bad})
            assert r.status_code == 422, (bad, r.text)
        assert await _state() == before
        ok = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "blank-role", "agent_name": "Quiet", "agent_role": "   "})
        assert ok.status_code == 200, ok.text
        assert [x[0] for x in await _sql(fetch=f"SELECT agent_role FROM agent_project_profiles WHERE member_id='{ok.json()['members'][0]['member_id']}'")] == [None]
