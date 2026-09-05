"""story #3373(Phase1·마케팅운영, 선생님 지적·페드루 PO 정정 2026-09-03 08:29Z·08:40Z) —
channel_app_credentials CRUD + 3단 자격 해석(조직 등록 → 플랫폼 공용 앱 → 없음). 암호화는
channel_credential_crypto.py에만 위임(신규 암호화 패턴 발명 0).

블루프린트 §8(페드루 PO 08:40Z 보정) — SaaS 기본은 **공용 앱**이고 조직별 자격은 옵션
(먼저 구현된 것일 뿐 우선순위는 조직이 위). 공용 앱 자격은 env var가 아니라
`platform_settings`(어드민 관리 싱글턴 테이블, app/models/platform_setting.py) 컬럼에
암호화 저장 — env var 경로(구 `settings.threads_app_id/secret`)는 폐기."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_app_credential import ChannelAppCredentials
from app.services.channel_credential_crypto import decrypt_channel_credential, encrypt_channel_credential

# 채널별 platform_settings 컬럼명 매핑 — 채널마다 컬럼명이 다르므로 명시 나열(새 채널을 열
# 때 여기 한 줄만 추가, platform_setting.py에도 그 채널의 컬럼 쌍을 먼저 추가).
_PLATFORM_SETTINGS_COLUMNS = {
    "threads": ("threads_platform_app_id", "threads_platform_encrypted_app_secret"),
    # story #3320(Phase2·마케팅운영, 페드루 PO 決定 2026-09-02) — "Threads 온보딩에서
    # 만드는 Meta 개발자 앱에 Instagram Graph API use case만 추가"가 그라운딩 근거①
    # 그 자체다: Instagram은 별도 앱이 아니라 **같은** Meta 개발자 앱(app_id/secret
    # 재사용) — 새 platform_settings 컬럼을 안 만들고 threads 컬럼을 그대로 가리킨다
    # (신규 컬럼 0·조직 상수 0, 스토리 본문 「결제 게이트 0」과 같은 취지의 「앱 등록
    # 게이트 0」).
    "instagram": ("threads_platform_app_id", "threads_platform_encrypted_app_secret"),
}


async def get_channel_app_credentials(
    db: AsyncSession, *, org_id: uuid.UUID, channel: str,
) -> ChannelAppCredentials | None:
    return (await db.execute(
        select(ChannelAppCredentials).where(
            ChannelAppCredentials.org_id == org_id, ChannelAppCredentials.channel == channel,
        )
    )).scalar_one_or_none()


async def upsert_channel_app_credentials(
    db: AsyncSession, *, org_id: uuid.UUID, channel: str, app_id: str, app_secret: str, updated_by: uuid.UUID,
) -> ChannelAppCredentials:
    existing = await get_channel_app_credentials(db, org_id=org_id, channel=channel)
    encrypted = encrypt_channel_credential(app_secret)
    if existing is None:
        row = ChannelAppCredentials(
            id=uuid.uuid4(), org_id=org_id, channel=channel, app_id=app_id,
            encrypted_app_secret=encrypted, updated_by=updated_by,
        )
        db.add(row)
    else:
        existing.app_id = app_id
        existing.encrypted_app_secret = encrypted
        existing.updated_by = updated_by
        row = existing
    await db.commit()
    await db.refresh(row)
    return row


async def resolve_app_credentials(
    db: AsyncSession, *, org_id: uuid.UUID, channel: str,
) -> tuple[str, str] | None:
    """3단 우선순위(페드루 PO 확定 2026-09-03 08:40Z, 블루프린트 §8) — ① 조직이
    channel_app_credentials에 등록한 자격 → ② platform_settings의 공용 앱 자격(SaaS
    기본, 어드민 관리) → ③ 둘 다 없으면 None. 호출부(라우터)가 None을 409
    CHANNEL_APP_CREDENTIALS_MISSING으로 번역한다.
    ⛔반환된 (app_id, app_secret)의 app_secret은 호출자가 즉시 소비만 하고 변수를 더
    들고 있거나 로깅하지 않는다(channel_credential_crypto 규율과 동일)."""
    row = await get_channel_app_credentials(db, org_id=org_id, channel=channel)
    if row is not None:
        return row.app_id, decrypt_channel_credential(row.encrypted_app_secret)

    columns = _PLATFORM_SETTINGS_COLUMNS.get(channel)
    if columns is not None:
        from app.services.platform_settings import get_platform_settings

        app_id_col, encrypted_secret_col = columns
        platform = await get_platform_settings(db)
        app_id = getattr(platform, app_id_col)
        encrypted_secret = getattr(platform, encrypted_secret_col)
        if app_id and encrypted_secret:
            return app_id, decrypt_channel_credential(encrypted_secret)
    return None


async def resolve_app_credentials_source(db: AsyncSession, *, org_id: uuid.UUID, channel: str) -> str:
    """story #3373 후속(페드루 PO 2026-09-03 11:19Z, 유나 화면설계 실측) — GET 상태 응답에
    필요한 «어디서 왔나» 신호. `resolve_app_credentials()`와 정확히 같은 3단 순서를
    따르지만 secret을 복호화하지 않는다(존재 확認만 필요 — 불필요한 decrypt 호출 0).
    반환값 "org"|"platform"|"none" — `configured=false`일 때(조직 미등록) 화면이 「공용
    앱으로 연결 가능」("platform")과 「연결 불가, 409로 막힘」("none")을 이걸로 가른다."""
    row = await get_channel_app_credentials(db, org_id=org_id, channel=channel)
    if row is not None:
        return "org"

    columns = _PLATFORM_SETTINGS_COLUMNS.get(channel)
    if columns is not None:
        from app.services.platform_settings import get_platform_settings

        app_id_col, encrypted_secret_col = columns
        platform = await get_platform_settings(db)
        if getattr(platform, app_id_col) and getattr(platform, encrypted_secret_col):
            return "platform"
    return "none"
