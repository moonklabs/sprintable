"""story 5041 (C0b) — an agent ASKS, a person PRESSES, the server runs the same call as that person.

Real database + the real app (the auth / org dependencies are overridden the way the neighbouring SEC tests do): what is proven is the flow in `app/services/agent_action.py`:
  · an agent's delete / close / grant is not run and not refused — it is kept (202 pending_approval), once, with a card in the approver's DM;
  · the press runs the call under the PRESSER (the deletion audit's actor is the person; a person without the right does not burn the request);
  · one press only; nobody pressing in 24 hours is a refusal; an edited snapshot does not run; an API key / agent cannot press.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org · project · an agent (made by the admin) · an admin and a plain member (both in the project) · a story, task, goal, doc and an active sprint"""
    from app.models.doc import Doc
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Goal, Sprint, Story, Task
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.services.agent_anchor_sync import ensure_human_member

    org = Organization(id=uuid.uuid4(), name="5041 Org", slug=f"c0b-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="5041 Project")
    session.add(project)
    await session.commit()

    people = {}
    for who, role in (("admin", "admin"), ("member", "member")):
        uid = uuid.uuid4()
        session.add(User(id=uid, email=f"{who}-{uid.hex[:8]}@test.com", hashed_password="x"))
        await session.commit()
        om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uid, role=role)
        session.add(om)
        await session.commit()
        await ensure_human_member(session, om.id)
        session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, member_id=om.id, permission="granted"))
        await session.commit()
        people[who] = {"user_id": uid, "om_id": om.id}

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Asking Agent", is_active=True, owner_member_id=people["admin"]["om_id"])
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member"))

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Story to delete", status="backlog")
    sprint = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Sprint to close", status="active")
    goal = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Goal to delete")
    doc = Doc(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Doc to delete", slug=f"doc-{uuid.uuid4().hex[:8]}")
    # a story WITH a task cannot be deleted through the ORM today (the task's story FK is set to NULL first and the column is NOT NULL — a known gap outside this story): the task has its own parent
    task_parent = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Parent of the task", status="backlog")
    session.add_all([story, task_parent, sprint, goal, doc])
    await session.commit()
    task = Task(id=uuid.uuid4(), org_id=org.id, story_id=task_parent.id, title="Task to delete", status="todo")
    session.add(task)
    await session.commit()
    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "admin_user": people["admin"]["user_id"], "admin_om": people["admin"]["om_id"],
        "member_user": people["member"]["user_id"], "member_om": people["member"]["om_id"],
        "story_id": story.id, "task_id": task.id, "goal_id": goal.id, "doc_id": doc.id, "sprint_id": sprint.id,
    }


def _client_for(app):
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(app, Session, user_id, org_id, *, api_key: bool = False, human_key: bool = False, project_id=None):
    """whoever the next call is made by (an agent is `api_key=True` with its member id; a person is a plain session)"""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if project_id is not None:
            claims["app_metadata"]["project_id"] = str(project_id)
        if api_key:
            claims["app_metadata"]["api_key_id"] = "test-key"
        if human_key:
            # the personal key of a person (`hu_live_`): `get_current_user` builds a person-shaped context and carries ONLY this marker
            claims["app_metadata"]["human_api_key_id"] = "test-human-key"
            claims["app_metadata"]["actor_type"] = "human"
        return AuthContext(user_id=str(user_id), email="test@test", claims=claims)

    async def _org():
        return org_id

    from tests.conftest import override_db_and_read

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _exists(Session, model, row_id):
    from sqlalchemy import select

    async with Session() as s:
        return (await s.execute(select(model.id).where(model.id == row_id))).scalar_one_or_none() is not None


async def _requests(Session, org_id):
    from sqlalchemy import select

    from app.models.hitl import HitlRequest

    async with Session() as s:
        return list((await s.execute(select(HitlRequest).where(HitlRequest.org_id == org_id, HitlRequest.request_type == "agent_action").order_by(HitlRequest.created_at))).scalars())


@pytest.mark.anyio
async def test_agent_delete_story_is_kept_not_run_and_not_refused():
    from app.main import app
    from app.models.pm import Story
    from sqlalchemy import select
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            first = await c.delete(f"/api/v2/stories/{d['story_id']}")
            again = await c.delete(f"/api/v2/stories/{d['story_id']}")
        assert first.status_code == 202, first.text
        body = first.json()
        assert body["status"] == "pending_approval" and body["card_delivered"] is True and "request_id" in body
        assert again.status_code == 202 and again.json()["request_id"] == body["request_id"], "the same ask while one is open is the same request"
        assert await _exists(Session, Story, d["story_id"]), "an agent's ask never runs the delete"

        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].status == "pending" and str(reqs[0].agent_id) == str(d["agent_id"])
        assert reqs[0].expires_at - datetime.now(timezone.utc) > timedelta(hours=23)
        assert reqs[0].hitl_metadata["snapshot"]["method"] == "DELETE" and reqs[0].hitl_metadata["action_key"] == "story.delete"
        async with Session() as s:
            cards = (await s.execute(select(ConversationMessage).where(ConversationMessage.msg_metadata["agent_action"]["request_id"].astext == str(reqs[0].id)))).scalars().all()
        assert len(cards) == 1 and cards[0].mentioned_ids == [d["admin_om"]], "one card, to the person who made the agent"
        assert cards[0].msg_metadata["card"] == {"kind": "agent_action", "ref": str(reqs[0].id)}, "the web draws it from the request (kind + id), never from the message"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_press_runs_the_delete_as_the_person_and_tells_the_agent():
    from app.main import app
    from app.models.conversation import ConversationMessage
    from app.models.deletion_audit import DeletionAuditLog
    from app.models.pm import Story
    from sqlalchemy import select, text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert pressed.status_code == 200, pressed.text
        assert pressed.json()["state"] == "executed"
        assert not await _exists(Session, Story, d["story_id"]), "the story is gone"
        async with Session() as s:
            audit = (await s.execute(select(DeletionAuditLog).where(DeletionAuditLog.entity_id == d["story_id"]))).scalars().all()
            replies = (await s.execute(select(ConversationMessage).where(ConversationMessage.msg_metadata["agent_action_result"]["request_id"].astext == request_id))).scalars().all()
        assert len(audit) == 1 and audit[0].actor_id == d["admin_om"], "the record says the PERSON deleted it, not the agent"
        assert len(replies) == 1 and replies[0].mentioned_ids == [d["agent_id"]] and replies[0].msg_metadata["agent_action_result"]["result"] == "approved"
        # the result line is the SERVER's (the org's «시스템 발행»), never the pressing person's own bubble
        assert replies[0].sender_id != d["admin_om"]
        async with Session() as s:
            speaker_runtime = (await s.execute(text("SELECT runtime_type FROM members WHERE id = :i"), {"i": replies[0].sender_id})).scalar_one()
        assert speaker_runtime == "system-publisher"
        assert pressed.json()["target"] == {"kind": "story", "id": str(d["story_id"])}, "the card can say what it is about (and open it)"
        # the agent's result line ARRIVES: the system speaker is not a participant of the DM, yet the asking agent gets its event (the activation reaches it)
        async with Session() as s:
            arrived = (await s.execute(text("SELECT count(*) FROM events WHERE recipient_id = :a AND CAST(payload AS text) LIKE :m"), {"a": d["agent_id"], "m": f"%{replies[0].id}%"})).scalar_one()
        assert arrived >= 1, "the asking agent received the result line as an event"
        (req,) = await _requests(Session, d["org_id"])
        assert req.status == "approved" and req.responded_by == d["admin_om"] and req.hitl_metadata["execution"]["state"] == "executed"

        async with _client_for(app) as c:
            second = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert second.status_code == 409 and second.json()["error"]["code"] == "AGENT_ACTION_ALREADY_DECIDED", "one press only"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_without_the_right_does_not_burn_the_request():
    """a plain member may not delete a goal (org owner / admin only): the call says 403, the request goes back to pending, and the admin can still press it"""
    from app.main import app
    from app.models.pm import Goal

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.delete(f"/api/v2/goals/{d['goal_id']}")).json()["request_id"]

        await _act_as(app, Session, d["member_user"], d["org_id"])
        async with _client_for(app) as c:
            refused = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert refused.status_code == 403, refused.text
        assert refused.json()["error"]["code"] == "AGENT_ACTION_FORBIDDEN_FOR_APPROVER" and refused.json()["error"]["reason"]
        assert await _exists(Session, Goal, d["goal_id"])
        (req,) = await _requests(Session, d["org_id"])
        assert req.status == "pending" and req.responded_by is None and "execution" not in req.hitl_metadata

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed"
        assert not await _exists(Session, Goal, d["goal_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refusing_expiring_and_a_tampered_snapshot_run_nothing():
    from app.main import app
    from app.models.pm import Story, Task
    from sqlalchemy import text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            refused_id = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]
            expired_id = (await c.delete(f"/api/v2/tasks/{d['task_id']}")).json()["request_id"]
            tampered_id = (await c.delete(f"/api/v2/docs/{d['doc_id']}")).json()["request_id"]
        async with Session() as s:
            await s.execute(text("UPDATE agent_hitl_requests SET expires_at = now() - interval '1 minute' WHERE id = :i"), {"i": expired_id})
            # a row edited by hand: the stored path now names ANOTHER route than the action's
            await s.execute(text("UPDATE agent_hitl_requests SET metadata = jsonb_set(metadata, '{snapshot,path}', to_jsonb(CAST(:p AS text))) WHERE id = :i"), {"p": f"/api/v2/stories/{d['story_id']}", "i": tampered_id})
            await s.commit()

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            r = await c.post(f"/api/v2/agent-actions/{refused_id}/decision", json={"decision": "reject"})
            e = await c.post(f"/api/v2/agent-actions/{expired_id}/decision", json={"decision": "approve"})
            t = await c.post(f"/api/v2/agent-actions/{tampered_id}/decision", json={"decision": "approve"})
            view = await c.get(f"/api/v2/agent-actions/{expired_id}")
        assert r.status_code == 200 and r.json()["state"] == "rejected"
        assert e.status_code == 409 and e.json()["error"]["code"] == "AGENT_ACTION_EXPIRED"
        assert view.json()["state"] == "expired", "nobody pressing in time is a REFUSAL"
        assert t.status_code == 409 and t.json()["error"]["code"] == "AGENT_ACTION_SNAPSHOT_INVALID"
        assert await _exists(Session, Story, d["story_id"]) and await _exists(Session, Task, d["task_id"])
        from app.models.doc import Doc

        assert await _exists(Session, Doc, d["doc_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_only_a_persons_session_can_press():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]
            by_agent = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        await _act_as(app, Session, d["admin_user"], d["org_id"], api_key=True)  # a person's own API key is no session either
        async with _client_for(app) as c:
            by_key = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
            read_by_key = await c.get(f"/api/v2/agent-actions/{request_id}")
        await _act_as(app, Session, d["admin_user"], d["org_id"], human_key=True)  # a person's PERSONAL key: the admin who made the agent, but not a session
        async with _client_for(app) as c:
            by_personal_key = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
            reject_by_personal_key = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "reject"})
            read_by_personal_key = await c.get(f"/api/v2/agent-actions/{request_id}")
        assert [r.status_code for r in (by_personal_key, reject_by_personal_key, read_by_personal_key)] == [403, 403, 403]
        assert by_personal_key.json()["error"]["code"] == "AGENT_ACTION_PERSON_SESSION_REQUIRED"
        assert by_agent.status_code == 403 and by_agent.json()["error"]["code"] == "AGENT_ACTION_PERSON_SESSION_REQUIRED"
        assert by_key.status_code == 403 and by_key.json()["error"]["code"] == "AGENT_ACTION_PERSON_SESSION_REQUIRED"
        assert read_by_key.status_code == 403
        (req,) = await _requests(Session, d["org_id"])
        assert req.status == "pending"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_without_the_project_is_refused_and_nothing_is_kept():
    from app.main import app
    from app.models.member import Member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            stranger = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="No Access Agent", is_active=True)
            s.add(stranger)
            await s.commit()
        await _act_as(app, Session, stranger.id, d["org_id"], api_key=True)
        async with _client_for(app) as c:
            resp = await c.delete(f"/api/v2/stories/{d['story_id']}")
        # an agent that is in no project of the org is not even resolvable (400 «team member not found», as before this story); one that is in ANOTHER project gets 403 from the access check
        assert resp.status_code in (400, 403, 404), resp.text
        assert await _requests(Session, d["org_id"]) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_close_sprint_and_give_reward_are_asks_and_run_as_the_admin():
    from app.main import app
    from app.models.pm import Sprint
    from sqlalchemy import select
    from app.models.reward import RewardLedger

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            close_id = (await c.post(f"/api/v2/sprints/{d['sprint_id']}/close")).json()["request_id"]
            reward = await c.post("/api/v2/rewards", json={"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 5, "reason": "well done", "granted_by": str(d["agent_id"])})  # the server ignores granted_by (derives it from whoever presses)
        assert reward.status_code == 202 and reward.json()["status"] == "pending_approval"
        async with Session() as s:
            assert (await s.execute(select(Sprint.status).where(Sprint.id == d["sprint_id"]))).scalar_one() == "active"
            assert (await s.execute(select(RewardLedger.id).where(RewardLedger.project_id == d["project_id"]))).first() is None

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            closed = await c.post(f"/api/v2/agent-actions/{close_id}/decision", json={"decision": "approve"})
            granted = await c.post(f"/api/v2/agent-actions/{reward.json()['request_id']}/decision", json={"decision": "approve"})
        assert closed.status_code == 200 and closed.json()["state"] == "executed", closed.text
        assert granted.status_code == 200 and granted.json()["state"] == "executed", granted.text
        async with Session() as s:
            assert (await s.execute(select(Sprint.status).where(Sprint.id == d["sprint_id"]))).scalar_one() == "closed"
            ledger = (await s.execute(select(RewardLedger).where(RewardLedger.project_id == d["project_id"]))).scalars().all()
        assert len(ledger) == 1 and ledger[0].granted_by == d["admin_om"], "the grant is the person's"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_cannot_pile_up_cards_past_the_hourly_ceiling():
    from app.main import app
    from app.models.hitl import HitlRequest
    from app.services import agent_action

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            for _ in range(agent_action.MAX_OPEN_PER_AGENT_PER_HOUR):
                s.add(HitlRequest(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], agent_id=d["agent_id"], request_type="agent_action", title="x", prompt="x",
                                  requested_for=d["admin_om"], status="pending", expires_at=datetime.now(timezone.utc) + timedelta(hours=1), hitl_metadata={"action_key": "story.delete", "snapshot": {"sha256": uuid.uuid4().hex}}))
            await s.commit()
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            resp = await c.delete(f"/api/v2/stories/{d['story_id']}")
        assert resp.status_code == 429 and resp.json()["error"]["code"] == "AGENT_ACTION_RATE_LIMITED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_two_asks_at_the_same_moment_are_one_request_and_one_card():
    """codex security pass: «look for the same open ask, count the hour, insert» is check-then-insert — without the per-agent lock two retries at once make two requests (and a person pressing both gives the reward twice)"""
    import asyncio

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        body = {"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 5, "reason": "once", "granted_by": str(d["agent_id"])}
        async with _client_for(app) as c:
            answers = await asyncio.gather(*[c.post("/api/v2/rewards", json=body) for _ in range(6)])
        assert {a.status_code for a in answers} == {202}, [a.text for a in answers]
        assert len({a.json()["request_id"] for a in answers}) == 1, "six identical asks at once are ONE request"
        assert len(await _requests(Session, d["org_id"])) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_replay_carries_only_the_authorization_of_the_pressing_request():
    """codex security pass: a person's press that also carries a Cookie or an X-Agent-Api-Key must not let the replay run as somebody else than the identity that was checked"""
    import httpx
    from starlette.requests import Request

    from app.services import agent_action

    seen: dict = {}

    class _Spy(httpx.AsyncClient):
        async def request(self, method, url, **kw):  # noqa: ANN001
            seen.update(kw.get("headers") or {})
            return httpx.Response(204)

    scope = {"type": "http", "method": "POST", "path": "/x", "headers": [
        (b"authorization", b"Bearer person"), (b"cookie", b"session=other"), (b"x-agent-api-key", b"agent-key"), (b"x-org-id", b"someone-elses")], "app": object()}
    snap = {"method": "DELETE", "path": "/api/v2/stories/1", "query": "", "org_id": "o", "project_id": "p", "body_b64": ""}
    orig = agent_action.httpx.AsyncClient
    agent_action.httpx.AsyncClient = lambda **kw: _Spy()  # type: ignore[assignment]
    try:
        await agent_action.execute_as_presser(Request(scope), snap, request_id=uuid.uuid4())
    finally:
        agent_action.httpx.AsyncClient = orig  # type: ignore[assignment]
    assert seen["authorization"] == "Bearer person"
    assert "cookie" not in seen and "x-agent-api-key" not in seen
    assert seen["x-org-id"] == "o", "the org / project are the SNAPSHOT's, not whatever the pressing request said"


async def _room_for_run(Session, d, *, who_asked: str = "admin", agent_in_room: bool = True, run_agent=None, run_status: str = "running", outsider: bool = False):
    """a room with the person who asked and the agent, and a run of the agent started by that person's message"""
    from app.models.agent_run import AgentRun
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    async with Session() as s:
        conv = Conversation(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], type="group", title="room")
        s.add(conv)
        await s.commit()
        s.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv.id, member_id=d[f"{who_asked}_om"]))
        if agent_in_room:
            s.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv.id, member_id=d["agent_id"]))
        if outsider:
            # a person in the room who may NOT see this project (a plain org member with no grant): the card's line would be read by them
            from app.models.project import OrgMember
            from app.models.user import User
            from app.services.agent_anchor_sync import ensure_human_member

            uid = uuid.uuid4()
            s.add(User(id=uid, email=f"outsider-{uid.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=d["org_id"], user_id=uid, role="member")
            s.add(om)
            await s.commit()
            await ensure_human_member(s, om.id)
            s.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv.id, member_id=om.id))
        await s.commit()
        msg = ConversationMessage(id=uuid.uuid4(), conversation_id=conv.id, sender_id=d[f"{who_asked}_om"], content="스프린트 닫아 줘", mentioned_ids=[d["agent_id"]])
        s.add(msg)
        await s.commit()
        run = AgentRun(id=uuid.uuid4(), org_id=d["org_id"], agent_id=run_agent or d["agent_id"], project_id=d["project_id"], status=run_status, conversation_id=conv.id, triggering_message_id=msg.id, trigger="chat")
        s.add(run)
        await s.commit()
        return conv.id, run.id


@pytest.mark.anyio
async def test_the_card_goes_to_the_room_the_run_came_from_and_names_the_person_who_asked():
    from app.main import app
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        conv_id, run_id = await _room_for_run(Session, d, who_asked="member")
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            resp = await c.post(f"/api/v2/sprints/{d['sprint_id']}/close", headers={"X-Sprintable-Run-Id": str(run_id)})
        assert resp.status_code == 202 and resp.json()["card_delivered"] is True, resp.text
        (req,) = await _requests(Session, d["org_id"])
        async with Session() as s:
            cards = (await s.execute(select(ConversationMessage).where(ConversationMessage.msg_metadata["agent_action"]["request_id"].astext == str(req.id)))).scalars().all()
        assert [c.conversation_id for c in cards] == [conv_id], "ONE card, in the room the person asked in (not a DM)"
        assert cards[0].mentioned_ids == [d["member_om"]], "it names the person who asked — a plain member; whoever may do it on screen may still press"
        assert req.requested_for == d["member_om"] and req.hitl_metadata["cards"][0]["conversation_id"] == str(conv_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_run_that_does_not_lead_to_a_room_falls_back_to_the_dm_and_nothing_is_guessed():
    """no header · another agent's run · the agent is not in that room: the card goes to the DM of the person who made the agent, as before"""
    from app.main import app
    from app.models.conversation import ConversationMessage
    from app.models.member import Member
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Other Agent", is_active=True)
            s.add(other)
            await s.commit()
        _c1, someone_elses_run = await _room_for_run(Session, d, run_agent=other.id)
        _c2, not_in_room = await _room_for_run(Session, d, agent_in_room=False)
        _c3, finished_run = await _room_for_run(Session, d, run_status="completed")      # a stale header: that run is over
        _c4, with_outsider = await _room_for_run(Session, d, outsider=True)               # someone in the room may not see the project
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            a = await c.delete(f"/api/v2/stories/{d['story_id']}")                                                                    # no header
            b = await c.delete(f"/api/v2/tasks/{d['task_id']}", headers={"X-Sprintable-Run-Id": str(someone_elses_run)})               # a run of another agent
            e = await c.delete(f"/api/v2/docs/{d['doc_id']}", headers={"X-Sprintable-Run-Id": str(not_in_room)})                      # the agent is not in that room
            g = await c.delete(f"/api/v2/goals/{d['goal_id']}", headers={"X-Sprintable-Run-Id": "not-a-uuid"})
            h = await c.post(f"/api/v2/sprints/{d['sprint_id']}/close", headers={"X-Sprintable-Run-Id": str(finished_run)})
            i = await c.post("/api/v2/rewards", headers={"X-Sprintable-Run-Id": str(with_outsider)}, json={"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 1, "reason": "x", "granted_by": str(d["agent_id"])})
        assert [x.status_code for x in (a, b, e, g, h, i)] == [202] * 6
        async with Session() as s:
            ids = [str(r.id) for r in await _requests(Session, d["org_id"])]
            rows = (await s.execute(select(ConversationMessage).where(ConversationMessage.msg_metadata["agent_action"]["request_id"].astext.in_(ids)))).scalars().all()
        assert len(rows) == 6 and {r.conversation_id for r in rows}.isdisjoint({_c1, _c2, _c3, _c4}), "every card is in the person's DM, none in those rooms"
        assert all(r.mentioned_ids == [d["admin_om"]] for r in rows)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _sql(Session, stmt, **params):
    from sqlalchemy import text

    async with Session() as s:
        res = await s.execute(text(stmt), params)
        await s.commit()
        return res


async def _make_stuck(Session, request_id, minutes=10):
    """a press that claimed the request and never finished (the process died): approved + running, pressed `minutes` ago"""
    await _sql(Session, "UPDATE agent_hitl_requests SET status='approved', responded_at = now() - make_interval(mins => :m), metadata = jsonb_set(metadata, '{execution}', '{\"state\":\"running\"}'::jsonb, true) WHERE id = :i", m=minutes, i=request_id)


@pytest.mark.anyio
async def test_the_generic_hitl_routes_neither_decide_nor_list_an_agent_action():
    """Kadir's audit M1 + M2: the generic PATCH would close the request without running anything (the card then says «running» for good); the generic list would show another agent's stored call"""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.post("/api/v2/rewards", json={"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 7, "reason": "secret recipient", "granted_by": str(d["agent_id"])})).json()["request_id"]
        await _act_as(app, Session, d["admin_user"], d["org_id"], project_id=d["project_id"])
        async with _client_for(app) as c:
            patched = await c.patch(f"/api/v2/hitl/requests/{request_id}", json={"status": "approved"})
            listed = await c.get("/api/v2/hitl/requests")
        assert patched.status_code == 409, patched.text
        (req,) = await _requests(Session, d["org_id"])
        assert req.status == "pending" and "execution" not in req.hitl_metadata, "the status was not flipped"
        assert request_id not in listed.text and "secret recipient" not in listed.text and "body_b64" not in listed.text, "the generic list never carries the stored call"
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True, project_id=d["project_id"])
        async with _client_for(app) as c:
            listed_by_agent = await c.get("/api/v2/hitl/requests")
        assert "body_b64" not in listed_by_agent.text and request_id not in listed_by_agent.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_reads_only_its_own_ask_and_never_the_stored_call():
    from app.main import app
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Other Agent", is_active=True)
            s.add(other)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=d["project_id"], member_id=other.id, permission="granted", role="member"))
            await s.commit()
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]
            own = await c.get(f"/api/v2/agent-actions/{request_id}")
            await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        await _act_as(app, Session, other.id, d["org_id"], api_key=True)
        async with _client_for(app) as c:
            theirs = await c.get(f"/api/v2/agent-actions/{request_id}")
        assert own.status_code == 200 and own.json()["state"] == "pending" and "snapshot" not in own.text and "body_b64" not in own.text
        assert theirs.status_code == 404, "another agent does not even learn it exists"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_press_that_never_finished_is_given_back_pressable_and_the_reward_is_paid_once():
    """Kadir's audit M3 + the PO's rule: nothing rests on «check before you press» — the replay carries the request id and the ledger keeps it, so the second press returns the first grant"""
    from app.main import app
    from app.models.reward import RewardLedger
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        body = {"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 5, "reason": "once", "granted_by": str(d["agent_id"])}
        async with _client_for(app) as c:
            request_id = (await c.post("/api/v2/rewards", json=body)).json()["request_id"]
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            first = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert first.json()["state"] == "executed"
        # the process died after the grant and before the result was written: the request is «approved · running», pressed 10 minutes ago
        await _make_stuck(Session, request_id)
        async with _client_for(app) as c:
            view = await c.get(f"/api/v2/agent-actions/{request_id}")
            again = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
            third = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert view.json()["state"] == "retry", "past the time limit it is given back, not «running» for good"
        assert again.status_code == 200 and again.json()["state"] == "executed", again.text
        assert third.status_code == 409, "and after it ended, once more is refused"
        async with Session() as s:
            rows = (await s.execute(select(RewardLedger).where(RewardLedger.project_id == d["project_id"]))).scalars().all()
        assert len(rows) == 1 and str(rows[0].agent_action_request_id) == request_id, "paid ONCE; the ledger names the request"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_second_grant_for_the_same_request_id_is_refused_by_the_database():
    """the unique index is what makes «once» true even when two presses race past the look-up"""
    from app.models.reward import RewardLedger
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        rid = uuid.uuid4()
        async with Session() as s:
            for _ in range(2):
                s.add(RewardLedger(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], member_id=d["admin_om"], amount=1, reason="x", agent_action_request_id=rid))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_delete_that_finds_the_thing_gone_after_an_unfinished_press_is_done_not_failed():
    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]
        await _sql(Session, "DELETE FROM stories WHERE id = :i", i=d["story_id"])        # the first press did delete it, then the process died
        await _make_stuck(Session, request_id)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            again = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"})
        assert again.status_code == 200 and again.json()["state"] == "executed", again.text
        assert not await _exists(Session, Story, d["story_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_cron_sweep_declines_the_expired_and_gives_back_the_stuck_and_tells_the_agent():
    from app.models.conversation import ConversationMessage
    from app.services import agent_action
    from sqlalchemy import select

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            old = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]
            stuck = (await c.delete(f"/api/v2/tasks/{d['task_id']}")).json()["request_id"]
        await _sql(Session, "UPDATE agent_hitl_requests SET expires_at = now() - interval '1 minute' WHERE id = :i", i=old)
        await _make_stuck(Session, stuck)
        async with Session() as s:
            counts = await agent_action.sweep(s)
            await s.commit()
        assert counts == {"expired": 1, "unfinished": 1}
        reqs = {str(r.id): r for r in await _requests(Session, d["org_id"])}
        assert reqs[old].status == "rejected" and reqs[old].response_text == "expired"
        assert reqs[stuck].status == "pending" and reqs[stuck].hitl_metadata["execution"]["reason"] == "unfinished"
        async with Session() as s:
            told = (await s.execute(select(ConversationMessage).where(ConversationMessage.msg_metadata["agent_action_result"]["request_id"].astext.in_([old, stuck])))).scalars().all()
        assert sorted(m.msg_metadata["agent_action_result"]["result"] for m in told) == ["expired", "unfinished"] and all(m.mentioned_ids == [d["agent_id"]] for m in told)
        async with Session() as s:
            again = await agent_action.sweep(s)
        assert again == {"expired": 0, "unfinished": 0}, "a second pass finds nothing (and tells nobody twice)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_card_names_what_it_would_do_and_to_whom():
    """Kadir's audit M4: a grant says who gets it (and the agent's free text is quoted); a goal says how many stories go with it; a pin says which pin"""
    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            for i in range(3):
                s.add(Story(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], title=f"in goal {i}", status="backlog", epic_id=d["goal_id"]))
            await s.commit()
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            await c.post("/api/v2/rewards", json={"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 5, "reason": "well done", "granted_by": str(d["agent_id"])})
            await c.delete(f"/api/v2/goals/{d['goal_id']}")
        by_key = {r.hitl_metadata["action_key"]: r for r in await _requests(Session, d["org_id"])}
        reward = by_key["reward.give"]
        assert "“well done”" in reward.title and "5" in reward.title, reward.title
        assert reward.hitl_metadata["target_label"].split(" · ")[0] not in ("", None), "it starts with the recipient's name"
        assert "3" in by_key["goal.delete"].title, by_key["goal.delete"].title
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_action_without_arguments_stores_no_query_and_no_body():
    """audit L3: nothing rides along that the card does not show — and a stored row that has one does not run"""
    from app.main import app
    from app.services.agent_action import snapshot_hash, snapshot_is_sound

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.request("DELETE", f"/api/v2/stories/{d['story_id']}?force=1", content=b'{"extra":"thing"}', headers={"content-type": "application/json"})
        assert r.status_code == 202
        (req,) = await _requests(Session, d["org_id"])
        snap = req.hitl_metadata["snapshot"]
        assert snap["query"] == "" and snap["body_b64"] == ""
        tampered = {**snap, "query": "force=1"}
        tampered["sha256"] = snapshot_hash(tampered)  # even with a hash that matches, an action that takes no arguments does not run with one
        assert snapshot_is_sound("story.delete", snap) and not snapshot_is_sound("story.delete", tampered)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_request_view_names_what_the_ask_is_about_from_the_path_only():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            ids = {
                "story": (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"],
                "task": (await c.delete(f"/api/v2/tasks/{d['task_id']}")).json()["request_id"],
                "epic": (await c.delete(f"/api/v2/goals/{d['goal_id']}")).json()["request_id"],
                "doc": (await c.delete(f"/api/v2/docs/{d['doc_id']}")).json()["request_id"],
                "sprint": (await c.post(f"/api/v2/sprints/{d['sprint_id']}/close")).json()["request_id"],
            }
            reward = (await c.post("/api/v2/rewards", json={"project_id": str(d["project_id"]), "member_id": str(d["admin_om"]), "amount": 1, "reason": "x", "granted_by": str(d["agent_id"])})).json()["request_id"]
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        want = {"story": d["story_id"], "task": d["task_id"], "epic": d["goal_id"], "doc": d["doc_id"], "sprint": d["sprint_id"]}
        async with _client_for(app) as c:
            for kind, rid in ids.items():
                view = (await c.get(f"/api/v2/agent-actions/{rid}")).json()
                assert view["target"] == {"kind": kind, "id": str(want[kind])}, (kind, view["target"])
            assert (await c.get(f"/api/v2/agent-actions/{reward}")).json()["target"] is None, "a grant has no page to open"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_stored_path_of_another_kind_than_its_action_is_no_target():
    """codex pass: the target is read from the stored path only, and only when it names the kind its action is about"""
    from app.routers.agent_actions import _target_of

    story = "/api/v2/stories/0d6e953f-6d43-42c1-a87c-b023544497db"
    assert _target_of({"path": story}, "story.delete") == {"kind": "story", "id": "0d6e953f-6d43-42c1-a87c-b023544497db"}
    assert _target_of({"path": story}, "doc.delete") is None, "a story path under a doc action is nobody's target"
    assert _target_of({"path": story}, None) is None
    assert _target_of({"path": "/api/v2/rewards"}, "reward.give") is None
    assert _target_of({"path": 7}, "story.delete") is None


def test_text_from_elsewhere_becomes_one_plain_line():
    """codex pass: an agent's reward reason must not fake the card's own structure (line breaks, direction marks, control characters)"""
    from app.services.agent_action import plain_text

    assert plain_text("a\nb\r\n\tc  d", 80) == "a b c d"
    assert plain_text("ok\u202eevil\u200b", 80) == "okevil", "direction / zero-width format characters go"
    assert plain_text("x" * 500, 120) == "x" * 120
    assert plain_text(None, 10) == ""


@pytest.mark.anyio
async def test_a_replay_that_hangs_is_cancelled_so_a_stale_running_request_has_no_live_replay():
    import httpx
    from starlette.requests import Request

    from app.services import agent_action

    class _Hang(httpx.AsyncClient):
        async def request(self, method, url, **kw):  # noqa: ANN001
            await asyncio.sleep(30)

    scope = {"type": "http", "method": "POST", "path": "/x", "headers": [(b"authorization", b"Bearer p")], "app": object()}
    snap = {"method": "DELETE", "path": "/api/v2/stories/1", "query": "", "org_id": "o", "project_id": "p", "body_b64": ""}
    orig, orig_t = agent_action.httpx.AsyncClient, agent_action.EXECUTE_TIMEOUT
    agent_action.httpx.AsyncClient = lambda **kw: _Hang()  # type: ignore[assignment]
    agent_action.EXECUTE_TIMEOUT = timedelta(milliseconds=200)
    try:
        with pytest.raises(TimeoutError):
            await agent_action.execute_as_presser(Request(scope), snap, request_id=uuid.uuid4())
        assert agent_action.replaying_request_id() is None, "the idempotency context is reset even when the replay is cancelled"
    finally:
        agent_action.httpx.AsyncClient = orig  # type: ignore[assignment]
        agent_action.EXECUTE_TIMEOUT = orig_t
    assert agent_action.EXECUTE_TIMEOUT > timedelta(seconds=60) and agent_action.RUNNING_STALE_AFTER > agent_action.EXECUTE_TIMEOUT


def test_every_registered_action_is_asked_for_by_exactly_one_route():
    """a registered action no route asks for (or a route naming one that is not registered) is a rule nobody enforces — and no route calls `request_approval` around the setting (it would skip `auto` / `block`)"""
    import ast
    import pathlib

    from app.services.agent_action import SPECS

    named: dict[str, int] = {}
    for path in pathlib.Path("app/routers").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            # a route asks the USER's setting first (`gate_agent_call`: ask → the approval card · block · auto) — it is the one call a road makes; `request_approval` is what it does for `ask`
            if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "gate_agent_call":
                for kw in node.keywords:
                    if kw.arg == "action_key" and isinstance(kw.value, ast.Constant):
                        named[kw.value.value] = named.get(kw.value.value, 0) + 1
    assert named == {key: 1 for key in SPECS}, named
    bare = [str(path) for path in pathlib.Path("app/routers").glob("*.py") if "agent_action.request_approval(" in path.read_text()]
    assert bare == [], f"a road must go through gate_agent_call, not ask for approval around the user's setting: {bare}"


# ── Kadir's audit of 6012 (lows) ────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_target_is_read_from_the_whole_path_and_a_real_uuid_only():
    """L1: `$` also matched before a trailing newline · L2: `[0-9a-f-]{36}` let `-` ×36 through — the target is the action patterns' own UUID shape, the whole path"""
    from app.routers.agent_actions import _target_of

    ok = "0d6e953f-6d43-42c1-a87c-b023544497db"
    assert _target_of({"path": f"/api/v2/stories/{ok}"}, "story.delete") == {"kind": "story", "id": ok}
    assert _target_of({"path": f"/api/v2/stories/{ok}\n"}, "story.delete") is None, "a newline after the id is not the path"
    assert _target_of({"path": "/api/v2/stories/" + "-" * 36}, "story.delete") is None, "36 dashes are not a UUID"
    assert _target_of({"path": f"/api/v2/stories/{ok}/../x"}, "story.delete") is None
    assert _target_of({"path": f"/api/v2/sprints/{ok}/close"}, "sprint.close") == {"kind": "sprint", "id": ok}
    assert _target_of({"path": f"/api/v2/sprints/{ok}/close\n"}, "sprint.close") is None


def test_the_reason_the_agent_is_told_is_a_code_never_the_responses_sentence():
    """L3: the line is spoken by the server to the asking agent — a sentence written for the person who pressed can name what the agent may not read"""
    import httpx

    from app.services.agent_action import _reason_of

    def resp(status, body):
        return httpx.Response(status, json=body)

    assert _reason_of(resp(403, {"detail": {"code": "FORBIDDEN", "message": "Only Kim in Sales may do this"}})) == "FORBIDDEN"
    assert _reason_of(resp(403, {"detail": {"message": "Only Kim in Sales may do this"}})) == "HTTP 403"
    assert _reason_of(resp(404, {"detail": "Story 'Salary review' not found"})) == "HTTP 404", "a sentence is not a code"
    assert _reason_of(resp(409, {"detail": "SPRINT_ALREADY_CLOSED"})) == "SPRINT_ALREADY_CLOSED"
    assert _reason_of(httpx.Response(500, text="boom")) == "HTTP 500"
    assert _reason_of(resp(403, {"detail": {"code": "api_key:abc123"}})) == "HTTP 403", "a key:value shape is not a code word (codex on 6014)"
    assert _reason_of(resp(403, {"detail": {"code": "/etc/passwd"}})) == "HTTP 403"


@pytest.mark.anyio
async def test_the_card_and_the_result_line_are_in_the_readers_language_not_the_agents():
    """dev QA lap 11-27: on an English screen the card said «되돌릴 수 없어요…» and the result line «승인되어 실행했어요» — they were written in the language of the agent's request. The card's sentence is
    made when it is READ (the screen's locale arrives as Accept-Language), and the result line is spoken in the language of the person who pressed."""
    from app.main import app
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            request_id = (await c.delete(f"/api/v2/stories/{d['story_id']}")).json()["request_id"]  # the agent asks with no language: the default (ko) is what gets stored
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            en = (await c.get(f"/api/v2/agent-actions/{request_id}", headers={"Accept-Language": "en-US,en;q=0.9"})).json()
            ko = (await c.get(f"/api/v2/agent-actions/{request_id}", headers={"Accept-Language": "ko"})).json()
            pressed = await c.post(f"/api/v2/agent-actions/{request_id}/decision", json={"decision": "approve"}, headers={"Accept-Language": "en"})
        assert pressed.status_code == 200, pressed.text
        assert en["prompt"].startswith("This cannot be undone") and en["title"].startswith("Delete story"), (en["title"], en["prompt"])
        assert ko["prompt"].startswith("되돌릴 수 없어요") and ko["title"].startswith("스토리"), (ko["title"], ko["prompt"])
        assert pressed.json()["prompt"].startswith("This cannot be undone"), "the press answer is in the presser's language too"
        async with Session() as s:
            result = (await s.execute(select(ConversationMessage.content).where(ConversationMessage.content.like("Approved and done%")))).scalars().all()
        assert result, "the result line was spoken in English (the presser's language)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
