"""E-A2A-완성 S-A4(story 03034d86): SendStreamingMessage — 실 Postgres 검증.

ASGITransport(httpx 테스트용 in-process transport)는 StreamingResponse를 제너레이터
완료 시점까지 통째로 버퍼링해 진짜 incremental 배달을 흉내내지 못한다(실측 확認 — 실 uvicorn
TCP 서버에선 정상 동작). 그래서 이 테스트들은 HTTP 계층을 거치지 않고 `_stream_send_message`가
반환하는 `StreamingResponse.body_iterator`를 직접 순회해 제너레이터 로직 자체를 검증한다
([실증] 실 TCP 서버 E2E는 scratchpad 라이브 스크립트로 별도 완료 — story 8236bbc3 컨벤션:
create_all 자체 스키마 관리)."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _bypass_fk(session) -> None:
    from sqlalchemy import text as _text
    await session.execute(_text("SET session_replication_role = replica"))


def _mock_request() -> MagicMock:
    req = MagicMock()
    req.is_disconnected = AsyncMock(return_value=False)
    return req


def _send_params(text: str) -> dict:
    return {
        "message": {
            "messageId": str(uuid.uuid4()),
            "role": "ROLE_USER",
            "parts": [{"text": text}],
        }
    }


async def _collect_frames(body_iterator, *, max_frames: int) -> list[dict]:
    """`data: {...}\\n\\n` SSE 프레임을 파싱된 dict 리스트로. StopAsyncIteration=스트림 종료."""
    frames = []
    async for chunk in body_iterator:
        for line in chunk.split("\n"):
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: "):]))
        if len(frames) >= max_frames:
            break
    return frames


@pytest.mark.anyio
async def test_streaming_yields_task_then_status_update_then_artifact_on_completion():
    from app.models.team import TeamMember
    from app.routers.a2a import _stream_send_message

    engine, Session = await _session()
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=uuid.uuid4(), type="agent",
                name="Stream Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.commit()
            member_id = member.id

        async with Session() as s:
            m = (await s.execute(
                __import__("sqlalchemy").select(TeamMember).where(TeamMember.id == member_id)
            )).scalar_one()
            resp = await _stream_send_message(
                _mock_request(), "req-1", s, m, org_id, _send_params("stream please"), frozenset(),
            )

        gen = resp.body_iterator
        first = await gen.__anext__()
        assert '"result": {"task"' in first or '"task"' in first
        task_frame = json.loads(first.removeprefix("data: ").strip())
        task_id = uuid.UUID(task_frame["result"]["task"]["id"])
        assert task_frame["result"]["task"]["status"]["state"] == "TASK_STATE_WORKING"

        # "CC의 답신"을 DB에 삽입 — 다음 폴링 tick이 감지하도록.
        from sqlalchemy import select
        from app.models.a2a_task import A2ATask
        from app.models.conversation import ConversationMessage
        async with Session() as s:
            t = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
            s.add(ConversationMessage(
                id=uuid.uuid4(), conversation_id=t.context_id, sender_id=None,
                content="the real reply", thread_id=t.root_message_id,
                created_at=datetime.now(timezone.utc),
            ))
            await s.commit()

        remaining = []
        async for chunk in gen:
            for line in chunk.split("\n"):
                if line.startswith("data: "):
                    remaining.append(json.loads(line[len("data: "):]))
            if len(remaining) >= 2:
                break

        kinds = [next(iter(f["result"].keys())) for f in remaining]
        assert kinds == ["statusUpdate", "artifactUpdate"]
        assert remaining[0]["result"]["statusUpdate"]["status"]["state"] == "TASK_STATE_COMPLETED"
        assert remaining[1]["result"]["artifactUpdate"]["artifact"]["parts"][0]["text"] == "the real reply"

        # 제너레이터가 스스로 종료됐는지(추가 프레임 없이 StopAsyncIteration).
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_streaming_stops_immediately_when_client_disconnects():
    from app.models.team import TeamMember
    from app.routers.a2a import _stream_send_message

    engine, Session = await _session()
    try:
        org_id = uuid.uuid4()
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=uuid.uuid4(), type="agent",
                name="Disconnect Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.commit()

            disconnected_request = MagicMock()
            disconnected_request.is_disconnected = AsyncMock(return_value=True)

            resp = await _stream_send_message(
                disconnected_request, "req-2", s, member, org_id,
                _send_params("nobody's listening"), frozenset(),
            )

        gen = resp.body_iterator
        first = await gen.__anext__()  # task 프레임은 disconnect 체크 이전이라 여전히 옴
        assert '"task"' in first

        # 다음 순회에서 is_disconnected=True라 루프 진입 없이 바로 종료돼야 함.
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_advertises_streaming_true():
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.capabilities.streaming is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_surfaces_persona_model_when_set():
    """방향서 03·에이전트 속성 슬라이스① — AgentPersona.model이 카드 API에 실제로 배관됐는지."""
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember
    from app.models.agent_deployment import AgentPersona

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Model Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()
            persona = AgentPersona(
                id=uuid.uuid4(), org_id=member.org_id, project_id=member.project_id,
                agent_id=member.id, slug="model-card-test",
                name="Model Card Test Persona", is_default=True, model="claude-sonnet-5",
            )
            s.add(persona)
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.model == "claude-sonnet-5"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_model_is_honest_none_when_persona_has_none():
    """no-fiction: 미배정/persona 없음이면 지어내지 않고 None 그대로 노출."""
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="No Persona Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.model is None
        assert card.permission_scope is None
        assert card.expected_cost is None
        assert card.stop_condition is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_surfaces_expected_cost_and_stop_condition_when_declared():
    """방향서 03·에이전트 속성 슬라이스② — 선언 필드(예상 비용·중단 조건) 배관."""
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember
    from app.models.agent_deployment import AgentPersona

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Declared Attrs Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()
            persona = AgentPersona(
                id=uuid.uuid4(), org_id=member.org_id, project_id=member.project_id,
                agent_id=member.id, slug="declared-attrs-test",
                name="Declared Attrs Test Persona", is_default=True,
                expected_cost_note="월 5만원 내외(추정)", stop_condition_note="예산 초과 시 정지",
            )
            s.add(persona)
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.expected_cost == "월 5만원 내외(추정)"
        assert card.stop_condition == "예산 초과 시 정지"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_permission_scope_reflects_active_api_key_not_persona_config():
    """표시 SSOT=ApiKey.scope(실제 집행값) — persona.config.tool_allowlist가 달라도 카드는
    실제 발급된 활성 키의 scope를 보인다(설계 doc §1의 드리프트 경고를 직접 검증)."""
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember
    from app.models.agent_deployment import AgentPersona
    from app.models.api_key import ApiKey

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Scope Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()
            persona = AgentPersona(
                id=uuid.uuid4(), org_id=member.org_id, project_id=member.project_id,
                agent_id=member.id, slug="scope-drift-test", name="Scope Drift Test Persona",
                is_default=True, config={"tool_allowlist": ["stale_persona_only_tool"]},
            )
            s.add(persona)
            key = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_testpfx",
                key_hash="fake-hash-for-test", scope=["real_enforced_tool"],
            )
            s.add(key)
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.permission_scope == ["real_enforced_tool"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_permission_scope_ignores_revoked_key():
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Revoked Key Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()
            revoked = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_revoked",
                key_hash="fake-hash-revoked", scope=["should_not_appear"],
                revoked_at=datetime.now(timezone.utc),
            )
            s.add(revoked)
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.permission_scope is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_permission_scope_unions_multiple_active_keys():
    """카디르 HIGH 재발견(story #2941): 활성 키가 2개 이상일 수 있다(POST /agents/{id}/
    api-keys는 recruit과 달리 기존 활성 키 확인 없이 무조건 신규 발급). "표시=집행값"
    원칙상 어느 한 키만 임의로 보여주면 과소평가 위험 — 전 활성 키 scope의 합집합을 보인다."""
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Multi Key Union Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()
            key_a = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_uniona",
                key_hash="fake-hash-union-a", scope=["read", "write"],
            )
            key_b = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_unionb",
                key_hash="fake-hash-union-b", scope=["deploy"],
            )
            s.add_all([key_a, key_b])
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.permission_scope == ["deploy", "read", "write"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_card_permission_scope_none_when_any_active_key_unrestricted():
    """무제한(scope=None) 활성 키가 하나라도 있으면 좁은 목록으로 과소평가하지 않고
    전체를 None(무제한)으로 표시한다."""
    from app.routers.a2a import _build_agent_card
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey

    engine, Session = await _session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
                name="Unrestricted Key Card Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()
            narrow_key = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_narrow",
                key_hash="fake-hash-narrow", scope=["read"],
            )
            unrestricted_key = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_unres",
                key_hash="fake-hash-unrestricted", scope=None,
            )
            s.add_all([narrow_key, unrestricted_key])
            await s.commit()
            card = await _build_agent_card(s, member, "http://test")
        assert card.permission_scope is None
    finally:
        await engine.dispose()
