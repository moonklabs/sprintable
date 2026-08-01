"""#2375 — dispatched Event이 영구 pending으로 쌓이는 근본원인 재현·검산. 실 PG.

양성대조(AC4): 고치기 前엔 payload에 content 키가 없어(어댑터가 ack 前에 조용히 드롭하는
정확한 그 조건) pending에 남고, 고친 뒤엔 content가 채워져 어댑터의 injectable 판정을
통과함을 실측한다. 어댑터(fakechat/server.ts·hermes adapter.py) 자체를 이 테스트에서 구동하진
않지만, 그 두 곳이 실제로 검사하는 조건(`content` 키 존재·non-empty)을 그대로 재사용해 판정한다
— "어댑터가 볼 것"과 "이 테스트가 재는 것"이 같은 필드여야 재현력이 있다.
"""
from __future__ import annotations

import os
import uuid

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


async def _seed_org_project_agent(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent", is_active=True)
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id}


def _adapter_would_ack(payload: dict) -> bool:
    """fakechat/server.ts:218-219·hermes adapter.py:296-299와 동형 판정 —
    두 어댑터 모두 `(data.content ?? payload.content ?? '').strip()`가 비면 ack 前에 return한다.
    이 헬퍼가 그 정확한 조건을 재사용해, "Event가 났다"가 아니라 "어댑터가 실제로 넘어갔을
    자리인가"를 판정한다."""
    content = (payload or {}).get("content") or ""
    return bool(content.strip())


@pytest.mark.anyio
async def test_dispatched_event_payload_carries_content_agent_would_ack():
    """핵심 회귀 케이스 — story 상태변경 dispatched가 agent 수신자에게 갈 때, 그 payload가
    어댑터의 injectable 판정(content non-empty)을 통과해야 한다. 통과 못 하면 정확히 오늘
    #2375 상태(pending 영구 적체)를 재현하는 것이다."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="story.status_changed",
                target_member_ids=[seeded["agent_id"]],
                title="스토리 상태 변경: [결함·BE] ...", body="ready-for-dev → in-progress",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                    Event.event_type == "dispatched",
                )
            )).scalars().all()
            assert len(rows) == 1
            event = rows[0]
            assert event.status == "pending", "이 단계에선 아직 pending이 정상(ack는 어댑터가 함)"

            # AC4 핵심 단언 — 이게 실패하면 #2375가 재현된 것(어댑터가 이 payload를 조용히 드롭)
            assert "content" in event.payload, (
                f"payload에 content 키가 없다 — 어댑터가 ack 없이 드롭해 영구 pending. payload={event.payload}"
            )
            assert _adapter_would_ack(event.payload), (
                f"content가 비어 어댑터 injectable 판정을 통과 못 한다. payload={event.payload}"
            )
            assert event.payload["content"] == event.payload["body"], (
                "body가 있을 땐 content가 body를 그대로 반영해야 한다(title로 뭉개면 안 됨)"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_dispatched_event_falls_back_to_title_when_body_missing():
    """body가 없는 호출(현재도 실제로 존재 — body: str | None = None)에서도 content가
    비지 않아야 한다. title은 필수 파라미터라 항상 non-empty."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="story.status_changed",
                target_member_ids=[seeded["agent_id"]],
                title="스토리 상태 변경: 제목만 있는 경우",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                )
            )).scalars().all()
            assert len(rows) == 1
            event = rows[0]
            assert _adapter_would_ack(event.payload), (
                f"body 없는 호출에서 content가 비었다 — title 폴백이 안 걸렸다. payload={event.payload}"
            )
            assert event.payload["content"] == event.payload["title"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_dispatched_event_gets_recipient_seq_assigned():
    """#2375 후속 회귀 — content를 채워도 recipient_seq가 없으면 이벤트가 여전히 「존재하지만
    도달 불가」다. agent_gateway.py의 /stream 쿼리는 `recipient_seq > :after_seq`로 커서
    필터링해 NULL을 절대 통과시키지 않는다 — 실측(dev, 2026-08-01): content 채운 뒤에도
    agent-recipient dispatched의 delivered 건수가 여전히 0이었던 진짜 근본원인. 이 값이 없으면
    fakechat/hermes 어댑터도 seq=0으로 떨어져 ack을 절대 안 보낸다(#2375 AC5가 고친 그 분기
    자체가 트리거되지 않는다 — seq 0은 애초에 `if seq > 0` 조건을 못 만족)."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="story.status_changed",
                target_member_ids=[seeded["agent_id"]],
                title="스토리 상태 변경: seq 배정 회귀가드", body="ready-for-dev → in-progress",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                )
            )).scalars().all()
            assert len(rows) == 1
            event = rows[0]
            assert event.recipient_seq is not None, (
                "recipient_seq가 NULL — /stream 쿼리(recipient_seq > :after_seq)를 절대 통과 "
                "못 하고, 어댑터도 seq=0으로 ack을 안 보낸다. content가 있어도 영구 도달불가."
            )
            assert event.recipient_seq >= 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_dispatched_recipient_seq_is_dense_per_recipient_across_multiple_dispatches():
    """같은 수신자에게 두 번 dispatch하면 seq가 1, 2로 조밀하게 증가해야 한다(event_seq.py의
    per-recipient counter 계약 — agent_dispatch.py 경로와 동일 SSOT 재사용 확인)."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)

        for i in range(2):
            async with Session() as s:
                await dispatch_notification(
                    s, org_id=seeded["org_id"], event_type="story.status_changed",
                    target_member_ids=[seeded["agent_id"]],
                    title=f"디스패치 {i}", body=f"본문 {i}",
                    source_project_id=seeded["project_id"],
                )
                await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                ).order_by(Event.created_at)
            )).scalars().all()
            assert len(rows) == 2
            seqs = [r.recipient_seq for r in rows]
            assert seqs == [1, 2], f"seq가 조밀하게 증가하지 않음: {seqs}"
    finally:
        await engine.dispose()
