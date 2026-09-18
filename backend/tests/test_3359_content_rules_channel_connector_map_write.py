"""story #3359 CHANGES(카디르 발견, 페드루 PO 리뷰 2026-09-08) — 리졸버의 org override
우선순위①이 쓰기 계약 부재로 죽은 경로였다: `ContentRulesFields`(extra="forbid")에
`channel_connector_map` 필드가 없어 PUT body에 실으면 422로 거부됐다 — org가 blog/
newsletter 같은 별칭을 영원히 등록 못 하는 상태(리졸버는 읽기만 살아있고 쓰기 통로가
없었다). 세팅 헬퍼는 test_3471_org_content_rules_lint.py 재사용(중복 재발명 금지).

이 파일은 기존 mocked 뮤테이션킬(test_3359_channel_connector_map.py::
test_resolver_org_override_wins_over_default)의 짝 — 그건 get_org_content_rules를
mock해 «리졸버 로직 자체»를 검증했고, 여긴 실 PUT→실 DB→리졸버 왕복으로 «쓰기 계약이
실제로 뚫려 있는지»를 검증한다."""
from __future__ import annotations

import os

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_human,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_put_channel_connector_map_no_longer_422():
    """뮤테이션 킬 — channel_connector_map 필드가 ContentRulesFields에서 다시 빠지면
    (또는 extra="forbid"가 이 필드를 여전히 모르면) 이 PUT이 422로 되돌아간다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={
                    "rules": {"channel_connector_map": {"blog": "site_git", "newsletter": "stibee"}},
                    "expected_version": 0,
                },
            )
        assert r.status_code == 200, r.text
        assert r.json()["rules"]["channel_connector_map"] == {"blog": "site_git", "newsletter": "stibee"}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_written_override_round_trips_through_real_resolver_no_mocking():
    """실 PUT → 실 org_content_rules 행 → resolve_connector_key_for_channel(실 DB
    조회, mock 0)까지 왕복 — 쓰기 계약과 리졸버가 실제로 이어져 있다는 증거(둘 중
    하나만 고치고 다른 쪽을 안 잇는 클래스를 잡는다)."""
    from app.main import app
    from app.services.channel_connector_map import resolve_connector_key_for_channel

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"channel_connector_map": {"blog": "site_git"}}, "expected_version": 0},
            )
        assert r.status_code == 200, r.text

        async with Session() as s:
            resolved = await resolve_connector_key_for_channel(s, org_id=org_id, channel="blog")
        assert resolved == "site_git"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_still_unknown_key_returns_422_regression():
    """회귀 0 — channel_connector_map을 열어준 게 extra="forbid" 자체를 약화시키지
    않았는지(정말 모르는 키는 여전히 거부)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"totally_unknown_field": "x"}, "expected_version": 0},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
