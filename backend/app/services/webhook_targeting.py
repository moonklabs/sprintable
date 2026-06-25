"""E-EVENT-1CONFIG: webhook 커버리지 판정 공용 진실원(SSOT).

메시지 경로(`conversations.py`)·`notification_dispatch`가 공유하는 "webhook으로 전달되는
멤버" 판정의 단일 진실원. 이 집합이 곧 내장 SSE enqueue(또는 in-app 알림)를 **스킵**할
멤버 집합 — 같은 메시지를 webhook + SSE 양쪽으로 받는 이중수신을 박멸한다.

## 판정 스코프 (c2dfb823 머지코드 = d21089f1 `deliver_conversation_message_webhook` SSOT)
- **member-bound webhook(member_id != null)** 은 member-global union 쿼리가 ``project_id``
  필터 없이 전달하므로 **project 독립**이다. 즉 멤버가 활성 member-bound webhook 을 가지면
  그 멤버는 어느 프로젝트 대화든 webhook 으로 전달받는다 → webhook-covered.
- **member_id=null 브로드캐스트** 는 특정 멤버의 세션 구동 채널이 아니라 공유 엔드포인트로
  전달된다. 이를 멤버 커버리지로 치면 webhook 없는 agent 의 SSE 까지 꺼져 **silent loss**
  가 발생하므로 이 판정에서 **제외**한다(``member_id`` 가 NULL 이 아닌 행만 본다).

따라서 SSE-skip 판정 = "그 agent 가 활성 member-bound webhook 을 보유"(project 무관)이며,
이는 webhook 실 전달과 정확히 대칭이라 ①이중수신 잔존(너무 좁음) ②silent loss(너무 넓음)
둘 다 없다. notification_dispatch 의 기존 member-only 판정이 보안상 옳았음을 SSOT 로 확정한다.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.webhook_config import WebhookConfig

logger = logging.getLogger(__name__)


async def active_webhook_member_ids(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_ids: Collection[uuid.UUID],
) -> set[uuid.UUID]:
    """``member_ids`` 중 활성 member-bound webhook 보유 멤버 집합(project 독립).

    webhook 으로 전달되는(=내장 SSE/알림 스킵 대상) 멤버를 가린다.

    fail-open: 조회 실패 시 빈 집합을 반환해 **아무도 스킵하지 않는다**. webhook 판정 실패가
    전달 자체를 막으면 안 되므로(SSE 는 항상 살아남아 메시지 누락 0), 예외는 삼키고 경고만 남긴다.

    Args:
        db: async 세션.
        org_id: webhook 을 org 로 스코프(실 전달 predicate 와 대칭·cross-org 격리).
        member_ids: 후보 멤버(보통 인가 수신자=mentioned 우선·없으면 participants).
    """
    candidate_ids = [m for m in member_ids if m is not None]
    if not candidate_ids:
        return set()
    try:
        rows = await db.execute(
            select(WebhookConfig.member_id).where(
                WebhookConfig.org_id == org_id,
                WebhookConfig.member_id.in_(candidate_ids),
                WebhookConfig.is_active.is_(True),
                WebhookConfig.member_id.isnot(None),
            )
        )
        return {row for row in rows.scalars().all()}
    except Exception:
        logger.warning(
            "active_webhook_member_ids lookup failed — no skip applied (fail-open SSE)",
            exc_info=True,
        )
        return set()
