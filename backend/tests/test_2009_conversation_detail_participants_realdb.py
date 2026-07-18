"""story #2009 — GET /api/v2/conversations/{id} participants 필드 realPG 통합 테스트.

배경: list_conversations(GET /conversations?project_id=...)는 participants를 배치 조회해
내려주지만, 단건 get_conversation(GET /conversations/{id})은 그 필드가 없었다. FE는 이를
list 엔드포인트(default limit=30, updated_at desc)를 호출해 client-side `.find()`로 우회
했는데, org 대화가 30건을 넘고 열람 대상이 최근 30건 안에 없으면 `.find()`가 undefined를
반환해 헤더(title/participants/mute)가 영구 공백으로 렌더링되는 실 버그가 있었다(founder
계정 92개 대화 — "채팅이 느리다/깨졌다" 제보의 유력 근본원인으로 지목).

본 테스트가 증명하는 것:
1. **핵심 회귀**: org에 35개+ 대화가 있고, 호출 대상이 top-30-by-updated_at 밖(오래된 대화)
   이어도 GET /conversations/{id} 단건 호출만으로 participants가 정확히 채워진다(더 이상
   list 페이지 위치에 의존하지 않음 — FE workaround 제거 가능).
2. **shape parity**: 같은 대화에 대해 단건 응답의 participants와 list 응답의 participants
   항목이 완전히 동일(추출 리팩터가 두 엔드포인트 간 드리프트를 만들지 않았음 실증).
3. **엣지 케이스**: human+agent 혼합 참가자(type/runtime_type 분기), 그리고 caller 단독
   참가자(추가 participant 0명)인 대화.

`_fetch_conversation_participants` 헬퍼(list_conversations의 기존 배치 로직을 추출한 것)를
get_conversation이 호출하도록 한 리팩터 + `ConversationResponse.participants` 신규 필드를
검증한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
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
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


T0 = datetime(2026, 7, 17, 8, 0, 0, tzinfo=timezone.utc)


def _t(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


async def _make_org_project_member(session, *, name: str = "Me"):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"me-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    me = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_id, name=name)
    session.add(me)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=me.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org": org, "project": project, "user_id": user_id, "member": me}


async def _make_human_member(session, org_id, project_id, *, name: str):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"{name}-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    m = Member(id=uuid.uuid4(), org_id=org_id, type="human", user_id=user_id, name=name)
    session.add(m)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=m.id, permission="granted", role="member",
    ))
    await session.commit()
    return m


async def _make_agent_member(session, org_id, project_id, *, name: str, runtime_type: str | None = "claude_code"):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    a = Member(
        id=uuid.uuid4(), org_id=org_id, type="agent", name=name,
        runtime_type=runtime_type, is_active=True,
    )
    session.add(a)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=a.id, permission="granted", role="member",
    ))
    await session.commit()
    return a


async def _make_conversation(session, org_id, project_id, *, title, created_by, updated_at, participant_ids):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title=title, created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for pid in participant_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=pid))
    await session.commit()

    # updated_at은 server_default(now())라 seed 후 명시 override — 최신순 정렬 시나리오 구성용.
    from sqlalchemy import update as sa_update
    await session.execute(
        sa_update(Conversation).where(Conversation.id == conv.id).values(updated_at=updated_at)
    )
    await session.commit()
    return conv


# ─── 1. 핵심 회귀: 30건 경계 밖 대화도 단건 조회에 participants가 채워진다 ────

@pytest.mark.anyio
async def test_get_conversation_beyond_top30_boundary_has_participants():
    """org에 35개 대화(caller가 전부 참여) 시드 — 가장 오래된(=updated_at 최솟값=list 정렬상
    30번째보다 뒤) 대화 하나를 골라 단건 조회. 과거엔 FE가 list(limit=30, desc)에서 이걸
    못 찾아 참가자를 영영 못 봤다(undefined). 지금은 단건 엔드포인트 자체가 participants를
    포함하므로 list 페이지 위치와 무관하게 정확한 값이 와야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _make_org_project_member(s, name="Me")
            other = await _make_human_member(s, ctx["org"].id, ctx["project"].id, name="Other")

            convs = []
            for i in range(35):
                # updated_at 내림차순 = i가 클수록 최신. i=0이 가장 오래됨(=top-30 밖으로 밀림).
                conv = await _make_conversation(
                    s, ctx["org"].id, ctx["project"].id,
                    title=f"Conv {i}", created_by=ctx["member"].id,
                    updated_at=_t(i),
                    participant_ids=[ctx["member"].id, other.id],
                )
                convs.append(conv)

        # convs[0]이 가장 오래됨(updated_at=_t(0)) → desc 정렬 시 35개 중 인덱스 34(맨 끝),
        # limit=30 기본 페이지에는 절대 안 들어옴(31~35번째 대화 밖).
        target = convs[0]

        await _setup_app_human(app, Session, ctx["user_id"], ctx["org"].id)
        client = _client_for(app)
        try:
            # 사전 확인: 기본 limit=30 list에는 target이 없다(경계 시나리오 실측).
            list_resp = await client.get(
                "/api/v2/conversations", params={"project_id": str(ctx["project"].id)},
            )
            assert list_resp.status_code == 200, list_resp.text
            list_ids = {item["id"] for item in list_resp.json()["data"]}
            assert len(list_resp.json()["data"]) == 30
            assert str(target.id) not in list_ids, (
                "테스트 전제 붕괴: target이 top-30 안에 있음 — 경계 시나리오가 재현 안 됨"
            )

            # 본 fix 검증: 단건 조회만으로 participants가 채워져야 한다.
            resp = await client.get(f"/api/v2/conversations/{target.id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == str(target.id)
            assert "participants" in body
            participant_ids_in_resp = {p["member_id"] for p in body["participants"]}
            assert participant_ids_in_resp == {str(ctx["member"].id), str(other.id)}, body["participants"]
            assert len(body["participants"]) == 2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 2. shape parity: 단건 vs list 항목이 완전히 동일 ────────────────────────

@pytest.mark.anyio
async def test_get_conversation_participants_shape_matches_list_conversations():
    """대화가 list 페이지(top-30) 안에 있을 때, GET /conversations/{id}의 participants와
    GET /conversations?project_id=...의 동일 대화 항목 participants가 완전히 동일해야 한다
    (추출 리팩터가 두 경로 간 드리프트를 만들지 않았음 실증)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _make_org_project_member(s, name="Me")
            other = await _make_human_member(s, ctx["org"].id, ctx["project"].id, name="Other")
            agent = await _make_agent_member(
                s, ctx["org"].id, ctx["project"].id, name="Bot", runtime_type="claude_code",
            )
            conv = await _make_conversation(
                s, ctx["org"].id, ctx["project"].id,
                title="Parity Conv", created_by=ctx["member"].id,
                updated_at=_t(0),
                participant_ids=[ctx["member"].id, other.id, agent.id],
            )

        await _setup_app_human(app, Session, ctx["user_id"], ctx["org"].id)
        client = _client_for(app)
        try:
            get_resp = await client.get(f"/api/v2/conversations/{conv.id}")
            assert get_resp.status_code == 200, get_resp.text
            get_participants = get_resp.json()["participants"]

            list_resp = await client.get(
                "/api/v2/conversations", params={"project_id": str(ctx["project"].id)},
            )
            assert list_resp.status_code == 200, list_resp.text
            list_item = next(
                item for item in list_resp.json()["data"] if item["id"] == str(conv.id)
            )
            list_participants = list_item["participants"]

            def _by_member_id(rows):
                return {r["member_id"]: r for r in rows}

            assert _by_member_id(get_participants) == _by_member_id(list_participants), (
                get_participants, list_participants,
            )
            assert len(get_participants) == 3
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 3. 엣지 케이스: human+agent 혼합 / 참가자 caller 단독(추가 0명) ─────────

@pytest.mark.anyio
async def test_get_conversation_participants_mixed_human_agent_type_and_runtime_type():
    """human+agent 혼합 참가자 — type/runtime_type 분기 실증. human은 runtime_type=None,
    agent는 seed한 runtime_type 값이 그대로 노출돼야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _make_org_project_member(s, name="Me")
            other = await _make_human_member(s, ctx["org"].id, ctx["project"].id, name="Other")
            agent = await _make_agent_member(
                s, ctx["org"].id, ctx["project"].id, name="Bot", runtime_type="claude_code",
            )
            conv = await _make_conversation(
                s, ctx["org"].id, ctx["project"].id,
                title="Mixed Conv", created_by=ctx["member"].id,
                updated_at=_t(0),
                participant_ids=[ctx["member"].id, other.id, agent.id],
            )

        await _setup_app_human(app, Session, ctx["user_id"], ctx["org"].id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{conv.id}")
            assert resp.status_code == 200, resp.text
            by_id = {p["member_id"]: p for p in resp.json()["participants"]}

            assert by_id[str(ctx["member"].id)]["type"] == "human"
            assert by_id[str(ctx["member"].id)]["runtime_type"] is None
            assert by_id[str(other.id)]["type"] == "human"
            assert by_id[str(other.id)]["runtime_type"] is None
            assert by_id[str(agent.id)]["type"] == "agent"
            assert by_id[str(agent.id)]["runtime_type"] == "claude_code"
            assert by_id[str(agent.id)]["name"] == "Bot"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_conversation_participants_caller_only_no_extra_participants():
    """caller 단독 참가(추가 participant 0명) 대화 — participants는 caller 자기 자신 1건만
    (빈 리스트가 아니라 caller 본인 포함 1건)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _make_org_project_member(s, name="Solo")
            conv = await _make_conversation(
                s, ctx["org"].id, ctx["project"].id,
                title="Solo Conv", created_by=ctx["member"].id,
                updated_at=_t(0),
                participant_ids=[ctx["member"].id],
            )

        await _setup_app_human(app, Session, ctx["user_id"], ctx["org"].id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{conv.id}")
            assert resp.status_code == 200, resp.text
            participants = resp.json()["participants"]
            assert len(participants) == 1, participants
            assert participants[0]["member_id"] == str(ctx["member"].id)
            assert participants[0]["type"] == "human"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
