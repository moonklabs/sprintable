"""story #2181(모델↔DB drift 감사, 2026-07-24) — mockups 실PG 회귀 가드.

`model_db_drift_audit.py`(AC1/AC4)가 실 migrated DB 대조로 발견한 두 결함:
ⓐ `MockupComponent.type`이 DB엔 `component_type`으로 존재 — 모델·DB가 처음부터 한 번도
   일치한 적 없었음(create_all 기반 기존 테스트는 이 드리프트를 구조적으로 못 잡음, 모델
   자체로 테이블을 만드니까). select(MockupComponent)가 실 DB에서 UndefinedColumnError.
ⓑ `mockup_pages.viewport`가 실 DB엔 NOT NULL인데 모델은 Optional — `POST /mockups`가
   viewport 생략(클라 기본 None) 시 NotNullViolation 500.

이 테스트는 create_all이 아니라 **alembic 마이그레이션으로 프로비저닝된 실 PG**를 써서
(모델이 아니라 진짜 DB 스키마 대상) 두 결함이 실제로 재발하지 않는지 HTTP 왕복으로 검증한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
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


def _migrated_sync_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://",):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


def _run_migrations_to_head() -> None:
    """create_all이 아니라 **실제 alembic 마이그레이션**을 적용 — 이 테스트의 존재 이유
    자체가 "모델이 만드는 스키마"가 아니라 "마이그가 만드는 실 스키마"를 검증하는 것이라
    create_all을 쓰면 애초에 재현이 안 된다([[reference_local_migration_verify]])."""
    import subprocess
    import sys
    from pathlib import Path

    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(Path(__file__).resolve().parents[1]),
        env={**os.environ, "ALEMBIC_DATABASE_URL": _migrated_sync_url()},
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, f"alembic upgrade head 실패: {result.stdout}\n{result.stderr}"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix) if prefix != "postgresql://" else len("postgresql://"):]
            break
    engine = create_async_engine(url)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id):
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
            user_id=str(uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_realdb_create_mockup_without_viewport_does_not_500():
    """ⓑ 회귀가드 — viewport 생략 POST가 실 DB NotNullViolation 500 없이 성공하고, FE 자체
    기본값('desktop')과 통일된 값으로 채워지는지."""
    from app.main import app

    _run_migrations_to_head()
    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            from sqlalchemy import text
            await s.execute(text(
                "INSERT INTO organizations (id, name, slug, plan) VALUES (:id, 'O', :slug, 'free')"
            ), {"id": org_id, "slug": f"org-2181-{uuid.uuid4().hex[:8]}"})
            await s.execute(text(
                "INSERT INTO projects (id, org_id, name, violation_level) VALUES (:id, :org_id, 'P', 'warn')"
            ), {"id": project_id, "org_id": org_id})
            await s.commit()

        await _setup_app(app, Session, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/mockups", json={"slug": "no-viewport", "title": "T"})
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["viewport"] == "desktop", f"FE 기본값과 통일돼야 — 실제 {body['viewport']!r}"
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_realdb_update_mockup_components_type_roundtrips():
    """ⓐ 회귀가드 — components(type 포함) PUT이 실 DB에서 UndefinedColumnError 없이 성공하고,
    저장된 type이 그대로 조회되는지(모델 컬럼명 `type` ↔ 실 DB `component_type` 매핑 확認)."""
    from app.main import app

    _run_migrations_to_head()
    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            from sqlalchemy import text
            await s.execute(text(
                "INSERT INTO organizations (id, name, slug, plan) VALUES (:id, 'O', :slug, 'free')"
            ), {"id": org_id, "slug": f"org-2181b-{uuid.uuid4().hex[:8]}"})
            await s.execute(text(
                "INSERT INTO projects (id, org_id, name, violation_level) VALUES (:id, :org_id, 'P', 'warn')"
            ), {"id": project_id, "org_id": org_id})
            await s.commit()

        await _setup_app(app, Session, org_id, project_id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/mockups", json={"slug": "with-components", "title": "T", "viewport": "mobile"},
            )
            assert create_resp.status_code == 201, create_resp.text
            page_id = create_resp.json()["data"]["id"]

            put_resp = await client.put(
                f"/api/v2/mockups/{page_id}",
                json={"components": [{"type": "button", "props": {"label": "OK"}, "sort_order": 0}]},
            )
            assert put_resp.status_code == 200, (
                f"UndefinedColumnError(모델 `type` ↔ 실 DB `component_type` 미매핑) 재발 의심: {put_resp.text}"
            )

            get_resp = await client.get(f"/api/v2/mockups/{page_id}")
            assert get_resp.status_code == 200, get_resp.text
            comps = get_resp.json()["data"]["components"]
            assert len(comps) == 1
            assert comps[0]["type"] == "button", f"type 왕복 실패 — 실제 {comps[0]}"
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        await engine.dispose()
