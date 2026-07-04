"""E-LOOP-LEDGER S4(story e7b0e5cc): POST/GET /api/v2/loops/{loop_id}/artifacts 검증.

S4 고유 가치(비-tautological):
ⓐ 2단계 IDOR — ①loop project 접근(resolve_member root-fix #1815 재사용, agent 축까지)
   ②⭐신규 크로스-리소스 축: asset이 loop과 다른 project(또는 org-level NULL) 소유면 403.
ⓑ decision 서버 고정 — LoopArtifactCreate 스키마에 그 필드가 아예 없음을 구조적으로 증명.
ⓒ AssetLink SSOT 와이어링 — 생성 시 asset_links(source_type='loop_artifact') 행이 실제로 생김.
ⓓ GET variant_group 그룹핑 — 실 다중 그룹/다중 아이템으로 그룹핑 shape 실증.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import loops as r
from app.schemas.loop import LoopArtifactCreate
from app.services.loop import LoopServiceError

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ⓑ 오류 매핑 + decision 서버고정 구조 검증(유닛, DB 불요) ────────────────────

def test_error_status_map_covers_asset_codes():
    expected = {"ASSET_NOT_FOUND", "ASSET_PROJECT_MISMATCH"}
    assert expected <= set(r._ERROR_STATUS)


@pytest.mark.parametrize("code,status", [
    ("ASSET_NOT_FOUND", 404),
    ("ASSET_PROJECT_MISMATCH", 403),
])
def test_raise_maps_asset_code_to_status(code, status):
    with pytest.raises(HTTPException) as ei:
        r._raise(LoopServiceError(code, "msg"))
    assert ei.value.status_code == status


def test_loop_artifact_create_schema_has_no_decision_field():
    # client가 생성 시 decision='chosen' 등을 실어보낼 방법이 스키마 레벨부터 없다.
    assert "decision" not in LoopArtifactCreate.model_fields


# ── realdb ───────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("1e000000-0000-0000-0000-000000000001")
USER = uuid.UUID("1e000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("1e000000-0000-0000-0000-0000000000b1")
AGENT = uuid.UUID("1e000000-0000-0000-0000-0000000000d1")  # PROJ_A에만 grant
PROJ_A = uuid.UUID("1e000000-0000-0000-0000-000000000002")
PROJ_B = uuid.UUID("1e000000-0000-0000-0000-000000000003")


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _agent_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT), email=None,
        claims={"app_metadata": {"api_key_id": "ak_test", "org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _seed(s):
    """ORG·USER(PROJ_A grant)·AGENT(PROJ_A grant)·PROJ_A/PROJ_B 시드."""
    for sql in [
        f"DELETE FROM asset_links WHERE org_id='{ORG}'",
        f"DELETE FROM loop_artifacts WHERE org_id='{ORG}'",
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C1E','c1eorg','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c1e.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}',NULL,'{AGENT}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_loop(s, project_id) -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=project_id, title="L", goal_tags=[], status="draft",
        created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _seed_asset(s, project_id) -> uuid.UUID:
    from app.models.asset import Asset
    a = Asset(
        id=uuid.uuid4(), org_id=ORG, project_id=project_id, container="uploads",
        object_path=f"org/{ORG}/asset-{uuid.uuid4().hex[:8]}.png", name="a.png",
        content_type="image/png", size_bytes=100,
    )
    s.add(a)
    await s.commit()
    return a.id


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── ⓐ① loop project 접근(resolve_member root-fix, agent 축) ───────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_agent_cross_project_loop_forbidden_403():
    """agent는 PROJ_A만 grant. loop이 PROJ_B 소속이면 resolve_member(project_id=PROJ_B)가
    403(까심 재현 시나리오와 동형 — root-fix #1815가 여기서도 막는지 loops artifact 표면서 실증)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_B)
            asset_id = await _seed_asset(s, PROJ_B)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop_artifact(
                    loop_id=loop_id,
                    body=LoopArtifactCreate(variant_group="g", variant_label="A", asset_id=asset_id),
                    session=s, auth=_agent_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_loop_not_found_404():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            asset_id = await _seed_asset(s, PROJ_A)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop_artifact(
                    loop_id=uuid.uuid4(),
                    body=LoopArtifactCreate(variant_group="g", variant_label="A", asset_id=asset_id),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 404
            assert ei.value.detail["code"] == "LOOP_NOT_FOUND"
    finally:
        await eng.dispose()


# ── ⓐ② 크로스-리소스: asset이 loop과 다른 project 소유 ──────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_asset_cross_project_forbidden_403():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            asset_id = await _seed_asset(s, PROJ_B)  # loop=A, asset=B — 불일치

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop_artifact(
                    loop_id=loop_id,
                    body=LoopArtifactCreate(variant_group="g", variant_label="A", asset_id=asset_id),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "ASSET_PROJECT_MISMATCH"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_org_level_asset_forbidden_for_project_loop():
    """asset.project_id=NULL(org-level)도 project-scoped loop엔 엄격 불허(설계 명시)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            asset_id = await _seed_asset(s, None)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop_artifact(
                    loop_id=loop_id,
                    body=LoopArtifactCreate(variant_group="g", variant_label="A", asset_id=asset_id),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "ASSET_PROJECT_MISMATCH"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_asset_not_found_404():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop_artifact(
                    loop_id=loop_id,
                    body=LoopArtifactCreate(variant_group="g", variant_label="A", asset_id=uuid.uuid4()),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 404
            assert ei.value.detail["code"] == "ASSET_NOT_FOUND"
    finally:
        await eng.dispose()


# ── ⓑⓒ 성공 경로: decision='pending' 고정 + AssetLink SSOT 생성 ─────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_success_pending_decision_and_asset_link_wired():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            asset_id = await _seed_asset(s, PROJ_A)

        async with Session() as s:
            out = await r.create_loop_artifact(
                loop_id=loop_id,
                body=LoopArtifactCreate(
                    variant_group="headline", variant_label="A",
                    asset_id=asset_id, generation_metadata={"model": "x"},
                ),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()
            assert out.decision == "pending"
            assert out.variant_group == "headline"
            assert out.created_by_member_id == OM
            artifact_id = out.id

        async with Session() as s:
            from app.models.asset import AssetLink
            link = (await s.execute(
                select(AssetLink).where(
                    AssetLink.asset_id == asset_id,
                    AssetLink.source_type == "loop_artifact",
                    AssetLink.source_id == artifact_id,
                )
            )).scalar_one_or_none()
            assert link is not None
    finally:
        await eng.dispose()


# ── ⓓ GET variant_group 그룹핑 ──────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_list_loop_artifacts_groups_by_variant_group():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            asset1 = await _seed_asset(s, PROJ_A)
            asset2 = await _seed_asset(s, PROJ_A)
            asset3 = await _seed_asset(s, PROJ_A)

        async with Session() as s:
            for variant_group, variant_label, asset_id in [
                ("headline", "B", asset2), ("headline", "A", asset1), ("cta", "A", asset3),
            ]:
                await r.create_loop_artifact(
                    loop_id=loop_id,
                    body=LoopArtifactCreate(variant_group=variant_group, variant_label=variant_label, asset_id=asset_id),
                    session=s, auth=_auth(), org_id=ORG,
                )
            await s.commit()

        async with Session() as s:
            groups = await r.list_loop_artifacts(loop_id=loop_id, session=s, auth=_auth(), org_id=ORG)
            assert [g.variant_group for g in groups] == ["cta", "headline"]
            cta_group = next(g for g in groups if g.variant_group == "cta")
            headline_group = next(g for g in groups if g.variant_group == "headline")
            assert len(cta_group.artifacts) == 1
            assert len(headline_group.artifacts) == 2
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_list_loop_artifacts_cross_project_forbidden_403():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_B)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.list_loop_artifacts(loop_id=loop_id, session=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()
