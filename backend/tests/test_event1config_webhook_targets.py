"""E-EVENT-1CONFIG: resolve_conversation_webhook_targets SSOT 가드.

이 함수가 SSE-skip covered set 과 실제 webhook delivery 대상의 단일 출처다(TOCTOU 차단).
가드: ①sender self-mention 제외(Finding 2) ②mentioned 우선·없으면 participants(sender 제외)
③member-bound project-독립 union ④member_id=null 브로드캐스트 포함하되 covered 엔 미포함.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.conversation_webhook import (
    _EVENT_TYPE,
    resolve_conversation_webhook_targets,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _wh(member_id, events=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        url=f"https://h/{uuid.uuid4()}",
        secret=None,
        events=events if events is not None else [_EVENT_TYPE],
        member_id=member_id,
    )


def _scalars(rows: list) -> MagicMock:
    r = MagicMock()
    r.scalars.return_value.all.return_value = rows
    return r


@pytest.mark.anyio
async def test_sender_excluded_from_mentioned_finding2():
    """멘션에 sender 가 포함돼도 sender webhook 은 전달 대상 아님(skip authorized set 과 통일)."""
    org, proj, sender, agent_a = (uuid.uuid4() for _ in range(4))
    wh_sender = _wh(sender)
    wh_a = _wh(agent_a)
    wh_bcast = _wh(None)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([wh_sender, wh_a, wh_bcast]),  # project-scope
        _scalars([wh_a]),                       # member-global union(member_id IN [agent_a])
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, conversation_id=uuid.uuid4(), org_id=org, project_id=proj,
        sender_id=sender, mentioned_ids=[sender, agent_a],
    )
    member_ids = {t.member_id for t in targets}
    assert sender not in member_ids, "sender self-mention 제외(Finding 2)"
    assert agent_a in member_ids
    assert None in member_ids, "member_id=null 브로드캐스트 포함"
    covered = {t.member_id for t in targets if t.member_id is not None}
    assert covered == {agent_a}, "covered 엔 broadcast 미포함·sender 미포함"


@pytest.mark.anyio
async def test_mention_only_sender_yields_no_member_target():
    """sender 가 자기만 멘션 → authorized 0 → member-bound 대상 없음(broadcast 만 가능)."""
    org, proj, sender = (uuid.uuid4() for _ in range(3))
    wh_sender = _wh(sender)
    wh_bcast = _wh(None)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([wh_sender, wh_bcast]),  # project-scope: sender 는 authorized 아님→제외, bcast 유지
        # member-global union 은 member_ids_for_webhook=[] 이라 호출 안 됨
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, conversation_id=uuid.uuid4(), org_id=org, project_id=proj,
        sender_id=sender, mentioned_ids=[sender],
    )
    assert {t.member_id for t in targets} == {None}, "broadcast 만 — sender member webhook 제외"


@pytest.mark.anyio
async def test_no_mention_uses_participants_minus_sender():
    """멘션 없으면 참가자(sender 제외) authorized — participant 쿼리 1발 선행."""
    org, proj, conv_id, sender, agent_a = (uuid.uuid4() for _ in range(5))
    wh_a = _wh(agent_a)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([agent_a]),   # participant query (.scalars().all())
        _scalars([wh_a]),      # project-scope
        _scalars([wh_a]),      # member-global union
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, conversation_id=conv_id, org_id=org, project_id=proj,
        sender_id=sender, mentioned_ids=None,
    )
    assert {t.member_id for t in targets} == {agent_a}


# ─── 실DB 전체 predicate (project 독립·sender 제외·broadcast) ──────────────────

_ASYNCPG_URL = (
    os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    or None
)
_requires_db = pytest.mark.skipif(
    not _ASYNCPG_URL, reason="DATABASE_URL not set — real DB test skipped"
)


@_requires_db
@pytest.mark.xfail(
    strict=False,
    reason="story 18eefc31 — 원래 xfail 사유(asyncpg 'attached to a different loop')는 "
    "테스트 전용 엔진으로 전환해 해결됐으나(다른 모든 realdb 테스트와 동일 관례), 그 뒤에서 "
    "별개의 진짜 product 버그가 드러났다: 이 테스트가 만드는 member_id=None 행(§AC2 "
    "'project-wide broadcast webhook' — conversation_webhook.py:149-150,192에 문서화된 "
    "핵심 로직, member_id IS NULL이면 무조건 포함)이 실 스키마에서 NotNullViolationError로 "
    "거부된다. baseline/schema.sql 실측 확인: `member_id uuid NOT NULL`(CREATE TABLE 원문) "
    "— ORM 모델(webhook_config.py: `member_id: Mapped[uuid.UUID]`, Optional 아님)과 "
    "생성 스키마(schemas/webhook_config.py: `member_id: uuid.UUID`, 필수)까지 전부 동일하게 "
    "NOT NULL/필수라 실제 API로 broadcast(member_id=NULL) webhook을 만들 방법 자체가 없다 "
    "— 이 AC2 브랜치는 100% 도달 불가 dead code. 테스트를 고쳐서(real member_id로 치환) "
    "통과시키는 건 이 발견을 숨기는 것이라 하지 않음 — product 판단(§AC2 폐기 vs "
    "member_id nullable 마이그+생성경로 복구) 필요 — follow-up story 34b3a8fb(E-EVENT-1CONFIG·"
    "backlog)로 분리, 그 story 의 결정·구현 완료 후 이 xfail 해소 예정. story 18eefc31 트래킹.",
)
@pytest.mark.anyio
async def test_resolve_predicate_realdb():
    """실DB: member-bound project-독립 union·sender 제외·broadcast 포함.

    story 18eefc31: `app.core.database.async_session_factory`(프로덕션 전역 엔진, import 시
    1회 생성)를 쓰면 pytest-asyncio의 함수-스코프 이벤트루프와 부딪힌다 — 커넥션 풀이 처음
    쓰인 루프에 바인딩되고, 같은 프로세스에서 다른 테스트가 새 루프로 그 풀을 재사용하려
    하면 asyncpg가 "attached to a different loop"로 죽는다(story 8236bbc3 e2e서 84개
    realdb 파일을 한 세션에 몰아 돌리며 실제로 재현·격리 시엔 안 남). 다른 모든 realdb
    테스트가 쓰는 관례(테스트 전용 엔진을 만들고 끝에 dispose)로 맞췄다 — 그 뒤 드러난 진짜
    product 버그(§AC2 broadcast dead code)는 위 xfail 사유 참고."""
    from app.models.webhook_config import WebhookConfig
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    org = uuid.uuid4()
    proj_x, proj_y = uuid.uuid4(), uuid.uuid4()
    sender, agent_a = uuid.uuid4(), uuid.uuid4()

    engine = create_async_engine(_ASYNCPG_URL.replace("postgresql://", "postgresql+asyncpg://"))
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as db:
            # agent_a webhook 은 proj_y 스코프(메시지는 proj_x) — project 독립 union 검증
            db.add_all([
                WebhookConfig(id=uuid.uuid4(), org_id=org, project_id=proj_y,
                              member_id=agent_a, url="https://h/a", is_active=True,
                              events=[_EVENT_TYPE]),
                WebhookConfig(id=uuid.uuid4(), org_id=org, project_id=proj_x,
                              member_id=sender, url="https://h/s", is_active=True,
                              events=[_EVENT_TYPE]),
                WebhookConfig(id=uuid.uuid4(), org_id=org, project_id=proj_x,
                              member_id=None, url="https://h/b", is_active=True,
                              events=[_EVENT_TYPE]),
            ])
            await db.commit()
            try:
                targets = await resolve_conversation_webhook_targets(
                    db, conversation_id=uuid.uuid4(), org_id=org, project_id=proj_x,
                    sender_id=sender, mentioned_ids=[sender, agent_a],
                )
                member_ids = {t.member_id for t in targets}
                assert agent_a in member_ids, "타 프로젝트 member-bound 도 union 으로 covered(project 독립)"
                assert sender not in member_ids, "sender 제외(Finding 2)"
                assert None in member_ids, "broadcast 포함"
            finally:
                for mid in (agent_a, sender):
                    await db.execute(
                        WebhookConfig.__table__.delete().where(WebhookConfig.member_id == mid)
                    )
                await db.execute(
                    WebhookConfig.__table__.delete().where(
                        WebhookConfig.org_id == org, WebhookConfig.member_id.is_(None)
                    )
                )
                await db.commit()
    finally:
        await engine.dispose()
