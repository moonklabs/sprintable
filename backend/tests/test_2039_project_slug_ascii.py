"""story #2039(P0): 한글 등 비ASCII 프로젝트/워크스페이스 이름의 slug 깨짐 → 클라이언트 사이드 404.

배경(오르테가 PO 실측): `/api/projects` 응답에서 `장사왕`→slug `장사왕`(원문 그대로) — 반면
`B2B Sales GTM`→`b2b-sales-gtm`. slug가 URL에서 percent-encode되고 FE 라우트 매처가 못 통과해
보드·스프린트·목표·문서가 전부 404(서버는 200, 콘솔 에러도 0이라 로그로 안 잡힘). 조직은 생성 시
client가 명시 ASCII slug를 필수 제출해(is_valid_slug_format) 이 경로를 안 타 우연히 무사했다.

이 파일 구성:
- `slugify_ascii`/`slugify_ascii_or_fallback` 순수 함수 매트릭스(한글·일본어·이모지·공백·특수문자
  ·혼합·순수 라틴).
- real-PG: `POST /api/v2/projects`에 한글 이름 → 응답 slug가 ASCII(is_valid_slug_format)이고
  org 내 유일.
- real-PG: 마이그레이션 0203이 기존 깨진(비ASCII) slug를 실제로 백필하고 `entity_slug_history`에
  이력을 남기며, `/api/v2/resolve`가 그 이력으로 구 slug 요청을 canonical slug로 redirect
  처리함을 실증(요구사항③ — 별도 인프라 없이 기존 메커니즘 재사용 확인).
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


# ── slugify_ascii / slugify_ascii_or_fallback 순수 함수 매트릭스 ────────────────

@pytest.mark.parametrize("name,expected", [
    ("B2B Sales GTM", "b2b-sales-gtm"),
    ("OB Test Project", "ob-test-project"),
    ("  leading and trailing  ", "leading-and-trailing"),
    ("Multiple   Spaces", "multiple-spaces"),
    ("Special!@#$%Chars", "specialchars"),
    ("MixedÜnïcode123", "mixedncode123"),  # 라틴 확장(ü,ï)은 ASCII 아니므로 제거되고 나머지만 남음
])
def test_slugify_ascii_matrix(name, expected):
    from app.services.entity_slug import slugify_ascii
    assert slugify_ascii(name) == expected


@pytest.mark.parametrize("name", [
    "장사왕",         # 순수 한글
    "제로고",         # 순수 한글
    "こんにちは",      # 일본어
    "🎉🚀✨",         # 이모지만
    "   ",           # 공백뿐
    "",              # 빈 문자열
])
def test_slugify_ascii_pure_nonascii_returns_empty(name):
    from app.services.entity_slug import slugify_ascii
    assert slugify_ascii(name) == ""


@pytest.mark.parametrize("name", ["장사왕", "제로고", "こんにちは", "🎉🚀✨", "   ", ""])
def test_slugify_ascii_or_fallback_always_valid_format(name):
    """순수 비ASCII 이름은 id-fallback으로 떨어지되, 결과는 항상 is_valid_slug_format을 통과한다
    (한글 이름 자체를 막지 않는다는 PO 제약 — name은 그대로 저장, slug만 폴백)."""
    from app.services.entity_slug import is_valid_slug_format, slugify_ascii_or_fallback

    slug = slugify_ascii_or_fallback(name, fallback_prefix="project")
    assert is_valid_slug_format(slug), slug
    assert slug.startswith("project-"), slug


def test_slugify_ascii_or_fallback_mixed_name_keeps_latin_part():
    from app.services.entity_slug import slugify_ascii_or_fallback
    assert slugify_ascii_or_fallback("B2B 세일즈 GTM") == "b2b-gtm"


def test_slugify_ascii_or_fallback_two_pure_korean_names_get_distinct_fallbacks():
    """치환(문자→고정기호) 대신 id-fallback을 택한 근거 실증 — 서로 다른 두 한글 이름이 같은
    슬러그로 수렴하지 않는다(식별력 보존)."""
    from app.services.entity_slug import slugify_ascii_or_fallback
    a = slugify_ascii_or_fallback("장사왕", fallback_prefix="project")
    b = slugify_ascii_or_fallback("제로고", fallback_prefix="project")
    assert a != b


# ── real-PG: 신규 생성 경로 ──────────────────────────────────────────────────

def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


def _sync_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드(entity_slug_history 포함)

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_with_human_member(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="owner"))
    await session.commit()

    return {"org_id": org.id, "caller_user_id": caller.id}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_create_project_korean_name_gets_ascii_slug():
    from app.main import app
    from app.services.entity_slug import is_valid_slug_format

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_human_member(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/projects", json={"name": "장사왕", "org_id": str(seeded["org_id"])},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["name"] == "장사왕", body  # 이름은 원문 그대로 저장/표시
            assert is_valid_slug_format(body["slug"]), body  # slug만 ASCII-safe

            # 두 번째 한글 프로젝트(다른 이름)도 서로 다른 slug를 받는다(충돌 없음).
            resp2 = await client.post(
                "/api/v2/projects", json={"name": "제로고", "org_id": str(seeded["org_id"])},
            )
            assert resp2.status_code == 201, resp2.text
            assert resp2.json()["slug"] != body["slug"]
            assert is_valid_slug_format(resp2.json()["slug"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── real-PG: 마이그레이션 0203 — 기존 깨진 slug 백필 + 구 링크 호환 ───────────────

def _load_migration_0203():
    spec = importlib.util.spec_from_file_location(
        "m0203", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions",
                               "0203_backfill_ascii_project_org_slugs.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_migration_0203_backfills_broken_slug_and_records_history():
    """0185/router가 예전엔 만들어냈을 "깨진" 상태(slug=한글 원문)를 raw insert로 재현한 뒀,
    0203을 직접 구동(reference_local_migration_verify 패턴 — Operations API 직구동)해 slug가
    ASCII로 교체되고 entity_slug_history에 old→new가 남는지, 그리고 /api/v2/resolve가 그 이력으로
    구 slug 요청을 새 slug로 redirect 처리하는지까지 엔드투엔드로 확인한다."""
    import sqlalchemy as sa
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_human_member(s)
            from app.models.project import Project
            broken = Project(
                id=uuid.uuid4(), org_id=seeded["org_id"], name="장사왕", slug="장사왕",
            )
            s.add(broken)
            await s.commit()
            broken_id = broken.id

        # 마이그레이션은 동기(psycopg2) op.get_bind() 계약 — reference_local_migration_verify.
        m = _load_migration_0203()
        sync_engine = sa.create_engine(_sync_url())
        with sync_engine.begin() as conn:
            ctx = MigrationContext.configure(conn)
            with Operations.context(ctx):
                m.upgrade()
        sync_engine.dispose()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_user_id"])
        client = _client_for(app)
        try:
            from app.services.entity_slug import is_valid_slug_format

            get_resp = await client.get(f"/api/v2/projects/{broken_id}")
            assert get_resp.status_code == 200, get_resp.text
            new_slug = get_resp.json()["slug"]
            assert is_valid_slug_format(new_slug), get_resp.json()
            assert new_slug != "장사왕"

            # entity_slug_history 이력 확인(재조회 — feedback_verify_commit_race).
            async with Session() as s2:
                from app.models.entity_slug_history import EntitySlugHistory
                from sqlalchemy import select
                hist = (await s2.execute(
                    select(EntitySlugHistory).where(
                        EntitySlugHistory.entity_type == "project",
                        EntitySlugHistory.entity_id == broken_id,
                    )
                )).scalar_one()
                assert hist.old_slug == "장사왕"
                assert hist.new_slug == new_slug

            # /api/v2/resolve — 구 slug(장사왕)로 요청해도 redirect 필드로 새 slug를 알려준다.
            from app.repositories.organization import OrganizationRepository
            async with Session() as s3:
                org = await OrganizationRepository(s3).get(seeded["org_id"])
                org_slug = org.slug

            resolve_resp = await client.get(
                "/api/v2/resolve", params={"workspace": org_slug, "project": "장사왕"},
            )
            assert resolve_resp.status_code == 200, resolve_resp.text
            rbody = resolve_resp.json()
            assert rbody["project_slug"] == new_slug, rbody
            assert rbody["redirect"]["project"] == new_slug, rbody
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
