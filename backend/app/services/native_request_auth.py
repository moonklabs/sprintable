"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc §7 SSOT 서두): §7 신규 public native
엔드포인트가 공유하는 전처리 — exact Firebase Bearer ID token(auth_time<=5m) + exact App
Check(REQUIRED, optional 아님 — 구 S5 `native_bootstrap.py` 스킴과의 차이) + eligible
migration state + auth_valid_after cutover epoch(story bea25062).

⚠️story cbd578d4(C4) 후속: Story A(PR #2206)가 develop에 머지돼 `_reject_if_before_
cutover`를 여기 추가한다(예고했던 소패치, §7.7 활성화 게이트 체크리스트 항목) — revoke된
사용자의 pre-cutover ID token이 register/bootstrap 챌린지 발급·소비를 통과하는 걸 막는다."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.auth_identity import AuthIdentity, AuthMigration
from app.models.user import User
from app.services.firebase_verifier import verify_app_check_token, verify_firebase_id_token

logger = logging.getLogger(__name__)

_AUTH_TIME_MAX_AGE_SECONDS = 5 * 60


@dataclass
class VerifiedNativeRequest:
    user_id: object
    firebase_uid: str
    app_check_app_id: str


def extract_bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer "):]


def allowed_app_ids() -> frozenset[str]:
    raw = settings.firebase_app_check_allowed_app_ids
    return frozenset(x.strip() for x in raw.split(",") if x.strip())


async def verify_native_request(
    *,
    authorization: str | None,
    app_check_token: str | None,
    db: AsyncSession,
    log_prefix: str,
) -> VerifiedNativeRequest:
    """실패 시 항상 401(enumeration 방지 — 사유는 로그에만). 순서: ID token → auth_time →
    App Check(필수) → identity 매핑 → user active → migration state 적격."""
    id_token = extract_bearer(authorization)
    if id_token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Firebase ID token")

    verified = await verify_firebase_id_token(id_token, settings.firebase_project_id)
    if verified is None:
        logger.warning("%s rejected reason=id_token_invalid", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Firebase ID token")

    now = datetime.now(timezone.utc).timestamp()
    if now - verified.auth_time > _AUTH_TIME_MAX_AGE_SECONDS:
        logger.warning("%s rejected reason=auth_time_stale", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication too old")

    if not app_check_token:
        logger.warning("%s rejected reason=app_check_missing", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="App Check token required")

    app_check = await verify_app_check_token(app_check_token, settings.firebase_project_number, allowed_app_ids())
    if app_check is None:
        logger.warning("%s rejected reason=app_check_invalid", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid App Check token")

    identity_row = (
        await db.execute(
            select(AuthIdentity).where(
                AuthIdentity.issuer == verified.issuer,
                AuthIdentity.subject == verified.firebase_uid,
                AuthIdentity.unlinked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if identity_row is None:
        logger.warning("%s rejected reason=unmapped_identity", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unmapped Firebase identity")

    user = await db.get(User, identity_row.user_id)
    if user is None or not user.is_active:
        logger.warning("%s rejected reason=inactive_or_missing_user", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    migration = await db.get(AuthMigration, identity_row.user_id)
    if migration is None or migration.state not in ("provisioning", "firebase"):
        logger.warning("%s rejected reason=ineligible_migration_state", log_prefix)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not eligible")

    from app.dependencies.auth import _reject_if_before_cutover

    await _reject_if_before_cutover(identity_row.user_id, int(verified.auth_time), db)

    return VerifiedNativeRequest(
        user_id=identity_row.user_id, firebase_uid=verified.firebase_uid, app_check_app_id=app_check.app_id
    )
