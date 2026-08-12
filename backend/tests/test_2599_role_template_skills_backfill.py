"""story #2599(E-AGENT-ONBOARD·A2A발견 P1, 문서 e-a2a-discovery-spike-design 갭 D):
role_templates.skills 최소 백필(qa-automation + backend/frontend/pm) 검증.

realdb 파트는 DB env 없으면 skip(0166 realdb 패턴과 동형). 순수 SELECT — destructive_schema
마커 사용 금지(0163 CI 회귀 교훈).
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_BACKFILLED_SLUGS = {"qa-automation", "backend", "frontend", "pm"}


def _load_migration_0240():
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic" / "versions" / "0240_role_templates_skills_minimal_backfill.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0240", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


# ── AC1/AC2: 콘텐츠 형태 — AgentSkill 스키마 정합 ──────────────────────────────

def test_migration_skills_cover_exactly_the_minimal_set():
    mod = _load_migration_0240()
    assert set(mod._SKILLS.keys()) == _BACKFILLED_SLUGS


def test_migration_skills_validate_as_agent_skill():
    from app.schemas.a2a import AgentSkill

    mod = _load_migration_0240()
    for slug, skills in mod._SKILLS.items():
        assert len(skills) >= 1, f"{slug}: skills 비어있음"
        for raw in skills:
            skill = AgentSkill(**raw)
            assert skill.id, f"{slug}: id 비어있음"
            assert skill.name, f"{slug}: name 비어있음"
            assert skill.tags, f"{slug}: tags 비어있음(발견 매칭 재료 없음)"


# ── AC4: `?skill=` 필터가 구조화 skills의 tags/id에도 매치(name뿐 아니라) ────────────

def test_skill_filter_matches_via_tags_not_just_name():
    """`_skill_matches`(a2a.py)는 name/description/tags substring OR 매칭이다 — 백필된
    tags로만 검색해도(예: qa-automation은 name에 "test-automation"이 없음) 걸려야 한다."""
    from app.routers.a2a import _skill_matches
    from app.schemas.a2a import AgentCapabilities, AgentCard, AgentInterface, AgentSkill

    mod = _load_migration_0240()

    def _card_for(slug: str) -> AgentCard:
        skills = [AgentSkill(**s) for s in mod._SKILLS[slug]]
        return AgentCard(
            name=slug,
            description="test",
            supported_interfaces=[
                AgentInterface(url="http://x", protocol_binding="JSONRPC", protocol_version="1.0")
            ],
            version="0.1.0-poc",
            capabilities=AgentCapabilities(),
            default_input_modes=["text/plain"],
            default_output_modes=["text/plain"],
            skills=skills,
        )

    # 각 role의 tags 중 name에는 없는(순수 tag-only) 검색어로 매칭 확인.
    assert _skill_matches(_card_for("qa-automation"), "test-automation")
    assert _skill_matches(_card_for("backend"), "database")
    assert _skill_matches(_card_for("frontend"), "react")
    assert _skill_matches(_card_for("pm"), "roadmap")
    # 교차 매칭은 없어야(qa 태그가 backend 카드엔 없음).
    assert not _skill_matches(_card_for("backend"), "test-automation")


# ── AC3/AC5: 실 Postgres — 백필 슬러그는 구조화, 그 외는 `[]` 그대로 ────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_backfilled_slugs_have_structured_skills_in_db():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT slug, skills FROM role_templates WHERE slug = ANY(:slugs)"
            ), {"slugs": list(_BACKFILLED_SLUGS)})).mappings().all()
        found = {r["slug"] for r in rows}
        assert found == _BACKFILLED_SLUGS, f"백필 슬러그 일부 DB에 없음: {_BACKFILLED_SLUGS - found}"
        empty = [r["slug"] for r in rows if not r["skills"]]
        assert not empty, f"백필됐어야 할 슬러그가 여전히 빈 skills: {empty}"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_non_backfilled_slugs_remain_empty_skills():
    """⛔범위 가드 — 전체 24 백필이 아니라 최소 셋만이라는 것을 실측으로 고정. 이 카운트가
    24로 늘면(누군가 다른 마이그에서 전량 백필) 이 테스트가 빨개져 스코프 확대를 알린다."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            total = (await conn.execute(text("SELECT count(*) FROM role_templates"))).scalar_one()
            non_empty = (await conn.execute(text(
                "SELECT count(*) FROM role_templates WHERE skills != '[]'::jsonb"
            ))).scalar_one()
        assert total >= 24, f"role_templates seed 미적용?(count={total})"
        assert non_empty == len(_BACKFILLED_SLUGS), (
            f"skills 비어있지 않은 role_template 수={non_empty}, 기대={len(_BACKFILLED_SLUGS)} — "
            "최소 백필 스코프를 벗어났을 수 있음(의도적이면 이 테스트도 같이 갱신)"
        )
    finally:
        await engine.dispose()
