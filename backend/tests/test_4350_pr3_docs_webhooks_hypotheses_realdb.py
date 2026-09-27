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
        yield Session, {"org": org.id, "pa": pa.id, "pb": pb.id, "user": member_user, "member": member_id}
    finally:
        await engine.dispose()


async def _get(Session, seeded, path, *, method="GET", json=None):
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
            return await c.request(method, path, json=json)
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


async def test_webhook_upsert_into_inaccessible_project_is_404_and_writes_nothing(monkeypatch):
    """까디르 P1 — 접근 못 하는 프로젝트를 걸어 웹훅을 만들면 그 프로젝트 이벤트가 내 URL로 갈 수 있었다. 저장 전 확인 · 없는 프로젝트와
    같은 404 · 행 0 / 접근 가능한 프로젝트 · org 수준(project 없음)은 그대로 저장."""
    from sqlalchemy import func, select

    from app.models.webhook_config import WebhookConfig

    # 관심은 프로젝트 접근 — URL 안전 검사(DNS 조회로 사설 IP 차단)는 test_ssrf.py 몫이라 여기선 끈다(샌드박스엔 DNS가 없다).
    monkeypatch.setattr("app.schemas.webhook_config.validate_webhook_url", lambda _v: None)
    async with _world() as (Session, seeded):
        def body(project_id, tag):
            return {"member_id": str(seeded["member"]), "url": f"https://hooks.example.com/{tag}",
                    "project_id": str(project_id) if project_id else None}

        other = await _get(Session, seeded, "/api/v2/webhooks/config", method="PUT", json=body(seeded["pb"], "NEW-B"))
        missing = await _get(Session, seeded, "/api/v2/webhooks/config", method="PUT", json=body(uuid.uuid4(), "NEW-X"))
        assert other.status_code == 404 == missing.status_code, (other.text[:200], missing.text[:200])
        assert other.json() == missing.json(), "없는 프로젝트와 응답 모양이 달라 존재가 샌다"
        own = await _get(Session, seeded, "/api/v2/webhooks/config", method="PUT", json=body(seeded["pa"], "NEW-A"))
        org_level = await _get(Session, seeded, "/api/v2/webhooks/config", method="PUT", json=body(None, "NEW-ORG"))
        assert own.status_code == 200 and org_level.status_code == 200, (own.text[:200], org_level.text[:200])
        async with Session() as s:
            written = (await s.execute(
                select(func.count()).select_from(WebhookConfig).where(WebhookConfig.url == "https://hooks.example.com/NEW-B")
            )).scalar_one()
        assert written == 0, "접근 못 하는 프로젝트의 웹훅이 저장됐다"
