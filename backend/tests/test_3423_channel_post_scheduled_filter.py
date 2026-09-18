"""story #3423(Phase1·마케팅운영·소형, 페드루 PO 確定 2026-09-04) — channel-posts 목록에
예약 시각 날짜 범위 필터(`scheduled_from`/`scheduled_to`)와 「날짜 미정」 필터
(`unscheduled=true`) 추가. 캘린더 화면(#3422) 선행 — 클라이언트 전량 조회 금지.

AC 요지:
- 기준 컬럼은 `gate.sealed_scheduled_at`(승인된 예약 시각) — `publication_command.
  scheduled_at`(요청 시점 스냅샷, #3414)이 아니다.
- `unscheduled`와 범위 파라미터는 상호 배타(422).
- `scheduled_from > scheduled_to`면 422. naive datetime(tz 정보 없음)도 422.
- 필터가 하나도 없으면 기존 응답과 완전히 동일해야 한다(회귀 0).
- 기존 6쿼리 구조 유지(N+1 금지) — 필터는 페이지 쿼리 자체에 gate 조인으로 들어간다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="3423 Scheduled Filter Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="담롱"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="채널 포스트"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_connection(session, org_id, *, channel="threads", status="active", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(*, work_item_id, connection_id, text="채널 포스트 본문입니다."):
    return {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": text}


async def _create_draft_submit_approve(
    client, session, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다.",
    scheduled_at: datetime | None = None,
):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json=_draft_body(work_item_id=story_id, connection_id=connection_id, text=text),
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    submit_body = {}
    if scheduled_at is not None:
        submit_body["scheduled_at"] = scheduled_at.isoformat()
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json=submit_body,
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(session, gate_id)
    return draft_id, gate_id


def _ids(items):
    return {it["draft_id"] for it in items}


@pytest.mark.anyio
async def test_no_filter_response_unchanged():
    """AC3 회귀 — 필터 파라미터를 아예 안 주면 기존 응답과 완전히 동일(정렬·전체 목록)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_a, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="A"),
                scheduled_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
            draft_b, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="B"),
            )

            r_no_filter = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            r_explicit_none = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"limit": 50, "offset": 0},
            )
        assert r_no_filter.status_code == 200, r_no_filter.text
        assert r_no_filter.json() == r_explicit_none.json()
        assert _ids(r_no_filter.json()) == {draft_a, draft_b}
        # 기본 정렬(최근 편집순 = created_at desc) — draft_b가 나중에 만들어졌으니 먼저.
        order = [it["draft_id"] for it in r_no_filter.json()]
        assert order.index(draft_b) < order.index(draft_a)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduled_range_filters_by_gate_sealed_scheduled_at():
    """AC1 핵심 — 범위 안의 gate.sealed_scheduled_at만 걸린다(다른 draft·미정 draft 제외)."""
    from app.main import app

    now = datetime.now(timezone.utc)
    in_range = now + timedelta(days=3)
    out_of_range = now + timedelta(days=30)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_in, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="in-range"),
                scheduled_at=in_range,
            )
            draft_out, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="out-of-range"),
                scheduled_at=out_of_range,
            )
            draft_unset, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="unset"),
            )

            r = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={
                    "scheduled_from": (now + timedelta(days=1)).isoformat(),
                    "scheduled_to": (now + timedelta(days=7)).isoformat(),
                },
            )
        assert r.status_code == 200, r.text
        assert _ids(r.json()) == {draft_in}, (
            f"범위 필터가 정확하지 않다: {_ids(r.json())} (기대: {{draft_in}}, "
            f"out={draft_out}, unset={draft_unset})"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduled_from_equals_to_matches_exact_instant():
    """AC3 경계 — from=to(같은 시각)면 정확히 그 시각인 draft만(포함 양끝)."""
    from app.main import app

    pinned = datetime.now(timezone.utc) + timedelta(days=2)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_pinned, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="pinned"),
                scheduled_at=pinned,
            )
            draft_off_by_one_sec, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="off-by-1s"),
                scheduled_at=pinned + timedelta(seconds=1),
            )

            r = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"scheduled_from": pinned.isoformat(), "scheduled_to": pinned.isoformat()},
            )
        assert r.status_code == 200, r.text
        assert _ids(r.json()) == {draft_pinned}
        assert draft_off_by_one_sec not in _ids(r.json())
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unscheduled_filter_matches_null_sealed_scheduled_at_including_no_gate():
    """AC1 — unscheduled=true는 sealed_scheduled_at IS NULL인 draft만: 예약 없이 상신된
    것뿐 아니라 **게이트조차 없는 순수 초안**도 포함(둘 다 「날짜 미정」, 유나 §11-1)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_scheduled, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="scheduled"),
                scheduled_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
            draft_submitted_unset, _ = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="submitted-unset"),
            )
            # 순수 초안(상신조차 안 함 — 게이트 자체가 없다).
            r_pure_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(
                    work_item_id=await _seed_story(s, org_id, project_id, title="pure-draft"),
                    connection_id=connection_id,
                ),
            )
            assert r_pure_draft.status_code == 201, r_pure_draft.text
            draft_pure = r_pure_draft.json()["draft_id"]

            r = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"unscheduled": "true"},
            )
        assert r.status_code == 200, r.text
        assert _ids(r.json()) == {draft_submitted_unset, draft_pure}, (
            f"unscheduled 필터 결과가 어긋남: {_ids(r.json())}"
        )
        assert draft_scheduled not in _ids(r.json())
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unscheduled_and_range_together_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, _project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={
                    "unscheduled": "true",
                    "scheduled_from": datetime.now(timezone.utc).isoformat(),
                },
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_POST_LIST_FILTER_CONFLICT"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduled_from_after_to_returns_422():
    from app.main import app

    now = datetime.now(timezone.utc)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, _project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={
                    "scheduled_from": (now + timedelta(days=5)).isoformat(),
                    "scheduled_to": now.isoformat(),
                },
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_POST_LIST_FILTER_RANGE_INVALID"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_naive_datetime_returns_422():
    """AC1 — tz 정보 없는 scheduled_from은 422(naive/aware 비교가 항상 어긋나는 함정,
    #3414 nit J와 동일 사상)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, _project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"scheduled_from": "2026-09-10T00:00:00"},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_POST_LIST_FILTER_NAIVE_DATETIME"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _count_selects_for_filtered_list(client, engine, org_id, *, params):
    from sqlalchemy import event

    statements: list[str] = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", _listener)
    try:
        r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts", params=params)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _listener)
    assert r.status_code == 200, r.text
    select_count = len([st for st in statements if st.strip().upper().startswith("SELECT")])
    return r.json(), select_count


@pytest.mark.anyio
async def test_filtered_query_count_flat_no_n_plus_one():
    """AC2 — 필터가 활성일 때 SELECT 수가 draft 개수와 무관하게 고정(N+1 금지).
    doc상 "총 6쿼리"는 published 상태 draft가 있을 때의 상한(배치⑤ published_publication
    본문해시 조회가 published_version_ids가 비면 조건부로 스킵된다 — 배치 수 자체가
    draft 수에 비례해 늘지 않는다는 것이 진짜 불변식이므로, 1건 vs 3건 draft를 필터
    활성 상태로 같이 재고 쿼리 수가 같은지로 검증한다(매직넘버 6 고정 대신)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        filter_params = {
            "scheduled_from": (datetime.now(timezone.utc)).isoformat(),
            "scheduled_to": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        }

        async with _client_for(app) as client, Session() as s:
            await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id,
                story_id=await _seed_story(s, org_id, project_id, title="one-draft"),
                scheduled_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
            items_1, select_count_1 = await _count_selects_for_filtered_list(
                client, engine, org_id, params=filter_params,
            )
            assert len(items_1) == 1

            for n in range(3):
                await _create_draft_submit_approve(
                    client, s, org_id=org_id, connection_id=connection_id,
                    story_id=await _seed_story(s, org_id, project_id, title=f"more-{n}"),
                    scheduled_at=datetime.now(timezone.utc) + timedelta(days=1),
                )
            items_4, select_count_4 = await _count_selects_for_filtered_list(
                client, engine, org_id, params=filter_params,
            )
            assert len(items_4) == 4

        print(f"\n=== N+1 실측(필터 활성): 1건 SELECT={select_count_1}, 4건 SELECT={select_count_4}")
        assert select_count_1 == select_count_4, (
            f"draft 수가 늘자 쿼리 수도 늘었다(N+1 의심): 1건={select_count_1}, 4건={select_count_4}"
        )
        assert select_count_1 >= 3, "쿼리가 너무 적다 — listener가 아무것도 못 잡았을 가능성"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
