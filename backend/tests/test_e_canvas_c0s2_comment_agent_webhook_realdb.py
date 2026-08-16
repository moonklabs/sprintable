"""E-CANVAS C0-S2 (story 8bace49e) — 스토리 코멘트 부활: comment.created가 활성 webhook 보유
에이전트에게 실제 도달(반응 왕복 부활)하는지 실 PG로 실증.

갭(C0-S1 후 실측): dispatch_notification이 agent(활성 webhook)의 Event INSERT는 스킵("외부 채널로
전달" 전제)하나 그 webhook 발송은 휴먼 전용(_deliver_personal_webhooks·m.type!='agent')이라
comment.created가 webhook-agent에 **미도달**(죽은 경로). fix: agent(활성 webhook)도 webhook 발송
(Event-skip 유지·이중배달 0)로 부활.

story #2696: via_outbox 기본값이 True로 바뀌어(outbox 이관) 이 파일이 검증하는 "한 호출 안에서
webhook까지 도달" 전제(_post_with_retry 직접 캡처)가 깨지므로 via_outbox=False를 명시해
즉시-배달 경로를 그대로 검증한다 — 이 파일의 관심사는 라우팅 결정(agent도 대상에 포함되는가·
payload 형식)이지 outbox 자체가 아니다.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

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


_DISCORD_URL = "https://discord.com/api/webhooks/1/agent-relay-token"


async def _seed(session):
    """org + agent Member(활성 webhook·Discord) + 트리거 project."""
    from app.models.member import AgentProjectProfile, Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.webhook_config import WebhookConfig

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Bot")
    session.add(agent)
    await session.commit()
    # 에이전트는 agent_project_profiles로 team_members 뷰에 surface(휴먼=project_access·에이전트=app).
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=agent.id, project_id=project.id))
    await session.commit()
    session.add(WebhookConfig(
        id=uuid.uuid4(), org_id=org.id, member_id=agent.id, url=_DISCORD_URL, events=[], is_active=True,
    ))
    await session.commit()
    return {"org_id": org.id, "agent_id": agent.id, "project_id": project.id}


async def _count_agent_events(Session, agent_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT count(*) FROM events WHERE recipient_id = :a"), {"a": agent_id}
        )).scalar_one()


@pytest.mark.anyio
async def test_comment_created_reaches_agent_webhook():
    """부활 실증: comment.created가 활성 webhook 보유 에이전트의 webhook으로 실제 POST되고(도달),
    Event INSERT는 스킵돼 이중배달이 없다(webhook 단일 채널)."""
    from app.dependencies.database import get_db  # noqa: F401 (ensure app importable)
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        posted: list[tuple] = []

        async def _capture_post(url, payload, secret, member_id):
            posted.append((url, payload, member_id))

        # SSRF 검증은 no-op(로컬 DNS 회피)·POST는 캡처.
        with (
            patch("app.services.dispatch_router._post_with_retry", new=_capture_post),
            patch("app.core.ssrf.validate_webhook_url_async", new=AsyncMock(return_value=None)),
        ):
            async with Session() as s:
                await dispatch_notification(
                    s,
                    org_id=seeded["org_id"],
                    event_type="comment.created",
                    target_member_ids=[seeded["agent_id"]],
                    title="새 코멘트: Story X",
                    body="에이전트 확인 바람",
                    reference_type="story",
                    reference_id=uuid.uuid4(),
                    source_project_id=seeded["project_id"],
                    via_outbox=False,
                )
                await s.commit()

        # ⭐도달: 에이전트 webhook으로 POST됨.
        agent_posts = [p for p in posted if p[0] == _DISCORD_URL]
        assert len(agent_posts) == 1, f"agent webhook 미도달(죽은 경로) — posted={posted}"
        # Discord payload content에 event_type 포함.
        assert "comment.created" in agent_posts[0][1].get("content", "")
        # 이중배달 0: agent Event INSERT는 스킵(webhook만).
        assert await _count_agent_events(Session, seeded["agent_id"]) == 0
    finally:
        await engine.dispose()


_GENERIC_URL = "https://agent-runtime.example.com/inbound/webhook"


@pytest.mark.anyio
async def test_agent_webhook_payload_carries_reaction_context():
    """계약(Ortega判定): generic(에이전트 런타임) webhook payload가 에이전트 반응에 필요한 최소
    맥락(reference_id=story·context{story_id·comment_id·content·author})을 실어 payload만 보고
    답글 달 수 있어야 한다."""
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        from app.models.member import AgentProjectProfile, Member
        from app.models.organization import Organization
        from app.models.project import Project
        from app.models.webhook_config import WebhookConfig

        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
            s.add_all([project, agent])
            await s.commit()
            s.add(AgentProjectProfile(id=uuid.uuid4(), member_id=agent.id, project_id=project.id))
            s.add(WebhookConfig(
                id=uuid.uuid4(), org_id=org.id, member_id=agent.id, url=_GENERIC_URL, events=[], is_active=True,
            ))
            await s.commit()
            agent_id, org_id, project_id = agent.id, org.id, project.id

        posted: list[tuple] = []

        async def _capture_post(url, payload, secret, member_id):
            posted.append((url, payload, member_id))

        story_id, comment_id, author_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        with (
            patch("app.services.dispatch_router._post_with_retry", new=_capture_post),
            patch("app.core.ssrf.validate_webhook_url_async", new=AsyncMock(return_value=None)),
        ):
            async with Session() as s:
                await dispatch_notification(
                    s, org_id=org_id, event_type="comment.created", target_member_ids=[agent_id],
                    title="새 코멘트: Story X", body="확인 바람",
                    reference_type="story", reference_id=story_id, source_project_id=project_id,
                    context={"story_id": str(story_id), "comment_id": str(comment_id),
                             "content": "확인 바람", "author_member_id": str(author_id)},
                             via_outbox=False,
                )
                await s.commit()

        agent_posts = [p for p in posted if p[0] == _GENERIC_URL]
        assert len(agent_posts) == 1, f"agent generic webhook 미도달 — posted={posted}"
        payload = agent_posts[0][1]
        # 계약: reference + 반응 맥락 전부 실림.
        assert payload["event"] == "comment.created"
        assert payload["reference_type"] == "story"
        assert payload["reference_id"] == str(story_id)
        ctx = payload["context"]
        assert ctx["story_id"] == str(story_id)
        assert ctx["comment_id"] == str(comment_id)
        assert ctx["content"] == "확인 바람"
        assert ctx["author_member_id"] == str(author_id)
    finally:
        await engine.dispose()
