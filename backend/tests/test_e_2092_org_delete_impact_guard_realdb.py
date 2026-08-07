"""#2092(P0 보안) real-DB — OrganizationRepository.delete_by_user()의 impact 재조회 가드를
실 organizations/deletion_audit_logs 위에서 검증. "파괴 조작이라 실측까지"(PO 지시,
2026-08-07) — 진짜 Postgres에 대고 ①거부 시 org가 실제로 살아남는지 ②override 시 실제로
삭제되고 감사로그에 note가 남는지 ③정상(impact 성공) 시 종전과 동일하게 동작하는지 확認.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_org_with_owner(session):
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    org_name = f"test-org-{org_id}"
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": org_name, "slug": f"slug-{org_id}"},
    )
    await session.execute(
        text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :user_id, 'owner')"),
        {"id": uuid.uuid4(), "org_id": org_id, "user_id": user_id},
    )
    await session.commit()
    return org_id, user_id, org_name


@pytest.mark.anyio
async def test_delete_rejected_realdb_org_survives_when_impact_query_fails_and_no_override():
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            with patch.object(repo, "get_impact", side_effect=RuntimeError("simulated impact query failure")):
                result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": False, "reason": "impact_unavailable"}

            row = (
                await session.execute(
                    text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id}
                )
            ).first()
            assert row is not None  # 거부됐으므로 org는 실제로 살아있어야 한다(파괴 안 됨)

            audit_count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM deletion_audit_logs WHERE entity_id=:oid"), {"oid": org_id}
                )
            ).scalar_one()
            assert audit_count == 0  # 거부됐으므로 감사로그도 안 남는다(진행 자체가 안 됐음)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_proceeds_realdb_org_removed_and_audit_note_recorded_with_override():
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            with patch.object(repo, "get_impact", side_effect=RuntimeError("simulated impact query failure")):
                result = await repo.delete_by_user(
                    org_id=org_id, user_id=user_id, confirmation=org_name, confirm_without_impact=True,
                )
            await session.commit()

            assert result == {"ok": True}

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is None  # override로 진행됐으므로 실제로 삭제됨

            audit_row = (
                await session.execute(
                    text("SELECT actor_id, entity_type, note FROM deletion_audit_logs WHERE entity_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert audit_row is not None
            assert audit_row.actor_id == user_id
            assert audit_row.entity_type == "organization"
            assert audit_row.note is not None and "확認 없이" in audit_row.note
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_proceeds_realdb_normal_path_no_audit_note_when_impact_succeeds():
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": True}

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is None

            audit_row = (
                await session.execute(
                    text("SELECT note FROM deletion_audit_logs WHERE entity_id=:oid"), {"oid": org_id}
                )
            ).first()
            assert audit_row is not None
            assert audit_row.note is None  # 정상 경로 — override 사유 없음
    finally:
        await engine.dispose()
