"""webhook_config upsert 회귀 — 부분 unique 인덱스 충돌(500) 해소 실 DB 가드.

근본: WebhookConfigRepository.upsert 가 과거 url 기준 조회 → None 이면 plain INSERT 했는데,
스키마에는 멤버 1행 강제 부분 unique 인덱스 2개가 있다:
  - idx_webhook_configs_unique:  UNIQUE(org_id, member_id, project_id) WHERE project_id IS NOT NULL
  - idx_webhook_configs_default: UNIQUE(org_id, member_id)             WHERE project_id IS NULL
같은 멤버가 다른 url 로 재등록하면 url 조회 None → INSERT → 부분 unique 위반 → IntegrityError 500.
fix(on_conflict_do_update)는 두 부분 인덱스를 충돌 타깃으로 잡아 url/설정을 갱신(중복키 0).

mock 으로는 부분 unique 위반을 재현 못 한다(real PG 필요). DB env 없으면 skip — CI alembic-fresh-db.
"""
from __future__ import annotations

import os
import uuid

import pytest

_RAW_URL = (
    os.environ.get("PARITY_TEST_DATABASE_URL")
    or os.environ.get("ALEMBIC_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or ""
)
_ASYNC_URL = _RAW_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _ASYNC_URL, reason="webhook upsert real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# 고정 UUID — 시드/검증/정리 공유
ORG = uuid.UUID("c1000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("c4000000-0000-0000-0000-000000000001")
MEMBER = uuid.UUID("c5000000-0000-0000-0000-000000000001")

URL_A = "https://hooks.example.com/a"
URL_B = "https://hooks.example.com/b"


async def _seed(session) -> None:
    """org + project 시드(이전 실행 잔여 정리 포함). member_id 는 FK 미enforced 라 별도 시드 불필요."""
    from sqlalchemy import text

    stmts = [
        f"DELETE FROM webhook_configs WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','WH','whorg','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P',0)",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


async def _count(session, project_is_null: bool) -> int:
    from sqlalchemy import text

    clause = "project_id IS NULL" if project_is_null else f"project_id='{PROJ}'"
    return (await session.execute(text(
        f"SELECT count(*) FROM webhook_configs WHERE org_id='{ORG}' AND member_id='{MEMBER}' AND {clause}"
    ))).scalar()


@pytest.mark.anyio
async def test_upsert_same_project_different_url_no_duplicate_no_500():
    """(org,member,project) 동일·url 만 다르게 재등록 → IntegrityError 안 남·중복키 0·url 갱신."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = WebhookConfigRepository(s, ORG)
            c1 = await repo.upsert(member_id=MEMBER, url=URL_A, project_id=PROJ, events=["e1"])
            await s.commit()
            assert c1.url == URL_A

        # 같은 (org,member,project) 에 다른 url 재등록 — pre-fix 면 여기서 500
        async with Session() as s:
            repo = WebhookConfigRepository(s, ORG)
            c2 = await repo.upsert(member_id=MEMBER, url=URL_B, project_id=PROJ, events=["e2"])
            await s.commit()
            assert c2.url == URL_B
            assert c2.id == c1.id  # 같은 행 갱신(신규 INSERT 아님)
            assert c2.events == ["e2"]

        async with Session() as s:
            assert await _count(s, project_is_null=False) == 1  # 중복키 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_project_none_different_url_no_duplicate_no_500():
    """project_id=None(개인) 동일·url 만 다르게 재등록 → idx_..._default 충돌도 갱신(중복 폭증 0)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = WebhookConfigRepository(s, ORG)
            c1 = await repo.upsert(member_id=MEMBER, url=URL_A, project_id=None, events=["e1"])
            await s.commit()
            assert c1.project_id is None

        # 같은 (org,member) project=NULL 에 다른 url 재등록 — pre-fix 면 여기서 500
        async with Session() as s:
            repo = WebhookConfigRepository(s, ORG)
            c2 = await repo.upsert(member_id=MEMBER, url=URL_B, project_id=None, events=None)
            await s.commit()
            assert c2.url == URL_B
            assert c2.id == c1.id
            assert c2.events == ["e1"]  # events=None → 기존 값 유지

        async with Session() as s:
            assert await _count(s, project_is_null=True) == 1  # 중복 폭증 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upsert_project_and_personal_coexist():
    """같은 멤버의 project-scoped 와 personal(NULL) webhook 은 별개 행으로 공존(부분 인덱스 분리)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.webhook_config import WebhookConfigRepository

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = WebhookConfigRepository(s, ORG)
            cp = await repo.upsert(member_id=MEMBER, url=URL_A, project_id=PROJ)
            cn = await repo.upsert(member_id=MEMBER, url=URL_B, project_id=None)
            await s.commit()
            assert cp.id != cn.id

        async with Session() as s:
            assert await _count(s, project_is_null=False) == 1
            assert await _count(s, project_is_null=True) == 1
    finally:
        await engine.dispose()
