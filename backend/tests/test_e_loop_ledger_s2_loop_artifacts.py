"""E-LOOP-LEDGER S2(story 9731403a): loop_artifacts(variant) 테이블 검증.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip. 특히 까심 QA 사전 요구사항 — partial UNIQUE
(chosen 슬롯당 1개) + CHECK + chosen_artifact_id FK 순환 정합을 비-tautological(실제
위반이 거부되는지 직접 재현)로 검증한다."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_org_project(session) -> tuple[uuid.UUID, uuid.UUID]:
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    await session.execute(
        text(
            "INSERT INTO organizations (id, name, slug) VALUES (:org_id, 'S2 Org', :slug) "
            "ON CONFLICT (id) DO NOTHING"
        ),
        {"org_id": org_id, "slug": f"s2-org-{org_id}"},
    )
    await session.execute(
        text("INSERT INTO projects (id, org_id, name) VALUES (:pid, :org_id, 'S2 Project')"),
        {"pid": project_id, "org_id": org_id},
    )
    await session.commit()
    return org_id, project_id


async def _seed_loop(session, org_id, project_id) -> uuid.UUID:
    from app.models.loop import LoopRun

    loop_id = uuid.uuid4()
    session.add(LoopRun(
        id=loop_id, org_id=org_id, project_id=project_id,
        title="loop for artifacts", created_by_member_id=uuid.uuid4(),
    ))
    await session.commit()
    return loop_id


async def _seed_asset(session, org_id, project_id) -> uuid.UUID:
    asset_id = uuid.uuid4()
    await session.execute(
        text(
            "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, "
            "size_bytes, created_by) VALUES (:id, :org_id, :project_id, 'sprintable-memo-attachments', "
            ":path, :name, 'image/png', 100, :created_by)"
        ),
        {"id": asset_id, "org_id": org_id, "project_id": project_id, "path": f"loop/{asset_id}.png",
         "name": f"variant-{asset_id}.png", "created_by": uuid.uuid4()},
    )
    await session.commit()
    return asset_id


@pytest.mark.anyio
async def test_create_artifact_defaults():
    from app.models.loop import LoopArtifact

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            loop_id = await _seed_loop(session, org_id, project_id)
            asset_id = await _seed_asset(session, org_id, project_id)

            artifact_id = uuid.uuid4()
            session.add(LoopArtifact(
                id=artifact_id, org_id=org_id, loop_id=loop_id, asset_id=asset_id,
                variant_group="headline", variant_label="A", created_by_member_id=uuid.uuid4(),
            ))
            await session.commit()

            fetched = (
                await session.execute(select(LoopArtifact).where(LoopArtifact.id == artifact_id))
            ).scalar_one()
            assert fetched.decision == "pending"
            assert fetched.generation_metadata == {}
            assert fetched.sort_order == 0
            assert fetched.choose_reason is None
            assert fetched.rejection_reason is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_decision_check_constraint_rejects_invalid_value():
    from app.models.loop import LoopArtifact

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            loop_id = await _seed_loop(session, org_id, project_id)
            asset_id = await _seed_asset(session, org_id, project_id)

            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_id,
                variant_group="headline", variant_label="A", decision="maybe",
                created_by_member_id=uuid.uuid4(),
            ))
            with pytest.raises(IntegrityError):
                await session.flush()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_second_chosen_in_same_variant_group_rejected():
    """까심 QA 사전 요구 — partial UNIQUE(loop_id, variant_group) WHERE chosen을 실제
    두 번째 chosen INSERT로 재현(happy-path 1건만으로는 tautological)."""
    from app.models.loop import LoopArtifact

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            loop_id = await _seed_loop(session, org_id, project_id)
            asset_a = await _seed_asset(session, org_id, project_id)
            asset_b = await _seed_asset(session, org_id, project_id)

            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_a,
                variant_group="headline", variant_label="A", decision="chosen",
                created_by_member_id=uuid.uuid4(),
            ))
            await session.commit()

            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_b,
                variant_group="headline", variant_label="B", decision="chosen",
                created_by_member_id=uuid.uuid4(),
            ))
            with pytest.raises(IntegrityError):
                await session.flush()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_chosen_in_different_variant_groups_allowed():
    """다중 슬롯(헤드라인셋+이미지셋 각 승자) — 서로 다른 variant_group이면 각각 chosen 가능."""
    from app.models.loop import LoopArtifact

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            loop_id = await _seed_loop(session, org_id, project_id)
            asset_a = await _seed_asset(session, org_id, project_id)
            asset_b = await _seed_asset(session, org_id, project_id)

            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_a,
                variant_group="headline", variant_label="A", decision="chosen",
                created_by_member_id=uuid.uuid4(),
            ))
            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_b,
                variant_group="image", variant_label="A", decision="chosen",
                created_by_member_id=uuid.uuid4(),
            ))
            await session.commit()  # 서로 다른 슬롯 — 위반 없어야
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_rejected_does_not_conflict_with_chosen_in_same_group():
    """partial index가 decision='chosen'에만 걸리므로 rejected 다건은 무제한이어야."""
    from app.models.loop import LoopArtifact

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            loop_id = await _seed_loop(session, org_id, project_id)
            asset_chosen = await _seed_asset(session, org_id, project_id)
            asset_r1 = await _seed_asset(session, org_id, project_id)
            asset_r2 = await _seed_asset(session, org_id, project_id)

            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_chosen,
                variant_group="headline", variant_label="A", decision="chosen",
                created_by_member_id=uuid.uuid4(),
            ))
            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_r1,
                variant_group="headline", variant_label="B", decision="rejected",
                rejection_reason="too generic", created_by_member_id=uuid.uuid4(),
            ))
            session.add(LoopArtifact(
                id=uuid.uuid4(), org_id=org_id, loop_id=loop_id, asset_id=asset_r2,
                variant_group="headline", variant_label="C", decision="rejected",
                rejection_reason="off-brand tone", created_by_member_id=uuid.uuid4(),
            ))
            await session.commit()  # 위반 없어야
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_loop_run_chosen_artifact_id_fk_now_enforced():
    """S1의 지연 FK(chosen_artifact_id)가 S2 마이그로 잠겼는지 — 존재 안 하는 artifact id
    참조는 FK 위반이어야(S1 시점엔 컬럼만 있어 이 위반이 안 걸렸을 것)."""
    from app.models.loop import LoopRun

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            session.add(LoopRun(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id,
                title="bad chosen_artifact_id", created_by_member_id=uuid.uuid4(),
                chosen_artifact_id=uuid.uuid4(),  # 존재하지 않는 artifact
            ))
            with pytest.raises(IntegrityError):
                await session.flush()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_loop_run_chosen_artifact_id_set_null_on_artifact_delete():
    from app.models.loop import LoopArtifact, LoopRun

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            loop_id = await _seed_loop(session, org_id, project_id)
            asset_id = await _seed_asset(session, org_id, project_id)
            artifact_id = uuid.uuid4()
            session.add(LoopArtifact(
                id=artifact_id, org_id=org_id, loop_id=loop_id, asset_id=asset_id,
                variant_group="headline", variant_label="A", decision="chosen",
                created_by_member_id=uuid.uuid4(),
            ))
            await session.commit()

            await session.execute(
                text("UPDATE loop_runs SET chosen_artifact_id = :aid WHERE id = :lid"),
                {"aid": artifact_id, "lid": loop_id},
            )
            await session.commit()

            await session.execute(text("DELETE FROM loop_artifacts WHERE id = :id"), {"id": artifact_id})
            await session.commit()

            run = (await session.execute(select(LoopRun).where(LoopRun.id == loop_id))).scalar_one()
            assert run.chosen_artifact_id is None  # SET NULL, 부모 loop_run 생존
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_link_source_type_accepts_loop_artifact():
    """asset_links CHECK가 실제로 넓어졌는지 — 'loop_artifact' INSERT가 성공해야."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            asset_id = await _seed_asset(session, org_id, project_id)
            await session.execute(
                text(
                    "INSERT INTO asset_links (id, org_id, asset_id, source_type, source_id) "
                    "VALUES (:id, :org_id, :asset_id, 'loop_artifact', :source_id)"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "asset_id": asset_id, "source_id": uuid.uuid4()},
            )
            await session.commit()  # 위반 없어야
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_link_source_type_still_rejects_unknown_value():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, project_id = await _seed_org_project(session)
            asset_id = await _seed_asset(session, org_id, project_id)
            with pytest.raises(IntegrityError):
                await session.execute(
                    text(
                        "INSERT INTO asset_links (id, org_id, asset_id, source_type, source_id) "
                        "VALUES (:id, :org_id, :asset_id, 'not_a_real_source', :source_id)"
                    ),
                    {"id": uuid.uuid4(), "org_id": org_id, "asset_id": asset_id, "source_id": uuid.uuid4()},
                )
                await session.commit()
    finally:
        await engine.dispose()
