"""story #2933 H1(P0-H, doc ia-... 아님 — trust-pipeline-be-design 후속) 실 PG.

GET /api/v2/stories/{id}(단일) · GET /api/v2/stories?status=&project_id=(보드 주경로) 둘 다
StoryResponse.trust_stage에 derive_trust_stage() 판정값이 실리는지, 6단계 전부(+done=None
파이프라인 스코프 밖)를 실측한다. PO 조건①(2933) — 수집(batch_trust_facts)이 단일/배치
어디로 들어오든 같은 story면 같은 값이 나와야 한다(두 엔드포인트 교차대조로 검증).
"""
from __future__ import annotations

import os
import uuid

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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id

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

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _base_org_project_caller(session):
    """test_e_ui_daegbyeon_p0_04_trust_pipeline_realdb.py의 검증된 anchor 패턴 재현(E-MEMBER-SSOT
    양쪽 컬럼 다 세팅 — 이 스토리는 project-access 체크가 걸리는 GET 라우트를 두드리므로 필요)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    session.add(project)
    await session.commit()
    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    m = Member(id=om.id, org_id=org.id, type="human", user_id=caller_id, name=f"Caller-{caller_id.hex[:6]}")
    session.add(m)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, member_id=m.id,
        permission="granted", role="member",
    ))
    await session.commit()
    return org.id, project.id, caller_id


def _story(org_id, project_id, title, status="in-progress"):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status)


async def _seed_six_states(session):
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.member import Member

    org_id, project_id, caller_id = await _base_org_project_caller(session)

    s_queued = _story(org_id, project_id, "Backlog", status="backlog")
    s_queued_ready = _story(org_id, project_id, "Ready", status="ready-for-dev")
    s_running = _story(org_id, project_id, "Running", status="in-progress")
    s_needs_input = _story(org_id, project_id, "Needs Input", status="in-progress")
    s_claimed = _story(org_id, project_id, "Claimed", status="in-review")
    s_merge_ready = _story(org_id, project_id, "Merge Ready", status="in-review")
    s_verified_blocked = _story(org_id, project_id, "Verified(blocked)", status="in-review")
    s_done = _story(org_id, project_id, "Done", status="done")
    session.add_all([
        s_queued, s_queued_ready, s_running, s_needs_input,
        s_claimed, s_merge_ready, s_verified_blocked, s_done,
    ])
    await session.commit()

    reviewer = Member(id=uuid.uuid4(), org_id=org_id, type="human", name="Reviewer", org_role="admin")
    session.add(reviewer)
    await session.commit()

    session.add(Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=s_needs_input.id, work_item_type="story",
        gate_type="pr_review", status="pending", requires_human=True,
    ))
    # merge_ready: human_verified(gate_approval evidence)+무블로커/무검증실패.
    session.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=s_merge_ready.id, work_item_type="story",
        type="gate_approval", ref="approved", created_by=reviewer.id,
    ))
    # verified(blocked): human_verified는 있지만 미해소 블로커가 있어 merge_ready로 못 감.
    session.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=s_verified_blocked.id, work_item_type="story",
        type="gate_approval", ref="approved", created_by=reviewer.id,
    ))
    await session.commit()

    from app.models.dependency import ItemDependency
    blocker_story = _story(org_id, project_id, "Blocker(open)", status="in-progress")
    session.add(blocker_story)
    await session.commit()
    session.add(ItemDependency(
        id=uuid.uuid4(), org_id=org_id, item_type="story",
        from_id=blocker_story.id, to_id=s_verified_blocked.id, dep_type="blocks",
    ))
    await session.commit()

    return {
        "org_id": org_id, "project_id": project_id, "caller_id": caller_id,
        "queued": s_queued.id, "queued_ready": s_queued_ready.id,
        "running": s_running.id, "needs_input": s_needs_input.id,
        "claimed_done": s_claimed.id, "merge_ready": s_merge_ready.id,
        "verified": s_verified_blocked.id, "done": s_done.id,
    }


@pytest.mark.anyio
async def test_get_story_exposes_trust_stage_for_all_six_states():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_six_states(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            expected = {
                "queued": "queued",
                "queued_ready": "queued",
                "running": "running",
                "needs_input": "needs_input",
                "claimed_done": "claimed_done",
                "merge_ready": "merge_ready",
                "verified": "verified",
                "done": None,
            }
            for key, want in expected.items():
                resp = await client.get(f"/api/v2/stories/{seeded[key]}")
                assert resp.status_code == 200, resp.text
                assert resp.json()["trust_stage"] == want, f"{key}: {resp.json()}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_stories_board_query_exposes_same_trust_stage_as_get_story():
    """PO 조건① 교차대조 — 보드 주경로(status+project_id 분기)가 단일 GET과 같은 값을 낸다
    (batch_trust_facts 하나로 수렴한 증거, 두 엔드포인트가 각자 다른 판정 로직을 안 탄다)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_six_states(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/stories?status=in-review&project_id={seeded['project_id']}"
            )
            assert resp.status_code == 200, resp.text
            by_id = {item["id"]: item["trust_stage"] for item in resp.json()}
            assert by_id[str(seeded["claimed_done"])] == "claimed_done"
            assert by_id[str(seeded["merge_ready"])] == "merge_ready"
            assert by_id[str(seeded["verified"])] == "verified"

            # 단일 GET과 교차대조(같은 story, 같은 값 — 판정 단일화 실증).
            single = await client.get(f"/api/v2/stories/{seeded['merge_ready']}")
            assert single.json()["trust_stage"] == by_id[str(seeded["merge_ready"])]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_stories_generic_filter_branch_also_exposes_trust_stage():
    """4개 list_stories 분기 중 generic filter 분기(project_id만, status_filter 없음)도
    trust_stage가 실린다 — 4곳 전부 배선했다는 실증(누락 방지)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_six_states(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            by_id = {item["id"]: item["trust_stage"] for item in resp.json()}
            assert by_id[str(seeded["needs_input"])] == "needs_input"
            assert by_id[str(seeded["done"])] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_story_response_includes_trust_stage():
    """story #2933 H4(카디르 QA 실결함, PR#3366 2026-08-22) — create_story 인라인 경로가
    _attach_trust_stage를 안 태워 신규 story 응답의 trust_stage가 항상 None이었다(default
    status='backlog'이므로 정직한 값은 'queued'). FE kanban-board.tsx가 이 필드를 그대로
    컬럼 판별자로 쓰므로(재파생 폴백 없음), 방금 만든 story가 신뢰축 뷰의 어느 컬럼에도
    안 잡히는 실종 버그로 이어졌다 — 재발 방지 회귀가드.
    """
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, caller_id = await _base_org_project_caller(s)
        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/stories",
                json={"project_id": str(project_id), "org_id": str(org_id), "title": "새 스토리"},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            data = body.get("data", body)
            assert data["status"] == "backlog"
            assert data["trust_stage"] == "queued", data
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bulk_update_stories_response_reflects_new_status_trust_stage():
    """story #2933 H4 qa:changes(카디르+codex, PR#3366 2026-08-22) — 보드 교차 신뢰컬럼
    드래그가 PATCH /stories/bulk 응답의 trust_stage를 낙관 갱신에 그대로 병합해야 하는데,
    이 엔드포인트가 H1 당시 _attach_trust_stage 배선에서 빠져 있어(뮤테이션 응답은 스코프
    밖이라는 결정 — 그땐 소비자가 없었다) 응답이 항상 trust_stage=None이었다. 병합하면
    오히려 카드가 실종되는 역효과(FE 재파생 폴백 없음 — PO 조건②) — 재발 방지 회귀가드.
    ready-for-dev('queued') → in-progress로 bulk 전이하면 응답이 'running'을 실어야 한다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, caller_id = await _base_org_project_caller(s)
            story = _story(org_id, project_id, "드래그 대상", status="ready-for-dev")
            s.add(story)
            await s.commit()
            story_id = story.id
        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                "/api/v2/stories/bulk",
                json={"items": [{"id": str(story_id), "status": "in-progress"}]},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            data = body if isinstance(body, list) else body.get("data", body)
            assert isinstance(data, list) and len(data) == 1
            assert data[0]["status"] == "in-progress"
            assert data[0]["trust_stage"] == "running", data[0]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bulk_update_stories_done_transition_trust_stage_is_null_not_stale():
    """카디르+codex 지적 두 번째 케이스 — done으로 옮기는 bulk 전이. trust_stage는 done
    파이프라인 스코프 밖(§7 확定④)이라 null이 «정직한» 값이다(FE storyTrustColumn이
    status==='done' 특별취급이라 null이어도 무해). 이 응답이 여전히 None을 실으면(구
    스코프-밖 상태) FE가 구값을 영구 잔존시킬 위험 자체가 있었다는 것만 별도로 고정."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, caller_id = await _base_org_project_caller(s)
            story = _story(org_id, project_id, "완료 전이 대상", status="in-review")
            s.add(story)
            await s.commit()
            story_id = story.id
        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                "/api/v2/stories/bulk",
                json={"items": [{"id": str(story_id), "status": "done"}]},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            data = body if isinstance(body, list) else body.get("data", body)
            assert data[0]["status"] == "done"
            assert data[0]["trust_stage"] is None, data[0]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_status_response_reflects_new_trust_stage():
    """PATCH /stories/{id}/status(단건 — 카드별 상태변경 메뉴 등 bulk를 안 타는 경로)도
    bulk와 동일 이유로 _attach_trust_stage 배선. in-review('claimed_done') →
    in-progress('running')로 단건 전이하면 응답이 'running'을 실어야 한다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, caller_id = await _base_org_project_caller(s)
            story = _story(org_id, project_id, "단건 전이 대상", status="in-review")
            s.add(story)
            await s.commit()
            story_id = story.id
        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story_id}/status",
                json={"status": "in-progress"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            data = body.get("data", body)
            assert data["status"] == "in-progress"
            assert data["trust_stage"] == "running", data
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_response_includes_trust_stage():
    """PATCH /stories/{id}(일반 — assignee/title 등, status 필드 자체가 없다)도 카디르 QA
    2R(PR#3366, 2026-08-22)로 배선. 이 엔드포인트는 status를 안 바꾸므로 trust_stage가
    바뀌진 않지만, 응답 자체가 항상 None이던 API 계약 비일관을 닫는다 — {list·create·get·
    bulk·status·update} 전 StoryResponse 엔드포인트가 이걸로 완결(codex 분류표 마지막 칸)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, caller_id = await _base_org_project_caller(s)
            story = _story(org_id, project_id, "제목만 바꿀 대상", status="ready-for-dev")
            s.add(story)
            await s.commit()
            story_id = story.id
        await _setup_app(app, Session, caller_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story_id}",
                json={"title": "제목 변경됨"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            data = body.get("data", body)
            assert data["title"] == "제목 변경됨"
            assert data["status"] == "ready-for-dev"  # 이 엔드포인트는 status를 안 건드림.
            assert data["trust_stage"] == "queued", data
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
