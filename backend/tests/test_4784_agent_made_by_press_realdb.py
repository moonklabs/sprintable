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
        # the card says the role "does not change how the agent works": a solo agent has no persona row, so the daemon's role (agent_personas) is empty
        # and `agent_role` never reaches it — if a default persona ever gets made here, that line on the card stops being true (Yuna)
        assert (await _sql(fetch=f"SELECT count(*) FROM agent_personas WHERE agent_id='{member['member_id']}'"))[0][0] == 0
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
        for bad in ({"agent_name": "   "}, {"agent_name": "a\nb"}, {"agent_name": "x" * 61}, {"agent_role": "r\tr"}, {"agent_role": "r" * 201}, {"folder_name": "f\nf"},
                    # a line/paragraph separator or a bidi override would split or flip the one line the name/role/folder is drawn in (codex r1)
                    {"agent_name": "a\u2028b"}, {"agent_name": "\u202eevil"}, {"agent_role": "r\u2029r"}, {"folder_name": "f\u2066f"},
                    # the persona list (Cc · Cf · Zl · Zp): zero-width space / joiner / BOM / soft hyphen / the invisible tag block, and names that draw as nothing (Kadir 5245 ⓒ)
                    {"agent_name": "Zed\u200bBot"}, {"agent_name": "a\u200db"}, {"agent_name": "\ufeffok"}, {"agent_name": "o\u00adk"}, {"agent_name": "\U000e006f\U000e006b"},
                    {"agent_name": "\u3164"}, {"agent_name": "\u2800\u2800"}, {"agent_name": " \u00a0 "}):
            r = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "bad-app", **bad})
            assert r.status_code == 422, (bad, r.text)
        assert await _state() == before
        ok = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "blank-role", "agent_name": "Quiet", "agent_role": "   "})
        assert ok.status_code == 200, ok.text
        assert [x[0] for x in await _sql(fetch=f"SELECT agent_role FROM agent_project_profiles WHERE member_id='{ok.json()['members'][0]['member_id']}'")] == [None]


async def _lock_waiters() -> int:
    return (await _sql(fetch=(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"
    )))[0][0]


@pytest.mark.anyio
async def test_two_presses_at_once_with_the_same_typed_name_make_one_agent(solo, monkeypatch):
    """codex r1: no unique key on member names — two setups (different codes) pressing «만들기» with the same typed name must not both find it
    free. The organization's row is locked before the name list is read; the window is held open until the second press is seen waiting on
    that lock in pg_stat_activity (or both have read — the unlocked case, which then makes two agents and fails here)."""
    import asyncio

    from app.services import desktop_setup as service

    real = service._unique_name
    read: list[str] = []
    both_read = asyncio.Event()

    async def watched(db, model, *conds, base, **kw):
        names = await real(db, model, *conds, base=base, **kw)
        if base == "Racer":
            read.append(names)
            if len(read) >= 2:
                both_read.set()
            while not both_read.is_set() and await _lock_waiters() == 0:
                await asyncio.sleep(0.02)
        return names

    monkeypatch.setattr(service, "_unique_name", watched)
    async with _client() as c:
        before = await _state()
        one, _, _ = await _solo_code(c, "d4784 race one")
        two, _, _ = await _solo_code(c, "d4784 race two")
        a, b = await asyncio.gather(
            _confirm_solo(c, one, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Racer"}),
            _confirm_solo(c, two, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Racer"}),
        )
        assert sorted([a.status_code, b.status_code]) == [200, 409], (a.text, b.text)
        assert (await _state())["agents"] == before["agents"] + 1


@pytest.mark.anyio
async def test_a_name_that_is_nearly_a_taken_one_is_taken_and_invisible_roles_are_no_role(solo):
    """Kadir 5245 ⓒ: the skeleton of a name (full-width letters folded, format characters dropped, spaces collapsed, case ignored) decides «taken»;
    a role or folder name that draws as nothing is none."""
    async with _client() as c:
        first, _, _ = await _solo_code(c, "d4784 skeleton first")
        ok = await _confirm_solo(c, first, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Zed Bot"})
        assert ok.status_code == 200, ok.text
        before = await _state()
        code, _, _ = await _solo_code(c, "d4784 skeleton second")
        for typed in ("ＺＥＤ  ｂｏｔ", "zed   BOT"):  # full-width letters · spacing and case
            r = await _confirm_solo(c, code, {"runtime": "claude", "project_id": str(PROJ), "agent_name": typed})
            assert (r.status_code, r.json()["error"]["code"]) == (409, "agent_name_taken"), (typed, r.text)
        assert await _state() == before
        fine = await _confirm_solo(c, code, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Zed Bot 2", "agent_role": "\u3164 \u2800", "folder_name": "\u3164"})
        assert fine.status_code == 200, fine.text
        assert [x[0] for x in await _sql(fetch=f"SELECT agent_role FROM agent_project_profiles WHERE member_id='{fine.json()['members'][0]['member_id']}'")] == [None]
        (line,) = await _lines(fine.json()["conversation_id"])
        assert line[0] == "에이전트를 만들었어요 · 이름 Zed Bot 2 · 도구 Claude Code"  # a folder name that draws as nothing is no folder name


@pytest.mark.anyio
async def test_the_free_name_of_a_long_name_still_fits_and_goes_through(solo):
    """Kadir 5245 ⓐ: a 60-character name's neighbour is cut before «2» is added — the card puts it in the field and «만들기» is 200, not 422."""
    async with _client() as c:
        for length in (60, 59):
            long_name = "n" * length
            a, _, _ = await _solo_code(c, f"d4784 long {length} a")
            assert (await _confirm_solo(c, a, {"runtime": "claude", "project_id": str(PROJ), "agent_name": long_name})).status_code == 200
            b, _, _ = await _solo_code(c, f"d4784 long {length} b")
            r = await _confirm_solo(c, b, {"runtime": "claude", "project_id": str(PROJ), "agent_name": long_name})
            assert r.status_code == 409, r.text
            free = r.json()["error"]["suggested_name"]
            assert len(free) <= 60 and free != long_name and free[-2] == " " and free[-1].isdigit(), free  # the 59-character case meets the 60-character one's «… 2» and takes «… 3»
            again = await _confirm_solo(c, b, {"runtime": "claude", "project_id": str(PROJ), "agent_name": free})
            assert again.status_code == 200, again.text
            assert again.json()["members"][0]["name"] == free


@pytest.mark.anyio
async def test_the_organization_is_locked_before_the_setup_row_and_only_for_an_admin(solo):
    """Kadir 5245 ⓓ ⓑ: the statements are recorded — an owner/admin's press locks `organizations` FOR UPDATE before `desktop_setups` FOR UPDATE
    (the organization's deletion takes them in that order); a plain member's wrong call takes no organization lock at all and is refused 403."""
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        text = " ".join(statement.split()).lower()
        if "for update" in text and " from organizations" in text:
            seen.append("organization")
        elif "for update" in text and " from desktop_setups" in text:
            seen.append("setup")

    async with _client() as c:
        code, _, _ = await _solo_code(c, "d4784 lock order")
        event.listen(Engine, "before_cursor_execute", record)
        try:
            ok = await _confirm_solo(c, code, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Locked"})
            assert ok.status_code == 200, ok.text
            admin_seen, seen[:] = list(seen), []
            other, _, _ = await _solo_code(c, "d4784 lock order plain")
            seen[:] = []
            plain = await _confirm_solo(c, other, {"runtime": "claude", "project_id": str(PROJ), "agent_name": "Plain"}, who=PLAIN)
            assert (plain.status_code, plain.json()["error"]["code"]) == (403, "not_org_admin"), plain.text
            plain_seen = list(seen)
        finally:
            event.remove(Engine, "before_cursor_execute", record)
    assert "organization" in admin_seen and "setup" in admin_seen
    assert admin_seen.index("organization") < admin_seen.index("setup"), admin_seen
    assert "organization" not in plain_seen, plain_seen
