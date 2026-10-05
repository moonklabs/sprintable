"""story #4534 (E-DESKTOP-2 B-3) — a person's signed stop / instruction from the phone, the DM header's session state, and the
turn-end notice. Contract 02d2cf71 §11 (v1.9 · v1.9.1). Numbers in the test names are Qadir's list (16:19Z): each check has a
test that goes red without it.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    PLAIN,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _pair, _plain_member, _register

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _state(c, device, agent, state, seq, *, key="s-1", at=None):
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json={
        "report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": (at or _now()).isoformat()})
    assert r.status_code == 200, r.text


async def _dm(*members) -> str:
    conv = str(uuid.uuid4())
    await _sql(f"INSERT INTO conversations (id, org_id, project_id, type, status, free_response) VALUES ('{conv}','{ORG}','{PROJ}','dm','open',false)",
               *[f"INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(),'{conv}','{m}')" for m in members])
    return conv


async def _grant(member):
    await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{member}','granted')")


async def _world(c, name):
    """A device of the owner's (its agent working · the owner's phone paired · a DM between them)."""
    device = await _device(c, name=name)
    agent = device["agents"][0]["member_id"]
    await _state(c, device, agent, "working", 1)
    phone, der = await _register(c)
    await _pair(c, device["device_token"], der)
    conv = await _dm(OWNER_TM, agent)
    return device, agent, phone, der, conv


def _cmd(kind, phone, *, conv=None, text=None, key=None, **extra):
    body = {"kind": kind, "session_key": "s-1", "idempotency_key": key or str(uuid.uuid4()), "signed": "eyJ2IjoxfQ.signed-by-the-phone",
            "phone_key_id": phone, **extra}
    if kind == "send_prompt":
        body.update(text="지금 PR 본문도 고쳐 줘" if text is None else text, conversation_id=conv)
    return body


def _post(c, agent, body, who=OWNER, headers=None):
    return c.post(f"/api/v2/agents/{agent}/desktop-commands", json=body, headers=headers or _person(who))


async def _commands(sid):
    return await _sql(fetch=f"SELECT kind, payload, requested_by, idempotency_key, state FROM desktop_commands WHERE setup_id = '{sid}' ORDER BY device_seq")


async def _lines(conv):
    return await _sql(fetch=f"SELECT sender_id, content FROM conversation_messages WHERE conversation_id = '{conv}'")


async def test_01_02_03_15_who_may_press_is_one_rule_and_the_phone_must_be_theirs_and_paired(world):
    plain_tm = await _plain_member()
    await _grant(plain_tm)
    async with _client() as c:
        device, agent, owner_phone, _der, conv = await _world(c, "d4424 mac 4534a")
        sid = device["setup_id"]
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], _der, plain_der)

        def view(who):
            return c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(who))

        # 01 · 15 — an org owner may; a plain member may not, and the header says the same
        assert (await view(OWNER)).json()["can_command"] is True
        assert (await view(PLAIN)).json()["can_command"] is False
        refused = await _post(c, agent, _cmd("stop_session", plain_phone), who=PLAIN)
        assert (refused.status_code, refused.json()["error"]["code"]) == (403, "not_allowed_to_command")
        # 01 — the agent's owner may (each of the three on its own)
        await _sql(f"UPDATE members SET owner_member_id = '{plain_tm}' WHERE id = '{agent}'")
        assert (await view(PLAIN)).json()["can_command"] is True
        assert (await _post(c, agent, _cmd("stop_session", plain_phone), who=PLAIN)).status_code == 201
        await _sql(f"UPDATE members SET owner_member_id = NULL WHERE id = '{agent}'")
        # 01 — whoever confirmed the device may
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid}'",
                   f"UPDATE org_members SET role = 'member' WHERE user_id = '{PLAIN}'")
        assert (await view(PLAIN)).json()["can_command"] is True
        assert (await _post(c, agent, _cmd("stop_session", plain_phone), who=PLAIN)).status_code == 201
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{sid}'")

        # 03 — the owner sending with someone else's paired phone id
        borrowed = await _post(c, agent, _cmd("stop_session", plain_phone))
        assert (borrowed.status_code, borrowed.json()["error"]["code"]) == (409, "phone_not_paired")
        # 02 — a role that may, but a phone not paired with that computer (role AND pairing)
        unpaired, _ = await _register(c, label="old phone")
        lone = await _post(c, agent, _cmd("stop_session", unpaired))
        assert (lone.status_code, lone.json()["error"]["code"]) == (409, "phone_not_paired")
        assert len(await _commands(sid)) == 2  # only the two allowed stops


async def test_01_owner_admin_is_the_org_role_never_a_project_role(world):
    """PO 17:28Z — the legacy resolver hands a project role: a plain org member who is a project admin must not command; an
    org admin who is only a project member must."""
    plain_tm = await _plain_member()
    await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES (gen_random_uuid(),'{PROJ}','{plain_tm}','granted','admin')")
    async with _client() as c:
        device, agent, _owner_phone, owner_der, _conv = await _world(c, "d4424 mac 4534h")
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], owner_der, plain_der)
        refused = await _post(c, agent, _cmd("stop_session", plain_phone), who=PLAIN)  # project admin · org member
        assert (refused.status_code, refused.json()["error"]["code"]) == (403, "not_allowed_to_command")
        assert (await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(PLAIN))).json()["can_command"] is False
        await _sql(f"UPDATE project_access SET role = 'member' WHERE member_id = '{plain_tm}'",
                   f"UPDATE org_members SET role = 'admin' WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'")
        assert (await _post(c, agent, _cmd("stop_session", plain_phone), who=PLAIN)).status_code == 201  # org admin · project member
        assert (await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(PLAIN))).json()["can_command"] is True


async def test_04_05_06_13_the_session_the_conversation_and_the_body_are_checked(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534b")
        other_agent = device["agents"][1]["member_id"]
        # 04 — a person's own API key · an agent key
        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4534 script", expires_at=None)
            await s.commit()
        try:
            for headers in ({"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)},
                            {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}):
                r = await _post(c, agent, _cmd("stop_session", phone), headers=headers)
                assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required")
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
        # 05 — another agent's session key, through this agent
        r = await _post(c, other_agent, _cmd("stop_session", phone))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "session_not_found")
        # 06 — the conversation must hold both the person and the agent
        person_only, agent_only = await _dm(OWNER_TM, plain_tm), await _dm(plain_tm, agent)
        for conv_id in (person_only, agent_only):
            r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv_id))
            assert (r.status_code, r.json()["error"]["code"]) == (404, "conversation_not_found"), conv_id
        # 13 — extra field · text 0 · 8001
        assert (await _post(c, agent, {**_cmd("stop_session", phone), "cmd": "rm -rf ~"})).status_code == 422
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=""))).status_code == 422
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text="x" * 8001))).status_code == 422
        assert await _commands(device["setup_id"]) == []


async def test_07_08_09_not_working_off_and_unreachable_make_no_command_and_no_line(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534c")
        sid = device["setup_id"]
        await _state(c, device, agent, "idle", 2)
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))  # 07
        assert (r.status_code, r.json()["error"]["code"]) == (409, "session_not_working")
        r = await _post(c, agent, _cmd("stop_session", phone))  # 08
        assert (r.status_code, r.json()) == (200, {"state": "already_stopped"})
        assert await _commands(sid) == [] and await _lines(conv) == []

        await _state(c, device, agent, "working", 3)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")  # 09
        r = await _post(c, agent, _cmd("stop_session", phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "remote_control_off")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
                   f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{sid}'")
        r = await _post(c, agent, _cmd("stop_session", phone))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")
        assert await _commands(sid) == []


async def test_10_11_12_the_instruction_goes_down_as_sent_with_one_line_and_keys_are_per_person(world):
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534d")
        sid = device["setup_id"]
        body = _cmd("send_prompt", phone, conv=conv, text="테스트도 같이 돌려 줘", key="same-key")
        r = await _post(c, agent, body)
        assert r.status_code == 201, r.text
        again = await _post(c, agent, body)  # the same key: the same command, no second line
        assert again.json()["command_id"] == r.json()["command_id"]
        [(kind, payload, by, idem, state)] = await _commands(sid)
        # 11 — carried as sent: the signed blob, the conversation, the text
        assert (kind, state, str(by)) == ("send_prompt", "queued", str(OWNER_TM))
        assert payload == {"session_key": "s-1", "signed": body["signed"], "text": "테스트도 같이 돌려 줘", "conversation_id": conv}
        # 10 — the key is the person's: b3:{member}:{key}
        assert idem == f"b3:{OWNER_TM}:same-key"
        # 12 — the conversation's line waits for the daemon (phone run 4 · PO 03:30Z ②): none while queued, one when it went in,
        # from the person who sent it — and a result again (a late duplicate) writes no second
        assert await _lines(conv) == []
        cid0 = r.json()["command_id"]
        done = await c.post(f"/api/v2/desktop/relay/commands/{cid0}/result", json={"state": "done"}, headers=_tok(device["device_token"]))
        assert done.status_code == 200, done.text
        [(sender, content)] = await _lines(conv)
        assert str(sender) == str(OWNER_TM) and content.startswith("지시 · 지금 턴에 보냄") and "테스트도 같이 돌려 줘" in content
        assert len(await _lines(conv)) == 1

        # the result line: the presser only
        cid = r.json()["command_id"]
        mine = await c.get(f"/api/v2/agents/{agent}/desktop-commands/{cid}", headers=_person(OWNER))
        assert mine.json()["state"] == "done"
        await _grant(plain_tm)
        assert (await c.get(f"/api/v2/agents/{agent}/desktop-commands/{cid}", headers=_person(PLAIN))).status_code == 404


async def test_14_16_17_the_header_is_for_the_agents_project_and_its_link_and_nudge_are_scoped(world, monkeypatch):
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534e")
        url = f"/api/v2/agents/{agent}/desktop-session"
        assert (await c.get(url, headers=_person(PLAIN))).status_code == 404  # 14 — no access to the agent's project
        view = (await c.get(url, headers=_person(OWNER))).json()
        assert (view["state"], view["device_name"], view["session_key"], view["remote_control"]) == ("working", "d4424 mac 4534e", "s-1", True)

        # 16 — the permission link is a request sent to this person only
        req = {"request_id": str(uuid.uuid4()), "session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "tool": "Bash",
               "summary": "ls", "input_hash": "sha256:" + "a" * 64, "expires_at": (_now() + timedelta(minutes=10)).isoformat()}
        made = (await c.post("/api/v2/desktop/relay/permission-requests", json=req, headers=_tok(device["device_token"]))).json()
        await _state(c, device, agent, "waiting_permission", 2)
        assert (await c.get(url, headers=_person(OWNER))).json()["pending_permission_request_id"] == made["id"]
        await _grant(plain_tm)
        assert (await c.get(url, headers=_person(PLAIN))).json()["pending_permission_request_id"] is None

        # 17 — a report nudges the people in a DM with the agent, with no body; nobody else
        import app.routers.events as events

        pushed = []
        monkeypatch.setattr(events, "_push_to_agent", lambda member, payload, *_a, **_k: pushed.append((member, payload)) or True)
        await _dm(plain_tm, device["agents"][1]["member_id"])  # a DM with the other agent: not this one's watcher
        await _state(c, device, agent, "working", 3)
        assert pushed == [(str(OWNER_TM), {"event_type": "desktop.session_changed", "agent_member_id": agent})]

        # a quiet computer reads as unknown, never as stopped
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{device['setup_id']}'")
        assert (await c.get(url, headers=_person(OWNER))).json()["state"] == "unknown"


async def _turn_end_notices(member):
    return await _sql(fetch=("SELECT payload FROM events WHERE recipient_id = :m AND event_type = 'dispatched' "
                             "AND payload->>'event_type' = 'agent.turn_ended'"), params={"m": member})


async def _sent_and_done(c, device, agent, phone, conv, *, key):
    r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text="그 PR 머리도 확인해 줘", key=key))
    cid = r.json()["command_id"]
    done = await c.post(f"/api/v2/desktop/relay/commands/{cid}/result", json={"state": "done"}, headers=_tok(device["device_token"]))
    assert done.status_code == 200
    return cid


async def test_18_20_21_22_the_turn_end_is_told_once_after_the_instruction_went_in(world):
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534f")
        await _sent_and_done(c, device, agent, phone, conv, key="t1")
        await _state(c, device, agent, "idle", 2, at=_now() - timedelta(minutes=1))  # 18 — an idle from before it went in
        assert await _turn_end_notices(OWNER_TM) == []
        await _state(c, device, agent, "waiting_permission", 3)  # 21 — through a permission wait, the turn goes on
        await _state(c, device, agent, "working", 4)
        await _state(c, device, agent, "idle", 5)
        await _state(c, device, agent, "idle", 6)  # 20 — once
        snap = {"report_seq": 7, "sessions": [{"session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "state": "idle",
                                                "at": _now().isoformat()}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(device["device_token"]))).status_code == 200
        notices = await _turn_end_notices(OWNER_TM)
        assert len(notices) == 1
        payload = notices[0][0]
        assert payload["title"] == f"{payload['agent_name']} · 다음 일 기다림"  # 22 — the agent and the words only
        assert "그 PR 머리도" not in str(payload)
        assert await _turn_end_notices(plain_tm) == []


async def test_19_a_stop_or_a_stopped_session_closes_the_wait_without_a_notice(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534g")
        await _sent_and_done(c, device, agent, phone, conv, key="s1")
        await _state(c, device, agent, "stopped", 2)  # the session ended
        await _state(c, device, agent, "idle", 3)
        assert await _turn_end_notices(OWNER_TM) == []

        await _state(c, device, agent, "working", 4)
        await _sent_and_done(c, device, agent, phone, conv, key="s2")
        stop = (await _post(c, agent, _cmd("stop_session", phone, key="stop"))).json()["command_id"]
        await c.post(f"/api/v2/desktop/relay/commands/{stop}/result", json={"state": "done"}, headers=_tok(device["device_token"]))
        await _state(c, device, agent, "idle", 5)  # idle because of the stop
        assert await _turn_end_notices(OWNER_TM) == []


async def test_23_the_phone_reads_the_names_it_shows_and_a_conversation_only_when_both_are_in_it(world):
    """phone contract 48616ee0 v0.3 (Kadir · PO 11:34Z): the sheet and the system prompt show the agent's name and the
    conversation's name from the server — the conversation only when the person and the agent are both in it (the same rule as
    a command's conversation_not_found) · neither is signed."""
    plain_tm = await _plain_member()
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534n")
        url = f"/api/v2/agents/{agent}/desktop-session"
        name = (await _sql(fetch=f"SELECT name FROM members WHERE id = '{agent}'"))[0][0]
        view = (await c.get(url, headers=_person(OWNER))).json()
        assert (view["agent_name"], view["conversation"]) == (name, None)  # no conversation asked → none
        # the DM of the person and the agent: its id · the agent's name (a DM without a title reads as the other one)
        view = (await c.get(url, params={"conversation_id": conv}, headers=_person(OWNER))).json()
        assert view["conversation"] == {"id": conv, "name": name}
        # a titled conversation of both: its title
        titled = await _dm(OWNER_TM, agent)
        await _sql(f"UPDATE conversations SET type = 'group', title = '배포 회의' WHERE id = '{titled}'")
        assert (await c.get(url, params={"conversation_id": titled}, headers=_person(OWNER))).json()["conversation"] == {"id": titled, "name": "배포 회의"}
        # the person is not in it · the agent is not in it · no such conversation → null (the shell refuses: conversation_not_found)
        others = await _dm(plain_tm, agent)
        without_agent = await _dm(OWNER_TM, plain_tm)
        for cid in (others, without_agent, str(uuid.uuid4())):
            assert (await c.get(url, params={"conversation_id": cid}, headers=_person(OWNER))).json()["conversation"] is None, cid
        # and a command into a conversation the view names null is refused the same way (one rule)
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=others))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "conversation_not_found")



async def test_24_the_same_key_again_gets_back_its_command_whatever_the_session_is_now(world):
    """Kadir 4955 1st line: the phone app's [결과 확인] after an end it could not see posts the same key again — it must get back the
    command it made, never a 409 «turn ended» (the app would then resend the instruction as a message: in twice) nor a second
    command. Asked after who may command: another person's key with the same text is theirs alone."""
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534e")
        sid = device["setup_id"]
        prompt = _cmd("send_prompt", phone, conv=conv, text="한 번만 들어가야 해", key="press-1")
        first = await _post(c, agent, prompt)
        assert first.status_code == 201, first.text
        # the turn ends meanwhile (the instruction went in, or not — the app could not see)
        await _state(c, device, agent, "idle", 2)
        again = await _post(c, agent, prompt)
        assert again.status_code == 201, again.text
        assert again.json()["command_id"] == first.json()["command_id"]
        assert len(await _commands(sid)) == 1
        assert await _lines(conv) == [], "no «지시 · 지금 턴에 보냄» line before the daemon says it went in, and never two"
        # a stop the same way: made while working, asked again when idle → the same command, not «already_stopped»
        await _state(c, device, agent, "working", 3)
        stop = _cmd("stop_session", phone, key="press-2")
        s1 = await _post(c, agent, stop)
        assert s1.status_code == 201, s1.text
        await _state(c, device, agent, "idle", 4)
        s2 = await _post(c, agent, stop)
        assert (s2.status_code, s2.json().get("command_id")) == (201, s1.json()["command_id"])
        # a NEW key while idle is still refused (nothing made): the rule for a fresh press is unchanged
        fresh = await _post(c, agent, _cmd("send_prompt", phone, conv=conv, key="press-3"))
        assert (fresh.status_code, fresh.json()["error"]["code"]) == (409, "session_not_working")
        assert len(await _commands(sid)) == 2


async def test_25_the_line_follows_the_daemons_answer_refused_writes_none_after_step_writes_one(world):
    """Phone run 4 (03:28Z): a tool open past the daemon's 20 s wait → `rejected · session_not_working` → the phone sends the words as a
    message. The line written at the press stood next to that message: one instruction read as two. Now: refused or failed → no line
    (the phone's message is the record); done — now or `after_step` — → its one line."""
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4534g")
        tok = _tok(device["device_token"])
        refused = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text="거절될 지시", key="r-1"))).json()["command_id"]
        r = await c.post(f"/api/v2/desktop/relay/commands/{refused}/result",
                         json={"state": "rejected", "result_code": "session_not_working"}, headers=tok)
        assert r.status_code == 200, r.text
        failed = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text="실패한 지시", key="r-2"))).json()["command_id"]
        assert (await c.post(f"/api/v2/desktop/relay/commands/{failed}/result", json={"state": "failed"}, headers=tok)).status_code == 200
        assert await _lines(conv) == []
        later = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text="단계 뒤에 들어갈 지시", key="r-3"))).json()["command_id"]
        assert (await c.post(f"/api/v2/desktop/relay/commands/{later}/result", json={"state": "acked"}, headers=tok)).status_code == 200
        assert await _lines(conv) == []  # acked is not «went in»
        r = await c.post(f"/api/v2/desktop/relay/commands/{later}/result", json={"state": "done", "result_code": "after_step"}, headers=tok)
        assert r.status_code == 200, r.text
        [(sender, content)] = await _lines(conv)
        assert str(sender) == str(OWNER_TM) and "단계 뒤에 들어갈 지시" in content and "거절될 지시" not in content
        # Yuna 03:49Z: after_step is its own line — not «지금 턴에 보냄» (it has not gone in yet)
        assert content.startswith("지시 · 하던 단계 뒤에 넣음") and "지금 턴에 보냄" not in content

