"""story 5025 (B1 · contract v1.2 §2.1 · §2.3 · §4) — who may READ a card: the server answers «which of the phones I pinned may read THIS agent's cards?» and, for a setup that said `seal_to_v1`,
refuses a sealed card whose receivers are not (a subset of) those phones.

Real database. Each test goes red without the line it names.
"""
from __future__ import annotations

import uuid
from datetime import datetime

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
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
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — the autouse remote-control fixture applies here too
    _ask,
    _post_ask,
    _remote_control_on,
    _with_session,
)
from tests.test_4972_permission_envelope_realdb import b64
from tests.test_5027_phone_key_proof_realdb import (  # noqa: F401 — the autouse fixtures (jwt secret · clean phones) apply here too
    Phone,
    _clean_phones,
    _jwt_secret,
    _member_of,
    _plain_member,
    _register as _register_phone,
)

pytestmark = pytest.mark.anyio

TARGETS = "/api/v2/desktop/relay/seal-targets"
PAIRINGS = "/api/v2/desktop/relay/pairings"
NONCE = "n" * 24


async def _phone(c, *, who=OWNER, proof=True) -> tuple[Phone, str]:
    """a phone of `who`, registered (with the proof of its key, or without: an older app) → (the phone, its remote_devices id — what a sealed envelope names in `to`)"""
    p = Phone()
    r = await _register_phone(c, p, who=who, proof=proof, expect=(201,))
    return p, r.json()["id"]


async def _pin(c, token, *phones: Phone, capabilities=None, extra_unregistered=0):
    at = datetime.now().astimezone().isoformat()
    fps = [p.fp for p in phones] + [f"sha256:{uuid.uuid4().hex}{uuid.uuid4().hex}" for _ in range(extra_unregistered)]
    body = {"pairings": [{"phone_key_fingerprint": fp, "paired_at": at} for fp in fps]}
    if capabilities is not None:
        body["capabilities"] = capabilities
    r = await c.put(PAIRINGS, json=body, headers=_tok(token))
    assert r.status_code == 200, r.text
    return r.json()


async def _ask_targets(c, token, agent, phones, nonce=NONCE, **over):
    return await c.post(TARGETS, json={"agent_member_id": agent, "phones": phones, "nonce": nonce, **over}, headers=_tok(token))


async def _computer(c, name):
    device = await _device(c, name=name)
    agent = await _with_session(c, device)
    setup_id = (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{name}'"))[0][0]
    return device, device["device_token"], agent, setup_id


def _sealed_card(agent, setup_id, to, **over):
    plain = _ask(agent)
    for k in ("tool", "summary", "workdir"):
        del plain[k]
    plain["masked"] = False
    ms = int(datetime.fromisoformat(plain["expires_at"]).timestamp() * 1000)
    plain["envelope"] = {
        "v": 1, "kind": "approval_card", "setup_id": str(setup_id), "session_key": "s-1", "command_id": plain["request_id"], "expires_at": ms,
        "from": "host-1", "to": list(to), "epoch": 1, "ctr": 0, "ts": ms - 60_000, "nonce": b64(16),
        "wraps": [{"to": t, "enc": b64(32), "ek": b64(48)} for t in to], "ct": b64(120), "sig": b64(71), **over,
    }
    return plain


async def _cards():
    return (await _sql(fetch="SELECT count(*) FROM agent_permission_requests"))[0][0]


# ── the question ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_a_computer_of_one_person_gets_every_pinned_phone_of_the_receiver_even_an_unproved_older_one_in_the_order_it_asked(world):
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025a")
        proved, proved_id = await _phone(c)
        older, older_id = await _phone(c, proof=False)  # an older app: no proof (§4 C1: with ONE person on the computer it stays a target)
        await _pin(c, token, proved, older)
        r = await _ask_targets(c, token, agent, [older_id, proved_id])
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["seal_to"] == [older_id, proved_id], "the host's own names, in the order it sent them"
        assert j["nonce"] == NONCE and j["reason"] == "paired"
        assert datetime.fromisoformat(j["server_time"]).tzinfo is not None


async def test_a_phone_of_another_person_is_never_named_and_once_people_are_mixed_only_a_proved_key_of_the_receiver_is(world):
    await _plain_member()
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025b")
        mine_proved, mine_proved_id = await _phone(c)
        mine_older, mine_older_id = await _phone(c, proof=False)
        other, other_id = await _phone(c, who=PLAIN)
        await _pin(c, token, mine_proved, mine_older, other)
        r = await _ask_targets(c, token, agent, [mine_proved_id, mine_older_id, other_id])
        assert r.status_code == 200, r.text
        assert r.json()["seal_to"] == [mine_proved_id], "the other person's phone is not the receiver's; the receiver's UNPROVED key vouches for nothing once people are mixed"


async def test_the_pin_of_a_key_the_server_never_saw_is_not_another_person_and_is_never_a_target(world):
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025c")
        older, older_id = await _phone(c, proof=False)
        counts = await _pin(c, token, older, extra_unregistered=1)  # the host pinned a key nobody registered here
        assert counts["unregistered"] == 1
        ghost = str(uuid.uuid4())
        r = await _ask_targets(c, token, agent, [older_id, ghost])
        assert r.json()["seal_to"] == [older_id], "the unregistered pin did not make the computer «mixed» (the older key is still a target) and a name the server has no key for is not chosen"


async def test_a_phone_that_is_revoked_or_no_longer_pinned_or_not_pinned_at_all_is_not_named(world):
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025d")
        a, a_id = await _phone(c)
        b, b_id = await _phone(c)
        not_pinned, not_pinned_id = await _phone(c)
        await _pin(c, token, a, b)
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{b_id}'")
        r = await _ask_targets(c, token, agent, [a_id, b_id, not_pinned_id])
        assert r.json()["seal_to"] == [a_id], "a revoked key and a key this computer never pinned are not receivers"
        await _pin(c, token)  # the computer dropped every pin
        r2 = await _ask_targets(c, token, agent, [a_id])
        assert r2.json()["seal_to"] == []


async def test_when_the_receiver_has_no_phone_pinned_here_the_answer_is_nobody_and_says_why(world):
    await _plain_member()
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025e")
        other, other_id = await _phone(c, who=PLAIN)
        await _pin(c, token, other)  # only the OTHER person paired a phone on this computer
        r = await _ask_targets(c, token, agent, [other_id])
        assert r.status_code == 200 and r.json()["seal_to"] == [] and r.json()["reason"] == "no_paired_phone"


async def test_the_question_is_refused_for_an_agent_that_is_not_on_this_computer_and_for_a_body_of_the_wrong_shape(world):
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025f")
        a, a_id = await _phone(c)
        await _pin(c, token, a)
        assert (await _ask_targets(c, token, str(uuid.uuid4()), [a_id])).status_code == 422  # agent_not_on_device
        assert (await _ask_targets(c, token, agent, [a_id], nonce="short")).status_code == 422
        assert (await c.post(TARGETS, json={"agent_member_id": agent, "phones": [a_id]}, headers=_tok(token))).status_code == 422  # no value to give back
        assert (await _ask_targets(c, token, agent, [a_id], extra="x")).status_code == 422
        assert (await _ask_targets(c, token, agent, [a_id] * 17)).status_code == 422
        assert (await c.post(TARGETS, json={"agent_member_id": agent, "phones": [a_id], "nonce": NONCE})).status_code in (401, 403)  # no device token
        assert (await _ask_targets(c, token, agent, [a_id])).status_code == 200


async def test_the_question_stores_nothing_and_names_no_card(world):
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025g")
        a, a_id = await _phone(c)
        await _pin(c, token, a)
        before = (await _sql(fetch="SELECT count(*) FROM agent_permission_requests"))[0][0]
        for _ in range(3):
            assert (await _ask_targets(c, token, agent, [a_id])).status_code == 200
        assert (await _sql(fetch="SELECT count(*) FROM agent_permission_requests"))[0][0] == before
        assert (await _sql(fetch="SELECT seal_to_v1_at FROM desktop_setups WHERE device_name = 'd4424 mac 5025g'"))[0][0] is None, "asking does not declare anything"


# ── the word `seal_to_v1` ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_a_pin_report_that_says_seal_to_v1_stands_a_mark_that_no_later_report_and_no_update_can_take_away(world):
    async with _client() as c:
        device, token, agent, _ = await _computer(c, "d4424 mac 5025h")
        a, _a = await _phone(c)
        mark = lambda: _sql(fetch="SELECT seal_to_v1_at FROM desktop_setups WHERE device_name = 'd4424 mac 5025h'")  # noqa: E731
        await _pin(c, token, a)
        assert (await mark())[0][0] is None, "a report without the word stands nothing"
        await _pin(c, token, a, capabilities=["some_future_word"])
        assert (await mark())[0][0] is None, "a word this server does not know is ignored"
        await _pin(c, token, a, capabilities=["seal_to_v1", "some_future_word"])
        first = (await mark())[0][0]
        assert first is not None
        await _pin(c, token, a, capabilities=["seal_to_v1"])
        assert (await mark())[0][0] == first, "the first one is kept"
        await _pin(c, token, a)  # an older build of the host joins the same setup, without the word
        assert (await mark())[0][0] == first, "a later report without the word does not turn it off"
        with pytest.raises(Exception, match="one-way"):
            await _sql("UPDATE desktop_setups SET seal_to_v1_at = NULL WHERE device_name = 'd4424 mac 5025h'")
        bad = await c.put(PAIRINGS, json={"pairings": [], "capabilities": ["Not A Word"]}, headers=_tok(token))
        assert bad.status_code == 422


# ── F6: a declared setup's sealed cards may name only the receiver's phones ─────────────────────────────────────────────────────────────────

async def test_a_setup_that_never_said_seal_to_v1_is_unchanged_a_card_sealed_to_anybody_is_taken_as_before(world):
    await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025i")
        mine, mine_id = await _phone(c)
        other, other_id = await _phone(c, who=PLAIN)
        await _pin(c, token, mine, other)
        r = await _post_ask(c, device, _sealed_card(agent, setup_id, [mine_id, other_id]))
        assert r.status_code == 201, r.text


async def test_a_declared_setup_takes_a_card_sealed_to_the_receivers_phones_and_refuses_one_that_names_another_persons_phone(world):
    await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025j")
        mine, mine_id = await _phone(c)
        other, other_id = await _phone(c, who=PLAIN)
        await _pin(c, token, mine, other, capabilities=["seal_to_v1"])
        good = _sealed_card(agent, setup_id, [mine_id])
        ok = await _post_ask(c, device, good)
        assert ok.status_code == 201, ok.text
        row = (await _sql(fetch=f"SELECT recipient_member_id FROM agent_permission_requests WHERE request_id = '{good['request_id']}'"))[0][0]
        assert row == await _member_of(OWNER), "the card was served to the person the question named (one function chooses both)"
        before = await _cards()
        wide = await _post_ask(c, device, _sealed_card(agent, setup_id, [mine_id, other_id]))
        assert wide.status_code == 422 and "envelope_receivers_mismatch" in wide.text, wide.text
        only_other = await _post_ask(c, device, _sealed_card(agent, setup_id, [other_id]))
        assert only_other.status_code == 422 and "envelope_receivers_mismatch" in only_other.text
        assert await _cards() == before, "a refused card leaves no row"


async def test_a_declared_setup_refuses_a_card_sealed_to_a_phone_it_never_pinned_or_a_key_that_is_unproved_among_people_or_nobody(world):
    await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025k")
        proved, proved_id = await _phone(c)
        older, older_id = await _phone(c, proof=False)
        other, other_id = await _phone(c, who=PLAIN)
        stranger, stranger_id = await _phone(c)  # registered by the receiver but NEVER pinned on this computer
        await _pin(c, token, proved, older, other, capabilities=["seal_to_v1"])
        for to in ([stranger_id], [older_id], [proved_id, older_id], [str(uuid.uuid4())]):
            r = await _post_ask(c, device, _sealed_card(agent, setup_id, to))
            assert r.status_code == 422 and "envelope_receivers_mismatch" in r.text, (to, r.text)
        assert (await _post_ask(c, device, _sealed_card(agent, setup_id, [proved_id]))).status_code == 201


async def test_a_setup_of_one_person_that_declared_keeps_working_with_an_unproved_older_phone(world):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025l")
        older, older_id = await _phone(c, proof=False)
        await _pin(c, token, older, capabilities=["seal_to_v1"])
        r = await _post_ask(c, device, _sealed_card(agent, setup_id, [older_id]))
        assert r.status_code == 201, r.text  # §4 C1: one person on the computer — no cross-person threat — an unproved key stays a target


async def test_once_declared_an_older_build_that_joins_the_same_setup_without_the_word_is_still_checked(world):
    await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025m")
        mine, mine_id = await _phone(c)
        other, other_id = await _phone(c, who=PLAIN)
        await _pin(c, token, mine, other, capabilities=["seal_to_v1"])
        await _pin(c, token, mine, other)  # the older build reports its pins: no word
        r = await _post_ask(c, device, _sealed_card(agent, setup_id, [mine_id, other_id]))
        assert r.status_code == 422 and "envelope_receivers_mismatch" in r.text, r.text


async def test_the_check_reads_the_pins_at_the_moment_of_the_card_a_phone_unpinned_since_is_no_longer_a_receiver(world):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025n")
        a, a_id = await _phone(c)
        b, b_id = await _phone(c)
        await _pin(c, token, a, b, capabilities=["seal_to_v1"])
        assert (await _post_ask(c, device, _sealed_card(agent, setup_id, [a_id, b_id]))).status_code == 201
        await _pin(c, token, a)  # b was unpinned
        r = await _post_ask(c, device, _sealed_card(agent, setup_id, [a_id, b_id]))
        assert r.status_code == 422 and "envelope_receivers_mismatch" in r.text


# ── the wordless card (contract v1.3 §1 ③): what the host may upload when it cannot learn who may read the real one ───────────────────────────────────

async def test_a_wordless_terminal_only_card_is_accepted_by_a_setup_that_seals_and_the_server_holds_nothing_of_it_but_its_request_id(world):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025o")
        mine, mine_id = await _phone(c)
        await _pin(c, token, mine, capabilities=["seal_to_v1"])
        assert (await _post_ask(c, device, _sealed_card(agent, setup_id, [mine_id]))).status_code == 201  # the computer has sealed: a plaintext card WITH words is refused from now on
        words = _ask(agent)
        refused = await _post_ask(c, device, words)
        assert refused.status_code == 422 and "sealed_required" in refused.text
        wordless = {"request_id": str(uuid.uuid4()), "session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "terminal_only": True,
                    "expires_at": _ask(agent)["expires_at"]}
        r = await _post_ask(c, device, wordless)
        assert r.status_code == 201, r.text
        row = (await _sql(fetch=("SELECT tool, summary, workdir, preview, envelope, input_hash, terminal_only, sealed FROM agent_permission_requests "
                                 f"WHERE request_id = '{wordless['request_id']}'")))[0]
        assert tuple(row[:6]) == (None, None, None, None, None, None) and row[6] is True and row[7] is False, "the server holds no word of it: only the request id (and the session it belongs to)"
        notices = await _sql(fetch="SELECT count(*) FROM events WHERE event_type = 'dispatched' AND payload->>'event_type' = 'agent.permission_request'")
        assert notices[0][0] == 1, "a terminal-only card sends no notice (only the sealed card above did)"
