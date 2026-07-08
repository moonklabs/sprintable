"""전 런타임 올지원(story 6f6ac081) 까심 QA 후속(2026-07-08) — migration 0163 실 Postgres 검증.

미르코 라이브 확認: grok/hermes 등 커넥터-라우팅 런타임 채용 산출물에 "## 런타임 노트"가
두 번 등장(section [A] role_behaviors에 0156/0157/0160이 하드코딩한 옛 거짓 문구 + section [E]
_runtime_notes의 정직한 버전, #1959). 0163이 role_behaviors 쪽 사본을 제거한다 — 이 테스트는
그 결과를 실 DB(마이그 실행 후)로 검증한다.
"""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# CI 회귀(2026-07-08): destructive_schema 마커 안 씀 — 이 테스트는 Base.metadata.create_all/
# drop_all로 스키마를 자체 관리하지 않는다(순수 SELECT, 마이그레이션이 이미 심은 role_templates
# 데이터를 읽기만 함). destructive_schema로 마킹하면 CI가 격리된 미마이그 fresh DB(sprintable_
# test_iso, alembic 미실행)를 배정해 role_templates 테이블 자체가 없어 UndefinedTableError.
# 이 테스트는 "alembic upgrade heads가 이미 실행된 공유 DB"(non-destructive 버킷)를 전제한다.


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL) — alembic upgrade heads 전제")
@pytest.mark.anyio
async def test_no_role_template_retains_stale_runtime_note_block():
    """0163 적용 후 모든 role_templates.role_behaviors에서 옛 하드코딩 문구가 완전히 사라져야 한다."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            stale_count = (await conn.execute(text(
                "SELECT count(*) FROM role_templates WHERE role_behaviors LIKE "
                "'%채용 시점 번들이 처리합니다%'"
            ))).scalar_one()
            heading_count = (await conn.execute(text(
                "SELECT count(*) FROM role_templates WHERE role_behaviors LIKE '%## 런타임 노트%'"
            ))).scalar_one()
        assert stale_count == 0
        assert heading_count == 0
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL) — alembic upgrade heads 전제")
@pytest.mark.anyio
async def test_compose_kit_has_exactly_one_runtime_note_heading_for_seeded_role():
    """0163 후 compose_kit가 실 seed 데이터로 정확히 1개의 '## 런타임 노트' 헤딩만 생성 —
    role_context(role_behaviors)와 onboarding(_runtime_notes) 중복 없음. 채용-kit
    재설계(story b1fe41cf) 이후 compose_prompt→compose_kit로 전환됐어도 이 회귀가드의
    의도(중복 0)는 그대로 유지."""
    from types import SimpleNamespace
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from app.services.agent_recruiter import compose_kit

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            row = (await conn.execute(text(
                "SELECT slug, role_behaviors, default_tool_groups, runtime_overrides "
                "FROM role_templates LIMIT 1"
            ))).mappings().first()
        assert row is not None, "role_templates 비어있음 — 0156/0157/0160 seed 마이그 미적용?"
        role = SimpleNamespace(
            name=row["slug"], role_behaviors=row["role_behaviors"],
            default_tool_groups=row["default_tool_groups"], runtime_overrides=row["runtime_overrides"] or {},
        )
        for runtime in ("claude-code", "grok"):
            out = "\n\n".join(compose_kit(role, runtime).values())
            assert out.count("## 런타임 노트") == 1, f"runtime={runtime}"
    finally:
        await engine.dispose()
