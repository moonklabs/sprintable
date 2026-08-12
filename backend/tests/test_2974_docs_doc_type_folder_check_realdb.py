"""story #2974(카디르 QA REQUEST_CHANGES·PO 방향 결정 2026-08-12) — docs_doc_type_check CHECK
제약이 'folder'를 허용하지 않아 실 Postgres INSERT가 CheckViolationError로 죽던 결함.

이 클래스는 mock 테스트(test_docs.py의 `BaseRepository.create` AsyncMock 패치)가 원천적으로
못 잡는다 — 실 DB 제약 위반이라 [[feedback_baseline_check_ci_sqlite_blindspot]]과 동형(CI
SQLite/session mock 경로는 통과했지만 카디르의 실 DB QA에서 500이 났다). realdb 필수.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2974000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("d2974000-0000-0000-0000-0000000000c1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s):
    for sql in [
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2974','d2974-org','free')",
        f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{PROJ}','{ORG}','P','d2974-proj')",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytest.mark.anyio
async def test_doc_type_folder_insert_succeeds_against_real_check_constraint():
    """핵심 회귀가드 — story #2974의 실제 실패 지점: DocRepository.create(doc_type="folder")가
    실 Postgres docs_doc_type_check를 위반하지 않고 커밋되는지. fix 前엔 이 INSERT가
    CheckViolationError(IntegrityError)로 죽었다(카디르 실 DB QA 500 재현)."""
    from app.repositories.doc import DocRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            repo = DocRepository(s, ORG)
            doc = await repo.create(
                project_id=PROJ,
                title="Real Folder",
                slug=f"real-folder-{uuid.uuid4().hex[:8]}",
                content="",
                doc_type="folder",
            )
            await s.commit()
            assert doc.doc_type == "folder"
            assert doc.is_folder is True  # derived property(models/doc.py) — doc_type 파생 확인
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_doc_type_bogus_value_still_rejected_by_check_constraint():
    """음성대조 — CHECK가 'folder' 하나만 넓혔지, 아무 값이나 통과시키는 게 아님을 고정."""
    from app.repositories.doc import DocRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            repo = DocRepository(s, ORG)
            with pytest.raises(IntegrityError):
                await repo.create(
                    project_id=PROJ,
                    title="Bogus",
                    slug=f"bogus-{uuid.uuid4().hex[:8]}",
                    content="",
                    doc_type="not-a-real-type",
                )
                await s.commit()
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_migration_backfills_legacy_is_folder_true_rows_to_doc_type_folder():
    """PO 실측(2026-08-12) 요청 — dev에서 실제로 관측된 케이스(is_folder=true 83건, 자식 251건이
    매달린 레거시 폴더)를 이 마이그레이션의 backfill(`UPDATE docs SET doc_type='folder' WHERE
    is_folder = true`)이 정확히 복원하는지 고정한다.

    이미 마이그레이션 0239가 적용된 shared realdb 픽스처엔 is_folder 컬럼 자체가 없으므로(은퇴
    완료) 그 컬럼에서 직접 backfill을 재현할 수 없다 — 격리 스키마에 0239 upgrade() 전 형태
    (is_folder 컬럼 있는 최소 테이블)를 만들어 실제 backfill SQL 문(마이그와 동일 문자열)을
    돌리고 결과만 검증한다. `public.docs`(실 데이터)는 건드리지 않는다."""
    eng, Session = await _engine()
    schema = f"test_2974_bf_{uuid.uuid4().hex[:8]}"
    try:
        async with Session() as s:
            await s.execute(text(f"CREATE SCHEMA {schema}"))
            await s.execute(text(f"""
                CREATE TABLE {schema}.docs (
                    id uuid PRIMARY KEY,
                    doc_type text NOT NULL DEFAULT 'page',
                    is_folder boolean NOT NULL DEFAULT false
                )
            """))
            folder_id, child_page_id, plain_page_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            # 실측과 같은 모양 — 레거시 폴더(is_folder=true, doc_type은 구ORM 시절 'page'로
            # 저장돼 있었다) + 그 아래 매달린 자식(정상 page, is_folder=false) + 무관한 다른 page.
            await s.execute(text(f"""
                INSERT INTO {schema}.docs (id, doc_type, is_folder) VALUES
                    ('{folder_id}', 'page', true),
                    ('{child_page_id}', 'page', false),
                    ('{plain_page_id}', 'general', false)
            """))
            await s.commit()

            # 마이그레이션 0239의 backfill 문과 동일(스키마만 격리로 치환).
            result = await s.execute(
                text(f"UPDATE {schema}.docs SET doc_type = 'folder' WHERE is_folder = true")
            )
            await s.commit()
            assert result.rowcount == 1

            rows = (await s.execute(text(f"SELECT id, doc_type FROM {schema}.docs ORDER BY id"))).all()
            by_id = {str(r.id): r.doc_type for r in rows}
            assert by_id[str(folder_id)] == "folder"      # backfill 대상 — 전환됨
            assert by_id[str(child_page_id)] == "page"     # is_folder=false — 안 건드림(자식 자체 타입 보존)
            assert by_id[str(plain_page_id)] == "general"  # 무관 행 — 안 건드림
    finally:
        async with Session() as s:
            await s.execute(text(f"DROP SCHEMA IF EXISTS {schema} CASCADE"))
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
async def test_is_folder_column_dropped_and_derived_from_doc_type():
    """죽은 is_folder boolean 컬럼이 실제로 은퇴됐는지(0239 마이그) — information_schema
    직조회로 컬럼 부재를 확인한다(derived property로만 존재해야 한다).

    0239는 backfill-then-drop(무조건)이다 — 실데이터가 있으면 drop을 보류하던 초기(83건
    실측 前) 설계가 아니라, is_folder=true 행을 doc_type='folder'로 먼저 옮겨(위
    test_migration_backfills_...) 데이터 손실 없이 항상 drop한다. 그래서 이 realdb 픽스처가
    가리키는 DB가 0239까지 정상 적용됐다면 컬럼은 반드시 없어야 한다 — 존재 여부를 그냥
    관측만 하지 않고 단정한다."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            exists = (await s.execute(
                text(
                    "SELECT 1 FROM information_schema.columns "
                    "WHERE table_name = 'docs' AND column_name = 'is_folder'"
                )
            )).scalar()
        assert not exists, "docs.is_folder should be fully retired after 0239 (backfill-then-drop)"

        async with Session() as s:
            await _seed(s)
            from app.repositories.doc import DocRepository
            repo = DocRepository(s, ORG)
            doc = await repo.create(
                project_id=PROJ, title="Derived Check",
                slug=f"derived-{uuid.uuid4().hex[:8]}", content="", doc_type="page",
            )
            await s.commit()
            assert doc.is_folder is False  # doc_type='page' → derived is_folder=False
    finally:
        await eng.dispose()
