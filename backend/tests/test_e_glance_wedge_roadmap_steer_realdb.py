"""E-GLANCE wedge #2(story 96b19bc3) — 로드맵 조타(재정렬) + epic.* 이벤트, 실 Postgres 검증.

⭐SEC-S8 하드닝을 처음부터 검증(회귀 아닌 설계 단계 봉인): PATCH /epics/bulk가 round1~8
(W/W2)의 resource-actual project-scope 가드를 그대로 내장했는지 realdb 네거티브 컨트롤로
증명. + list_epics order_by=position 옵트인 정렬 + epic.* 이벤트 발화(webhook 경로,
monkeypatch로 캡처)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org_a(project_a·epic_a1/a2) + org_b(project_x·epic_x1, cross-org 컨트롤용) +
    human_a(project_a에만 grant, org_b 및 project_x 접근권 없음)."""
    from app.models.organization import Organization
    from app.models.pm import Epic
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org_a.id, name="Project B(same org, no access)")
    project_x = Project(id=uuid.uuid4(), org_id=org_b.id, name="Project X(other org)")
    session.add_all([project_a, project_b, project_x])
    await session.commit()

    epic_a1 = Epic(id=uuid.uuid4(), org_id=org_a.id, project_id=project_a.id, title="Epic A1")
    epic_a2 = Epic(id=uuid.uuid4(), org_id=org_a.id, project_id=project_a.id, title="Epic A2")
    epic_b1 = Epic(id=uuid.uuid4(), org_id=org_a.id, project_id=project_b.id, title="Epic B1(same-org other project)")
    epic_x1 = Epic(id=uuid.uuid4(), org_id=org_b.id, project_id=project_x.id, title="Epic X1(cross-org)")
    session.add_all([epic_a1, epic_a2, epic_b1, epic_x1])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_a_id": org_a.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "epic_a1_id": epic_a1.id, "epic_a2_id": epic_a2.id, "epic_b1_id": epic_b1.id, "epic_x1_id": epic_x1.id,
        "human_user_id": human_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_bulk_reorder_own_project_success():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch("/api/v2/epics/bulk", json={
                "items": [
                    {"id": str(seeded["epic_a1_id"]), "position": 10},
                    {"id": str(seeded["epic_a2_id"]), "position": 20},
                ]
            })
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 2
            positions = {item["id"]: item["position"] for item in body}
            assert positions[str(seeded["epic_a1_id"])] == 10
            assert positions[str(seeded["epic_a2_id"])] == 20
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bulk_reorder_cross_org_item_silently_skipped():
    """SEC-S8 W 패턴(cross-org IDOR): org_b의 epic_x1을 org_id=None 필터 없이 org_a 필터로
    조회 실패 → not-found와 동형 조용히 스킵, 나머지 정당 item은 진행."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch("/api/v2/epics/bulk", json={
                "items": [
                    {"id": str(seeded["epic_a1_id"]), "position": 1},
                    {"id": str(seeded["epic_x1_id"]), "position": 99},
                ]
            })
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {item["id"] for item in body}
            assert str(seeded["epic_a1_id"]) in ids
            assert str(seeded["epic_x1_id"]) not in ids
            assert len(body) == 1
        finally:
            await client.aclose()

        # DB 레벨로도 epic_x1.position이 변조 안 됐음을 확인(응답 미포함만으론 부족).
        async with Session() as s2:
            from sqlalchemy import select
            from app.models.pm import Epic
            row = (await s2.execute(select(Epic.position).where(Epic.id == seeded["epic_x1_id"]))).scalar_one()
            assert row is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bulk_reorder_same_org_cross_project_item_silently_skipped():
    """SEC-S8 W2 패턴(same-org cross-project): project_a에만 grant된 휴먼이 같은 org의
    project_b(접근권 없음) epic_b1을 재정렬 시도 → not-found와 동형 조용히 스킵."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch("/api/v2/epics/bulk", json={
                "items": [
                    {"id": str(seeded["epic_a1_id"]), "position": 1},
                    {"id": str(seeded["epic_b1_id"]), "position": 99},
                ]
            })
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {item["id"] for item in body}
            assert str(seeded["epic_a1_id"]) in ids
            assert str(seeded["epic_b1_id"]) not in ids
            assert len(body) == 1
        finally:
            await client.aclose()

        async with Session() as s2:
            from sqlalchemy import select
            from app.models.pm import Epic
            row = (await s2.execute(select(Epic.position).where(Epic.id == seeded["epic_b1_id"]))).scalar_one()
            assert row is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bulk_reorder_fires_single_epic_reordered_event():
    """§2.3: 배치당 1회 발화 — 2건 재정렬해도 fire_webhooks는 정확히 1회."""
    from unittest.mock import AsyncMock, patch

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        webhook = AsyncMock()
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", webhook):
                resp = await client.patch("/api/v2/epics/bulk", json={
                    "items": [
                        {"id": str(seeded["epic_a1_id"]), "position": 1},
                        {"id": str(seeded["epic_a2_id"]), "position": 2},
                    ]
                })
            assert resp.status_code == 200, resp.text
            webhook.assert_awaited_once()
            assert webhook.call_args[0][2] == "epic.reordered"
            payload = webhook.call_args[0][3]
            assert len(payload["items"]) == 2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_epic_status_changed_fires_webhook_via_transition():
    from unittest.mock import AsyncMock, patch

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            from sqlalchemy import update
            from app.models.pm import Epic
            # active→archived는 native 전이(overlay-gate 없음) — human caller로 바로 검증.
            await s.execute(update(Epic).where(Epic.id == seeded["epic_a1_id"]).values(status="active"))
            await s.commit()

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        webhook = AsyncMock()
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", webhook):
                resp = await client.post(
                    f"/api/v2/epics/{seeded['epic_a1_id']}/transition", json={"status": "archived"},
                )
            assert resp.status_code == 200, resp.text
            webhook.assert_awaited_once()
            assert webhook.call_args[0][2] == "epic.status_changed"
            payload = webhook.call_args[0][3]
            assert payload["old_status"] == "active"
            assert payload["status"] == "archived"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_epic_created_fires_webhook():
    from unittest.mock import AsyncMock, patch

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        webhook = AsyncMock()
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", webhook):
                resp = await client.post("/api/v2/epics", json={
                    "project_id": str(seeded["project_a_id"]), "org_id": str(seeded["org_a_id"]),
                    "title": "New Epic",
                })
            assert resp.status_code == 201, resp.text
            webhook.assert_awaited_once()
            assert webhook.call_args[0][2] == "epic.created"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_epic_removed_fires_webhook_with_correct_title():
    from unittest.mock import AsyncMock, patch

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        # delete는 org owner/admin 전용 — human_om role을 owner로 승격.
        async with Session() as s3:
            from sqlalchemy import update
            from app.models.project import OrgMember
            await s3.execute(
                update(OrgMember).where(OrgMember.user_id == seeded["human_user_id"]).values(role="owner")
            )
            await s3.commit()

        client = _client_for(app)
        webhook = AsyncMock()
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", webhook):
                resp = await client.delete(f"/api/v2/epics/{seeded['epic_a1_id']}")
            assert resp.status_code == 200, resp.text
            webhook.assert_awaited_once()
            assert webhook.call_args[0][2] == "epic.removed"
            payload = webhook.call_args[0][3]
            assert payload["epic_title"] == "Epic A1"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_epics_order_by_position_sorts_curated_first():
    """§1.3: position 설정된 에픽이 앞으로(오름차순)·NULL은 뒤로(자동도출 순서 유지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            from sqlalchemy import update
            from app.models.pm import Epic
            # epic_a2를 먼저 큐레이션(position=1)·epic_a1은 NULL(미큐레이션) 유지.
            await s.execute(update(Epic).where(Epic.id == seeded["epic_a2_id"]).values(position=1))
            await s.commit()

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/epics?project_id={seeded['project_a_id']}&order_by=position"
            )
            assert resp.status_code == 200, resp.text
            ids_in_order = [item["id"] for item in resp.json()]
            # position=1인 epic_a2가 NULL인 epic_a1보다 먼저 와야 한다.
            assert ids_in_order.index(str(seeded["epic_a2_id"])) < ids_in_order.index(str(seeded["epic_a1_id"]))
            assert "X-Next-Cursor" not in resp.headers
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_epics_default_order_unchanged_no_position_field_forced():
    """회귀0(#2056 호환): order_by 미지정 시 기존 created_at 정렬 그대로."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/epics?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            assert "X-Next-Cursor" in resp.headers
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_epic_reordered_real_webhook_config_actually_receives_delivery():
    """까심 QA(#2076 REQUEST_CHANGES) #2 요구: fire_webhooks를 mock하지 않고 실 WebhookConfig
    를 시드해 실제 함수(gating 로직 포함)를 그대로 실행 — 오직 네트워크 I/O 경계(httpx POST +
    SSRF DNS 조회)만 캡처/우회한다. 이전 PR의 유닛테스트가 fire_webhooks 자체를 mock해서 empty-
    set 게이팅 버그를 놓쳤던 정확한 갭을 닫는다. member-bound(오르테가류) WebhookConfig가
    epic.reordered 구독 시 **실제로 정확히 1건 배달**됨을 증명(회귀 시 0건)."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.main import app
    from app.models.member import Member
    from app.models.webhook_config import WebhookConfig

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            ortega = Member(id=uuid.uuid4(), org_id=seeded["org_a_id"], type="agent", name="Ortega")
            s.add(ortega)
            await s.commit()
            s.add(WebhookConfig(
                id=uuid.uuid4(), org_id=seeded["org_a_id"], member_id=ortega.id,
                project_id=seeded["project_a_id"], url="https://ortega.example.com/webhook",
                events=["epic.reordered"], channel="generic", is_active=True,
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        captured_posts: list[tuple[str, str]] = []

        async def _fake_post(self, url, *, content=None, headers=None, **kwargs):
            captured_posts.append((url, content))
            return MagicMock(status_code=200)

        try:
            with (
                patch("app.services.webhook_dispatch.validate_webhook_url_async", AsyncMock()),
                patch("httpx.AsyncClient.post", _fake_post),
            ):
                resp = await client.patch("/api/v2/epics/bulk", json={
                    "items": [
                        {"id": str(seeded["epic_a1_id"]), "position": 1},
                        {"id": str(seeded["epic_a2_id"]), "position": 2},
                    ]
                })
            assert resp.status_code == 200, resp.text
            # 핵심 단언: fire_webhooks의 실 gating 로직을 거쳐 실제로 정확히 1건 HTTP POST됐다
            # (버그 상태에선 recipient_member_ids=set()로 인해 이 리스트가 비어 0건).
            assert len(captured_posts) == 1, f"expected exactly 1 real delivery, got {len(captured_posts)}"
            url, body = captured_posts[0]
            assert url == "https://ortega.example.com/webhook"
            assert "epic.reordered" in body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
