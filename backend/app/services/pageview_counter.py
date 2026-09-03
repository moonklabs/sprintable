"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — 자체 조회수 카운터 서비스.

org_metering_keys: 공개 키(비밀 아님, 랜딩 JS에 박힘) → org_id 해소.
org_pageview_daily: (org_id, path, day) upsert 집계 — recipe_repeat_schedule.py의 pg_insert
on_conflict_do_update 패턴 재사용(SKIP LOCKED 배치와 별개 축, 여기선 동시 beacon 두 개가
같은 (org, path, day) 행을 만들 때 원자적으로 count+1이 되게 하는 것만 목적)."""
from __future__ import annotations

import secrets
import uuid
from datetime import date as date_type
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_metering_key import OrgMeteringKey
from app.models.org_pageview_daily import OrgPageviewDaily

_KEY_BYTES = 32  # doc_share.py의 secrets.token_urlsafe(32)와 동일 관례


def _generate_public_key() -> str:
    return secrets.token_urlsafe(_KEY_BYTES)


async def get_or_create_active_key(db: AsyncSession, *, org_id: uuid.UUID) -> str:
    """현재 활성 키가 있으면 그대로, 없으면(최초 발급) 새로 만든다. GET(멤버 read)."""
    existing = (await db.execute(
        select(OrgMeteringKey).where(
            OrgMeteringKey.org_id == org_id, OrgMeteringKey.revoked_at.is_(None),
        )
    )).scalar_one_or_none()
    if existing is not None:
        return existing.public_key

    key = OrgMeteringKey(id=uuid.uuid4(), org_id=org_id, public_key=_generate_public_key())
    db.add(key)
    await db.commit()
    return key.public_key


async def rotate_key(db: AsyncSession, *, org_id: uuid.UUID) -> str:
    """옛 활성 키를 즉시 무효화(revoked_at)하고 새 키를 발급한다(owner/admin write)."""
    now = datetime.now(timezone.utc)
    existing = (await db.execute(
        select(OrgMeteringKey).where(
            OrgMeteringKey.org_id == org_id, OrgMeteringKey.revoked_at.is_(None),
        )
    )).scalar_one_or_none()
    if existing is not None:
        existing.revoked_at = now

    key = OrgMeteringKey(id=uuid.uuid4(), org_id=org_id, public_key=_generate_public_key())
    db.add(key)
    await db.commit()
    return key.public_key


async def resolve_org_by_public_key(db: AsyncSession, public_key: str) -> uuid.UUID | None:
    row = (await db.execute(
        select(OrgMeteringKey.org_id).where(
            OrgMeteringKey.public_key == public_key, OrgMeteringKey.revoked_at.is_(None),
        )
    )).scalar_one_or_none()
    return row


async def record_pageview(db: AsyncSession, *, org_id: uuid.UUID, path: str, day: date_type) -> None:
    stmt = pg_insert(OrgPageviewDaily).values(
        id=uuid.uuid4(), org_id=org_id, path=path, day=day, count=1,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_org_pageview_daily_org_path_day",
        set_={"count": OrgPageviewDaily.count + 1, "updated_at": datetime.now(timezone.utc)},
    )
    await db.execute(stmt)
    await db.commit()


async def get_pageviews(
    db: AsyncSession, *, org_id: uuid.UUID, path: str | None, date_from: date_type | None, date_to: date_type | None,
) -> list[OrgPageviewDaily]:
    stmt = select(OrgPageviewDaily).where(OrgPageviewDaily.org_id == org_id)
    if path is not None:
        stmt = stmt.where(OrgPageviewDaily.path == path)
    if date_from is not None:
        stmt = stmt.where(OrgPageviewDaily.day >= date_from)
    if date_to is not None:
        stmt = stmt.where(OrgPageviewDaily.day <= date_to)
    stmt = stmt.order_by(OrgPageviewDaily.day.asc())
    return list((await db.execute(stmt)).scalars().all())
