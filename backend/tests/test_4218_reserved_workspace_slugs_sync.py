"""story #4218 — 백엔드 workspace slug 예약어(`RESERVED_WORKSPACE_SLUGS`)를 FE `RESERVED_FIRST_SEGMENTS`와 한 원천으로.

예전 백엔드 목록은 2026-07-15 손 스냅샷이라 그 뒤 FE에 생긴 최상위 라우트(`gates`·`content`·`campaigns`·`desktop`·`today`·
`connect-rules`…)로 org를 만들 수 있었다 — 그 org의 scoped 경로 `/{slug}/…`는 미들웨어가 flat 라우트로 해석해 들어갈 수 없다.
이제 FE 목록을 직접 읽어(`tests/fe_reserved_segments.py`) «FE ⊆ 백엔드»를 고정한다: FE에 라우트가 늘면 여기가 RED.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.fe_reserved_segments import fe_reserved_first_segments
from tests.test_139d2405_slug_infra_realdb import (  # noqa: F401 — autouse 픽스처도 이 파일에 등록
    _client_for,
    _dispose_global_engine_after_test,
    _seed_human,
    _seed_org,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_realdb = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _missing_from_backend(fe: set[str]) -> list[str]:
    from app.services.entity_slug import RESERVED_WORKSPACE_SLUGS

    return sorted(fe - RESERVED_WORKSPACE_SLUGS)


def test_fe_reserved_segments_parser_reads_both_branches():
    """파서가 조용히 비거나 한 갈래만 읽지 않는다 — 손 스냅샷 리터럴과 `Object.keys(...)` 파생 둘 다."""
    fe = fe_reserved_first_segments()
    assert len(fe) >= 50, sorted(fe)
    assert {"gates", "today", "connect-rules", "set-password"} <= fe  # 손 스냅샷 리터럴
    assert {"flow", "work-list", "hypotheses", "mockups"} <= fe  # MIGRATED/RENAMED/RETIRED_RESOURCES 키


def test_backend_reserved_workspace_slugs_cover_every_fe_reserved_first_segment():
    """동기 가드 — FE가 워크스페이스로 해석하지 않는 첫 조각은 전부 백엔드에서도 org slug로 못 쓴다.
    RED가 나면: 그 이름을 `app/services/entity_slug.py`의 `RESERVED_WORKSPACE_SLUGS`에 더한다(FE 목록을 줄이지 말 것)."""
    assert _missing_from_backend(fe_reserved_first_segments()) == []


def test_sync_guard_goes_red_when_fe_gains_a_route(tmp_path, monkeypatch):
    """뮤테이션 고정 — FE 목록에 이름을 하나 더한 사본을 읽히면 가드가 그 이름을 잡는다."""
    import tests.fe_reserved_segments as mod

    src = mod.RESERVED_TS.read_text(encoding="utf-8")
    anchor = "export const RESERVED_FIRST_SEGMENTS = new Set(["
    mutated = tmp_path / "reserved-first-segments.ts"
    mutated.write_text(src.replace(anchor, anchor + "\n  'brand-new-route-4218',"), encoding="utf-8")
    monkeypatch.setattr(mod, "RESERVED_TS", mutated)
    assert _missing_from_backend(mod.fe_reserved_first_segments()) == ["brand-new-route-4218"]


def _message(resp) -> str | None:
    body = resp.json()
    return (body.get("error") or {}).get("message") or body.get("detail")


def _expected_detail(name: str) -> str:
    from app.services.entity_slug import is_valid_slug_format

    return "Slug is reserved" if is_valid_slug_format(name) else "Invalid slug format"


@_realdb
@pytest.mark.anyio
async def test_create_organization_rejects_every_fe_reserved_segment():
    """새 org 생성이 FE 예약 목록의 모든 이름을 400으로 거절한다(형식상 가능한 이름은 «예약어», 나머지는 형식)."""
    from app.main import app
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"u-{user_id.hex[:8]}@test.com", hashed_password="x", email_verified=True))
            await s.commit()
        await _setup_app(app, Session, user_id)
        client = _client_for(app)
        try:
            accepted = {}
            for name in sorted(fe_reserved_first_segments()):
                resp = await client.post("/api/v2/organizations", json={"name": f"Org {name}", "slug": name})
                if resp.status_code != 400 or _message(resp) != _expected_detail(name):
                    accepted[name] = (resp.status_code, resp.text[:120])
            assert accepted == {}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_realdb
@pytest.mark.anyio
async def test_rename_organization_slug_rejects_every_fe_reserved_segment():
    """slug 변경도 같은 목록을 전부 거절하고, 거절 뒤 org slug는 그대로다."""
    from sqlalchemy import select

    from app.main import app
    from app.models.organization import Organization

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _seed_org(s)
            original = org.slug
            user_id, _om = await _seed_human(s, org.id, role="owner")
        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            accepted = {}
            for name in sorted(fe_reserved_first_segments()):
                resp = await client.patch(f"/api/v2/organizations/{org.id}", json={"slug": name})
                if resp.status_code != 400 or _message(resp) != _expected_detail(name):
                    accepted[name] = (resp.status_code, resp.text[:120])
            assert accepted == {}
        finally:
            await client.aclose()
        async with Session() as s:
            assert (await s.execute(select(Organization.slug).where(Organization.id == org.id))).scalar_one() == original
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
