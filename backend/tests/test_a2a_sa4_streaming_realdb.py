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
