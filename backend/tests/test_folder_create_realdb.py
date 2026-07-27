"""story #1939 — POST /api/v2/folders 실PG 통합 테스트(0139 asset registry DB 전제).

DB env(ALEMBIC_DATABASE_URL) 없으면 skip. 커버: 정상 생성(project-scoped/org-level)·project
접근권 IDOR(403)·parent_id cross-project/cross-org 스코프(404)·중복 이름 충돌(409)·이름 정규화
delegate(422)·동시 생성 레이스(0198 NULLS NOT DISTINCT — case (b) project_id SET+parent_id
NULL 시나리오, 실 동시 INSERT 2건이 정확히 201/409 하나씩으로 갈리는지 mock 없이 실측).
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("a3000000-0000-0000-0000-000000000001")
USER = uuid.UUID("a3000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("a3000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("a3000000-0000-0000-0000-0000000000c1")
PROJ_B = uuid.UUID("a3000000-0000-0000-0000-0000000000c2")
ORG2 = uuid.UUID("a3000000-0000-0000-0000-000000000002")
PROJ_OTHER = uuid.UUID("a3000000-0000-0000-0000-0000000000d1")  # ORG2 소속


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _reset_and_seed(session):
    for sql in [
        f"DELETE FROM asset_folders WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{ORG2}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A3','a3org','free')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG2}','A3b','a3borg','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{USER}','u@a3.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_OTHER}','{ORG2}','OtherP')",
        # USER 는 PROJ_A 에만 grant(PROJ_B 접근 없음 — IDOR 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await session.execute(text(sql))
    await session.commit()


def _auth():
    from unittest.mock import MagicMock

    auth = MagicMock()
    auth.user_id = str(USER)
    auth.claims = {"app_metadata": {"org_id": str(ORG)}}
    return auth


@pytest.mark.anyio
async def test_create_folder_project_scoped():
    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            resp = await create_folder(
                FolderCreate(name=" My Docs ", project_id=PROJ_A, parent_id=None),
                db=s, auth=_auth(), org_id=ORG,
            )
            assert resp.name == "My Docs"  # trim 정규화
            assert resp.project_id == PROJ_A
            assert resp.parent_id is None

            row = (await s.execute(text(
                f"SELECT org_id, project_id, name, created_by FROM asset_folders WHERE id='{resp.id}'"
            ))).one()
            assert row.org_id == ORG and row.project_id == PROJ_A and row.name == "My Docs"
            assert row.created_by == OM  # attribution=인증 caller(canonical org_member.id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_org_level_no_project():
    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            resp = await create_folder(
                FolderCreate(name="Org Wide", project_id=None, parent_id=None),
                db=s, auth=_auth(), org_id=ORG,
            )
            assert resp.project_id is None
            n = (await s.execute(text(
                f"SELECT count(*) FROM asset_folders WHERE id='{resp.id}' AND project_id IS NULL"
            ))).scalar_one()
            assert n == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_no_project_access_403():
    from fastapi import HTTPException

    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            with pytest.raises(HTTPException) as ei:
                await create_folder(
                    FolderCreate(name="Nope", project_id=PROJ_B, parent_id=None),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
            n = (await s.execute(text(
                f"SELECT count(*) FROM asset_folders WHERE org_id='{ORG}' AND project_id='{PROJ_B}'"
            ))).scalar_one()
            assert n == 0  # 403이면 row가 생성되지 않아야
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_nested_parent_same_project():
    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            parent = await create_folder(
                FolderCreate(name="Parent", project_id=PROJ_A, parent_id=None),
                db=s, auth=_auth(), org_id=ORG,
            )
            child = await create_folder(
                FolderCreate(name="Child", project_id=PROJ_A, parent_id=parent.id),
                db=s, auth=_auth(), org_id=ORG,
            )
            assert child.parent_id == parent.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_parent_cross_project_404():
    """same-org 이지만 접근 불가 project(PROJ_B)에 있는 폴더를 parent로 지정 → 404
    (cross-project 폴더트리 오염 차단·존재 비노출)."""
    from fastapi import HTTPException

    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            # PROJ_B 폴더를 직접 INSERT(USER 는 PROJ_B 접근권 없음 → API 경유로는 못 만듦).
            other_parent = uuid.uuid4()
            await s.execute(text(
                "INSERT INTO asset_folders (id,org_id,project_id,name) VALUES "
                f"('{other_parent}','{ORG}','{PROJ_B}','B-Folder')"
            ))
            await s.commit()

            with pytest.raises(HTTPException) as ei:
                await create_folder(
                    FolderCreate(name="Child", project_id=PROJ_A, parent_id=other_parent),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_parent_cross_org_404():
    """타 org 폴더를 parent로 지정 → 404(존재 비노출)."""
    from fastapi import HTTPException

    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            foreign_parent = uuid.uuid4()
            await s.execute(text(
                "INSERT INTO asset_folders (id,org_id,project_id,name) VALUES "
                f"('{foreign_parent}','{ORG2}','{PROJ_OTHER}','Foreign')"
            ))
            await s.commit()

            with pytest.raises(HTTPException) as ei:
                await create_folder(
                    FolderCreate(name="Child", project_id=PROJ_A, parent_id=foreign_parent),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_duplicate_name_conflict_409():
    from fastapi import HTTPException

    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            await create_folder(
                FolderCreate(name="Dup", project_id=PROJ_A, parent_id=None),
                db=s, auth=_auth(), org_id=ORG,
            )
            with pytest.raises(HTTPException) as ei:
                await create_folder(
                    FolderCreate(name="Dup", project_id=PROJ_A, parent_id=None),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 409
            n = (await s.execute(text(
                f"SELECT count(*) FROM asset_folders WHERE org_id='{ORG}' AND project_id='{PROJ_A}' "
                "AND parent_id IS NULL AND name='Dup'"
            ))).scalar_one()
            assert n == 1  # 409 후에도 row는 1건만(rollback 정상)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_blank_name_422():
    from fastapi import HTTPException

    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            with pytest.raises(HTTPException) as ei:
                await create_folder(
                    FolderCreate(name="   ", project_id=PROJ_A, parent_id=None),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_roundtrip_visible_in_list_folders():
    """PR 셀프게이트 #12(write_ok≠read_success): POST 로 생성한 폴더가 GET list_folders 에도
    보이는지 왕복 확인(쓰기 성공만으론 부족·조회 경로까지 실검증)."""
    from app.routers.assets import FolderCreate, create_folder, list_folders

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            created = await create_folder(
                FolderCreate(name="Roundtrip", project_id=PROJ_A, parent_id=None),
                db=s, auth=_auth(), org_id=ORG,
            )
            listed = await list_folders(project_id=PROJ_A, db=s, auth=_auth(), org_id=ORG)
            ids = {f.id for f in listed}
            assert created.id in ids  # write_ok 만이 아니라 read_success 까지 확인
            match = next(f for f in listed if f.id == created.id)
            assert match.name == "Roundtrip"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_folder_concurrent_race_project_scoped_one_wins() -> None:
    """까심 QA 재작업 검증(0198 UNIQUE NULLS NOT DISTINCT): case (b) — project_id SET+parent_id
    NULL — 은 이전 구현의 DB 제약이 NULL-distinct 함정으로 발동 안 하던 조합이라, app-level
    사전조회만으로는 동시 요청 2건이 둘 다 사전조회를 통과하면 중복 폴더가 조용히 2건 생겼다
    (TOCTOU). 이 테스트는 **mock 없이 실 PG 커넥션 2개**로 진짜 동시 INSERT를 발사해, DB UNIQUE
    NULLS NOT DISTINCT가 실제로 하나만 커밋을 허용하는지(201 정확히 1건 + 409 정확히 1건) 실측
    검증한다. 두 세션이 각자 독립 커넥션이라 사전조회~flush 사이에서 진짜 인터리빙이 발생한다.
    """
    from fastapi import HTTPException

    from app.routers.assets import FolderCreate, create_folder

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        # 시드는 별도 세션에서 커밋 확정(두 레이스 세션이 동일 seed 를 보게).
        async with Session() as seed_s:
            await _reset_and_seed(seed_s)

        # 독립 커넥션 2개(진짜 별도 PG 세션) — 동일 커넥션 재사용시 자동 직렬화되어 레이스가 안 생김.
        async with Session() as s1, Session() as s2:
            results = await asyncio.gather(
                create_folder(
                    FolderCreate(name="RaceFolder", project_id=PROJ_A, parent_id=None),
                    db=s1, auth=_auth(), org_id=ORG,
                ),
                create_folder(
                    FolderCreate(name="RaceFolder", project_id=PROJ_A, parent_id=None),
                    db=s2, auth=_auth(), org_id=ORG,
                ),
                return_exceptions=True,
            )

        successes = [r for r in results if not isinstance(r, BaseException)]
        failures = [r for r in results if isinstance(r, BaseException)]
        assert len(successes) == 1, f"정확히 1건만 201 이어야(TOCTOU 레이스 막힘 검증) — got {results}"
        assert len(failures) == 1, f"정확히 1건만 409 여야 — got {results}"
        [exc] = failures
        assert isinstance(exc, HTTPException), f"실패는 HTTPException(409) 이어야 — got {exc!r}"
        assert exc.status_code == 409, f"패자는 409 여야 — got {exc.status_code}"

        # DB 최종 상태: row 정확히 1건(중복 미생성 실증 — 이게 이번 QA fix 의 핵심 단정).
        async with Session() as verify_s:
            n = (await verify_s.execute(text(
                f"SELECT count(*) FROM asset_folders WHERE org_id='{ORG}' AND project_id='{PROJ_A}' "
                "AND parent_id IS NULL AND name='RaceFolder'"
            ))).scalar_one()
            assert n == 1, f"레이스 후에도 DB row 는 정확히 1건이어야(TOCTOU 미방어시 2건 생김) — got {n}"
    finally:
        await engine.dispose()
