"""E-CAGE-REFEREE P1: verdict 내부 기록 서비스.

에이전트 자기 verdict 수동기록 공개 API 차단 — 이 함수만 사용.
게이밍·누락 방지. 신뢰 재는 데이터부터 신뢰가능해야 함.

result=null 허용: 미측정 소스는 null 유지 (거짓 pass/fail 금지).
uq(participation_id, source) 기반 upsert — 멱등 재기록.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.verdict import Verdict


async def record_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    participation_id: uuid.UUID,
    source: str,
    result: str | None,
    rounds: int | None = None,
) -> Verdict:
    """participation + source 쌍으로 verdict upsert.

    이미 존재하면 result·rounds·recorded_at 갱신.
    없으면 신규 생성.
    result=None → 미측정 유지 (거짓 채점 금지).
    """
    now = datetime.now(timezone.utc)

    existing = await session.execute(
        select(Verdict).where(
            Verdict.org_id == org_id,
            Verdict.participation_id == participation_id,
            Verdict.source == source,
        )
    )
    verdict = existing.scalar_one_or_none()

    if verdict is not None:
        verdict.result = result
        verdict.rounds = rounds
        verdict.recorded_at = now
    else:
        verdict = Verdict(
            id=uuid.uuid4(),
            org_id=org_id,
            participation_id=participation_id,
            source=source,
            result=result,
            rounds=rounds,
            recorded_at=now,
        )
        session.add(verdict)

    await session.flush()
    await session.refresh(verdict)
    return verdict


async def get_verdicts_by_participation(
    session: AsyncSession,
    org_id: uuid.UUID,
    participation_id: uuid.UUID,
) -> list[Verdict]:
    result = await session.execute(
        select(Verdict).where(
            Verdict.org_id == org_id,
            Verdict.participation_id == participation_id,
        )
    )
    return list(result.scalars().all())
