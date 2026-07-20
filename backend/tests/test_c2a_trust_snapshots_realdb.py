"""story 91404248(C2a) 게이트: org_member_trust_snapshots 실 PG 왕복 —
lazy write-through 적재·24h dedup·org-summary(admin-only·최신1건)·history(self-or-admin·추이)."""
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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _seed_org_and_members(session):
    """org + admin(caller) + regular member(target). 신뢰 계산용 participation/story/verdict 1건.

    team_members VIEW(members ⋈ project_access, [[feedback_team_members_view_human_drop]])
    해소를 위해 Member+ProjectAccess(member_id=target_om.id)도 함께 시드 — is_caller_member가
    TeamMember(뷰).id==member_id AND .user_id==caller로 axis-safe 비교하므로 필요."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.pm import Story
    from app.models.participation import Participation, ParticipationRole
    from app.models.verdict import Verdict
    from app.models.user import User
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    admin_user_id = uuid.uuid4()
    member_user_id = uuid.uuid4()
    session.add_all([
        User(id=admin_user_id, email=f"admin-{admin_user_id.hex[:8]}@test.com", hashed_password="x"),
        User(id=member_user_id, email=f"member-{member_user_id.hex[:8]}@test.com", hashed_password="x"),
    ])
    await session.commit()

    admin_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=admin_user_id, role="admin")
    target_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=member_user_id, role="member")
    session.add_all([admin_om, target_om])
    await session.commit()

    # target_om.id를 members.id로도 재사용 — Participation/snapshot의 member_id와
    # team_members 뷰 axis를 단일 id로 통일(테스트 seed 편의, 실 앱의 canonicalize 경로와 무관).
    session.add(Member(
        id=target_om.id, org_id=org.id, type="human", user_id=member_user_id, name="Target",
    ))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=target_om.id,
        member_id=target_om.id, permission="granted",
    ))
    await session.commit()

    role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="dev", label="개발", is_default=True)
    session.add(role)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="done")
    session.add(story)
    await session.commit()

    participation = Participation(
        id=uuid.uuid4(), org_id=org.id, story_id=story.id, member_id=target_om.id, role_id=role.id,
    )
    session.add(participation)
    await session.commit()

    verdict = Verdict(
        id=uuid.uuid4(), org_id=org.id, participation_id=participation.id,
        source="hypothesis_outcome_execution", result="pass", rounds=0,
    )
    session.add(verdict)
    await session.commit()

    return {
        "org_id": org.id, "admin_user_id": admin_user_id, "member_user_id": member_user_id,
        "target_member_id": target_om.id,
    }


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


@pytest.mark.anyio
async def test_get_trust_scores_writes_snapshot_and_dedups_within_24h_realdb():
    from app.main import app
    from app.models.trust_snapshot import OrgMemberTrustSnapshot
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_and_members(s)

        await _setup_app(app, Session, seeded["admin_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/trust-scores?member_id={seeded['target_member_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["scores"][0]["role_key"] == "dev"
            assert body["scores"][0]["hit_rate"] == 1.0

            # 두 번째 호출(24h 내) — dedup으로 신규 행 없어야 함.
            resp2 = await client.get(f"/api/v2/trust-scores?member_id={seeded['target_member_id']}")
            assert resp2.status_code == 200
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(OrgMemberTrustSnapshot).where(
                    OrgMemberTrustSnapshot.org_id == seeded["org_id"],
                    OrgMemberTrustSnapshot.member_id == seeded["target_member_id"],
                )
            )).scalars().all()
            assert len(rows) == 1, "dedup 실패 — 24h 내 중복 스냅샷 적재됨"
            assert rows[0].metrics["hit_rate"] == 1.0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_summary_admin_only_latest_per_member_role_realdb():
    from app.main import app
    from app.models.trust_snapshot import OrgMemberTrustSnapshot

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_and_members(s)
            older = OrgMemberTrustSnapshot(
                id=uuid.uuid4(), org_id=seeded["org_id"], member_id=seeded["target_member_id"],
                role_key="dev", window_days=90, metrics={"role_label": "개발", "hit_rate": 0.5, "resolved": 2},
                computed_at=datetime.now(timezone.utc) - timedelta(days=2),
            )
            newer = OrgMemberTrustSnapshot(
                id=uuid.uuid4(), org_id=seeded["org_id"], member_id=seeded["target_member_id"],
                role_key="dev", window_days=90, metrics={"role_label": "개발", "hit_rate": 0.9, "resolved": 9},
                computed_at=datetime.now(timezone.utc),
            )
            s.add_all([older, newer])
            await s.commit()

        # admin — 최신(0.9)만 반환.
        await _setup_app(app, Session, seeded["admin_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/trust-scores/org-summary")
            assert resp.status_code == 200, resp.text
            members = resp.json()["members"]
            assert len(members) == 1
            assert members[0]["hit_rate"] == 0.9
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 까심: 비-admin(target 본인)은 org-summary 403.
        await _setup_app(app, Session, seeded["member_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/trust-scores/org-summary")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_history_self_or_admin_ordered_desc_realdb():
    from app.main import app
    from app.models.trust_snapshot import OrgMemberTrustSnapshot

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_and_members(s)
            for i, hit_rate in enumerate([0.5, 0.7, 0.9]):
                s.add(OrgMemberTrustSnapshot(
                    id=uuid.uuid4(), org_id=seeded["org_id"], member_id=seeded["target_member_id"],
                    role_key="dev", window_days=90, metrics={"hit_rate": hit_rate},
                    computed_at=datetime.now(timezone.utc) - timedelta(days=3 - i),
                ))
            await s.commit()

        # self(target 본인) 조회 허용.
        await _setup_app(app, Session, seeded["member_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/trust-scores/history?member_id={seeded['target_member_id']}&role=dev"
            )
            assert resp.status_code == 200, resp.text
            snaps = resp.json()["snapshots"]
            assert [s["hit_rate"] for s in snaps] == [0.9, 0.7, 0.5], "computed_at DESC 정렬 실패"
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 까심: 제3자(admin 아닌 타인 — 여기선 admin이 아닌 새 유저)는 403.
        stranger_user_id = uuid.uuid4()
        from app.models.user import User
        async with Session() as s:
            s.add(User(id=stranger_user_id, email=f"stranger-{stranger_user_id.hex[:8]}@test.com", hashed_password="x"))
            from app.models.project import OrgMember
            s.add(OrgMember(id=uuid.uuid4(), org_id=seeded["org_id"], user_id=stranger_user_id, role="member"))
            await s.commit()

        await _setup_app(app, Session, stranger_user_id, seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/trust-scores/history?member_id={seeded['target_member_id']}&role=dev"
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
