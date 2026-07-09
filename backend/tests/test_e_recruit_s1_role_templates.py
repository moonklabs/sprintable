"""E-RECRUIT S1 (story a47e7374): role_templates 카탈로그 모델 + seed + GET 엔드포인트.

Alembic 경로로 확정(PO crux 2026-07-05 — packages/db/supabase 경로는 죽은 인프라, 0002_disable_rls.py
가 명시한 FastAPI-authz SSOT 원칙과 정합). RLS/SECURITY DEFINER 불요 — 인가는 애플리케이션 레이어.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import text

_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0156_role_templates.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("rev_0156", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0156_chains_off_0155():
    mod = _load_migration()
    assert mod.revision == "0156"
    assert mod.down_revision == "0155"
    assert callable(mod.upgrade) and callable(mod.downgrade)


def test_seed_covers_exactly_p0_four_roles():
    mod = _load_migration()
    slugs = {row[0] for row in mod._SEED}
    assert slugs == {"frontend", "backend", "qa", "pm"}


def test_seed_tool_groups_exclude_admin_and_destructive_only_groups():
    """AC: default_tool_groups 는 직무별 최소권한 — admin/rewards/webhooks/audit/agent_runs 제외."""
    mod = _load_migration()
    excluded = {"admin", "rewards", "webhooks", "audit", "agent_runs"}
    for slug, _name, _category, _description, tool_groups, _recipe in mod._SEED:
        assert not (set(tool_groups) & excluded), f"{slug} leaks an excluded group: {tool_groups}"
        assert tool_groups, f"{slug} has empty default_tool_groups"


def test_role_behaviors_reference_verified_tool_names_only():
    """AC: '검증된 도구 이름만' — role_behaviors 안의 sprintable_* 언급이 실제 등록 도구명과 일치."""
    import re

    mod = _load_migration()
    from sprintable_mcp.server import _TOOL_DEFS

    real_names = {name for name, *_ in _TOOL_DEFS} | {"ping"}
    for slug, behaviors in mod._ROLE_BEHAVIORS.items():
        mentioned = set(re.findall(r"`(sprintable_[a-z_]+)`", behaviors))
        assert mentioned, f"{slug} role_behaviors mentions no sprintable_* tools"
        unknown = mentioned - real_names
        assert not unknown, f"{slug} role_behaviors invents non-existent tool names: {unknown}"


def test_model_field_shape():
    from app.models.role_template import RoleTemplate

    cols = {c.name for c in RoleTemplate.__table__.columns}
    assert cols == {
        "id", "slug", "name", "category", "description", "role_behaviors",
        "default_tool_groups", "default_workflow_recipe_slug", "runtime_overrides",
        "is_builtin", "is_published", "tier", "version", "created_at", "updated_at",
        # 카탈로그 트랙 S1(0161, 문서 role-template-crud-api-crux §4).
        "division", "emoji", "skills",
        # E-I18N Phase B(story 11f1087c, migration 0164) — locale 번역 오버레이.
        "role_behaviors_i18n",
        # E-RECRUIT S24(story 25e8828d, migration 0167) — description locale 오버레이.
        "description_i18n",
    }


# ─── 실 Postgres — 실 마이그 적용 + GET 엔드포인트 ────────────────────────────

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_list_role_templates_returns_seeded_four_roles_realdb():
    from app.routers.role_templates import _list_role_templates as list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            out = await list_role_templates(session=s)
        slugs = {rt.slug for rt in out}
        assert {"frontend", "backend", "qa", "pm"} <= slugs
        # 목록 응답엔 role_behaviors(md 본문) 없음(페이로드 절감)
        assert not hasattr(out[0], "role_behaviors")
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_by_slug_includes_behaviors_realdb():
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            out = await get_role_template("backend", session=s)
        assert out.slug == "backend"
        assert "sprintable_" in out.role_behaviors
        assert out.default_tool_groups == ["stories", "tasks", "epics", "chat", "docs"]
        assert out.is_builtin is True
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_unknown_slug_404_realdb():
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_role_template("nonexistent-role", session=s)
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_unpublished_role_template_hidden_from_list_and_get_realdb():
    """is_published=False 는 목록/단건 둘 다 숨김(삭제 아닌 게이트)."""
    from app.routers.role_templates import _get_role_template as get_role_template
    from app.routers.role_templates import _list_role_templates as list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO role_templates (slug, name, category, role_behaviors, "
                "default_tool_groups, is_published) VALUES "
                "('draft-role', 'Draft', 'test', 'wip', ARRAY['stories'], false)"
            ))
            await s.commit()
        async with Session() as s:
            listed = await list_role_templates(session=s)
            assert "draft-role" not in {rt.slug for rt in listed}
            with pytest.raises(HTTPException) as ei:
                await get_role_template("draft-role", session=s)
            assert ei.value.status_code == 404
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM role_templates WHERE slug = 'draft-role'"))
            await s.commit()
        await eng.dispose()


# ─── E-RECRUIT S24(story 25e8828d): 카탈로그 detail locale 서빙 ───────────────


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_locale_en_selects_i18n_overlay_realdb():
    """locale=en 명시 시 role_behaviors_i18n.en 을 반환(0166 EN 백필이 backend 에 이미 존재)."""
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ko = await get_role_template("backend", session=s)
            en = await get_role_template("backend", session=s, locale="en")
        assert en.role_behaviors != ko.role_behaviors
        assert "sprintable_" in en.role_behaviors  # EN 본문도 실 도구명 참조
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_locale_unset_preserves_ko_regression_realdb():
    """AC3(KO 워크스페이스 회귀 0) — locale 미지정 시 기존 ko role_behaviors 그대로."""
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            no_locale = await get_role_template("backend", session=s)
            explicit_ko = await get_role_template("backend", session=s, locale="ko")
        assert no_locale.role_behaviors == explicit_ko.role_behaviors
        assert "sprintable_" in no_locale.role_behaviors
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_accept_language_header_fallback_realdb():
    """명시 locale 없이 Accept-Language 헤더만으로 en 선택(recruit 엔드포인트와 동일 폴백)."""
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            via_header = await get_role_template(
                "backend", session=s, accept_language="en-US,en;q=0.9,ko;q=0.5",
            )
            explicit_en = await get_role_template("backend", session=s, locale="en")
        assert via_header.role_behaviors == explicit_en.role_behaviors
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_locale_falls_back_to_ko_when_i18n_missing_realdb():
    """role_behaviors_i18n 에 그 locale 콘텐츠가 없으면(빈 dict) ko 원문으로 무회귀 폴백."""
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO role_templates (slug, name, category, role_behaviors, "
                "default_tool_groups, is_published, role_behaviors_i18n) VALUES "
                "('no-i18n-role', 'No I18N', 'test', 'ko-only-body', ARRAY['stories'], "
                "true, '{}'::jsonb)"
            ))
            await s.commit()
        async with Session() as s:
            out = await get_role_template("no-i18n-role", session=s, locale="en")
        assert out.role_behaviors == "ko-only-body"
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM role_templates WHERE slug = 'no-i18n-role'"))
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_list_role_templates_description_unaffected_when_no_ko_overlay_yet_realdb():
    """0156/0157/0160 builtin seed는 description_i18n 백필이 없다(순수 구조 추가, 0167) —
    PO ko 저작·주입 전까지는 locale 무관 항상 영어 원문(회귀 0)."""
    from app.routers.role_templates import _list_role_templates as list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ko_list = await list_role_templates(session=s, locale="ko")
            en_list = await list_role_templates(session=s, locale="en")
        ko_by_slug = {rt.slug: rt.description for rt in ko_list}
        en_by_slug = {rt.slug: rt.description for rt in en_list}
        assert ko_by_slug == en_by_slug
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_list_role_templates_division_localized_to_ko_realdb():
    """division(코드 상수 매핑, 데이터 백필 불요) — ko 요청 시 12개 고정값이 한글 표시명으로,
    en/미지정 시 저장된 영문 원문 그대로."""
    from app.routers.role_templates import _get_role_template as get_role_template
    from app.routers.role_templates import _list_role_templates as list_role_templates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO role_templates (slug, name, category, role_behaviors, "
                "default_tool_groups, is_published, division) VALUES "
                "('division-probe', 'Division Probe', 'test', 'body', ARRAY['stories'], "
                "true, 'Engineering')"
            ))
            await s.commit()
        async with Session() as s:
            ko_list = await list_role_templates(session=s, locale="ko")
            en_list = await list_role_templates(session=s, locale="en")
            ko_detail = await get_role_template("division-probe", session=s, locale="ko")
        ko_division = next(rt.division for rt in ko_list if rt.slug == "division-probe")
        en_division = next(rt.division for rt in en_list if rt.slug == "division-probe")
        assert ko_division == "엔지니어링"
        assert en_division == "Engineering"
        assert ko_detail.division == "엔지니어링"
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM role_templates WHERE slug = 'division-probe'"))
            await s.commit()
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
async def test_get_role_template_description_locale_selects_i18n_overlay_realdb():
    """description_i18n 에 ko 콘텐츠가 있으면 locale=ko 요청이 그걸 선택(en은 항상 원문)."""
    from app.routers.role_templates import _get_role_template as get_role_template

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO role_templates (slug, name, category, role_behaviors, "
                "default_tool_groups, is_published, description, description_i18n) VALUES "
                "('desc-i18n-probe', 'Desc Probe', 'test', 'body', ARRAY['stories'], true, "
                "'English description', '{\"ko\": \"한글 설명\"}'::jsonb)"
            ))
            await s.commit()
        async with Session() as s:
            ko = await get_role_template("desc-i18n-probe", session=s, locale="ko")
            en = await get_role_template("desc-i18n-probe", session=s, locale="en")
            unset = await get_role_template("desc-i18n-probe", session=s)
        assert ko.description == "한글 설명"
        assert en.description == "English description"
        # locale 미지정 → resolve_locale_from_request 의 DEFAULT_LOCALE="ko" 로 정규화되므로
        # ko 콘텐츠가 있으면 그게 선택된다(회귀 0은 "ko 콘텐츠가 아직 없는 행"에 한정 — 있는
        # 행에서 ko 유저가 한글을 보는 건 이 스토리가 의도하는 개선 그 자체).
        assert unset.description == "한글 설명"
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM role_templates WHERE slug = 'desc-i18n-probe'"))
            await s.commit()
        await eng.dispose()


# ─── ASGI 레벨(실 HTTP 쿼리파라미터·헤더 파싱) — mock_session/test_client(conftest) ────
# 위 realdb 테스트는 `_get_role_template()`/`_list_role_templates()`를 직접 호출해 Header()
# DI 마커·쿼리파라미터 파싱 자체(FastAPI 라우팅 레이어)는 안 거친다 — 그 레이어까지 실제로
# 도는지는 여기서 실 ASGI 요청으로 확인한다.


def _mock_role_template(**overrides):
    from datetime import datetime, timezone
    from unittest.mock import MagicMock
    import uuid as uuid_mod

    rt = MagicMock()
    rt.id = uuid_mod.uuid4()
    rt.slug = "http-probe"
    rt.name = "HTTP Probe"
    rt.category = "test"
    rt.description = "English description"
    rt.description_i18n = {"ko": "한글 설명"}
    rt.default_tool_groups = ["stories"]
    rt.default_workflow_recipe_slug = None
    rt.is_builtin = False
    rt.tier = "free"
    rt.version = 1
    rt.division = "Engineering"
    rt.emoji = None
    rt.skills = []
    rt.role_behaviors = "ko body"
    rt.role_behaviors_i18n = {"en": "en body"}
    rt.runtime_overrides = {}
    rt.created_at = datetime.now(timezone.utc)
    rt.updated_at = datetime.now(timezone.utc)
    for k, v in overrides.items():
        setattr(rt, k, v)
    return rt


def _scalar_result(obj):
    from unittest.mock import MagicMock

    res = MagicMock()
    res.scalar_one_or_none.return_value = obj
    return res


@pytest.mark.anyio
async def test_get_role_template_locale_query_param_http(test_client, mock_session):
    """실 HTTP GET ?locale=en — FastAPI 쿼리파라미터 파싱이 실제로 EN 을 골라내는지."""
    from unittest.mock import AsyncMock

    rt = _mock_role_template()
    mock_session.execute = AsyncMock(return_value=_scalar_result(rt))
    resp = await test_client.get("/api/v2/role-templates/http-probe", params={"locale": "en"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["role_behaviors"] == "en body"
    assert body["description"] == "English description"
    assert body["division"] == "Engineering"  # en → 매핑 미적용, 원문


@pytest.mark.anyio
async def test_get_role_template_accept_language_header_http(test_client, mock_session):
    """실 HTTP GET — 명시 locale 없이 Accept-Language 헤더만으로 ko 표시명/en 오버레이 선택."""
    from unittest.mock import AsyncMock

    rt = _mock_role_template()
    mock_session.execute = AsyncMock(return_value=_scalar_result(rt))
    resp = await test_client.get(
        "/api/v2/role-templates/http-probe",
        headers={"Accept-Language": "ko-KR,ko;q=0.9"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["role_behaviors"] == "ko body"  # ko는 role_behaviors_i18n에 en만 있어 원문 폴백
    assert body["description"] == "한글 설명"  # ko 오버레이 선택
    assert body["division"] == "엔지니어링"  # ko 표시명 매핑 적용


@pytest.mark.anyio
async def test_get_role_template_no_locale_signal_defaults_ko_http(test_client, mock_session):
    """locale 쿼리도 Accept-Language 헤더도 없으면 DEFAULT_LOCALE=ko(회귀 0 — 기존 클라이언트)."""
    from unittest.mock import AsyncMock

    rt = _mock_role_template()
    mock_session.execute = AsyncMock(return_value=_scalar_result(rt))
    resp = await test_client.get("/api/v2/role-templates/http-probe")
    assert resp.status_code == 200
    body = resp.json()
    assert body["description"] == "한글 설명"
    assert body["division"] == "엔지니어링"


@pytest.mark.anyio
async def test_list_role_templates_locale_query_param_http(test_client, mock_session):
    """실 HTTP GET list ?locale=ko — division/description 이 실제로 로케일 적용되는지."""
    from unittest.mock import AsyncMock, MagicMock

    rt = _mock_role_template()
    res = MagicMock()
    res.scalars.return_value.all.return_value = [rt]
    mock_session.execute = AsyncMock(return_value=res)
    resp = await test_client.get("/api/v2/role-templates", params={"locale": "ko"})
    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["division"] == "엔지니어링"
    assert body[0]["description"] == "한글 설명"
