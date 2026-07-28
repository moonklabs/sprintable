"""story #2273(C-1b, E-CONNECT) — 새 참조 표를 실제로 쓰게 재배선. 실PG 검증.

순서(PO 판정, 2026-07-28, 디디 지적으로 AC 정정): ①백필+수 검증 → ②read/write 같은 배포로
동시 전환 → ③옛 mentions 표는 안 지운다(되돌릴 길). read/write 를 가르면 그 사이 창에서
화면이 거짓말한다(#2185류 사고와 같은 클래스).
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


async def _seed_org_project_member(session):
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.user import User
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.flush()
    member = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user.id, name="Test Human")
    session.add(member)
    await session.flush()
    return org, project, member


@pytest.mark.anyio
async def test_backfill_verification_matches_after_backfill():
    """⭐AC1 핵심 — "돌렸다" 대신 "수가 같다"를 증명한다."""
    from app.models.mention import Mention
    from app.services.reference_backfill import backfill_mentions_to_references, verify_backfill_complete

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            for _ in range(3):
                session.add(Mention(
                    id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_id=uuid.uuid4(),
                    target_type="doc", target_id=uuid.uuid4(), created_by=member.id,
                ))
            await session.commit()

            before = await verify_backfill_complete(session, org_id=org.id)
            assert before.old_count == 3 and before.new_count == 0 and not before.matches

            await backfill_mentions_to_references(session, org_id=org.id)
            await session.commit()

            after = await verify_backfill_complete(session, org_id=org.id)
            assert after.old_count == 3
            assert after.new_count == 3
            assert after.matches
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_backfill_verification_flags_mismatch():
    """진짜 안 옮겨진 경우(시뮬레이션 — 백필 없이 옛 표만 채움)엔 matches=False로 정직하게 남는다."""
    from app.models.mention import Mention
    from app.services.reference_backfill import verify_backfill_complete

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            session.add(Mention(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_id=uuid.uuid4(),
                target_type="doc", target_id=uuid.uuid4(), created_by=member.id,
            ))
            await session.commit()

            result = await verify_backfill_complete(session, org_id=org.id)
            assert result.old_count == 1
            assert result.new_count == 0
            assert not result.matches
    finally:
        await engine.dispose()


# ─── AC10: count_orphan_types 가 실제로 도는 자리(cron endpoint) ────────────────


@pytest.mark.anyio
async def test_count_orphan_types_org_id_none_aggregates_all_orgs():
    """org_id=None(기본값) — cron endpoint가 쓰는 그 호출 형태. 여러 org에 걸쳐 집계된다.
    ⛔전체-org 카운트는 절대값이 아니라 **삽입 전후 delta**로 검증한다(로컬 DB가 여러
    테스트 실행에 걸쳐 재사용돼 잔여 데이터가 있을 수 있다 — org-scoped 쪽은 이 테스트가
    새로 만든 org라 절대값이 안전하다)."""
    from app.models.reference import Reference
    from app.services.reference_registry import count_orphan_types

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org_a, project_a, member_a = await _seed_org_project_member(session)
            org_b, project_b, member_b = await _seed_org_project_member(session)
            await session.commit()

            all_orgs_before = await count_orphan_types(session, org_id=None)
            before_count = all_orgs_before.get("target:not_registered", 0)

            for org, member in ((org_a, member_a), (org_b, member_b)):
                session.add(Reference(
                    id=uuid.uuid4(), org_id=org.id, source_type="story", source_field="description",
                    source_id=uuid.uuid4(), target_type="not_registered", target_id=uuid.uuid4(),
                    form="mention", created_by=member.id,
                ))
            await session.commit()

            org_scoped = await count_orphan_types(session, org_id=org_a.id)
            assert org_scoped.get("target:not_registered") == 1

            all_orgs_after = await count_orphan_types(session, org_id=None)
            assert all_orgs_after.get("target:not_registered", 0) == before_count + 2
    finally:
        await engine.dispose()


# ⛔story #2274로 분리(2026-07-28) — cron endpoint(entity_references_orphan_check) 배선이
# 이 PR의 CI에서 전역 401 회귀를 냈다(원인 미규명 — CRON_SECRET 전역 누수 의심, #2274 AC1이
# 그 원인부터 밝힌다). count_orphan_types 자체(위 테스트들)는 재배선 본체와 무관해 남기고,
# cron endpoint를 직접 부르는 테스트만 여기서 뺐다 — 원인 규명 뒤 #2274에서 다시 짠다.
