"""story #4350 PR 3(까디르 4727 판정 — PR 2 몫이었는데 diff에 없던 셋) — 같은 해소기(accessible_project_ids_in_org)로 막는다.

- docs 목록(project_id 없이): org 전체 문서가 나갔다(HIGH).
- webhooks config 목록: 멤버 범위만 보고 프로젝트 접근은 안 봤다(웹훅 URL · MEDIUM).
- hypotheses 목록(project_id 없이): 접근권 후필터가 limit 뒤라 페이지가 모자랐다 → SQL로.

한 시드: project A · B, 부르는 구성원은 A에만 grant. B 쪽 표지 «SECRET-B».
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import pytest

from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@asynccontextmanager
async def _world():
    from app.models.doc import Doc
    from app.models.hypothesis import Hypothesis
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.webhook_config import WebhookConfig

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
            pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
            s.add_all([pa, pb])
            await s.commit()
            member_id, member_user = await _make_member(s, org.id, pa.id)
            for proj, mark in ((pa, "VISIBLE-A"), (pb, "SECRET-B")):
                s.add(Doc(id=uuid.uuid4(), org_id=org.id, project_id=proj.id, title=f"{mark}-doc", slug=f"{mark.lower()}-doc"))
                s.add(WebhookConfig(
                    id=uuid.uuid4(), org_id=org.id, member_id=member_id, project_id=proj.id,
                    url=f"https://hooks.example.com/{mark}",
                ))
            s.add(WebhookConfig(id=uuid.uuid4(), org_id=org.id, member_id=member_id, project_id=None, url="https://hooks.example.com/VISIBLE-ORG"))
            # 가설: B 셋이 A 하나보다 최신 — limit=1이면 옛 후필터는 B 하나를 먹고 0건이 됐다.
            for i, (proj, mark) in enumerate(((pa, "VISIBLE-A"), (pb, "SECRET-B"), (pb, "SECRET-B"), (pb, "SECRET-B"))):
                s.add(Hypothesis(
                    org_id=org.id, project_id=proj.id, owner_member_id=member_id, statement=f"{mark}-hypothesis-{i}",
                    metric_definition={"metric": "m", "source": "db", "target": 1, "direction": "increase"},
                    measure_after=datetime(2030, 1, 1, tzinfo=UTC), status="active",
                    created_at=datetime(2026, 1, 1 + i, tzinfo=UTC),
                ))
            await s.commit()
        yield Session, {"org": org.id, "pa": pa.id, "pb": pb.id, "user": member_user}
    finally:
        await engine.dispose()


async def _get(Session, seeded, path):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(seeded["user"]), email="h@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            return await c.get(path)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("route,visible", [
    ("/api/v2/docs", "VISIBLE-A-doc"),
    ("/api/v2/webhooks/config", "VISIBLE-A"),
    ("/api/v2/hypotheses", "VISIBLE-A-hypothesis"),
])
async def test_no_project_filter_shows_only_accessible_projects(route, visible):
    async with _world() as (Session, seeded):
        resp = await _get(Session, seeded, route)
        assert resp.status_code == 200, resp.text[:400]
        assert "SECRET-B" not in resp.text, f"{route}: 접근 권한 없는 프로젝트(B)의 내용이 응답에 있다"
        assert visible in resp.text, f"{route}: 접근 가능한 프로젝트(A)의 내용은 그대로(회귀 0)"


async def test_webhook_org_level_config_stays_and_explicit_inaccessible_project_is_404():
    async with _world() as (Session, seeded):
        listed = await _get(Session, seeded, "/api/v2/webhooks/config")
        assert "VISIBLE-ORG" in listed.text, "프로젝트에 안 매인 org 수준 config는 그대로 보인다"
        other = await _get(Session, seeded, f"/api/v2/webhooks/config?project_id={seeded['pb']}")
        assert other.status_code == 404, other.text[:300]
        assert "SECRET-B" not in other.text


async def test_hypotheses_limit_applies_after_scope_not_before():
    """limit=1 — B 가설이 더 최신이어도 접근 가능한 A 하나가 온다(예전 후필터는 B를 먹고 0건)."""
    async with _world() as (Session, seeded):
        resp = await _get(Session, seeded, "/api/v2/hypotheses?limit=1")
        assert resp.status_code == 200, resp.text[:300]
        items = resp.json()
        items = items["data"] if isinstance(items, dict) and "data" in items else items
        assert len(items) == 1 and "VISIBLE-A" in items[0]["statement"], items
