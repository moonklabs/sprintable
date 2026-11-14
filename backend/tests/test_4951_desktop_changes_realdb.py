"""story #4951 (①a · Kadir lens A · E · F · G · H · I · J) — the LIST of changed files of one session's folder, from the computer of the person who paired it to that same person's
web / phone view: the `read_changes` command word, the short-lived read row, who may ask and read, the limits, what the server cuts and hides again, and what goes with a disconnect.
Names · a status word · line counts only — never content. Each test goes red without the line it names (mutants in the PR body).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OUTSIDER,
    OWNER,
    PLAIN,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _plain_member
from tests.test_4534_desktop_commands_realdb import _commands, _grant, _remote_control_on, _state  # noqa: F401

pytestmark = pytest.mark.anyio

SESSION = "s-1"
SECRET = "ZQ9-LEAK-MARKER-NAME"  # what must never reach a log line (not a word the sensitive-name rule hides: it must reach the list to be able to leak)


async def _setup(c, name):
    """A computer of the owner's (who paired it) with one agent whose session `s-1` is idle."""
    device = await _device(c, name=name)
    agent = device["agents"][0]["member_id"]
    await _state(c, device, agent, "idle", 1)
    return device, agent


def _ask(c, agent, who=OWNER, key=SESSION, **extra):
    return c.post(f"/api/v2/agents/{agent}/desktop-changes", json={"session_key": key, **extra}, headers=_person(who))


def _get(c, agent, command_id, who=OWNER):
    return c.get(f"/api/v2/agents/{agent}/desktop-changes/{command_id}", headers=_person(who))


def _file(name, status="modified", **extra):
    return {"status": status, "name": name, "adds": 3, "dels": 1, **extra}


def _list(*files, **extra):
    return {"files": list(files), **extra}


def _put(c, device, command_id, body):
    kw = {"content": body} if isinstance(body, (bytes, str)) else {"json": body}
    headers = {**_tok(device["device_token"]), **({"content-type": "application/json"} if "content" in kw else {})}
    return c.put(f"/api/v2/desktop/relay/changes/{command_id}", headers=headers, **kw)


async def _delivered(command_id):
    await _sql(f"UPDATE desktop_commands SET state = 'delivered' WHERE id = '{command_id}'")


async def _rows(sid):
    return await _sql(fetch=f"SELECT command_id, viewer_id, payload, written_at, expires_at - created_at FROM desktop_changes_reads WHERE setup_id = '{sid}'")


async def _age(sid):
    """Let the 3-second pause pass without waiting: what was asked of this computer is moved back in time (the person's pause reads the ask's command row)."""
    await _sql(f"UPDATE desktop_changes_reads SET created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}'")
    await _sql(f"UPDATE desktop_commands SET created_at = created_at - interval '10 seconds' WHERE setup_id = '{sid}' AND kind = 'read_changes'")


async def _fresh(sid):
    """…and its commands closed too, so the one-open-read rule lets the next ask through."""
    await _age(sid)
    await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE setup_id = '{sid}' AND kind = 'read_changes'")


async def _unpolled(cid):
    """The last look at a pending read is a second old (the poll pause, without waiting)."""
    await _sql(f"UPDATE desktop_changes_reads SET polled_at = NULL WHERE command_id = '{cid}'")


async def _ask_ready(c, device, agent):
    r = await _ask(c, agent)
    assert r.status_code == 201, r.text
    cid = r.json()["command_id"]
    await _delivered(cid)
    return cid


async def test_01_an_ask_queues_one_read_command_whose_payload_is_only_the_session_and_makes_a_two_minute_row(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951a")
        sid = device["setup_id"]
        r = await _ask(c, agent)
        assert r.status_code == 201, r.text
        assert r.headers["cache-control"] == "no-store"
        cid = r.json()["command_id"]
        assert [(k, p, st) for k, p, _by, _key, st in await _commands(sid)] == [("read_changes", {"session_key": SESSION}, "queued")]  # no folder, no path, no signature
        rows = await _rows(sid)
        assert [(str(a), str(b), p, w) for a, b, p, w, _ttl in rows] == [(cid, str(OWNER), None, None)]
        assert timedelta(seconds=120) <= rows[0][4] < timedelta(seconds=121)  # the row ends two minutes after it was asked (Kadir A)


async def test_02_the_ask_forbids_everything_but_the_session_key_and_names_a_real_session_of_that_agent(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951b")
        other_device, other_agent = await _setup(c, "d4424 mac 4951b2")
        sid = device["setup_id"]
        for body in ({"session_key": SESSION, "path": "/Users/x"}, {"session_key": SESSION, "folder": "/"}, {"session_key": SESSION, "signed": "x"}, {}, {"session_key": ""},
                     {"session_key": "../etc"}, {"session_key": "s" * 65}):
            r = await c.post(f"/api/v2/agents/{agent}/desktop-changes", json=body, headers=_person(OWNER))
            assert r.status_code == 422, str(body)
        assert (await _ask(c, agent, key="s-nope")).status_code == 404  # no such session of this agent
        assert (await _ask(c, other_agent)).status_code == 201  # the other computer's own agent is fine on its own
        await _fresh(other_device["setup_id"])
        assert (await _ask(c, agent, key=SESSION)).status_code == 201
        assert [k for k, *_ in await _commands(sid)] == ["read_changes"]


async def test_03_only_the_person_who_paired_the_computer_may_ask_not_an_org_admin_not_a_member_who_can_open_the_agent(world):
    plain_tm = await _plain_member()
    await _grant(plain_tm)  # the plain member CAN open the agent's DM
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951c")
        sid = device["setup_id"]
        r = await _ask(c, agent, who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_read_changes")
        await _sql(f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")  # an org ADMIN who did not pair it: still no
        r = await _ask(c, agent, who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_read_changes")
        assert (await _ask(c, agent, who=OUTSIDER)).status_code in (403, 404)  # another organization's admin
        assert await _commands(sid) == []
        assert await _rows(sid) == []
        assert (await _ask(c, agent)).status_code == 201


async def test_04_the_pairing_is_judged_again_under_the_computers_lock_a_computer_paired_by_someone_else_is_refused(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951d")
        sid = device["setup_id"]
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # re-paired to someone else
        r = await _ask(c, agent)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_read_changes")
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        assert (await _ask(c, agent)).status_code == 201


async def test_04b_a_re_pairing_committed_between_the_first_check_and_the_lock_is_caught_under_the_lock(world, monkeypatch):
    """The two judgments are two layers: the first (before the lock) can pass on a computer that is re-paired a moment later; the one under the computer's lock reads the row afresh. This
    makes that moment: the re-pairing commits right after the first judgment's data was read, and the ask is refused all the same — the second layer alone stops it."""
    from app.services import desktop_changes as dc

    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951d2")
        sid = device["setup_id"]
        real = dc._session_of_agent

        async def re_paired_after_the_read(db, **kw):
            session, setup = await real(db, **kw)  # `setup` is read: it still says «paired by the owner»
            await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")  # …and the re-pairing commits before the lock is taken
            return session, setup

        monkeypatch.setattr(dc, "_session_of_agent", re_paired_after_the_read)
        r = await _ask(c, agent)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_allowed_to_read_changes")
        assert await _commands(sid) == [] and await _rows(sid) == []


async def test_05_the_limits_one_open_read_per_computer_one_ask_per_person_per_three_seconds_remote_control_on_a_computer_heard_from(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951e")
        sid = device["setup_id"]
        assert (await _ask(c, agent)).status_code == 201
        r = await _ask(c, agent)  # at once again
        assert (r.status_code, r.json()["error"]["code"]) == (429, "changes_too_fast")
        await _age(sid)
        r = await _ask(c, agent)  # past the pause, but the first read is still open on that computer
        assert (r.status_code, r.json()["error"]["code"]) == (409, "changes_busy")
        await _fresh(sid)
        assert (await _ask(c, agent)).status_code == 201
        await _fresh(sid)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        r = await _ask(c, agent)
        assert r.status_code == 409 and r.json()["error"]["code"] != "changes_busy"
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 hour' WHERE setup_id = '{sid}'")
        r = await _ask(c, agent)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")


async def test_06_a_read_that_waited_past_thirty_seconds_is_rejected_not_delivered(world):
    from app.core.database import async_session_factory
    from app.services.desktop_relay import commands_to_send

    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951f")
        sid = device["setup_id"]
        r = await _ask(c, agent)
        cid = r.json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '31 seconds' WHERE id = '{cid}'")
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(sid), 0)
            await s.commit()
        assert [x.kind for x in sent if x.kind == "read_changes"] == []
        assert [(st, code) for st, code in await _sql(fetch=f"SELECT state, result_code FROM desktop_commands WHERE id = '{cid}'")] == [("rejected", "expired")]
        await _fresh(sid)
        r = await _ask(c, agent)  # a new ask is a new command and goes
        async with async_session_factory() as s:
            sent = await commands_to_send(s, uuid.UUID(sid), 0)
            await s.commit()
        assert [str(x.id) for x in sent if x.kind == "read_changes"] == [r.json()["command_id"]]


async def test_07_the_computers_list_is_cut_cleaned_and_hidden_again_by_the_server_whatever_it_sent(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951g")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        long_name = "d/" + "가" * 400
        files = [
            _file("src/app.ts"),
            _file("notes.txt", "renamed", old_name=".env"),  # a secret renamed to a plain name: still hidden (its OLD name counts)
            _file("keys/server.PEM", "added"), _file("config/.env.production", "modified"), _file("deploy/credentials.json", "added"),
            _file("sub/.ENV", "added"), _file("x/.aws/config", "modified"), _file("id_rsa.pub", "added"), _file("a/service-account-prod.json", "added"),
            _file("terraform.tfstate", "modified"), _file(".docker/config.json", "modified"), _file("secret.p8 ", "added"), _file("k.pfx.", "added"),
            _file("docs/read‮me\u0007.txt", "added"),  # a bidirectional override and a control character in a shown name
            _file(long_name, "added", binary=True),
            _file("img.png", "added", hidden=False, adds=None, dels=None, binary=True),
            _file(".e\u200bnv", "added"), _file(".netrc\u00a0", "added"), _file("x\uff0f.env", "added"),  # invisible format character · no-break space · full-width slash: the same names, drawn differently
            _file("secrets.yaml", "added"), _file("cfg/client_secret.json", "added"), _file("infra/prod.tfvars.json", "added"), _file("a/login.keychain-db", "added"), _file("x/.token", "added"),  # lens #1
            _file("d/" + "p" * 300 + "/.env", "added"),  # lens #2: the secret segment is past the 240 a name is SHOWN at — judged on the whole name, so it is hidden
            _file("docs/conf\u200big.json", "added"),  # lens #3: a zero-width character is not kept in what is shown
        ]
        r = await _put(c, device, cid, _list(*files))
        assert (r.status_code, r.json()) == (200, {"files": len(files)}), r.text
        got = (await _get(c, agent, cid)).json()
        rows = got["files"]
        shown = {f["name"]: f for f in rows if not f["hidden"]}
        # the plain files are shown with their counts; the renamed secret and every sensitive spelling are hidden — no name, no old name, no counts
        assert shown["src/app.ts"]["adds"] == 3 and "img.png" in shown and shown["img.png"]["binary"] is True
        hidden = [f for f in rows if f["hidden"]]
        assert len(hidden) == 21
        assert "docs/config.json" in shown and not any("\u200b" in n for n in shown)
        assert all(f["name"] is None and f["old_name"] is None and f["adds"] is None and f["dels"] is None for f in hidden)
        assert "notes.txt" not in shown and ".env" not in str(rows)
        assert "docs/readme.txt" in shown  # the override character and the control character are gone
        assert not any(ch in "".join(f["name"] for f in shown.values()) for ch in "‮\u0007")
        assert max(len(n) for n in shown) == 240  # a long name is cut at 240 characters
        assert got["more"] is False and got["total"] == len(files) and got["state"] == "done"
        assert await _rows(sid) == []


async def test_08_the_list_is_cut_at_two_hundred_files_and_says_there_is_more_a_body_over_512kb_is_refused_unstored(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951h")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        files = [_file(f"f{i:04d}.txt") for i in range(260)]
        assert (await _put(c, device, cid, _list(*files))).status_code == 200
        got = (await _get(c, agent, cid)).json()
        assert (len(got["files"]), got["more"], got["total"]) == (200, True, 260)
        await _fresh(sid)
        cid2 = await _ask_ready(c, device, agent)
        big = ('{"files":[{"status":"added","name":"' + "x" * (512 * 1024) + '"}]}').encode()
        r = await _put(c, device, cid2, big)
        assert (r.status_code, r.json()["error"]["code"]) == (413, "changes_too_large")
        r = await _put(c, device, cid2, _list(*[_file(f"g{i}.txt") for i in range(1001)]))
        assert r.status_code == 422  # more than a computer may even send
        assert [p for _a, _b, p, *_ in await _rows(sid)] == [None]  # nothing stored


async def test_09_the_computers_body_forbids_content_and_a_refusal_never_echoes_what_it_held(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951i")
        cid = await _ask_ready(c, device, agent)
        for body in (_list({**_file("a.txt"), "diff": f"+{SECRET}"}), _list({**_file("a.txt"), "content": SECRET}), {"files": [], "text": SECRET}, _list(_file("a.txt", status="exploded")),
                     _list(_file("a.txt", adds=-1)), _list(_file("a.txt", adds="3")), _list(_file(SECRET, status="oops"))):
            r = await _put(c, device, cid, body)
            assert r.status_code == 422, str(body)
            assert SECRET not in r.text
        r = await _put(c, device, cid, '{"files": [' + SECRET)  # not even JSON
        assert r.status_code == 422 and SECRET not in r.text


async def test_10_a_list_is_written_once_only_into_an_open_read_of_that_computer(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951j")
        other, _other_agent = await _setup(c, "d4424 mac 4951j2")
        sid = device["setup_id"]
        r = await _ask(c, agent)
        cid = r.json()["command_id"]
        r = await _put(c, device, cid, _list(_file("a.txt")))  # the command is still `queued`: nothing was told to this computer yet
        assert (r.status_code, r.json()["error"]["code"]) == (409, "changes_command_closed")
        await _delivered(cid)
        r = await _put(c, other, cid, _list(_file("a.txt")))  # another computer cannot write into it
        assert (r.status_code, r.json()["error"]["code"]) == (404, "changes_read_not_found")
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        r = await _put(c, device, cid, _list(_file("b.txt")))  # a second write: no
        assert (r.status_code, r.json()["error"]["code"]) == (409, "changes_already_written")
        assert (await _put(c, device, str(uuid.uuid4()), _list())).status_code == 404
        assert [f["name"] for f in (await _get(c, agent, cid)).json()["files"]] == ["a.txt"]  # the first write is what stands
        assert await _rows(sid) == []
        # a read whose pairing person is no longer the one who asked takes no list
        await _fresh(sid)
        cid2 = await _ask_ready(c, device, agent)
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        r = await _put(c, device, cid2, _list(_file("a.txt")))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "changes_viewer_gone")
        assert await _rows(sid) == []


async def test_11_a_list_is_read_once_and_the_row_is_deleted_by_the_reading(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951k")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        r = await _get(c, agent, cid)  # nothing yet: where the read stands, and the row stays
        assert (r.status_code, r.json()["state"], r.json()["files"]) == (200, "delivered", None)
        assert len(await _rows(sid)) == 1
        assert (await _put(c, device, cid, _list(_file("a.txt"), _file("b.txt", "added")))).status_code == 200
        assert r.headers["cache-control"] == "no-store"
        await _unpolled(cid)  # (the look above was a poll: the next look is a second away — see test_23)
        r = await _get(c, agent, cid)
        assert (r.status_code, [f["name"] for f in r.json()["files"]]) == (200, ["a.txt", "b.txt"])
        assert await _rows(sid) == []  # gone with the reading
        r = await _get(c, agent, cid)  # the second read: nothing
        assert (r.status_code, r.json()["error"]["code"]) == (404, "changes_read_not_found")
        # the audit line: who · which computer · how many files · no content
        audit = await _sql(fetch=f"SELECT viewer_id, setup_id, command_id, file_count FROM desktop_changes_audit WHERE org_id = '{ORG}'")
        assert [(str(v), str(s), str(cm), n) for v, s, cm, n in audit] == [(str(OWNER), sid, cid, 2)]
        assert "a.txt" not in str(audit)


async def test_12_a_computer_that_ends_without_a_list_is_the_answer_and_leaves_no_row(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951l")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        r = await c.post(f"/api/v2/desktop/relay/commands/{cid}/result", json={"state": "failed", "result_code": "not_a_repo"}, headers=_tok(device["device_token"]))
        assert r.status_code == 200, r.text
        r = await _get(c, agent, cid)
        assert (r.status_code, r.json()["state"], r.json()["code"], r.json()["files"]) == (200, "failed", "not_a_repo", None)
        assert await _rows(sid) == []


async def test_13_another_person_another_agent_or_another_computer_cannot_read_by_the_id_and_the_row_stays_for_its_owner(world):
    plain_tm = await _plain_member()
    await _grant(plain_tm)
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951m")
        other, other_agent = await _setup(c, "d4424 mac 4951m2")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        for who, ag in ((PLAIN, agent), (OUTSIDER, agent), (OWNER, other_agent)):  # another person · another org's person · another computer's agent
            r = await _get(c, ag, cid, who=who)
            assert r.status_code in (403, 404), (who, r.text)
            assert "a.txt" not in r.text
        assert len(await _rows(sid)) == 1  # nothing of that consumed the row
        assert [f["name"] for f in (await _get(c, agent, cid)).json()["files"]] == ["a.txt"]  # its owner still reads it


async def test_14_an_expired_row_is_not_readable_and_goes_and_the_sweep_takes_the_rest(world):
    from app.core.database import async_session_factory
    from app.services.desktop_changes import purge_expired

    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951n")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        await _sql(f"UPDATE desktop_changes_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid}'")
        r = await _get(c, agent, cid)
        assert (r.status_code, r.json()["error"]["code"]) == (404, "changes_read_not_found")
        assert await _rows(sid) == []  # the refusal deleted it
        await _fresh(sid)
        cid2 = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid2, _list(_file("b.txt")))).status_code == 200
        await _sql(f"UPDATE desktop_changes_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid2}'")
        async with async_session_factory() as s:  # nobody comes back to read it: the cron's sweep
            assert await purge_expired(s) == 1
            await s.commit()
        assert await _rows(sid) == []
        # a write into a row past its end is refused
        await _fresh(sid)
        cid3 = await _ask_ready(c, device, agent)
        await _sql(f"UPDATE desktop_changes_reads SET expires_at = now() - interval '1 second' WHERE command_id = '{cid3}'")
        assert (await _put(c, device, cid3, _list(_file("c.txt")))).status_code == 404


async def test_15_a_read_whose_pairing_remote_control_or_line_is_gone_is_not_readable_and_leaves_nothing(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951o")
        sid = device["setup_id"]
        # re-paired to someone else after the list was written: the old viewer gets nothing, and the row goes
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        assert (await _get(c, agent, cid)).status_code == 404
        assert await _rows(sid) == []
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")
        await _fresh(sid)
        # remote control turned off (the owner's switch) takes every list of the organization
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        r = await c.put(f"/api/v2/organizations/{ORG}/remote-control", json={"enabled": False}, headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert await _rows(sid) == []
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
        await _fresh(sid)
        # the computer is disconnected (the web's [연결 끊기]): its lists go and no new ask is taken
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert await _rows(sid) == []
        assert (await _get(c, agent, cid)).status_code == 404
        assert (await _ask(c, agent)).status_code in (403, 404, 409)
        assert await _rows(sid) == []


async def test_15b_a_replaced_line_and_a_reclaimed_account_take_their_lists_too(world):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account
    from app.services.desktop_setup import _retire_same_machine

    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951q")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        assert len(await _rows(sid)) == 1
        # a new setup on the same machine replaces this line
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4951' WHERE id = '{sid}'")
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, uuid.UUID(sid))
            agents = frozenset(uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent")
            assert await _retire_same_machine(s, machine_key="mk-4951", others=[setup], now=datetime.now(timezone.utc), new_agents=agents, before={setup.id: agents}) == 1
            await s.commit()
        assert await _rows(sid) == []
        await _fresh(sid)  # the person's pause: the first ask's command row stays after its list is gone
        # an unproved account is reclaimed: the computers it confirmed are cut off
        device2, agent2 = await _setup(c, "d4424 mac 4951q2")
        sid2 = device2["setup_id"]
        cid2 = await _ask_ready(c, device2, agent2)
        assert (await _put(c, device2, cid2, _list(_file("b.txt")))).status_code == 200
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'", f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid2}'")
        assert len(await _rows(sid2)) == 1
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            assert await _reclaim_unproved_account(s, user, why="test 4951") is not None
            await s.commit()
        assert await _rows(sid2) == []


async def test_19_a_session_key_that_passes_to_another_agent_after_the_ask_can_neither_hand_over_nor_take_the_list(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951r")
        other_agent = device["agents"][1]["member_id"]
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        await _sql(f"UPDATE desktop_sessions SET agent_member_id = '{other_agent}' WHERE setup_id = '{sid}' AND session_key = '{SESSION}'")  # a later report hands the key to another agent
        r = await _put(c, device, cid, _list(_file("a.txt")))  # …so the list of the folder it now stands for is not stored under the first ask
        assert (r.status_code, r.json()["error"]["code"]) == (409, "changes_session_gone")
        assert await _rows(sid) == []
        # written first, then the key moves: the agent the key was handed to cannot take it, and neither does the one it was asked for (the session is no longer theirs)
        await _sql(f"UPDATE desktop_sessions SET agent_member_id = '{agent}' WHERE setup_id = '{sid}' AND session_key = '{SESSION}'")
        await _fresh(sid)
        cid2 = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid2, _list(_file("b.txt")))).status_code == 200
        await _sql(f"UPDATE desktop_sessions SET agent_member_id = '{other_agent}' WHERE setup_id = '{sid}' AND session_key = '{SESSION}'")
        assert (await _get(c, other_agent, cid2)).status_code == 404  # the new owner of the key: the row was asked for another agent
        assert (await _get(c, agent, cid2)).status_code == 404  # the asked-for agent: the session is not theirs any more
        await _sql(f"UPDATE desktop_sessions SET agent_member_id = '{agent}' WHERE setup_id = '{sid}' AND session_key = '{SESSION}'")
        assert [f["name"] for f in (await _get(c, agent, cid2)).json()["files"]] == ["b.txt"]  # back where it was asked: the list is still its own


async def test_20_the_pause_outlives_the_reading_and_one_physical_computer_reads_one_list_at_a_time(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951s")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        assert (await _get(c, agent, cid)).status_code == 200  # read: the row is gone
        r = await _ask(c, agent)  # …the person's three seconds are not
        assert (r.status_code, r.json()["error"]["code"]) == (429, "changes_too_fast")
        await _fresh(sid)
        # two lines of ONE machine: one open read between them
        device2, agent2 = await _setup(c, "d4424 mac 4951s2")
        sid2 = device2["setup_id"]
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4951-two' WHERE id IN ('{sid}', '{sid2}')")
        assert (await _ask(c, agent)).status_code == 201
        await _age(sid)
        r = await _ask(c, agent2)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "changes_busy")
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4951-other' WHERE id = '{sid2}'")  # a different machine: no such limit
        assert (await _ask(c, agent2)).status_code == 201


async def test_21_a_list_whose_command_ended_without_success_after_it_was_stored_is_not_given(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951t")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        await _sql(f"UPDATE desktop_commands SET state = 'rejected', result_code = 'expired' WHERE id = '{cid}'")  # the stale rejection that came after the list was stored
        r = await _get(c, agent, cid)
        assert (r.status_code, r.json()["state"], r.json()["files"]) == (200, "rejected", None)
        assert await _rows(sid) == []


async def test_22_the_limits_are_counted_under_advisory_locks_a_second_ask_waits_for_the_person_and_for_the_machine(world):
    """The two locks are what make «one at a time» true for asks that arrive together: while another transaction holds the person's key (or the machine's), an ask does not pass — it waits,
    and when the key is let go it goes through. (Removing a lock — or taking another key — lets the ask through at once and this goes red.)"""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async def blocked_while_held(key: str, agent: str, c) -> None:
        async with async_session_factory() as holder:
            await holder.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key})
            task = asyncio.create_task(_ask(c, agent))
            await asyncio.sleep(1.5)
            assert not task.done(), f"an ask went through while {key} was held"
            await holder.commit()  # lets the key go
        r = await asyncio.wait_for(task, 20)
        assert r.status_code == 201, r.text

    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951u")
        sid = device["setup_id"]
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4951-lock' WHERE id = '{sid}'")
        await blocked_while_held(f"changes-person:{OWNER}", agent, c)
        await _fresh(sid)
        await blocked_while_held(f"changes-machine:{ORG}:mk-4951-lock", agent, c)


async def test_23_a_pending_read_is_looked_at_once_a_second(world):
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951v")
        cid = await _ask_ready(c, device, agent)
        r = await _get(c, agent, cid)
        assert (r.status_code, r.json()["state"]) == (200, "delivered")
        r = await _get(c, agent, cid)  # at once again: no lock is asked for, the person is told to wait a second
        assert (r.status_code, r.json()["error"]["code"], r.json()["error"]["detail"]) == (429, "changes_polled_too_fast", {"retry_after": 1})
        await _unpolled(cid)
        assert (await _get(c, agent, cid)).status_code == 200
        assert (await _put(c, device, cid, _list(_file("a.txt")))).status_code == 200
        assert (await _get(c, agent, cid)).status_code == 429  # the look that takes the list is held to the same second
        await _unpolled(cid)
        assert [f["name"] for f in (await _get(c, agent, cid)).json()["files"]] == ["a.txt"]


async def test_24_an_audit_line_lives_ninety_days_and_goes_with_its_persons_account_purge(world):
    from app.core.database import async_session_factory
    from app.services.account_purge import purge_deleted_accounts
    from app.services.desktop_changes import purge_audit

    async def line(viewer, days):
        await _sql(f"INSERT INTO desktop_changes_audit (id, org_id, viewer_id, setup_id, command_id, file_count, created_at) "
                   f"VALUES (gen_random_uuid(), '{ORG}', '{viewer}', gen_random_uuid(), gen_random_uuid(), 3, now() - interval '{days} days')")

    async def lines():
        return sorted(str(v) + ":" + str(n) for v, n in await _sql(fetch="SELECT viewer_id, file_count FROM desktop_changes_audit"))

    await line(OWNER, 91)   # past its ninety days
    await line(OWNER, 89)   # inside them
    await line(PLAIN, 1)
    async with async_session_factory() as s:
        assert await purge_audit(s) == 1
        await s.commit()
    assert await lines() == sorted([f"{OWNER}:3", f"{PLAIN}:3"])
    # the account purge of a person whose grace is over takes that person's lines — and only theirs
    await _sql(f"UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = '{PLAIN}'")
    async with async_session_factory() as s:
        assert await purge_deleted_accounts(s) >= 1
        await s.commit()
    assert await lines() == [f"{OWNER}:3"]


async def test_16_no_log_line_and_no_error_carries_a_file_name_on_any_road_of_the_read(world, caplog):
    from app.main import app  # noqa: F401 — importing the app configures logging and clears the root handlers (caplog's included): attach it again
    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.INFO, logger="httpx")  # the app sets httpx to WARNING (its INFO lines carry full request URLs); the test client's own request lines are the ones counted here
    async with _client() as c:
        device, agent = await _setup(c, "d4424 mac 4951p")
        sid = device["setup_id"]
        cid = await _ask_ready(c, device, agent)
        assert (await _put(c, device, cid, _list(_file(f"src/{SECRET}.ts"), _file(f"{SECRET}.txt", "renamed", old_name=f".env/{SECRET}")))).status_code == 200
        await _put(c, device, cid, _list(_file(f"src/{SECRET}.ts")))  # a second write (409) · a bad one (422) · a wrong id (404): none says the name
        await _put(c, device, cid, '{"files": [{"name": "' + SECRET)
        await _put(c, device, str(uuid.uuid4()), _list(_file(SECRET)))
        assert (await _get(c, agent, cid)).status_code == 200
        assert (await _get(c, agent, cid)).status_code == 404
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'")
        await _fresh(sid)
        await _ask(c, agent)
    lines = [rec.getMessage() for rec in caplog.records if rec.name != "httpx"]
    assert not [ln for ln in lines if SECRET in ln], [ln for ln in lines if SECRET in ln][:3]
    assert any("desktop changes read" in ln for ln in lines)  # the ids and counts line is there


def test_17_the_command_word_and_its_payload_schema_and_the_checks_are_one_set():
    from app.models.desktop_relay import COMMAND_KINDS
    from app.services.desktop_relay import PAYLOAD_SCHEMAS

    assert "read_changes" in COMMAND_KINDS and tuple(PAYLOAD_SCHEMAS) == COMMAND_KINDS


def test_18_the_sensitive_name_rule_reads_every_segment_both_names_and_every_spelling():
    from app.services.desktop_changes import clean_name, is_sensitive_path

    for path in (".env", "a/b/.env.local", "A/.ENV", ".env.", ".env ", "dir/id_ed25519", "x/server.key", "x/Cert.PEM", "a/.aws/credentials", ".aws/config", "k/my-credentials-2.txt",
                 "svc/service-account-x.json", "t/terraform.tfstate.backup", ".docker/config.json", "app/.npmrc", "b/.netrc", "x/vpn.ovpn", "p/.htpasswd", "k/kubeconfig", "a\\.env", "secrets.yaml", "cfg/client_secret.json", "my-secret.txt", "infra/prod.tfvars.json", "a.keychain", "login.keychain-db", "x/.token", ".docker\u1680/config.json", ".docker./config.json\u00a0",
                 ".e\u200bnv", ".netrc\u00a0", ".env\u2003", "x\uff0f.env", "a/.ENV\u200d", "ｋ/.env", ".aws\u200b/config"):
        assert is_sensitive_path(path), path
    for path in ("src/app.ts", "README.md", "environment.ts", "docs/key-notes.md", "assets/keyboard.png", "src/envelope.ts", "env\u200bironment.ts", "", None):
        assert not is_sensitive_path(path), path
    assert clean_name("a‮b⁦c‎d\u0000e\u0085f g") == "abcdefg"
    assert len(clean_name("가" * 300)) == 240
    assert clean_name("conf\u200big\u00adfile\ufeff.json") == "configfile.json"  # Cf never reaches what is shown
