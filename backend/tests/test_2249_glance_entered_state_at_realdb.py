"""story #2249 실PG 테스트 — `/api/v2/glance/attention`의 5종 신호 전부가 `entered_state_at`을
싣는 것을 실증한다(AC2: 신호를 내는 자리를 전수·한 경로만 고치고 멈추지 않는다).

소스는 kind별로 다르다(glance.py 모듈 docstring 참조):
  gate_pending → WorkflowLineStepApproval.created_at
  blocked      → ItemDependency.created_at
  needs_input  → Gate.status_entered_at(#2249 신규)
  verify_fail  → Gate.evidence_status_entered_at(#2249 신규)
merge_ready(StoryActivity 기반)는 기존 test_e_glance_attention_realdb.py의 3신호 스위트가
이미 회귀 없음을 실증 — 이 파일은 시각 필드 자체의 정확성에 집중한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


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


def _story(org_id, project_id, title, status="in-progress"):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status)


async def _seed_base(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id,
                               permission="granted", role="member"))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "caller_id": caller_id}


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    # story #2451(§6 Phase3, 카디르 QA 4차 2026-08-04): 이 파일은 /api/v2/glance/attention
    # (A1이 get_read_db로 라우팅한 엔드포인트)을 5회 호출하는데 get_db만 override — 1차
    # QA 때 「우연 통과」로 넘어갔던 진짜 latent bug. baseline에 얼리지 않고 지금 고친다.
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_gate_pending_entered_state_at_matches_approval_created_at():
    """gate_pending의 entered_state_at == WorkflowLineStepApproval.created_at."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepApproval

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Gate Story")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="review", status="pending")
            s.add(gate)
            await s.commit()
            approval = WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                step_run_id=uuid.uuid4(), approval_group_id=uuid.uuid4(),
                approver_member_id=uuid.uuid4(), approver_member_type="agent",
                gate_id=gate.id, kind="approver", blocking=True, status="pending",
            )
            s.add(approval)
            await s.commit()
            expected_at = approval.created_at

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            item = next(i for i in resp.json()["items"] if i["kind"] == "gate_pending")
            assert item["entered_state_at"] is not None
            got = datetime.fromisoformat(item["entered_state_at"].replace("Z", "+00:00"))
            assert abs((got - expected_at).total_seconds()) < 1
            assert item["entered_state_at_precision"] == "exact"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_needs_input_and_verify_fail_use_new_gate_columns():
    """needs_input → Gate.status_entered_at · verify_fail → Gate.evidence_status_entered_at
    (#2249 신규 컬럼) — updated_at 아님을 실증(둘을 서로 다른 시각으로 세팅해 구분)."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_ni = _story(seeded["org_id"], seeded["project_id"], "Needs Input Story")
            story_vf = _story(seeded["org_id"], seeded["project_id"], "Verify Fail Story")
            s.add_all([story_ni, story_vf])
            await s.commit()

            ni_entered = datetime(2026, 7, 20, 0, 0, 0, tzinfo=timezone.utc)
            gate_ni = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story_ni.id,
                work_item_type="story", gate_type="doc_approval", status="pending",
                status_entered_at=ni_entered, requires_human=True, evidence_status="insufficient",
                # updated_at은 onupdate=func.now()라 커밋 시점이 됨 — status_entered_at과
                # 다른 값이어야 "updated_at을 쓴 게 아니다"가 실증된다.
            )
            vf_entered = datetime(2026, 7, 15, 0, 0, 0, tzinfo=timezone.utc)
            gate_vf = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story_vf.id,
                work_item_type="story", gate_type="merge", status="pending",
                evidence_status="blocked", evidence_status_entered_at=vf_entered,
            )
            s.add_all([gate_ni, gate_vf])
            await s.commit()
            assert gate_ni.updated_at != ni_entered  # 방어적 확認 — onupdate가 다른 값을 냈다.
            assert gate_vf.updated_at != vf_entered

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]

            ni_item = next(i for i in items if i["kind"] == "needs_input")
            got_ni = datetime.fromisoformat(ni_item["entered_state_at"].replace("Z", "+00:00"))
            assert got_ni == ni_entered
            assert ni_item["entered_state_at_precision"] == "exact"
            # ⛔story #2232(2026-07-30) — 값이 있는데 ref가 안 나르던 것을 고침. 값-레벨 증거로
            # 닫는다("코드에 넣었다"가 아니라 "응답에 실제로 있다"가 증거, 오늘 아침 교훈).
            assert ni_item["ref"]["gate_type"] == "doc_approval"
            assert ni_item["ref"]["evidence_status"] == "insufficient"
            assert ni_item["ref"]["gate_id"] == str(gate_ni.id)

            vf_item = next(i for i in items if i["kind"] == "verify_fail")
            got_vf = datetime.fromisoformat(vf_item["entered_state_at"].replace("Z", "+00:00"))
            assert got_vf == vf_entered
            assert vf_item["entered_state_at_precision"] == "exact"

            assert got_ni != got_vf  # 서로 다른 축(status vs evidence_status)임을 재확認.
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_needs_input_ref_carries_null_evidence_status_faithfully():
    """story #2232 — evidence_status가 구조적으로 NULL인 게이트(예: artifact_canonicalize류)도
    ref에 «None 그대로» 실려야 한다(빈 문자열로 뭉개거나 키 자체를 생략하면 FE가 "구조적 NULL"과
    "값 없는 에러"를 못 가른다 — 실측: 37건 중 5건이 NULL, 그중 merge인데 NULL인 1건은 다른
    의미라 FE가 갈라야 한다는 것이 오르테가 판정, BE는 값을 «그대로» 나르기만 한다)."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "No Evidence Status")
            s.add(story)
            await s.commit()

            gate = Gate(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                work_item_type="story", gate_type="artifact_canonicalize", status="pending",
                requires_human=True,  # evidence_status 생략 — 구조적으로 None
            )
            s.add(gate)
            await s.commit()

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]
            ni_item = next(i for i in items if i["kind"] == "needs_input")
            assert ni_item["ref"]["gate_type"] == "artifact_canonicalize"
            assert ni_item["ref"]["evidence_status"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_blocked_entered_state_at_is_none_not_approx():
    """⭐오르테가군 리뷰(2026-07-28, 처방 정정) pin — blocked는 entered_state_at=None(값을
    안 싣는다). 최초엔 "approx"로 실었으나 철회됨: ItemDependency.created_at의 오차가 유계
    지터가 아니라(재오픈 edge case 시 수 시간~수 개월) 임의로 커질 수 있어 「근사」 라벨을
    붙이면 «라벨 붙인 거짓»이 된다 — 「모르면 안 준다」가 맞는 처방."""
    from app.main import app
    from app.models.dependency import ItemDependency

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            blocker = _story(seeded["org_id"], seeded["project_id"], "Blocker")
            blocked_story = _story(seeded["org_id"], seeded["project_id"], "Blocked Story")
            s.add_all([blocker, blocked_story])
            await s.commit()
            s.add(ItemDependency(
                id=uuid.uuid4(), org_id=seeded["org_id"], from_id=blocker.id, to_id=blocked_story.id,
                dep_type="blocks", item_type="story",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            item = next(i for i in resp.json()["items"] if i["kind"] == "blocked")
            assert item["entered_state_at"] is None, (
                "blocked의 entered_state_at은 유계가 아닌 오차라 값을 실으면 안 된다 — "
                "ItemDependency.created_at을 쓰면 재오픈 edge case에서 몇 개월까지 틀릴 수 있다."
            )
            assert item["entered_state_at_precision"] is None  # 값-정밀도는 항상 짝.
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_entered_state_at_is_optional_and_backward_compatible():
    """AC5 회귀 0 — 신규 필드가 없어도(구 소비자) 기존 필드는 그대로다. 응답에 entered_state_at이
    있어도 kind/story_id/title/ref 등 기존 계약은 안 바뀐다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepApproval

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Gate Story")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="review", status="pending")
            s.add(gate)
            await s.commit()
            s.add(WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                step_run_id=uuid.uuid4(), approval_group_id=uuid.uuid4(),
                approver_member_id=uuid.uuid4(), approver_member_type="agent",
                gate_id=gate.id, kind="approver", blocking=True, status="pending",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            item = resp.json()["items"][0]
            # 구 계약 필드 전부 여전히 존재 — 신규 필드 추가가 기존 소비자를 안 깬다.
            for key in ("kind", "story_id", "title", "ref"):
                assert key in item
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
