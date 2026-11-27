"""story 5041 (C0b) — an agent ASKS, a person PRESSES, the server runs the same call as that person.

Real database + the real app (the auth / org dependencies are overridden the way the neighbouring SEC tests do): what is proven is the flow in `app/services/agent_action.py`:
  · an agent's delete / close / grant is not run and not refused — it is kept (202 pending_approval), once, with a card in the approver's DM;
  · the press runs the call under the PRESSER (the deletion audit's actor is the person; a person without the right does not burn the request);
  · one press only; nobody pressing in 24 hours is a refusal; an edited snapshot does not run; an API key / agent cannot press.
"""
from __future__ import annotations

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


async def _act_as(app, Session, user_id, org_id, *, api_key: bool = False):
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
        if api_key:
            claims["app_metadata"]["api_key_id"] = "test-key"
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
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_press_runs_the_delete_as_the_person_and_tells_the_agent():
    from app.main import app
    from app.models.conversation import ConversationMessage
    from app.models.deletion_audit import DeletionAuditLog
    from app.models.pm import Story
    from sqlalchemy import select

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
        assert resp.status_code in (400, 403), resp.text
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


def test_every_registered_action_is_asked_for_by_exactly_one_route():
    """a registered action no route asks for (or a route naming one that is not registered) is a rule nobody enforces"""
    import ast
    import pathlib

    from app.services.agent_action import SPECS

    named: dict[str, int] = {}
    for path in pathlib.Path("app/routers").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "request_approval":
                for kw in node.keywords:
                    if kw.arg == "action_key" and isinstance(kw.value, ast.Constant):
                        named[kw.value.value] = named.get(kw.value.value, 0) + 1
    assert named == {key: 1 for key in SPECS}, named
