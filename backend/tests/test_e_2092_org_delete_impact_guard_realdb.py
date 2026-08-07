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
async def test_delete_with_override_survives_real_postgres_transaction_abort_realdb():
    """카디르 결함사냥 HIGH①(#2898 재QA, 2026-08-07) 재현+fix 검증 — 순수 Python
    RuntimeError mock이 아니라 **진짜 Postgres 에러**(존재하지 않는 테이블 참조 →
    UndefinedTable, asyncpg가 그 커넥션의 트랜잭션을 실제로 "aborted" 상태로 만든다)로
    get_impact()를 실패시킨다. fix(savepoint) 前엔 override로 진행해도 그 아래
    audit-insert·org-delete가 오염된 트랜잭션 위에서 실행돼 깨끗한 성공도 실패도 아닌
    상태가 됐다 — fix 後엔 SAVEPOINT가 그 실패를 격리해 override 진행이 실제로 끝까지
    깨끗하게 성공(org 삭제+audit 기입)해야 한다."""
    from sqlalchemy.exc import DBAPIError

    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            repo = OrganizationRepository(session)

            async def _broken_get_impact(org_id):
                # 진짜 Postgres 에러 — 존재하지 않는 테이블 참조. asyncpg가 이 커넥션의
                # 현재 트랜잭션을 실제로 aborted 상태로 만든다(mock RuntimeError로는
                # 재현 불가능한 축).
                await session.execute(text("SELECT * FROM this_table_does_not_exist_2092"))

            with patch.object(repo, "get_impact", side_effect=_broken_get_impact):
                try:
                    result = await repo.delete_by_user(
                        org_id=org_id, user_id=user_id, confirmation=org_name, confirm_without_impact=True,
                    )
                except DBAPIError:
                    pytest.fail(
                        "savepoint 격리 실패 — get_impact()의 진짜 Postgres 에러가 바깥 "
                        "트랜잭션까지 오염시켜 audit-insert/delete가 aborted 트랜잭션 위에서 "
                        "실행되며 예외로 전파됨(fix 前 재현 정확히 이 형태)"
                    )
                await session.commit()

            assert result == {"ok": True}

            verify_engine = create_async_engine(_ASYNC)
            try:
                async with async_sessionmaker(verify_engine, expire_on_commit=False)() as verify_session:
                    org_row = (
                        await verify_session.execute(
                            text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id}
                        )
                    ).first()
                    assert org_row is None  # 진짜로, 완전히 삭제됨(부분실패 아님)

                    audit_row = (
                        await verify_session.execute(
                            text("SELECT note FROM deletion_audit_logs WHERE entity_id=:oid"), {"oid": org_id}
                        )
                    ).first()
                    assert audit_row is not None
                    assert audit_row.note is not None and "확認 없이" in audit_row.note
            finally:
                await verify_engine.dispose()
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


# ─── 카디르 결함사냥 HIGH②(#2898 재QA, 2026-08-07) — checkout_claimed_at 인지 ────

async def _insert_pending_subscription_with_claim(session, *, org_id, claimed_at):
    await session.execute(
        text(
            "INSERT INTO org_subscriptions (id, org_id, tier, status, provider, currency, checkout_claimed_at) "
            "VALUES (:id, :org_id, 'starter', 'pending', 'toss', 'krw', :claimed_at)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "claimed_at": claimed_at},
    )
    await session.commit()


@pytest.mark.anyio
async def test_delete_rejected_when_checkout_in_flight_realdb():
    """진행 中(staleness 안 넘긴) checkout claim이 있으면(구독 status는 아직 'pending' —
    'active' 아님) org 삭제를 거부한다 — #2896의 checkout_claimed_at 진행 中 claim을
    「활성 구독」과 동형으로 취급(reason=active_subscription 재사용). fix 前엔 이 창에서
    org가 삭제되고, 뒤늦게 그 checkout의 charge가 confirmed돼도 org가 이미 사라진 뒤라
    삭제된 org에 실 청구가 완료될 수 있었다."""
    from datetime import datetime, timezone

    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            await _insert_pending_subscription_with_claim(
                session, org_id=org_id, claimed_at=datetime.now(timezone.utc)
            )
            repo = OrganizationRepository(session)

            result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": False, "reason": "active_subscription"}

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is not None  # 거부됐으므로 org는 살아있어야 한다
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_proceeds_when_checkout_claim_is_stale_realdb():
    """staleness를 넘긴(=죽은/멈춘) checkout claim은 「진행 中」으로 안 쳐준다 —
    자기치유 회귀 없음(영원히 삭제 불가능한 org가 생기면 안 됨)."""
    from datetime import datetime, timedelta, timezone

    from app.repositories.organization import OrganizationRepository
    from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            stale_claim_at = datetime.now(timezone.utc) - STALE_CLAIM_WINDOW - timedelta(minutes=1)
            await _insert_pending_subscription_with_claim(session, org_id=org_id, claimed_at=stale_claim_at)
            repo = OrganizationRepository(session)

            result = await repo.delete_by_user(org_id=org_id, user_id=user_id, confirmation=org_name)
            await session.commit()

            assert result == {"ok": True}  # 죽은 claim은 회복 증거로 안 쳐줌 — 정상 삭제

            org_row = (
                await session.execute(text("SELECT id FROM organizations WHERE id=:oid"), {"oid": org_id})
            ).first()
            assert org_row is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_get_impact_reflects_in_flight_checkout_claim_realdb():
    """get_impact()의 has_active_subscription 필드(FE 표시용)도 진행 中 checkout claim을
    반영해야 한다 — 삭제 거부 판정과 사용자에게 보여주는 정보가 어긋나면 안 된다."""
    from datetime import datetime, timezone

    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, user_id, org_name = await _seed_org_with_owner(session)
            await _insert_pending_subscription_with_claim(
                session, org_id=org_id, claimed_at=datetime.now(timezone.utc)
            )
            repo = OrganizationRepository(session)

            impact = await repo.get_impact(org_id=org_id)
            assert impact.has_active_subscription is True
    finally:
        await engine.dispose()
