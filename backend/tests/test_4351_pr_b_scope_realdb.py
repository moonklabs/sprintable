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


async def test_material_performance_of_inaccessible_publication_is_not_looked_up(monkeypatch):
    """⑧ 형제(가드 첫 스캔) — 발행물 성과는 마스터 스토리 프로젝트 소속. 접근 불가면 스냅샷 조회 자체를 안 하고 org 밖 id와 같은 `[]` ·
    자기 프로젝트 · owner는 조회한다(시드 발행물엔 스냅샷이 없어 응답은 셋 다 `[]` → 조회 여부로 가른다)."""
    import app.routers.material_lineage as lineage_router
    from sqlalchemy import select

    from app.models.material_lineage import MaterialLineage

    looked_up: list[uuid.UUID] = []

    async def _record(session, *, org_id, publication_id):
        looked_up.append(publication_id)
        return []

    async def _head(session, *, publication_id):
        return publication_id

    monkeypatch.setattr(lineage_router, "list_insight_snapshots_for_publication", _record)
    monkeypatch.setattr(lineage_router, "resolve_head_publication_id", _head)
    async with _world() as (Session, seeded):
        async with Session() as s:
            derived = {
                key: (await s.execute(select(MaterialLineage.derived_id).where(MaterialLineage.work_item_id == seeded[f"story_{key}"]))).scalar_one()
                for key in ("a", "b")
            }
        path = "/api/v2/material-lineage/material-performance?derived_id={}"
        other = await _get(Session, seeded, path.format(derived["b"]), seeded["member_user"])
        assert other.status_code == 200 and other.json() == [] and looked_up == [], (other.text[:200], looked_up)
        own = await _get(Session, seeded, path.format(derived["a"]), seeded["member_user"])
        owner = await _get(Session, seeded, path.format(derived["b"]), seeded["owner_user"])
        assert own.status_code == 200 and owner.status_code == 200
        assert looked_up == [derived["a"], derived["b"]], "자기 프로젝트 · owner는 조회한다(회귀 0)"


async def test_comment_on_inaccessible_story_is_404_and_writes_nothing():
    """가드 첫 스캔(PO 2026-09-26) — `POST /stories/{id}/comments`가 형제 GET과 달리 프로젝트 접근을 안 봤다(쓰기 IDOR). 접근 불가 스토리 =
    없는 스토리와 같은 404 · 댓글 행 0 · 자기 프로젝트 스토리는 201."""
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func, select

    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.main import app
    from app.models.pm import StoryComment

    async with _world() as (Session, seeded):
        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(
                user_id=str(seeded["member_user"]), email="u@test",
                claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = lambda: seeded["org"]
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                other = await c.post(f"/api/v2/stories/{seeded['story_b']}/comments", json={"content": "SECRET-B-comment"})
                missing = await c.post(f"/api/v2/stories/{uuid.uuid4()}/comments", json={"content": "x"})
                own = await c.post(f"/api/v2/stories/{seeded['story_a']}/comments", json={"content": "VISIBLE-A-comment"})
        finally:
            app.dependency_overrides.clear()
        assert other.status_code == 404 == missing.status_code, (other.text[:200], missing.text[:200])
        assert own.status_code == 201, own.text[:300]
        async with Session() as s:
            written = (await s.execute(
                select(func.count()).select_from(StoryComment).where(StoryComment.story_id == seeded["story_b"])
            )).scalar_one()
        assert written == 0, "접근 불가 스토리에 댓글이 써졌다"


async def test_insights_board_published_today_and_hook_performance_count_only_accessible_projects():
    """⑤ 읽기 · 수 둘(PO 2026-09-26) — 인사이트 보드 행 · published_today · hook-performance가 접근 가능 프로젝트 발행만(제한 구성원) ·
    범위 표기 scope · owner는 org 전체 그대로."""
    from datetime import UTC, datetime

    from app.models.publication_command import PublicationCommand
    from tests.test_3502_insights_board import _seed_channel_publication, _seed_gate
    from tests.test_3978_published_in_window import _seed_connection

    async with _world() as (Session, seeded):
        now = datetime.now(UTC)
        async with Session() as s:
            connection_id = await _seed_connection(s, seeded["org"])
            for key in ("a", "b"):
                gate = await _seed_gate(s, org_id=seeded["org"], work_item_id=seeded[f"story_{key}"])
                pub = await _seed_channel_publication(
                    s, org_id=seeded["org"], gate_id=gate.id, channel="threads", published_at=now,
                    permalink=f"https://example.com/{'VISIBLE-A' if key == 'a' else 'SECRET-B'}-post",
                )
                s.add(PublicationCommand(
                    id=uuid.uuid4(), org_id=seeded["org"], gate_id=gate.id, destination=connection_id,
                    approved_version=uuid.uuid4(), operation="publish", status="completed",
                    requested_by_member_id=seeded["member_id"], updated_at=now,
                ))
                evidence_id = await _seed_master_evidence(s, org_id=seeded["org"], work_item_id=seeded[f"story_{key}"])
                await _seed_lineage(
                    s, org_id=seeded["org"], source_evidence_id=evidence_id, work_item_id=seeded[f"story_{key}"],
                    derived_id=pub.id, hook_key="hk-4351",
                )
            await s.commit()
        seen = {}
        for who in ("member_user", "owner_user"):
            board = await _get(Session, seeded, f"/api/v2/organizations/{seeded['org']}/insights-board?window=30d", seeded[who])
            today = await _get(Session, seeded, "/api/v2/today?tz=UTC", seeded[who])
            hook = await _get(Session, seeded, "/api/v2/material-lineage/hook-performance?hook_key=hk-4351", seeded[who])
            assert board.status_code == 200 and today.status_code == 200 and hook.status_code == 200, (
                board.text[:300], today.text[:300], hook.text[:300],
            )
            seen[who] = {
                "rows": len(board.json()["rows"]), "board_scope": board.json()["scope"], "secret_in_board": "SECRET-B" in board.text,
                "published_today": today.json()["published_today"]["count"], "today_scope": today.json()["scope"],
                "hook_variants": hook.json()["variant_count"], "hook_scope": hook.json()["scope"],
            }
        assert seen["member_user"] == {
            "rows": 1, "board_scope": "accessible_projects", "secret_in_board": False,
            "published_today": 1, "today_scope": "accessible_projects", "hook_variants": 1, "hook_scope": "accessible_projects",
        }, seen
        assert seen["owner_user"] == {
            "rows": 2, "board_scope": "org", "secret_in_board": True,
            "published_today": 2, "today_scope": "org", "hook_variants": 2, "hook_scope": "org",
        }, seen


async def test_today_needs_me_agent_progress_and_completed_drop_inaccessible_projects(monkeypatch):
    """까디르 C(PO 2026-09-27) — /today의 결재 항목(needs_me) · 에이전트 진행 · 오늘 완료가 접근 불가 프로젝트 스토리를 싣지 않는다
    (참여 술어만으론 접근 잃은 프로젝트 제목이 보였다) · owner는 그대로. needs_me 원천 둘은 합성 항목으로 대체(거르기 · 해소는 실 PG)."""
    from datetime import UTC, datetime

    from sqlalchemy import update

    import app.services.today_service as today_service
    from app.models.agent_run import AgentRun
    from app.models.pm import Story

    async with _world() as (Session, seeded):
        now = datetime.now(UTC)

        def _item(key):
            return {
                "kind": "approval", "risk": "low", "source": "workflow_step", "source_id": str(uuid.uuid4()),
                "work_item_type": "story", "work_item_id": seeded[f"story_{key}"], "gate_type": "merge", "title": None,
                "requested_by_member_id": None, "reason": None, "created_at": now, "gate_id": None,
                "actions": ["approve", "request_changes", "hold"],
            }

        async def _gates(*_a, **_k):
            return [_item("a"), _item("b")]

        async def _steps(*_a, **_k):
            return []

        monkeypatch.setattr(today_service, "_needs_me_from_gate_inbox", _gates)
        monkeypatch.setattr(today_service, "_needs_me_from_workflow_steps", _steps)
        async with Session() as s:
            for key in ("a", "b"):
                story = await s.get(Story, seeded[f"story_{key}"])
                await s.execute(update(Story).where(Story.id == story.id).values(assignee_id=seeded["member_id"]))
                for status, ended in (("running", None), ("completed", now)):
                    s.add(AgentRun(
                        id=uuid.uuid4(), org_id=seeded["org"], project_id=story.project_id, agent_id=seeded["member_id"],
                        story_id=story.id, status=status, started_at=now, finished_at=ended,
                    ))
            await s.commit()
        member = await _get(Session, seeded, "/api/v2/today?tz=UTC", seeded["member_user"])
        owner = await _get(Session, seeded, "/api/v2/today?tz=UTC", seeded["owner_user"])
        assert member.status_code == 200 and owner.status_code == 200, (member.text[:300], owner.text[:300])
        assert "SECRET-B" not in member.text, "접근 불가 프로젝트 스토리 제목이 /today에 있다"
        assert "VISIBLE-A-story" in member.text
        assert member.json()["needs_me_count"] == 1
        assert "SECRET-B-story" in owner.text and owner.json()["needs_me_count"] == 2


async def test_lineage_of_a_deleted_master_story_is_hidden_from_everyone():
    """까디르 P2 — 계보 행은 스토리 FK · 정리가 없어 지운 스토리의 고아 행이 남는다. 가릴 프로젝트를 모른다고 누구에게나 보이면 안 된다
    (fail-closed): 없는 스토리 = 거부 · owner도 `[]`."""
    async with _world() as (Session, seeded):
        orphan_story = uuid.uuid4()
        async with Session() as s:
            evidence_id = await _seed_master_evidence(s, org_id=seeded["org"], work_item_id=orphan_story)
            await _seed_lineage(s, org_id=seeded["org"], source_evidence_id=evidence_id, work_item_id=orphan_story, derived_id=uuid.uuid4())
        for who in ("member_user", "owner_user"):
            resp = await _get(Session, seeded, f"/api/v2/material-lineage?work_item_id={orphan_story}", seeded[who])
            assert resp.status_code == 200 and resp.json() == [], (who, resp.text[:300])


async def test_today_agent_run_in_an_accessible_project_linking_an_inaccessible_story_hides_its_title():
    """까디르 P2 — `POST /agent-runs`가 story 소속을 확인하지 않아 A 프로젝트 run에 B 스토리를 달 수 있다. 표시는 스토리 제목이라 거르는
    축도 스토리 프로젝트: (run A · 스토리 B) → 숨김 / 대조 (run B · 스토리 A) → 보임(run의 프로젝트가 아니라 스토리로 가른다)."""
    from datetime import UTC, datetime

    from sqlalchemy import update

    from app.models.agent_run import AgentRun
    from app.models.pm import Story

    async with _world() as (Session, seeded):
        now = datetime.now(UTC)
        async with Session() as s:
            await s.execute(update(Story).where(Story.id.in_([seeded["story_a"], seeded["story_b"]])).values(assignee_id=seeded["member_id"]))
            pb = (await s.get(Story, seeded["story_b"])).project_id
            for run_project, story in ((seeded["pa"], seeded["story_b"]), (pb, seeded["story_a"])):
                for status, finished in (("running", None), ("completed", now)):
                    s.add(AgentRun(
                        id=uuid.uuid4(), org_id=seeded["org"], project_id=run_project, agent_id=seeded["member_id"],
                        story_id=story, status=status, started_at=now, finished_at=finished,
                    ))
            await s.commit()
        member = await _get(Session, seeded, "/api/v2/today?tz=UTC", seeded["member_user"])
        assert member.status_code == 200, member.text[:300]
        assert "SECRET-B" not in member.text, "A 프로젝트 run에 달린 B 스토리 제목이 보인다"
        assert "VISIBLE-A-story" in member.text, "B 프로젝트 run에 달린 A 스토리는 보여야 한다(스토리 기준)"


async def test_my_actions_queue_drops_inaccessible_project_items():
    """PO 09-27 — my-actions의 action queue(리뷰 · 할 일 · 블로커 · 대기 · 결재)는 «내 몫»이지만 project 접근을 안 봤다: 접근 잃은 프로젝트의
    스토리 · 과제 제목이 보였다. A 담당 스토리 · 과제 → 보임 / B 담당 스토리 · 과제 → 숨김."""
    from sqlalchemy import update

    from app.models.pm import Story, Task

    async with _world() as (Session, seeded):
        async with Session() as s:
            await s.execute(update(Story).where(Story.id.in_([seeded["story_a"], seeded["story_b"]])).values(assignee_id=seeded["member_id"]))
            for key, mark in (("a", "VISIBLE-A"), ("b", "SECRET-B")):
                s.add(Task(id=uuid.uuid4(), org_id=seeded["org"], story_id=seeded[f"story_{key}"], title=f"{mark}-task", assignee_id=seeded["member_id"]))
            await s.commit()
        resp = await _get(Session, seeded, "/api/v2/command-center/my-actions", seeded["member_user"])
        assert resp.status_code == 200, resp.text[:300]
        queue = resp.json()["action_queue"]
        assert "SECRET-B" not in str(queue), "접근 불가 프로젝트의 담당 항목이 action queue에 있다"
        assert "VISIBLE-A-story" in str(queue) and "VISIBLE-A-task" in str(queue)


async def test_workflow_executions_list_of_an_inaccessible_project_is_404():
    """PO 09-27 — 실행 기록 목록은 비관리자에게 «자기 member_id»만 허락했지만 project 접근은 안 봤다. 접근 불가 project = 없는 프로젝트와
    같은 404 · 자기 프로젝트 = 200."""
    async with _world() as (Session, seeded):
        async with Session() as s:
            from app.models.pm import Story

            pb = (await s.get(Story, seeded["story_b"])).project_id
        other = await _get(Session, seeded, f"/api/v2/workflow-executions?project_id={pb}&member_id={seeded['member_id']}", seeded["member_user"])
        missing = await _get(Session, seeded, f"/api/v2/workflow-executions?project_id={uuid.uuid4()}&member_id={seeded['member_id']}", seeded["member_user"])
        own = await _get(Session, seeded, f"/api/v2/workflow-executions?project_id={seeded['pa']}&member_id={seeded['member_id']}", seeded["member_user"])
        assert other.status_code == 404 == missing.status_code, (other.text[:200], missing.text[:200])
        assert own.status_code == 200, own.text[:300]
