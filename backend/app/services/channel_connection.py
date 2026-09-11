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
from app.services.graph_api_errors import mark_connection_recovered

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
    # story #3492 — pasted_secret 채널만 재방문 표시용 힌트를 남긴다(oauth는 이 개념이
    # 없다, §2 규격 3).
    secret_hint = _secret_hint(access_token) if access_token and credential_kind == "pasted_secret" else None

    if existing is None:
        row = ChannelConnection(
            id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=account_id,
            account_label=account_label, credential_kind=credential_kind,
            encrypted_access_token=encrypted_access_token, encrypted_refresh_token=encrypted_refresh_token,
            token_expires_at=token_expires_at, refresh_mode=refresh_mode, scopes=scopes,
            status="active", connected_by=connected_by, secret_hint=secret_hint,
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
        # story #3633 — status/last_error 3종(last_error_code·last_error_at 포함)
        # 클리어를 mark_connection_recovered 하나로(graph_api_errors.py, 3605
        # sticky_connection_status와 같은 모듈).
        mark_connection_recovered(existing)
        existing.connected_by = connected_by
        existing.secret_hint = secret_hint
        row = existing
        # story #3612 — 재연결(active 복귀)이 이 함수의 else 분기(기존 행 upsert)로만
        # 일어난다(if existing is None 분기는 신규 연결이라 쉬는 스케줄이 있을 수
        # 없음). wake_resting_comment_schedules 참고(단일 깨우는 손).
        from app.services.channel_post_comments import wake_resting_comment_schedules
        await wake_resting_comment_schedules(db, connection_id=existing.id)

    await db.commit()
    await db.refresh(row)
    return row


def _secret_hint(secret: str) -> str | None:
    """channel_connections.py::_app_id_suffix와 동형(끝 4자리) — story #3492.

    페드루 PO 차단(2026-09-05, PR#3841 리뷰·유나 Design FAIL) — 이전엔 3자 이하
    secret이면 원문 통째를 그대로 돌려줬다(`len(secret) >= 4`가 아니면 else 분기가
    `secret` 자체). 그 값이 DB `secret_hint` 컬럼(평문)·목록 응답(member까지)·화면
    「****ab」로 그대로 샌다 — 짧은 secret일수록 오히려 더 많이 새는 역설. 8자
    미만이면 힌트 자체를 안 만든다(None, 화면은 `secretHint ? … : null`이라 이미
    null-safe — 무변경)."""
    return secret[-4:] if len(secret) >= 8 else None


async def replace_channel_connection_credential(
    db: AsyncSession, *, org_id: uuid.UUID, connection_id: uuid.UUID,
    new_secret: str, updated_by: uuid.UUID, account_label: str | None = None,
) -> ChannelConnection:
    """story #3492(PO 決定 2026-09-05) — 붙여넣기(pasted_secret) 자격 「제자리 교체」.
    `upsert_channel_connection`과 의도적으로 다른 함수다 — 그쪽은 (org, channel,
    account_id) 키로 새 행을 만들거나 찾아 갱신하지만(account_id가 바뀌면 새 행),
    이 함수는 `connection_id` 하나로 정확히 그 행만 찾아 자격만 바꾼다(id·account_id·
    channel 전부 불변 — draft·발행 이력·external_publish 게이트 scope_key(story
    #3478, connection_id 단위)가 안 끊긴다는 것이 이 스토리의 존재 이유).

    `account_label`은 WordPress만 갱신 대상(username이 바뀔 수 있다 — webhook은
    label 개념이 없어 호출부가 안 넘긴다). `status`는 시험 성공 前에도 그대로
    active로 남는다(PO 明示 — pending_verify 같은 신규 상태를 만들지 않는다,
    「연결 시험」이 검증 축). 기존 last_error는 지운다(새 자격이 이전 실패를
    고쳤을 수 있다 — 사람이 다시 시험 눌러 실제로 확인)."""
    row = (await db.execute(
        select(ChannelConnection).where(
            ChannelConnection.id == connection_id, ChannelConnection.org_id == org_id,
        ).with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise ChannelConnectionNotFoundError(connection_id)

    row.encrypted_access_token = encrypt_channel_credential(new_secret)
    row.secret_hint = _secret_hint(new_secret)
    if account_label is not None:
        row.account_label = account_label
    # story #3633 — mark_connection_recovered로 status/last_error 3종 통일.
    mark_connection_recovered(row)
    row.connected_by = updated_by
    # story #3612 — 이 자격 교체도 non-active→active 복귀 경로다(wake_resting_
    # comment_schedules 참고, 단일 깨우는 손).
    from app.services.channel_post_comments import wake_resting_comment_schedules
    await wake_resting_comment_schedules(db, connection_id=row.id)

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
    new_refresh_token: str | None = None,
) -> None:
    """story #3808(Phase3·3-3 PR1) — `new_refresh_token` 신규 파라미터(옵션, 기본
    None=기존 동작 그대로 무변경). X류 **1회용 회전** refresh_token(매 갱신마다
    새 refresh_token 발급·이전 값 즉시 무효)은 여기서 갱신하지 않으면 다음 cron
    tick이 이미 무효화된 옛 refresh_token으로 또 갱신을 시도해 항상 실패한다 —
    threads/instagram(refresh_mode="reissue_from_access_token", refresh_token
    자체가 없음)는 이 인자를 안 넘기므로 회귀 0."""
    connection.encrypted_access_token = encrypt_channel_credential(new_access_token)
    if new_refresh_token is not None:
        connection.encrypted_refresh_token = encrypt_channel_credential(new_refresh_token)
    connection.token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
    connection.last_refreshed_at = datetime.now(timezone.utc)
    # story #3633 — mark_connection_recovered로 status/last_error 3종 통일.
    mark_connection_recovered(connection)
    # story #3612 — 자동 토큰 갱신 성공도 non-active→active 복귀 경로다(wake_
    # resting_comment_schedules 참고, 단일 깨우는 손).
    from app.services.channel_post_comments import wake_resting_comment_schedules
    await wake_resting_comment_schedules(db, connection_id=connection.id)
    await db.commit()


async def apply_connection_failure(
    db: AsyncSession, *, connection: ChannelConnection, status: str, error_message: str,
) -> None:
    """story #3598 — `apply_refresh_failure`(status="expired" 고정)의 status 일반화판.
    `_classify_threads_error`가 code==190/OAuthException을 expired|revoked로 세분화한
    뒤 이 함수로 정확한 status를 남긴다(모델 컬럼 주석 그대로 active|expired|revoked|
    error 중 하나). last_error는 provider 원문 그대로(가공은 화면 몫, apply_refresh_
    failure와 동일 규율).

    story #3605 CHANGES-2(유나 코드 리뷰 재확認, 페드루 PO 채택 2026-09-07) —
    "되돌아가지 않기" 규율이 한때 이 함수 안에 따로 구현돼 있었다(status=="error"
    일 때만 막고 expired↔revoked는 서로 덮게 둠) — `graph_api_errors.
    connection_status_for_error_code`가 쓰던 규율(expired·revoked는 서로도 안
    덮는 완전 sticky)과 «같은 사실»을 다르게 말하고 있어 하나는 거짓이었다.
    이제 `graph_api_errors.sticky_connection_status`(공유 단일 지점) 하나로
    통일한다. last_error는 그래도 최신 원문으로 갱신한다(status가 안 바뀌어도
    "최근에도 계속 실패 中"이라는 사실 자체는 갱신할 가치가 있다)."""
    from app.services.graph_api_errors import sticky_connection_status

    connection.last_error = error_message[:2000]
    connection.status = sticky_connection_status(connection.status, status)
    await db.commit()


async def apply_refresh_failure(db: AsyncSession, *, connection: ChannelConnection, error_message: str) -> None:
    """AC4 — 갱신 실패 시 status=expired(자동 재시도 스톰 방지, owner가 재인증해야 벗어남).
    last_error는 provider 원문 그대로 저장(페드루 PO 확定 2026-09-03 07:09Z) — 사람이 읽을
    말로 가공하는 건 화면(FE) 몫. story #3598 — apply_connection_failure(status="expired")
    의 특수판으로 위임(기존 cron 갱신-실패 호출부 시그니처 무변경, 회귀 0)."""
    await apply_connection_failure(db, connection=connection, status="expired", error_message=error_message)


def decrypt_for_use(connection: ChannelConnection) -> str | None:
    """⛔호출자는 반환값을 즉시 소비하고 변수를 더 들고 있지 않는다(로깅 금지) —
    channel_credential_crypto.decrypt_channel_credential과 동일 규율."""
    if connection.encrypted_access_token is None:
        return None
    return decrypt_channel_credential(connection.encrypted_access_token)


def decrypt_refresh_token_for_use(connection: ChannelConnection) -> str | None:
    """story #3808(Phase3·3-3 PR1) — `decrypt_for_use`의 refresh_token판. X류
    refresh_mode="refresh_token" 채널의 cron 재발급은 access_token이 아니라 **이
    refresh_token**을 provider에 보낸다(decrypt_for_use가 access_token만 다루므로
    이 채널군에는 그대로 재사용할 수 없음 — 새 함수가 맞는 자리). 같은 ⛔즉시
    소비 규율."""
    if connection.encrypted_refresh_token is None:
        return None
    return decrypt_channel_credential(connection.encrypted_refresh_token)
