"""story 5041 (PO 11-28, B3 follow-up · the «C» step) — the approval card of an agent's project / organisation deletion says what REALLY happens, and the test measures it after the press.

Measured (see `test_5041_current_project_after_delete_realdb`): the delete road removes the `projects` row itself; the rows that hang on the project without a delete cascade (stories, their tasks) stay behind as invisible orphans;
conversations stay (their project becomes NULL — the room outlives its project); an organisation delete CLOSES the organisation (access · keys · public links · channel tokens end; the organisation row goes) and leaves the data.
So the card must not say «gone with it»: it says «out of sight (the data stays)», «the conversations stay», «the organization is closed». Real database; the card text is compared with the state AFTER the press.
"""
from __future__ import annotations

import re
import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _requests,
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


async def _as_agent(app, Session, d, method, path, body=None):
    await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
    async with _client_for(app) as c:
        return await c.request(method, path, json=body) if body is not None else await c.request(method, path)


async def _count(Session, sql, **params):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text(sql), params)).scalar_one()


def _n(title, *patterns):
    """the number a card sentence gives for the first matching phrase (either language)"""
    for p in patterns:
        m = re.search(p, title)
        if m:
            return int(m.group(1))
    raise AssertionError(f"no number for {patterns} in: {title}")


@pytest.mark.anyio
async def test_the_project_card_says_out_of_sight_and_the_data_stays_and_the_conversations_stay_and_the_state_after_the_press_agrees():
    from app.main import app
    from app.models.conversation import Conversation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            s.add_all([Conversation(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], type="group", title=f"Room {i}") for i in range(2)])
            await s.commit()
        r = await _as_agent(app, Session, d, "DELETE", f"/api/v2/projects/{d['project_id']}")
        assert r.status_code == 202, r.text
        card = (await _requests(Session, d["org_id"]))[0]
        title = card.title
        stories = _n(title, r"스토리 (\d+)개", r"(\d+) stories")
        tasks = _n(title, r"할 일 (\d+)개", r"(\d+) tasks")
        rooms = _n(title, r"대화 (\d+)개", r"(\d+) conversations")
        assert (stories, tasks, rooms) == (2, 1, 2), title
        # what the card says about them: out of sight, the data stays; the rooms stay — and NOT «gone with it»
        assert re.search(r"목록에서 사라져요|out of sight", title) and re.search(r"자료는 지워지지 않아요|the data stays", title), title
        assert re.search(r"대화 \d+개는 남아요|conversations stay", title), title
        assert not re.search(r"함께 사라|gone with it|go with it", title), title

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{card.id}/decision", json={"decision": "approve"})
            assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
            # out of sight: the person can no longer read them
            seen = await c.get(f"/api/v2/stories/{d['story_id']}")
            assert seen.status_code in (403, 404), seen.text
        # the data stays — exactly the number the card gave
        assert await _count(Session, "SELECT count(*) FROM stories WHERE project_id = :p", p=d["project_id"]) == stories
        assert await _count(Session, "SELECT count(*) FROM tasks t JOIN stories s ON s.id = t.story_id WHERE s.project_id = :p", p=d["project_id"]) == tasks
        # the rooms stay, with no project — exactly the number the card gave
        assert await _count(Session, "SELECT count(*) FROM conversations WHERE org_id = :o AND project_id IS NULL AND title LIKE 'Room %'", o=d["org_id"]) == rooms
        assert await _count(Session, "SELECT count(*) FROM projects WHERE id = :p", p=d["project_id"]) == 0, "the project itself is gone"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_organisation_card_says_it_is_closed_and_the_data_stays_and_the_state_after_the_press_agrees():
    from app.main import app
    from app.models.project import OrgMember
    from app.models.user import User
    from app.services.agent_anchor_sync import ensure_human_member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            uid = uuid.uuid4()
            s.add(User(id=uid, email=f"owner-{uid.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=d["org_id"], user_id=uid, role="owner")
            s.add(om)
            await s.commit()
            await ensure_human_member(s, om.id)
        r = await _as_agent(app, Session, d, "DELETE", f"/api/v2/organizations/{d['org_id']}", {"confirmation": "5041 Org"})
        assert r.status_code == 202, r.text
        card = (await _requests(Session, d["org_id"]))[0]
        title = card.title
        projects = _n(title, r"프로젝트 (\d+)개", r"of (\d+) projects")
        stories = _n(title, r"스토리 (\d+)개", r"(\d+) stories")
        assert (projects, stories) == (1, 2), title
        assert re.search(r"조직을 닫음|organization is closed", title) and re.search(r"무효가 돼요|stop working", title) and re.search(r"자료는 지워지지 않아요|stays", title), title
        assert not re.search(r"함께 사라|gone with it|go with it", title), title

        await _act_as(app, Session, uid, d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{card.id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
        # closed: the organisation is gone and every person's seat is ended
        assert await _count(Session, "SELECT count(*) FROM organizations WHERE id = :o", o=d["org_id"]) == 0
        assert await _count(Session, "SELECT count(*) FROM org_members WHERE org_id = :o AND deleted_at IS NULL", o=d["org_id"]) == 0, "access is closed"
        # the data stays — exactly the number the card gave
        assert await _count(Session, "SELECT count(*) FROM stories WHERE org_id = :o", o=d["org_id"]) == stories
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
