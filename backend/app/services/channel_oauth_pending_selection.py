"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Page 연결의
페이지 선택 중간 상태 CRUD. 모듈 설계 근거는 마이그 0342 docstring 참고(중복 0).

삭제는 성공에만(페드루 PO REQUIRED, 2026-09-06) — `/me/accounts` 재호출이 일시
실패(네트워크·Meta 5xx)해도 pending 행을 지우면 사람이 OAuth를 처음부터 다시 해야
한다. 검증 실패(page_id∉candidates·requester 불일치)·Meta 호출 실패 둘 다 행을
유지하고, expires_at(TTL 15분)이 최종 상한 노릇을 한다."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_oauth_pending_selection import ChannelOAuthPendingSelection
from app.services.channel_credential_crypto import encrypt_channel_credential

PENDING_SELECTION_TTL = timedelta(minutes=15)


async def create_pending_selection(
    db: AsyncSession, *, org_id: uuid.UUID, requester_member_id: uuid.UUID, channel: str,
    user_token: str, candidates: list[dict], now: datetime,
) -> ChannelOAuthPendingSelection:
    """candidates=[{"page_id": str, "name": str}, ...] — 페이지 토큰은 여기 안 실림
    (select 단계가 /me/accounts를 재호출해 얻는다)."""
    row = ChannelOAuthPendingSelection(
        id=uuid.uuid4(), org_id=org_id, requester_member_id=requester_member_id, channel=channel,
        encrypted_user_token=encrypt_channel_credential(user_token), candidates=candidates,
        expires_at=now + PENDING_SELECTION_TTL,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def get_pending_selection(
    db: AsyncSession, *, pending_id: uuid.UUID, org_id: uuid.UUID,
) -> ChannelOAuthPendingSelection | None:
    return (await db.execute(
        select(ChannelOAuthPendingSelection).where(
            ChannelOAuthPendingSelection.id == pending_id, ChannelOAuthPendingSelection.org_id == org_id,
        )
    )).scalar_one_or_none()


async def delete_pending_selection(db: AsyncSession, *, pending_id: uuid.UUID) -> None:
    """성공 경로 전용 — 실패·검증거부 경로는 이 함수를 안 부른다(모듈 docstring)."""
    await db.execute(delete(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.id == pending_id))
    await db.commit()


async def sweep_expired_pending_selections(db: AsyncSession, *, now: datetime | None = None) -> int:
    """cron.py `/publication-commands` tick 피기백(새 Cloud Scheduler 잡 0, 3497/3527과
    동형 사상) — expires_at이 지난 행을 지운다. 반환값=삭제 건수(tick 응답 카운트용)."""
    now = now or datetime.now(timezone.utc)
    result = await db.execute(
        delete(ChannelOAuthPendingSelection).where(ChannelOAuthPendingSelection.expires_at <= now)
    )
    await db.commit()
    return result.rowcount or 0
