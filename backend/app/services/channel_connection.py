"""story #3373(Phase1·마케팅운영) — channel_connections CRUD·업서트·만료 갱신 비즈니스 로직.
암호화는 channel_credential_crypto.py에만 위임 — 이 파일은 평문 토큰을 오래 들고 있지 않는다
(encrypt 직전/decrypt 직후에만 존재, 즉시 사용·즉시 폐기)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_connection import ChannelConnection
from app.services.channel_credential_crypto import decrypt_channel_credential, encrypt_channel_credential

# 만료 임박 임계값(cron이 이보다 이내로 남은 active 연결을 갱신 대상으로 본다) — 설정값
# (story AC 명시, 코드 상수로 시작 — 조직별로 달라질 필요가 생기면 그때 org 설정으로 승격).
REFRESH_LEAD_TIME = timedelta(hours=48)


class ChannelConnectionNotFoundError(Exception):
    def __init__(self, connection_id: uuid.UUID | None = None):
        self.connection_id = connection_id
        super().__init__(f"channel connection을 찾을 수 없습니다: {connection_id}")


async def list_channel_connections(db: AsyncSession, *, org_id: uuid.UUID) -> list[ChannelConnection]:
    stmt = (
        select(ChannelConnection)
        .where(ChannelConnection.org_id == org_id)
        .order_by(ChannelConnection.created_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_channel_connection(
    db: AsyncSession, *, org_id: uuid.UUID, connection_id: uuid.UUID,
) -> ChannelConnection | None:
    return (await db.execute(
        select(ChannelConnection).where(
            ChannelConnection.id == connection_id, ChannelConnection.org_id == org_id,
        )
    )).scalar_one_or_none()


async def upsert_channel_connection(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    channel: str,
    account_id: str,
    account_label: str | None,
    credential_kind: str,
    access_token: str | None,
    refresh_token: str | None,
    token_expires_at: datetime | None,
    refresh_mode: str,
    scopes: list,
    connected_by: uuid.UUID,
) -> ChannelConnection:
    """AC8 — 같은 (org, channel, account_id) 재연결은 새 행이 아니라 기존 행 upsert·
    status='active' 복귀(예: revoked 상태에서 재연결해도 다시 active로 돌아온다)."""
    existing = (await db.execute(
        select(ChannelConnection)
        .where(
            ChannelConnection.org_id == org_id, ChannelConnection.channel == channel,
            ChannelConnection.account_id == account_id,
        )
        .with_for_update()
    )).scalar_one_or_none()

    encrypted_access_token = encrypt_channel_credential(access_token) if access_token else None
    encrypted_refresh_token = encrypt_channel_credential(refresh_token) if refresh_token else None

    if existing is None:
        row = ChannelConnection(
            id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=account_id,
            account_label=account_label, credential_kind=credential_kind,
            encrypted_access_token=encrypted_access_token, encrypted_refresh_token=encrypted_refresh_token,
            token_expires_at=token_expires_at, refresh_mode=refresh_mode, scopes=scopes,
            status="active", connected_by=connected_by,
        )
        db.add(row)
    else:
        existing.account_label = account_label
        existing.credential_kind = credential_kind
        existing.encrypted_access_token = encrypted_access_token
        existing.encrypted_refresh_token = encrypted_refresh_token
        existing.token_expires_at = token_expires_at
        existing.refresh_mode = refresh_mode
        existing.scopes = scopes
        existing.status = "active"
        existing.last_error = None
        existing.connected_by = connected_by
        row = existing

    await db.commit()
    await db.refresh(row)
    return row


async def revoke_channel_connection(
    db: AsyncSession, *, org_id: uuid.UUID, connection_id: uuid.UUID,
) -> ChannelConnection:
    """AC5 — 즉시 status=revoked(행 보존·토큰 파기). 파기는 컬럼을 NULL로 지운다(암호문이라도
    안 남기는 편이 안전 — 이후 이 연결로의 발행은 status 자체로 막히므로 토큰 필요가 없다)."""
    row = await get_channel_connection(db, org_id=org_id, connection_id=connection_id)
    if row is None:
        raise ChannelConnectionNotFoundError(connection_id)
    row.status = "revoked"
    row.encrypted_access_token = None
    row.encrypted_refresh_token = None
    await db.commit()
    await db.refresh(row)
    return row


async def list_connections_due_for_refresh(db: AsyncSession, *, now: datetime) -> list[ChannelConnection]:
    """cron이 부르는 조회 — active 상태·refresh_mode가 자동 갱신 가능·만료가 REFRESH_LEAD_TIME
    이내(이미 만료 포함)인 행."""
    from app.services.channel_adapters import can_auto_refresh

    threshold = now + REFRESH_LEAD_TIME
    stmt = select(ChannelConnection).where(
        ChannelConnection.status == "active",
        ChannelConnection.token_expires_at.is_not(None),
        ChannelConnection.token_expires_at <= threshold,
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [r for r in rows if can_auto_refresh(r.refresh_mode)]


async def apply_refresh_result(
    db: AsyncSession, *, connection: ChannelConnection, new_access_token: str, expires_in_seconds: int,
) -> None:
    connection.encrypted_access_token = encrypt_channel_credential(new_access_token)
    connection.token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
    connection.last_refreshed_at = datetime.now(timezone.utc)
    connection.last_error = None
    connection.status = "active"
    await db.commit()


async def apply_refresh_failure(db: AsyncSession, *, connection: ChannelConnection, error_message: str) -> None:
    """AC4 — 갱신 실패 시 status=expired(자동 재시도 스톰 방지, owner가 재인증해야 벗어남).
    last_error는 provider 원문 그대로 저장(페드루 PO 확定 2026-09-03 07:09Z) — 사람이 읽을
    말로 가공하는 건 화면(FE) 몫."""
    connection.status = "expired"
    connection.last_error = error_message[:2000]
    await db.commit()


def decrypt_for_use(connection: ChannelConnection) -> str | None:
    """⛔호출자는 반환값을 즉시 소비하고 변수를 더 들고 있지 않는다(로깅 금지) —
    channel_credential_crypto.decrypt_channel_credential과 동일 규율."""
    if connection.encrypted_access_token is None:
        return None
    return decrypt_channel_credential(connection.encrypted_access_token)
