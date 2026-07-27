"""E-SECURITY SEC-S8(story 83ea3d6a) EE: standup impersonation + oss_seed org-scope 봉쇄
실증(까심 전수스윕, CRITICAL 3건 라이브확定).

- upsert_standup: body.project_id 접근권 검증 0 + body.author_id가 client-supplied 그대로
  신뢰돼(self-scope 검증 0) 남의 project에 남의 이름으로 standup을 위조할 수 있었다.
- add_feedback: body.project_id 접근권 검증 0 + body.feedback_by_id가 client-supplied 그대로
  신뢰돼(self-scope 검증 0) 남의 project에 남의 이름으로 feedback을 위조할 수 있었다
  ("트랩#9" 자기주석에도 불구 실제로 뚫려있었다).
- oss_seed: org_id가 get_verified_org_id를 거치지 않는 raw client query param이라 인증
  유저가 소속 여부와 무관하게 임의 org_id로 시드를 심을 수 있었다."""
from __future__ import annotations

import os
import uuid
from datetime import date as _date

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


async def _seed_two_humans_two_orgs(session):
    """org_a(project_a, human_a=project_a grant) + org_b(project_b, human_b=project_b grant).

    human_a는 project_a에만 접근권 있고, human_b는 org_b(별개 org) 소속 — cross-project와
    cross-org 양쪽 각도 모두 재현 가능."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    human_a_id = uuid.uuid4()
    human_a = User(id=human_a_id, email=f"a-{human_a_id.hex[:8]}@test.com", hashed_password="x")
    human_b_id = uuid.uuid4()
    human_b = User(id=human_b_id, email=f"b-{human_b_id.hex[:8]}@test.com", hashed_password="x")
    session.add_all([human_a, human_b])
    await session.commit()

    om_a = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=human_a_id, role="member")
    om_b = OrgMember(id=uuid.uuid4(), org_id=org_b.id, user_id=human_b_id, role="member")
    session.add_all([om_a, om_b])
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, org_member_id=om_a.id, permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, org_member_id=om_b.id, permission="granted", role="member"),
    ])
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "project_a_id": project_a.id, "project_b_id": project_b.id,
        "human_a_user_id": human_a_id, "human_b_user_id": human_b_id,
        "human_b_om_id": om_b.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
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
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ── upsert_standup ───────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_upsert_standup_cross_project_blocked_no_row():
    """human_a가 project_a에만 grant인데 project_b로 standup 작성 시도 → 차단·row 무생성."""
    from app.main import app
    from app.models.standup import StandupEntry

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)

        await _setup_app(app, Session, seeded["human_a_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/standups", json={
                "project_id": str(seeded["project_b_id"]),
                "author_id": str(seeded["human_a_user_id"]),
                "date": "2026-07-11", "plan": "injected plan",
            })
            assert resp.status_code in (403, 404), resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            rows = (await s.execute(
                select(StandupEntry).where(StandupEntry.project_id == seeded["project_b_id"])
            )).scalars().all()
            assert rows == [], "무권한 project에 standup entry가 생성되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_standup_author_id_spoof_ignored_uses_caller_identity():
    """human_a가 자기 project에서 author_id=human_b(타인) 스푸핑 시도 → 실제 저장은 caller(human_a) 신원."""
    from app.main import app
    from app.models.standup import StandupEntry

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)

        await _setup_app(app, Session, seeded["human_a_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/standups", json={
                "project_id": str(seeded["project_a_id"]),
                "author_id": str(seeded["human_b_user_id"]),  # 스푸핑 시도(타인 신원)
                "date": "2026-07-11", "plan": "who wrote this?",
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            entry = (await s.execute(
                select(StandupEntry).where(StandupEntry.project_id == seeded["project_a_id"])
            )).scalar_one()
            # author_id가 스푸핑값(human_b)이 아니라 caller(human_a org_member.id=om_a) 기반이어야 함.
            assert str(entry.author_id) != str(seeded["human_b_om_id"]), "author_id 스푸핑이 저장되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_standup_same_project_still_works():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)

        await _setup_app(app, Session, seeded["human_a_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/standups", json={
                "project_id": str(seeded["project_a_id"]),
                "author_id": str(seeded["human_a_user_id"]),
                "date": "2026-07-11", "plan": "legit plan",
            })
            assert resp.status_code == 201, resp.text
            assert resp.json()["plan"] == "legit plan"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── add_feedback ──────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_add_feedback_cross_project_blocked_no_row():
    """entry가 project_b(caller 무권한) 소속인데 body.project_id를 project_a(caller 유권한)라
    주장해도 차단돼야 한다 — 까심 QA가 잡은 bypass 벡터(body-claimed project 신뢰 금지,
    entry.project_id가 실제 인가 기준)."""
    from app.main import app
    from app.models.standup import StandupEntry, StandupFeedback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)
            from app.models.project import Project
            project_c = Project(id=uuid.uuid4(), org_id=seeded["org_a_id"], name="Project C (no grant)")
            s.add(project_c)
            await s.commit()
            entry = StandupEntry(
                id=uuid.uuid4(), org_id=seeded["org_a_id"], project_id=project_c.id,
                author_id=uuid.uuid4(), date=_date(2026, 7, 11),
            )
            s.add(entry)
            await s.commit()
            entry_id = entry.id

        await _setup_app(app, Session, seeded["human_a_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/standups/{entry_id}/feedback", json={
                "org_id": str(seeded["org_a_id"]),
                "project_id": str(seeded["project_a_id"]),  # caller 유권한 project라 주장(bypass 시도)
                "feedback_by_id": str(seeded["human_a_user_id"]),
                "review_type": "comment", "feedback_text": "injected",
            })
            assert resp.status_code in (403, 404), resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            rows = (await s.execute(
                select(StandupFeedback).where(StandupFeedback.standup_entry_id == entry_id)
            )).scalars().all()
            assert rows == [], "무권한 entry에 feedback이 생성되면 안 됨(body-claimed project 우회 차단)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_add_feedback_by_id_spoof_ignored_uses_caller_identity():
    from app.main import app
    from app.models.standup import StandupEntry, StandupFeedback

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)
            entry = StandupEntry(
                id=uuid.uuid4(), org_id=seeded["org_a_id"], project_id=seeded["project_a_id"],
                author_id=uuid.uuid4(), date=_date(2026, 7, 11),
            )
            s.add(entry)
            await s.commit()
            entry_id = entry.id

        await _setup_app(app, Session, seeded["human_a_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/standups/{entry_id}/feedback", json={
                "org_id": str(seeded["org_a_id"]),
                "project_id": str(seeded["project_a_id"]),
                "feedback_by_id": str(seeded["human_b_user_id"]),  # 스푸핑 시도
                "review_type": "comment", "feedback_text": "legit feedback",
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            fb = (await s.execute(
                select(StandupFeedback).where(StandupFeedback.standup_entry_id == entry_id)
            )).scalar_one()
            assert str(fb.feedback_by_id) != str(seeded["human_b_om_id"]), "feedback_by_id 스푸핑이 저장되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── oss_seed ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_oss_seed_cross_org_blocked_no_rows():
    """human_b(org_b 소속)가 org_a(자기 소속 아님)+project_a로 시드 시도 → 차단·row 무생성."""
    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)

        await _setup_app(app, Session, seeded["human_b_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/oss/seed", params={
                "project_id": str(seeded["project_a_id"]),
            })
            assert resp.status_code in (403, 404), resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            rows = (await s.execute(
                select(Story).where(Story.project_id == seeded["project_a_id"])
            )).scalars().all()
            assert rows == [], "무권한 org/project에 샘플 스토리가 생성되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_oss_seed_same_org_project_still_works():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_humans_two_orgs(s)

        await _setup_app(app, Session, seeded["human_a_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/oss/seed", params={
                "project_id": str(seeded["project_a_id"]),
            })
            assert resp.status_code == 200, resp.text
            assert resp.json()["seeded"] is True
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
