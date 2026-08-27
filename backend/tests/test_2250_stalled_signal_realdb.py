"""story #2250(93b076c8, "침묵의 정체") 실PG 테스트 — `/api/v2/glance/attention`의 6번째
신호(kind="stalled"). AC 축: ①정의(StoryActivity status_changed 최신, ㉠좁은) ②48h+ 임계
③backlog 제외(아직 시작 안 함≠멈춰 섬) ④1~5(gate_pending/blocked/merge_ready/needs_input/
verify_fail)와 섞지 않음(AC5) ⑤status_changed 행 자체가 없으면 "모르면 안 준다"로 제외
⑥stalled_computed_at 항상 present(0건이 "정말 없음"과 "계산 안 됨"을 가름) ⑦정렬(가장 오래
무변화 먼저) ⑧BE는 자르지 않는다(전량 반환).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


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
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
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


async def _seed_status_changed_activity(session, org_id, project_id, story_id, created_at, new_value="in-progress"):
    from app.models.pm import StoryActivity
    row = StoryActivity(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, story_id=story_id,
        activity_type="status_changed", old_value="backlog", new_value=new_value,
        created_by=uuid.uuid4(),
    )
    session.add(row)
    await session.flush()
    # created_at은 server_default=func.now() — 과거 시각을 강제로 심으려면 커밋 후 UPDATE.
    from sqlalchemy import update
    from app.models.pm import StoryActivity as SA
    await session.execute(update(SA).where(SA.id == row.id).values(created_at=created_at))
    await session.commit()
    return row


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

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_stalled_item_surfaces_past_48h_threshold():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Silent Story")
            s.add(story)
            await s.commit()
            old_at = datetime.now(timezone.utc) - timedelta(hours=72)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], story.id, old_at)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["stalled_computed_at"] is not None
            item = next(i for i in body["items"] if i["kind"] == "stalled")
            assert item["story_id"] == str(story.id)
            got = datetime.fromisoformat(item["entered_state_at"].replace("Z", "+00:00"))
            assert abs((got - old_at).total_seconds()) < 1
            assert item["entered_state_at_precision"] == "exact"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_fresh_activity_under_threshold_not_stalled():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Fresh Story")
            s.add(story)
            await s.commit()
            recent_at = datetime.now(timezone.utc) - timedelta(hours=2)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], story.id, recent_at)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            stalled = [i for i in resp.json()["items"] if i["kind"] == "stalled"]
            assert stalled == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_backlog_story_never_stalled_even_if_ancient():
    """backlog은 "아직 시작 안 함"이지 "멈춰 섬"이 아니다(#2250 §6-1) — activity가 아무리
    오래됐어도(또는 아예 없어도) 모집단에서 빠진다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Backlog Story", status="backlog")
            s.add(story)
            await s.commit()
            ancient_at = datetime.now(timezone.utc) - timedelta(days=100)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], story.id, ancient_at, new_value="backlog")

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            stalled = [i for i in resp.json()["items"] if i["kind"] == "stalled"]
            assert stalled == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_status_changed_activity_excluded_not_guessed():
    """「모르면 안 준다」— status_changed 행이 아예 없는 story는 (created_at 등으로 대체
    추측하지 않고) stalled 후보에서 그냥 빠진다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "No Activity Story")
            s.add(story)
            await s.commit()
            # StoryActivity 행 자체를 안 만든다.

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            stalled = [i for i in resp.json()["items"] if i["kind"] == "stalled"]
            assert stalled == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_already_merge_ready_signal_excluded_from_stalled():
    """AC5 — 1~5 중 하나로 이미 뜬 story는 status_changed가 아무리 오래돼도 stalled로
    또 뜨면 안 된다(섞으면 "할 일 목록"이 "사정 나열"이 된다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Merge Ready + Old Activity", status="in-review")
            s.add(story)
            await s.commit()
            old_at = datetime.now(timezone.utc) - timedelta(hours=200)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], story.id, old_at, new_value="in-review")

            # merge_ready 자격: human_verified(Evidence gate_approval) + blocker/verify_fail 없음.
            from app.models.evidence import Evidence
            s.add(Evidence(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id, work_item_type="story",
                type="gate_approval", created_by=seeded["caller_id"], ref="",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]
            story_items = [i for i in items if i["story_id"] == str(story.id)]
            kinds = {i["kind"] for i in story_items}
            assert "merge_ready" in kinds
            assert "stalled" not in kinds, "이미 merge_ready로 뜬 story가 stalled로도 중복 노출됨"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_stalled_computed_at_present_even_when_zero_items():
    """AC6 — stalled 0건이어도 stalled_computed_at은 항상 채워져 "계산이 실제로 돌았다"를
    증명한다(무신호=정말 없음 vs 무신호=계산 안 됨을 가른다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            # 아무 story도 안 만든다 — 진짜 빈 프로젝트.

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["items"] == []
            assert body["stalled_computed_at"] is not None
            computed_at = datetime.fromisoformat(body["stalled_computed_at"].replace("Z", "+00:00"))
            assert (datetime.now(timezone.utc) - computed_at).total_seconds() < 30
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_multiple_stalled_items_sorted_oldest_first_and_no_cap():
    """⛔BE는 자르지 않는다(top-N 없음) — 전량 반환 + 가장 오래 무변화인 항목이 먼저(내림차순
    무변화 일수 = entered_state_at 오름차순)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            newer_story = _story(seeded["org_id"], seeded["project_id"], "Newer Stall", status="in-progress")
            older_story = _story(seeded["org_id"], seeded["project_id"], "Older Stall", status="in-progress")
            s.add_all([newer_story, older_story])
            await s.commit()
            newer_at = datetime.now(timezone.utc) - timedelta(hours=50)
            older_at = datetime.now(timezone.utc) - timedelta(hours=500)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], newer_story.id, newer_at)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], older_story.id, older_at)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            stalled = [i for i in resp.json()["items"] if i["kind"] == "stalled"]
            assert len(stalled) == 2
            assert stalled[0]["story_id"] == str(older_story.id), "가장 오래 무변화인 것이 먼저 와야 한다"
            assert stalled[1]["story_id"] == str(newer_story.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_done_story_excluded_from_stalled_population():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story = _story(seeded["org_id"], seeded["project_id"], "Done Story", status="done")
            s.add(story)
            await s.commit()
            old_at = datetime.now(timezone.utc) - timedelta(hours=1000)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_id"], story.id, old_at, new_value="done")

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_id']}")
            assert resp.status_code == 200, resp.text
            stalled = [i for i in resp.json()["items"] if i["kind"] == "stalled"]
            assert stalled == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
