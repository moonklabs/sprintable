"""story #4244 — 알림 목록이 대상(reference)의 프로젝트와 문서 slug를 싣는다(목록 조회 때 배치 해소 · 저장 안 함).

- 게이트 알림: 게이트 대상 work item의 프로젝트(#4241 조직 전체 결재함과 같은 해소기) · 자기 참조 앵커는 neutral_facts.project_id.
- story · task · doc · visual_artifact · epic · sprint · conversation: 각자의 프로젝트. 문서는 slug도(삭제된 문서는 slug 없음 → FE는 목록 폴백).
- 조직 단위(team_member) · 다른 조직 대상 · 없는 대상: None(다른 조직 행은 org_id 조건으로 새지 않는다).
- 단건 resolve_work_item_project_id ↔ 배치 resolve_work_item_project_ids_batch 가 종류마다 같은 값(두 해소기 어긋남 방지).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_2054_gate_inbox import (
    _REAL_DB_SKIP,
    _client_for,
    _seed_org_project_users,
    _session_factory,
    _setup_app,
)

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_targets(s, seeded):
    """다른 프로젝트(D)에 종류마다 대상 하나씩 — 현재/기본 프로젝트와 섞이지 않게."""
    from app.models.conversation import Conversation
    from app.models.doc import Doc
    from app.models.gate import Gate
    from app.models.hypothesis import Hypothesis
    from app.models.loop import LoopRun
    from app.models.organization import Organization
    from app.models.pm import Goal, Sprint, Story, Task
    from app.models.project import Project
    from app.models.visual_artifact import VisualArtifact
    from app.models.workflow_line import WorkflowLineDefinitionVersion

    org_id, member_id = seeded["org_id"], seeded["org_member_a_id"]
    project_d = Project(id=uuid.uuid4(), org_id=org_id, name="Project D")
    other_org = Organization(id=uuid.uuid4(), name="Other", slug=f"other-{uuid.uuid4().hex[:8]}")
    s.add_all([project_d, other_org])
    await s.flush()
    other_project = Project(id=uuid.uuid4(), org_id=other_org.id, name="Other P")
    s.add(other_project)
    await s.flush()
    pid = project_d.id
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="st")
    s.add(story)
    await s.flush()
    t = {
        "story": story,
        "task": Task(id=uuid.uuid4(), org_id=org_id, story_id=story.id, title="tk"),
        "doc": Doc(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="d", slug=f"doc-{uuid.uuid4().hex[:8]}", content=""),
        "doc_deleted": Doc(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="dd", slug=f"del-{uuid.uuid4().hex[:8]}",
                           content="", deleted_at=datetime.now(timezone.utc)),
        "doc_other_org": Doc(id=uuid.uuid4(), org_id=other_org.id, project_id=other_project.id, title="od",
                             slug=f"od-{uuid.uuid4().hex[:8]}", content=""),
        "epic": Goal(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="g"),
        "sprint": Sprint(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="sp"),
        "conversation": Conversation(id=uuid.uuid4(), org_id=org_id, project_id=pid, type="group", created_by=member_id),
        "loop": LoopRun(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="loop", goal_tags=[], created_by_member_id=member_id),
        "hypothesis": Hypothesis(id=uuid.uuid4(), org_id=org_id, project_id=pid, owner_member_id=member_id, statement="h",
                                 metric_definition={"metric": "signups", "source": "manual", "target": 100, "direction": "up"},
                                 measure_after=datetime.now(timezone.utc) + timedelta(days=1), status="measuring"),
        "wf_line_version": WorkflowLineDefinitionVersion(id=uuid.uuid4(), org_id=org_id, project_id=pid, entity_type="story",
                                                         version=1, config_hash="h1", created_by_member_id=member_id),
    }
    s.add_all([v for k, v in t.items() if k != "story"])
    await s.flush()
    t["visual_artifact"] = VisualArtifact(id=uuid.uuid4(), org_id=org_id, project_id=pid, title="va", created_by=member_id)
    s.add(t["visual_artifact"])
    await s.flush()
    t["gate"] = Gate(id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story", gate_type="merge", status="pending")
    gid = uuid.uuid4()
    t["gate_self_anchor"] = Gate(id=gid, org_id=org_id, work_item_id=gid, work_item_type="agent_decision", gate_type="merge",
                                 status="pending", neutral_facts={"project_id": str(pid)})
    s.add_all([t["gate"], t["gate_self_anchor"]])
    await s.flush()
    return pid, t


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_notification_list_carries_target_project_and_doc_slug():
    from app.main import app
    from app.models.notification import Notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, a_id = seeded["org_id"], seeded["user_a_id"]
            pid, t = await _seed_targets(s, seeded)
            refs = {
                "gate": ("gate", t["gate"].id), "gate_self_anchor": ("gate", t["gate_self_anchor"].id),
                "story": ("story", t["story"].id), "task": ("task", t["task"].id), "doc": ("doc", t["doc"].id),
                "doc_deleted": ("doc", t["doc_deleted"].id), "doc_other_org": ("doc", t["doc_other_org"].id),
                "visual_artifact": ("visual_artifact", t["visual_artifact"].id), "epic": ("epic", t["epic"].id),
                "sprint": ("sprint", t["sprint"].id), "conversation": ("conversation", t["conversation"].id),
                "team_member": ("team_member", seeded["org_member_a_id"]), "missing_gate": ("gate", uuid.uuid4()),
            }
            notif_ids = {}
            for key, (rtype, rid) in refs.items():
                n = Notification(id=uuid.uuid4(), org_id=org_id, user_id=a_id, type="x", title=key, reference_type=rtype, reference_id=rid)
                s.add(n)
                notif_ids[key] = n.id
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/notifications")
            assert resp.status_code == 200, resp.text
            by_id = {row["id"]: row for row in resp.json()["data"]}
            got = {key: by_id[str(nid)]["target_project_id"] for key, nid in notif_ids.items()}
            expected = {key: str(pid) for key in notif_ids}
            expected.update({"doc_other_org": None, "team_member": None, "missing_gate": None})
            assert got == expected
            slugs = {key: by_id[str(notif_ids[key])]["target_doc_slug"] for key in ("doc", "doc_deleted", "doc_other_org", "story")}
            assert slugs == {"doc": t["doc"].slug, "doc_deleted": None, "doc_other_org": None, "story": None}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_event_notification_list_carries_target_project_not_recipient_project():
    """종 알림(events) — events.project_id는 수신자 멤버 행의 프로젝트(대상과 다를 수 있음)라 링크에 쓰면 안 된다. 목록 항목의
    target_project_id는 대상(source_entity) 자신의 프로젝트 · 문서는 slug도."""
    from app.main import app
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id, a_id = seeded["org_id"], seeded["user_a_id"]
            pid, t = await _seed_targets(s, seeded)
            recipient_project = seeded["project_id"]  # 수신자 멤버 행의 프로젝트(대상 프로젝트 D와 다름)
            assert recipient_project != pid
            ev = {}
            for key, stype, sid in (("story", "story", t["story"].id), ("doc", "doc", t["doc"].id), ("gate", "gate", t["gate"].id),
                                    ("epic", "epic", t["epic"].id), ("agent", "agent", uuid.uuid4())):
                e = Event(id=uuid.uuid4(), org_id=org_id, project_id=recipient_project, event_type="dispatched",
                          source_entity_type=stype, source_entity_id=sid, recipient_id=seeded["org_member_a_id"],
                          recipient_type="human", payload={}, status="delivered")
                s.add(e)
                ev[key] = e.id
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/event-notifications", params={"limit": 50})
            assert resp.status_code == 200, resp.text
            by_id = {row["id"]: row for row in resp.json()}
            got = {k: by_id[str(i)]["target_project_id"] for k, i in ev.items()}
            assert got == {"story": str(pid), "doc": str(pid), "gate": str(pid), "epic": str(pid), "agent": None}
            assert by_id[str(ev["doc"])]["target_doc_slug"] == t["doc"].slug
            assert all(by_id[str(i)]["project_id"] == str(recipient_project) for i in ev.values())  # 원래 필드는 그대로(수신자 쪽)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_batch_project_resolver_matches_single_per_type():
    from app.services.gate_service import resolve_work_item_project_id, resolve_work_item_project_ids_batch

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_users(s)
            org_id = seeded["org_id"]
            pid, t = await _seed_targets(s, seeded)
            await s.commit()
            items = [(k, t[k].id) for k in ("story", "task", "doc", "visual_artifact", "loop", "hypothesis", "epic", "sprint")]
            batch = await resolve_work_item_project_ids_batch(s, org_id, items + [("wf_line_version", t["wf_line_version"].id)])
            for wtype, wid in items:
                single = await resolve_work_item_project_id(s, org_id, wtype, wid)
                assert single == pid, wtype
                assert batch.get((wtype, wid)) == single, wtype
            assert batch.get(("wf_line_version", t["wf_line_version"].id)) == pid
            # 다른 조직 행은 배치에서도 새지 않는다
            other = await resolve_work_item_project_ids_batch(s, org_id, [("doc", t["doc_other_org"].id)])
            assert other == {}
    finally:
        await engine.dispose()
