"""E-EVENT-1CONFIG + story #2620(P3, DeliveryDecision 단일화): resolve_conversation_webhook_targets SSOT 가드.

이 함수가 SSE-skip covered set 과 실제 webhook delivery 대상의 단일 출처다(TOCTOU 차단).
story #2620부터 「누가 authorized 인가」(멘션/참가자/차단 판정)는 caller가 route_message()의
DeliveryDecision에서 뽑아 `authorized_member_ids`로 넘긴다 — 이 함수 자신은 더 이상 mentioned_ids
판정도 blocker 조회도 하지 않는다(SSE·discord·webhook 셋 다 같은 판정 원천, PO 확定 2026-08-13).

가드: ①sender self-exclusion(방어심층, Finding 2 — route_message가 이미 recipient_ids에서
sender를 빼므로 정상 경로에선 no-op) ②authorized_member_ids 그대로 필터링(caller 위임)
③member-bound project-독립 union ④member_id=null 브로드캐스트 포함하되 covered 엔 미포함
⑤authorized 0건이면 member-global union 쿼리 자체를 안 함.
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
async def test_sender_excluded_even_if_present_in_authorized_defensive():
    """방어심층(Finding 2) — authorized_member_ids에 sender가 섞여 들어와도(정상 경로에선
    route_message가 이미 제외해 안 일어나지만) member-bound 대상에서 빠진다."""
    org, proj, sender, agent_a = (uuid.uuid4() for _ in range(4))
    wh_sender = _wh(sender)
    wh_a = _wh(agent_a)
    wh_bcast = _wh(None)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([wh_sender, wh_a, wh_bcast]),  # project-scope
        _scalars([wh_a]),                       # member-global union(member_id IN [agent_a])
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, org_id=org, project_id=proj,
        sender_id=sender, authorized_member_ids={sender, agent_a},
    )
    member_ids = {t.member_id for t in targets}
    assert sender not in member_ids, "sender는 authorized에 섞여도 방어심층으로 제외(Finding 2)"
    assert agent_a in member_ids
    assert None in member_ids, "member_id=null 브로드캐스트 포함"
    covered = {t.member_id for t in targets if t.member_id is not None}
    assert covered == {agent_a}, "covered 엔 broadcast 미포함·sender 미포함"


@pytest.mark.anyio
async def test_empty_authorized_yields_broadcast_only_no_member_union_query():
    """authorized_member_ids가 비면(route_message가 아무도 못 통과시킨 경우) member-bound
    대상은 없고(broadcast만) member-global union 쿼리 자체를 안 한다(불필요 쿼리 회피)."""
    org, proj, sender = (uuid.uuid4() for _ in range(3))
    wh_bcast = _wh(None)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([wh_bcast]),  # project-scope만 — member-global union은 호출 안 됨
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, org_id=org, project_id=proj,
        sender_id=sender, authorized_member_ids=set(),
    )
    assert {t.member_id for t in targets} == {None}, "broadcast만 — authorized 0건"
    assert db.execute.await_count == 1, "member-global union 쿼리가 스킵돼야(authorized 0건)"


@pytest.mark.anyio
async def test_authorized_member_ids_passthrough_to_project_scope_targets():
    """authorized_member_ids를 그대로 project-scope 게이팅에 쓴다 — caller(route_message
    decisions)가 넘긴 집합이 곧 이 함수의 판정 근거 전부(자체 mentioned_ids/participant
    재조회 없음, story #2620)."""
    org, proj, sender, agent_a = (uuid.uuid4() for _ in range(4))
    wh_a = _wh(agent_a)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([wh_a]),      # project-scope
        _scalars([wh_a]),      # member-global union
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, org_id=org, project_id=proj,
        sender_id=sender, authorized_member_ids={agent_a},
    )
    assert {t.member_id for t in targets} == {agent_a}


@pytest.mark.anyio
async def test_recipient_not_in_authorized_set_is_excluded():
    """story #2349 AC3 계승 — 이제는 「누가 authorized인가」 자체가 caller 책임(route_message가
    이미 blocker/mute/mentions-gate 반영)이라, 이 함수는 authorized_member_ids에 없는 멤버의
    webhook을 project-scope 게이팅에서 그냥 걸러낸다(caller가 안 넘긴 이유는 이 함수가 몰라도
    된다 — 판정 단일화의 핵심)."""
    org, proj, sender, excluded_member, agent_a = (uuid.uuid4() for _ in range(5))
    wh_excluded = _wh(excluded_member)
    wh_a = _wh(agent_a)

    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        _scalars([wh_excluded, wh_a]),  # project-scope — excluded_member는 authorized 밖
        _scalars([wh_a]),               # member-global union
    ]))

    targets = await resolve_conversation_webhook_targets(
        db, org_id=org, project_id=proj,
        sender_id=sender, authorized_member_ids={agent_a},
    )
    member_ids = {t.member_id for t in targets}
    assert excluded_member not in member_ids, "authorized 밖 멤버의 webhook은 제외"
    assert agent_a in member_ids


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
    "'project-wide broadcast webhook' — conversation_webhook.py 핵심 로직, member_id IS "
    "NULL이면 무조건 포함)이 실 스키마에서 NotNullViolationError로 거부된다. baseline/"
    "schema.sql 실측 확인: `member_id uuid NOT NULL`(CREATE TABLE 원문) — ORM 모델"
    "(webhook_config.py: `member_id: Mapped[uuid.UUID]`, Optional 아님)과 생성 스키마"
    "(schemas/webhook_config.py: `member_id: uuid.UUID`, 필수)까지 전부 동일하게 NOT NULL/"
    "필수라 실제 API로 broadcast(member_id=NULL) webhook을 만들 방법 자체가 없다 — 이 AC2 "
    "브랜치는 100% 도달 불가 dead code. 테스트를 고쳐서(real member_id로 치환) 통과시키는 건 "
    "이 발견을 숨기는 것이라 하지 않음 — product 판단(§AC2 폐기 vs member_id nullable 마이그+"
    "생성경로 복구) 필요 — follow-up story 34b3a8fb(E-EVENT-1CONFIG·backlog)로 분리, 그 "
    "story의 결정·구현 완료 후 이 xfail 해소 예정. story 18eefc31 트래킹.",
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
                    db, org_id=org, project_id=proj_x,
                    sender_id=sender, authorized_member_ids={agent_a},
                )
                member_ids = {t.member_id for t in targets}
                assert agent_a in member_ids, "타 프로젝트 member-bound 도 union 으로 covered(project 독립)"
                assert sender not in member_ids, "sender는 authorized에 안 넣었으니 애초에 대상 아님"
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
