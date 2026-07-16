"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5·doc §9.1·산티아고 §9 코드 보안계약 2026-07-15):
네이티브 부트스트랩 단회코드 발급/소비.

**발급**: 256bit CSPRNG(`secrets.token_urlsafe(32)`) — code_hash(SHA-256)만 저장, raw code는
호출부 응답으로만 반환. TTL 30~60초(기본 45초). project_id(exact Firebase project/tenant)
바인딩. device_binding_hash는 발급 시점에 App Check 검증이 있었을 때만 채워짐(optional).

**소비**: 단일 원자적 `UPDATE...WHERE code_hash=? AND consumed_at IS NULL AND expires_at>now()
AND project_id=? RETURNING`(check-then-insert TOCTOU 없음 — SELECT 후 별도 UPDATE 절대 금지,
동시 2요청 중 정확히 1건만 RETURNING 행을 받는다). project_id 불일치·만료·이미 소비·
device_binding_hash 불일치는 전부 동일하게 "0 rows updated"로 수렴 — 실패 사유를 구분해
노출하지 않는다(enumeration 방지).
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_native_bootstrap import AuthNativeBootstrapCode

DEFAULT_TTL_SECONDS = 45  # 산티아고 §9: 30~60초


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


async def issue_bootstrap_code(
    db: AsyncSession,
    *,
    user_id,
    firebase_uid: str,
    project_id: str,
    device_binding_hash: str | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> str:
    """raw code를 반환 — 이 함수 반환 이후로는 raw code가 어디에도 다시 나타나지 않는다
    (DB엔 hash만, 로그에도 절대 남기지 않는다 — 호출부 책임)."""
    code = secrets.token_urlsafe(32)  # 256bit 이상 엔트로피
    now = datetime.now(timezone.utc)
    row = AuthNativeBootstrapCode(
        user_id=user_id,
        firebase_uid=firebase_uid,
        project_id=project_id,
        code_hash=_hash_code(code),
        device_binding_hash=device_binding_hash,
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
    )
    db.add(row)
    await db.commit()
    return code


@dataclass
class ConsumedBootstrapCode:
    user_id: object
    firebase_uid: str
    created_at: datetime  # story bea25062: 발급 시각 — cutover epoch 비교의 기준 시점


async def consume_bootstrap_code(
    db: AsyncSession,
    *,
    code: str,
    project_id: str,
    device_binding_hash: str | None = None,
) -> ConsumedBootstrapCode | None:
    """원자적 1회 소비. 실패(만료/이미소비/project_id 불일치/device_binding_hash 불일치/
    존재하지 않는 코드) 시 전부 None — 사유 구분 없음."""
    code_hash = _hash_code(code)
    now = datetime.now(timezone.utc)

    conditions = [
        AuthNativeBootstrapCode.code_hash == code_hash,
        AuthNativeBootstrapCode.consumed_at.is_(None),
        AuthNativeBootstrapCode.expires_at > now,
        AuthNativeBootstrapCode.project_id == project_id,
    ]
    # 발급 시 device_binding_hash가 채워진 코드는 소비 시 정확 일치 필수(산티아고 §9:
    # device binding은 client-supplied ID 저장만으론 불충분 — 검증 가능한 proof 매칭).
    # 발급 시 NULL이었던 코드는(App Check 미요구 발급) device proof 없이도 소비 허용.
    conditions.append(
        (AuthNativeBootstrapCode.device_binding_hash.is_(None))
        | (AuthNativeBootstrapCode.device_binding_hash == device_binding_hash)
    )

    stmt = (
        update(AuthNativeBootstrapCode)
        .where(*conditions)
        .values(consumed_at=now)
        .returning(
            AuthNativeBootstrapCode.user_id,
            AuthNativeBootstrapCode.firebase_uid,
            AuthNativeBootstrapCode.created_at,
        )
    )
    result = await db.execute(stmt)
    row = result.first()
    await db.commit()
    if row is None:
        return None
    return ConsumedBootstrapCode(user_id=row[0], firebase_uid=row[1], created_at=row[2])
