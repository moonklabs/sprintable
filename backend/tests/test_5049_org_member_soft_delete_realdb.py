"""story 5049 — the REAL soft delete of an organization member (`DELETE /api/v2/org-members/{id}`), against real Postgres. The mocked `tests/test_org_members.py::test_soft_delete_200` feeds the route a fixed list of statement results,
so it cannot say what the route really does when the road gained a statement (the unread read-marking). This is the one that does: the answer, the seat's row, the person's seats in the project channels, and the
read state of their bell lines.

  · 200 — the person is removed (`org_members.deleted_at` set);
  · they are out of the project's channel (no participant row) — as before 5032;
  · their UNREAD words-lines of the channel are read in that transaction, their MENTION stays unread (4846 AC9), and a bystander in the same channel keeps every unread line.
"""
from __future__ import annotations

import pytest

from tests.test_4752_account_delete_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _no_rate_limit,
)
from tests.test_5032_channel_residual_access_realdb import (  # noqa: F401
    _H,
    _add_person,
    _close,
    _owner_and_channel,
    _q,
    _say,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _unread(w, who) -> dict:
    return {k: n for k, n in await _q(w, "SELECT event_type, count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND event_type IN ('conversation.message_created', 'conversation:mention') GROUP BY 1", a=who)}


async def test_a_real_soft_delete_answers_200_takes_the_seat_out_of_the_channel_and_reads_their_channel_lines_but_not_their_mention():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w, "SoftDelete")
        uid_a, a, ta = await _add_person(w, org, ot, pid)
        uid_b, b, tb = await _add_person(w, org, ot, pid)  # a bystander in the same channel
        for tok, name in ((ta, "A"), (tb, "B")):
            r = await w.client.post(f"/api/v2/conversations/{chan}/messages", headers=_H(tok), json={"content": f"{name} speaks"})
            assert r.status_code == 201, r.text
        for i in range(3):
            await _say(w, ot, chan, f"line {i}")
        await _say(w, ot, chan, "mention A", mention=[a])

        before_a, before_b = await _unread(w, a), await _unread(w, b)
        assert before_a.get("conversation.message_created", 0) >= 3 and before_a.get("conversation:mention") == 1, before_a

        r = await w.client.delete(f"/api/v2/org-members/{a}", headers=_H(ot))
        assert r.status_code == 200, r.text

        assert (await _q(w, "SELECT deleted_at IS NOT NULL FROM org_members WHERE id = :a", a=a))[0][0] is True
        assert (await _q(w, "SELECT count(*) FROM conversation_participants WHERE conversation_id = :c AND member_id = :a", c=chan, a=a))[0][0] == 0
        after_a = await _unread(w, a)
        assert after_a.get("conversation.message_created", 0) == 0, after_a            # the channel's words-lines are read with the seat
        assert after_a.get("conversation:mention") == 1, after_a                        # the mention is not touched
        assert await _unread(w, b) == before_b, "a bystander's unread lines moved"
    finally:
        await _close(engine, w)
