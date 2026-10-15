"""story 4695 — a phone that scans a computer's QR must send its key and offer with THAT computer's organization.

The failure (the teacher, 10-15): «이 QR의 컴퓨터를 찾지 못했어요» with the organization and the account right. The phone's pairing page sits outside
the dashboard shell, so it carries no X-Org-Id and the server judged the offer by the login's default org — an account in several orgs whose default
is not the QR's org got `setup_not_found` for a computer that is theirs. `GET /remote-devices/pairing-target?setup_id=` answers the org of the
computer for a MEMBER of that org (anyone else: the same `setup_not_found` as the offer — nothing says whether such a computer exists), and the
phone sends the rest with it. The server's own record now tells the four causes of `setup_not_found` apart — in words, with no id.
"""
from __future__ import annotations

import logging
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    OWNER_TM,
    PLAIN,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device
from tests.test_4531_pairing_offers_realdb import OFFERS, _offer, _phone_key
from tests.test_4533_agent_permissions_realdb import PHONES, _pair, _phone_key as _new_phone_key, _register, _remote_control_on, _with_session  # noqa: F401

pytestmark = pytest.mark.anyio

TARGET = "/api/v2/remote-devices/pairing-target"


def _no_org(user: uuid.UUID) -> dict:
    """a login with no org header (the phone's pairing page): only the Authorization"""
    h = _person(user)
    h.pop("X-Org-Id")
    return h


def _code(r) -> tuple[int, str]:
    return r.status_code, r.json()["error"]["code"]


async def _also_member_of(user: uuid.UUID, org: uuid.UUID, member_id: uuid.UUID | None = None) -> None:
    await _sql(f"INSERT INTO org_members (id, org_id, user_id, role) VALUES ('{member_id or uuid.uuid4()}', '{org}', '{user}', 'member')")


async def test_01_a_member_of_the_computers_org_gets_that_org_without_any_org_header(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695a")
        await _with_session(c, device)
        r = await c.get(TARGET, params={"setup_id": device["setup_id"]}, headers=_no_org(OWNER))
        assert (r.status_code, r.json()) == (200, {"org_id": str(ORG)}), r.text


async def test_02_everyone_else_gets_the_offers_own_answer_whatever_the_cause(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695b")
        await _with_session(c, device)
        sid = device["setup_id"]
        # not a member of the computer's org (another org's admin) · an unknown id
        assert _code(await c.get(TARGET, params={"setup_id": sid}, headers=_no_org(OUTSIDER))) == (404, "setup_not_found")
        assert _code(await c.get(TARGET, params={"setup_id": str(uuid.uuid4())}, headers=_no_org(OWNER))) == (404, "setup_not_found")
        # disconnected · never exchanged
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
        assert _code(await c.get(TARGET, params={"setup_id": sid}, headers=_no_org(OWNER))) == (404, "setup_not_found")
        await _sql(f"UPDATE desktop_setups SET revoked_at = NULL, exchanged_at = NULL WHERE id = '{sid}'")
        assert _code(await c.get(TARGET, params={"setup_id": sid}, headers=_no_org(OWNER))) == (404, "setup_not_found")
        # an API key is not a person's session
        assert (await c.get(TARGET, params={"setup_id": sid}, headers={"Authorization": f"Bearer {device['agents'][0]['api_key']}"})).status_code == 403
        # no login
        assert (await c.get(TARGET, params={"setup_id": sid})).status_code in (401, 403)


async def test_03_an_account_in_two_orgs_asks_for_the_org_of_the_QR_not_its_default(world):
    """the teacher's case: OWNER is in ORG (the session's org) and in ORG2; the computer is ORG2's."""
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695c")
        await _with_session(c, device)
        await _also_member_of(OWNER, ORG2)
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE id = '{device['setup_id']}'")
        r = await c.get(TARGET, params={"setup_id": device["setup_id"]}, headers=_no_org(OWNER))
        assert (r.status_code, r.json()) == (200, {"org_id": str(ORG2)}), r.text
        # the other org's own person gets the same
        r2 = await c.get(TARGET, params={"setup_id": device["setup_id"]}, headers=_no_org(OUTSIDER))
        assert r2.json() == {"org_id": str(ORG2)}


async def test_04_the_record_tells_the_causes_apart_in_words_and_names_nothing(world, caplog):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695d")
        await _with_session(c, device)
        phone_id, _ = await _register(c)
        public_key = await _phone_key(phone_id)
        sid = device["setup_id"]

        def last(msg_part: str) -> str:
            return [r.getMessage() for r in caplog.records if "setup_not_found" in r.getMessage() and msg_part in r.getMessage()][-1]

        caplog.set_level(logging.INFO, logger="app.services.agent_permissions")
        # the computer is another org's, and the caller is a member of THAT org too (the multi-org account)
        await _also_member_of(OWNER, ORG2)
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE id = '{sid}'")
        assert _code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (404, "setup_not_found")
        assert "reason=computer_of_another_org caller_in_computers_org=True" in last("computer_of_another_org")
        # …and not a member of it
        await _sql(f"DELETE FROM org_members WHERE org_id = '{ORG2}' AND user_id = '{OWNER}'")
        assert _code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (404, "setup_not_found")
        assert "reason=computer_of_another_org caller_in_computers_org=False" in last("computer_of_another_org")
        # back in the session's org: disconnected · never exchanged · no such computer
        await _sql(f"UPDATE desktop_setups SET org_id = '{ORG}', revoked_at = now() WHERE id = '{sid}'")
        assert _code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (404, "setup_not_found")
        assert "reason=computer_disconnected" in last("computer_disconnected")
        await _sql(f"UPDATE desktop_setups SET revoked_at = NULL, exchanged_at = NULL WHERE id = '{sid}'")
        assert _code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (404, "setup_not_found")
        assert "reason=computer_not_exchanged" in last("computer_not_exchanged")
        assert _code(await c.post(OFFERS, json=_offer(device, phone_id, public_key, setup_id=str(uuid.uuid4())), headers=_person(OWNER))) == (404, "setup_not_found")
        assert "reason=no_such_computer" in last("no_such_computer")
        # the phone is told the same one thing every time, and the record holds no id
        text = "\n".join(r.getMessage() for r in caplog.records if "setup_not_found" in r.getMessage())
        for secret in (sid, str(ORG), str(ORG2), str(OWNER), str(phone_id)):
            assert secret not in text


async def test_05_the_offer_with_the_QR_orgs_header_goes_through_for_that_orgs_person(world):
    """what the phone now sends: the phone key registered and the offer made with `X-Org-Id` = the computer's org."""
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695e")
        await _with_session(c, device)
        phone_id, _ = await _register(c)
        public_key = await _phone_key(phone_id)
        # OWNER's session may rest on another org (a default org of an account in several): the header names the QR's
        await _also_member_of(OWNER, ORG2)
        r = await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER, ORG))
        assert (r.status_code, r.json()) == (202, {"state": "sent"}), r.text
        # the same offer with the other org's header: the computer is not there for that org — as before
        r2 = await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER, ORG2))
        assert r2.status_code == 404, r2.text


OWNER_IN_ORG2 = uuid.UUID("d4424000-0000-0000-0000-000000000095")


async def _owner_joins_org2() -> None:
    """OWNER is also a person of ORG2 (a members row there — a different member id than OWNER_TM)"""
    # the member id of a person is their org_members id (0075: members.id = org_members.id), and a members row carries it
    await _also_member_of(OWNER, ORG2, OWNER_IN_ORG2)
    await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{OWNER_IN_ORG2}','{ORG2}','{OWNER}','human','Owner in org2',true)")


async def test_06_a_key_registered_under_the_default_org_moves_to_the_org_of_the_QR_and_not_otherwise(world):
    """the teacher's retry after the failure: the first attempt had registered the phone's key under the login's default org; the same
    person, now asking with the QR's org, must not be told «registered by someone else»."""
    async with _client() as c:
        key, _der = _new_phone_key()
        await _owner_joins_org2()
        first = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER, ORG))
        assert first.status_code == 201, first.text
        again = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER, ORG2))
        assert again.status_code in (200, 201), again.text
        assert again.json()["id"] == first.json()["id"]  # the same key row, now the ORG2 member's
        row = (await _sql(fetch=f"SELECT member_id, org_id FROM remote_devices WHERE id = '{first.json()['id']}'"))[0]
        assert (str(row[0]), str(row[1])) == (str(OWNER_IN_ORG2), str(ORG2))
        # another person's key is still «taken» (PLAIN asks for OWNER's key under their own member)
        taken = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(PLAIN, ORG))
        assert (taken.status_code, taken.json()["error"]["code"]) == (409, "remote_device_taken")


async def test_07_a_key_that_holds_a_live_pairing_stays_where_it_is(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4695f")
        await _with_session(c, device)
        await _owner_joins_org2()
        key, der = _new_phone_key()
        first = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER, ORG))
        assert first.status_code == 201, first.text
        await _pair(c, device["device_token"], der)  # the computer reports this key as paired
        again = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER, ORG2))
        assert (again.status_code, again.json()["error"]["code"]) == (409, "remote_device_taken")
        row = (await _sql(fetch=f"SELECT member_id FROM remote_devices WHERE id = '{first.json()['id']}'"))[0]
        assert str(row[0]) == str(OWNER_TM)


async def test_09_a_failing_reason_lookup_logs_the_kind_of_failure_only_and_never_changes_the_answer(world, caplog):
    """Kadir/PO (5091): the warning carried `exc_info` — a failed query's traceback holds its parameters (setup · org ids), which the record
    must not. Only the exception's class name is kept."""
    from app.services import agent_permissions as svc

    setup_id, org_id, member_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    class _Db:
        async def execute(self, *_a, **_k):
            raise RuntimeError(f"could not read {setup_id} of org {org_id} for {member_id}")

    caplog.set_level(logging.INFO, logger="app.services.agent_permissions")
    await svc._log_setup_not_found(_Db(), member_id=member_id, org_id=org_id, setup_id=setup_id)  # type: ignore[arg-type]
    records = [r for r in caplog.records if "setup_not_found" in r.getMessage()]
    assert len(records) == 1 and records[0].levelno == logging.WARNING
    assert records[0].exc_info is None
    text = records[0].getMessage()
    assert "RuntimeError" in text
    for v in (setup_id, org_id, member_id):
        assert str(v) not in text
