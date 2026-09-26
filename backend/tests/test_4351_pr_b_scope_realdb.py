"""story #4351 PR B — id로 닿거나 org 전체를 모으는 나머지 자리가 접근 권한 없는 프로젝트의 내용을 싣지 않는다.

한 시드: project A · B, 부르는 구성원은 A에만 grant. B 쪽 내용엔 «SECRET-B», A 쪽엔 «VISIBLE-A». 접근 불가 id는 없는 id와 같은
응답(존재 비노출), 자기 프로젝트 것은 그대로(회귀 0), owner(전체 접근)는 옛 동작 그대로.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import pytest

from tests.conftest import override_db_and_read
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_4058_material_lineage_hook_performance_realdb import _seed_lineage, _seed_master_evidence
from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@asynccontextmanager
async def _world():
    """org · project A/B · 스토리 각 1(제목에 표지) · 구성원(A만) · owner. 각 스토리에 계보 edge 1 · participation + verdict 1."""
    from app.models.organization import Organization
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.user import User
    from app.models.verdict import Verdict

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
            pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
            s.add_all([pa, pb])
            await s.commit()
            member_id, member_user = await _make_member(s, org.id, pa.id)
            owner_user = uuid.uuid4()
            s.add(User(id=owner_user, email=f"o-{owner_user.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user, role="owner"))
            role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="dev", label="dev", is_default=True)
            s.add(role)
            await s.commit()
            seeded = {"org": org.id, "pa": pa.id, "member_id": member_id, "member_user": member_user, "owner_user": owner_user}
            for key, proj, mark in (("a", pa, "VISIBLE-A"), ("b", pb, "SECRET-B")):
                story = Story(id=uuid.uuid4(), org_id=org.id, project_id=proj.id, title=f"{mark}-story")
                s.add(story)
                await s.commit()
                evidence_id = await _seed_master_evidence(s, org_id=org.id, work_item_id=story.id)
                await _seed_lineage(s, org_id=org.id, source_evidence_id=evidence_id, work_item_id=story.id, derived_id=uuid.uuid4())
                participation = Participation(id=uuid.uuid4(), org_id=org.id, story_id=story.id, member_id=member_id, role_id=role.id)
                s.add(participation)
                await s.commit()
                s.add(Verdict(id=uuid.uuid4(), org_id=org.id, participation_id=participation.id, source="hypothesis_outcome_execution", result="pass", rounds=0))
                await s.commit()
                seeded[f"story_{key}"] = story.id
                seeded[f"participation_{key}"] = participation.id
        yield Session, seeded
    finally:
        await engine.dispose()


async def _get(Session, seeded, path, user):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.main import app

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(user), email="u@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = lambda: seeded["org"]
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            return await c.get(path)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("path", [
    "/api/v2/material-lineage?work_item_id={story}",
    "/api/v2/verdicts?participation_id={participation}",
])
async def test_id_reachable_rows_of_inaccessible_project_look_like_missing_ids(path):
    """⑧ material-lineage(마스터 스토리 제목을 싣는다) · ⑨ verdicts — 접근 불가 프로젝트 id = 없는 id와 같은 `200 []`."""
    async with _world() as (Session, seeded):
        def fill(key):
            return path.format(story=seeded[f"story_{key}"], participation=seeded[f"participation_{key}"])

        other = await _get(Session, seeded, fill("b"), seeded["member_user"])
        assert other.status_code == 200 and other.json() == [], other.text[:300]
        missing = await _get(Session, seeded, path.format(story=uuid.uuid4(), participation=uuid.uuid4()), seeded["member_user"])
        assert (missing.status_code, missing.json()) == (other.status_code, other.json()), "없는 id와 응답이 달라 존재가 샌다"
        own = await _get(Session, seeded, fill("a"), seeded["member_user"])
        assert own.status_code == 200 and len(own.json()) == 1, own.text[:300]
        owner = await _get(Session, seeded, fill("b"), seeded["owner_user"])
        assert owner.status_code == 200 and len(owner.json()) == 1, "전체 접근은 옛 동작 그대로"
        if "lineage" in path:
            assert "VISIBLE-A-story" in own.text and "SECRET-B" in owner.text


async def test_judgments_hide_those_touching_an_inaccessible_story():
    """③ PO 2026-09-26 — `scope=items`는 걸린 스토리 중 하나라도 접근 불가면 숨김 · 둘 다 접근 가능이면 보임 · `general`과 못 푸는 id만
    걸린 판정은 org 수준이라 보임 · owner는 전부."""
    from app.models.judgment import Judgment

    async with _world() as (Session, seeded):
        async with Session() as s:
            for mark, scope, items in (
                ("VISIBLE-A-only", "items", [seeded["story_a"]]),
                ("SECRET-B-mixed", "items", [seeded["story_a"], seeded["story_b"]]),
                ("SECRET-B-only", "items", [seeded["story_b"]]),
                ("VISIBLE-ORG-general", "general", []),
                ("VISIBLE-UNRESOLVED", "items", [uuid.uuid4()]),
            ):
                s.add(Judgment(
                    id=uuid.uuid4(), org_id=seeded["org"], scope=scope, kind="judgment", statement=mark,
                    work_item_ids=items, created_by=seeded["member_user"],
                ))
            await s.commit()
        member = await _get(Session, seeded, "/api/v2/judgments", seeded["member_user"])
        assert member.status_code == 200, member.text[:300]
        for visible in ("VISIBLE-A-only", "VISIBLE-ORG-general", "VISIBLE-UNRESOLVED"):
            assert visible in member.text
        assert "SECRET-B" not in member.text
        owner = await _get(Session, seeded, "/api/v2/judgments", seeded["owner_user"])
        assert "SECRET-B-mixed" in owner.text and "SECRET-B-only" in owner.text


async def test_command_center_overview_narrows_project_aggregates_for_restricted_callers():
    """④ — 에픽 · 비용 추세가 접근 가능 프로젝트만(제한 구성원) · scope 라벨이 그 범위를 말함 · owner는 org 전체 그대로."""
    from datetime import UTC, datetime

    from sqlalchemy import update

    from app.models.agent_run import AgentRun
    from app.models.pm import Goal, Story

    async with _world() as (Session, seeded):
        async with Session() as s:
            projects = {"a": seeded["pa"]}
            projects["b"] = (await s.get(Story, seeded["story_b"])).project_id
            for key, mark, cost in (("a", "VISIBLE-A", 1), ("b", "SECRET-B", 100)):
                goal = Goal(id=uuid.uuid4(), org_id=seeded["org"], project_id=projects[key], title=f"{mark}-epic", status="active")
                s.add(goal)
                await s.flush()
                await s.execute(update(Story).where(Story.id == seeded[f"story_{key}"]).values(epic_id=goal.id))
                s.add(AgentRun(
                    id=uuid.uuid4(), org_id=seeded["org"], project_id=projects[key], agent_id=seeded["member_id"],
                    cost_usd=cost, started_at=datetime.now(UTC),
                ))
            await s.commit()
        member = await _get(Session, seeded, "/api/v2/command-center/overview", seeded["member_user"])
        owner = await _get(Session, seeded, "/api/v2/command-center/overview", seeded["owner_user"])
        assert member.status_code == 200 and owner.status_code == 200, (member.text[:300], owner.text[:300])
        assert "VISIBLE-A-epic" in member.text and "SECRET-B" not in member.text
        assert member.json()["scope"] == "accessible_projects"
        assert member.json()["project_status"]["cost_trend"]["total_cost_usd"] == 1
        assert "SECRET-B-epic" in owner.text and owner.json()["scope"] == "org"
        assert owner.json()["project_status"]["cost_trend"]["total_cost_usd"] == 101


async def test_today_result_counts_and_workflow_line_metrics_count_only_accessible_projects():
    """수 셋 — /today landed_today · qa_passed_today, workflow-line/metrics: 제한 구성원은 접근 가능 프로젝트 몫만(게이트는 org 수준도
    센다), owner는 전부."""
    from datetime import UTC, datetime

    from app.models.gate import Gate
    from app.models.pm import Story, StoryActivity
    from app.models.workflow_line import WorkflowLineStepRun

    async with _world() as (Session, seeded):
        async with Session() as s:
            now = datetime.now(UTC)
            for key in ("a", "b"):
                story = await s.get(Story, seeded[f"story_{key}"])
                s.add(StoryActivity(
                    id=uuid.uuid4(), org_id=seeded["org"], story_id=story.id, project_id=story.project_id,
                    activity_type="status_changed", new_value="done", created_by=seeded["member_id"], created_at=now,
                ))
                s.add(Gate(
                    id=uuid.uuid4(), org_id=seeded["org"], work_item_id=story.id, work_item_type="story",
                    gate_type="merge", status="approved", resolved_at=now, neutral_facts={},
                ))
                s.add(WorkflowLineStepRun(
                    org_id=seeded["org"], project_id=story.project_id, entity_type="story", entity_id=story.id,
                    to_status="done", status="dispatched", mode="advisory_only", delivery_status="not_required",
                    correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex, started_at=now,
                ))
            s.add(Gate(
                id=uuid.uuid4(), org_id=seeded["org"], work_item_id=uuid.uuid4(), work_item_type="unknown_org_level",
                gate_type="merge", status="approved", resolved_at=now, neutral_facts={},
            ))
            await s.commit()
        counts = {}
        for who in ("member_user", "owner_user"):
            today = await _get(Session, seeded, "/api/v2/today?tz=UTC", seeded[who])
            metrics = await _get(Session, seeded, "/api/v2/stories/workflow-line/metrics", seeded[who])
            assert today.status_code == 200 and metrics.status_code == 200, (today.text[:300], metrics.text[:300])
            body = today.json()
            results = body.get("today_results", body)
            counts[who] = (
                results["landed_today"]["count"], results["qa_passed_today"]["count"], metrics.json()["total_step_runs"],
            )
        assert counts["member_user"] == (1, 2, 1), counts
        assert counts["owner_user"] == (2, 3, 2), counts
