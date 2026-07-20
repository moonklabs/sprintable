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
    from app.models.pm import Goal
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

    epic_a1 = Goal(id=uuid.uuid4(), org_id=org_a.id, project_id=project_a.id, title="Epic A1")
    epic_a2 = Goal(id=uuid.uuid4(), org_id=org_a.id, project_id=project_a.id, title="Epic A2")
    epic_b1 = Goal(id=uuid.uuid4(), org_id=org_a.id, project_id=project_b.id, title="Epic B1(same-org other project)")
    epic_x1 = Goal(id=uuid.uuid4(), org_id=org_b.id, project_id=project_x.id, title="Epic X1(cross-org)")
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
            from app.models.pm import Goal
            row = (await s2.execute(select(Goal.position).where(Goal.id == seeded["epic_x1_id"]))).scalar_one()
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
            from app.models.pm import Goal
            row = (await s2.execute(select(Goal.position).where(Goal.id == seeded["epic_b1_id"]))).scalar_one()
            assert row is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bulk_reorder_emits_no_event_draft_model():
    """⭐STEER 커밋 모델(ff662876·선생님 재정의): 드래그(PATCH /epics/bulk)는 **이벤트 0**이다.
    인간이 로드맵을 번복하는 초안 사고과정이 실시간 이벤트로 새면 안 되므로, bulk는 position만
    저장하고 아무 웹훅도 발화하지 않는다(fire_webhooks 미호출). 이벤트는 steer-dispatch에서만."""
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
            # 드래그=무이벤트: fire_webhooks가 한 번도 안 불려야 한다.
            webhook.assert_not_awaited()
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
            from app.models.pm import Goal
            # active→archived는 native 전이(overlay-gate 없음) — human caller로 바로 검증.
            await s.execute(update(Goal).where(Goal.id == seeded["epic_a1_id"]).values(status="active"))
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
            from app.models.pm import Goal
            # epic_a2를 먼저 큐레이션(position=1)·epic_a1은 NULL(미큐레이션) 유지.
            await s.execute(update(Goal).where(Goal.id == seeded["epic_a2_id"]).values(position=1))
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
async def _seed_owner_and_orchestrator(s, seeded):
    """⭐feedback_seed_masks_realdata_assumption 반영: owner(사람·role='owner'=실 relay-owner)와
    orchestrator(별개 에이전트·role='member')를 **분리 시드**한다. 실데이터(송윤재=사람 owner,
    오르테가=member 에이전트)와 동형. 둘 다 epic.reordered 구독 웹훅 보유 — 인간이 recipient로
    orchestrator를 명시하면 orchestrator에게만 배달되고 relay-owner(사람)에겐 0건임을 실증
    (BE가 relay-owner를 추측하지 않음·선생님 B). 반환=(owner canonical member id, orchestrator id)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.webhook_config import WebhookConfig

    # 사람 owner — resolve_project_relay_owner가 이 사람으로 해소(우선순위1 project_access owner).
    owner_uid = uuid.uuid4()
    s.add(User(id=owner_uid, email=f"owner-{owner_uid.hex[:8]}@test.com", hashed_password="x"))
    await s.commit()
    owner_om = OrgMember(id=uuid.uuid4(), org_id=seeded["org_a_id"], user_id=owner_uid, role="member")
    s.add(owner_om)
    await s.commit()
    s.add(ProjectAccess(
        id=uuid.uuid4(), project_id=seeded["project_a_id"], org_member_id=owner_om.id,
        permission="granted", role="owner",
    ))
    s.add(WebhookConfig(
        id=uuid.uuid4(), org_id=seeded["org_a_id"], member_id=owner_om.id,
        project_id=seeded["project_a_id"], url="https://human-owner.example.com/webhook",
        events=["epic.reordered"], channel="generic", is_active=True,
    ))
    await s.commit()

    # orchestrator 에이전트 — 인간이 커밋 시 지정할 수신자(role='member'·owner 아님).
    orch = Member(id=uuid.uuid4(), org_id=seeded["org_a_id"], type="agent", name="Ortega")
    s.add(orch)
    await s.commit()
    s.add(ProjectAccess(
        id=uuid.uuid4(), project_id=seeded["project_a_id"], member_id=orch.id,
        permission="granted", role="member",
    ))
    s.add(WebhookConfig(
        id=uuid.uuid4(), org_id=seeded["org_a_id"], member_id=orch.id,
        project_id=seeded["project_a_id"], url="https://ortega.example.com/webhook",
        events=["epic.reordered"], channel="generic", is_active=True,
    ))
    await s.commit()
    return owner_om.id, orch.id


async def test_steer_dispatch_delivers_only_to_human_specified_recipient_not_relay_owner():
    """⭐STEER 커밋(선생님 B): 드래그(/bulk) 저장 뒤 명시적 커밋(POST /steer-dispatch)에서만 발화.
    수신자는 **커밋한 인간이 명시**한 orchestrator(별개 에이전트)로 게이팅한다. 실 relay-owner는
    사람 owner(role='owner')지만 BE는 relay-owner를 추측하지 않으므로 **사람 owner에겐 배달 0**·
    지정된 orchestrator에게만 1건. owner≠orchestrator 분리 시드로 seed-마스킹 갭을 닫는다
    ([[feedback_seed_masks_realdata_assumption]]). 실 WebhookConfig+실 gating(네트워크 I/O만 우회)."""
    from unittest.mock import AsyncMock, MagicMock, patch
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            _owner_mid, orch_id = await _seed_owner_and_orchestrator(s, seeded)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        captured_posts: list[tuple[str, str]] = []

        import httpx
        _orig_post = httpx.AsyncClient.post

        async def _fake_post(self, url, **kwargs):
            # 웹훅 배달(외부 URL)만 캡처·우회. 테스트 클라이언트의 POST(/steer-dispatch·http://test)는
            # 실제 ASGI로 위임해야 엔드포인트 응답이 정상 반환된다(AsyncClient.post 전역 패치 함정).
            if "example.com" in str(url):
                captured_posts.append((str(url), kwargs.get("content")))
                return MagicMock(status_code=200)
            return await _orig_post(self, url, **kwargs)

        try:
            # 1) 드래그 저장(초안·무이벤트)
            with patch("app.services.webhook_dispatch.fire_webhooks", AsyncMock()) as wh:
                r1 = await client.patch("/api/v2/epics/bulk", json={"items": [
                    {"id": str(seeded["epic_a1_id"]), "position": 1},
                    {"id": str(seeded["epic_a2_id"]), "position": 2},
                ]})
                assert r1.status_code == 200, r1.text
                wh.assert_not_awaited()  # 드래그=무이벤트

            # 2) 명시적 커밋 — 인간이 orchestrator(에이전트)를 recipient로 지정(relay-owner=사람 아님).
            with (
                patch("app.services.webhook_dispatch.validate_webhook_url_async", AsyncMock()),
                patch("httpx.AsyncClient.post", _fake_post),
            ):
                r2 = await client.post("/api/v2/epics/steer-dispatch", json={
                    "items": [
                        {"id": str(seeded["epic_a1_id"]), "position": 1},
                        {"id": str(seeded["epic_a2_id"]), "position": 2},
                    ],
                    "recipient_member_ids": [str(orch_id)],
                })
            assert r2.status_code == 200, r2.text
            assert r2.json()["recipient_member_ids"] == [str(orch_id)]
            # 게이팅 실증: 지정 orchestrator에게만 1건·사람 owner(relay-owner)에겐 0건(추측 폴백 없음).
            assert len(captured_posts) == 1, f"expected 1 delivery(specified recipient only), got {len(captured_posts)}"
            url, body = captured_posts[0]
            assert url == "https://ortega.example.com/webhook"
            assert "epic.reordered" in body
            assert not any("human-owner" in u for u, _ in captured_posts), "relay-owner(사람)에게 새면 안 됨"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_steer_dispatch_requires_recipient_member_ids_400():
    """선생님 B: recipient_member_ids 필수 — None(미지정) 또는 빈 리스트면 400. BE가 relay-owner를
    추측하지 않으므로(보편적 오케스트레이터란 없다) 인간이 반드시 수신자를 지정해야 한다."""
    from unittest.mock import AsyncMock, patch
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", AsyncMock()) as wh:
                await client.patch("/api/v2/epics/bulk", json={"items": [{"id": str(seeded["epic_a1_id"]), "position": 1}]})
                # recipient 미지정 → 400
                r_none = await client.post("/api/v2/epics/steer-dispatch", json={
                    "items": [{"id": str(seeded["epic_a1_id"]), "position": 1}],
                })
                # recipient 빈 리스트 → 400
                r_empty = await client.post("/api/v2/epics/steer-dispatch", json={
                    "items": [{"id": str(seeded["epic_a1_id"]), "position": 1}],
                    "recipient_member_ids": [],
                })
            assert r_none.status_code == 400, r_none.text
            assert r_empty.status_code == 400, r_empty.text
            wh.assert_not_awaited()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_steer_dispatch_cross_project_epic_blocked_403():
    """신규 mutation 인가표면(add_feedback 교훈): 대상 epic이 caller 무접근 project(같은 org
    project_b)면 has_project_access resource-actual 가드로 403 — 이벤트 발화 없음."""
    from unittest.mock import AsyncMock, patch
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", AsyncMock()) as wh:
                resp = await client.post("/api/v2/epics/steer-dispatch", json={
                    "items": [{"id": str(seeded["epic_b1_id"]), "position": 1}],
                })
            assert resp.status_code == 403, resp.text
            wh.assert_not_awaited()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_steer_dispatch_cross_org_recipient_injection_blocked_400():
    """⭐recipient 인가표면: recipient_member_ids에 caller org 소속 아닌 member id를 주입하면
    400(resolve_member_identity가 org에서 미해소) — cross-org 조타 배달 주입 차단(body-claimed 금지).
    가드가 없으면 임의 org 밖 member로 조타 이벤트를 배달시킬 수 있다."""
    from unittest.mock import AsyncMock, patch
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            # epic_a1 position을 1로 저장(정합검증 통과용)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", AsyncMock()) as wh:
                await client.patch("/api/v2/epics/bulk", json={"items": [{"id": str(seeded["epic_a1_id"]), "position": 1}]})
                resp = await client.post("/api/v2/epics/steer-dispatch", json={
                    "items": [{"id": str(seeded["epic_a1_id"]), "position": 1}],
                    "recipient_member_ids": [str(uuid.uuid4())],  # org에 없는 member
                })
            assert resp.status_code == 400, resp.text
            wh.assert_not_awaited()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_steer_dispatch_position_snapshot_conflict_409():
    """Q1 서버 정합검증: 커밋 스냅샷 position이 저장된 draft와 다르면 409(미저장/경합) —
    커밋은 저장된 확定 상태의 전달이지 재-write가 아니다. 이벤트 발화 없음."""
    from unittest.mock import AsyncMock, patch
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            with patch("app.services.webhook_dispatch.fire_webhooks", AsyncMock()) as wh:
                await client.patch("/api/v2/epics/bulk", json={"items": [{"id": str(seeded["epic_a1_id"]), "position": 1}]})
                # 저장은 1인데 커밋 스냅샷은 99 → 409
                resp = await client.post("/api/v2/epics/steer-dispatch", json={
                    "items": [{"id": str(seeded["epic_a1_id"]), "position": 99}],
                })
            assert resp.status_code == 409, resp.text
            wh.assert_not_awaited()
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
