"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5·doc §9.1·산티아고 §9 코드 보안계약 2026-07-15):
네이티브 부트스트랩 단회코드 발급/소비.

**발급**: 256bit CSPRNG(`secrets.token_urlsafe(32)`) — code_hash(SHA-256)만 저장, raw code는
호출부 응답으로만 반환. TTL 30~60초(기본 45초). project_id(exact Firebase project/tenant)
바인딩.

⚠️story cbd578d4(C4·§7.0/§7.5): `device_binding_hash`(문자열 비교, S5 임시 스킴) 완전 삭제.
코드는 이제 등록된 `installation_id`+`key_version`에 바인딩되고, 소비는 §7.5 2단계 원자
트랜잭션(issue+redeem-challenge 동시생성, consume 6조건)의 일부로 재구성됐다 — 이 모듈은
순수 코드 저장/조회 프리미티브만 제공, 트랜잭션 오케스트레이션은 라우터(consume_native_
bootstrap 등) 책임.

**소비**: 단일 원자적 `UPDATE...WHERE code_hash=? AND consumed_at IS NULL AND expires_at>now()
AND project_id=? AND installation_id=? RETURNING`(check-then-insert TOCTOU 없음). 실패
사유(만료/이미소비/project_id·installation_id 불일치/존재하지 않는 코드)는 전부 "0 rows
updated"로 수렴 — enumeration 방지.
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


def generate_bootstrap_code() -> tuple[str, str]:
    """순수 함수(DB 무접촉) — (raw_code, code_hash) 반환. §7.5 2단계 원자 트랜잭션에서
    redeem 챌린지가 이 code_hash를 canonical transcript에 먼저 바인딩해야 하므로, 코드
    행 생성보다 먼저 호출해야 한다(순서 중요 — chicken-and-egg를 이 분리로 해소)."""
    code = secrets.token_urlsafe(32)  # 256bit 이상 엔트로피
    return code, _hash_code(code)


async def issue_bootstrap_code(
    db: AsyncSession,
    *,
    code_hash: str,
    user_id,
    firebase_uid: str,
    project_id: str,
    installation_id=None,
    key_version: int | None = None,
    redeem_challenge_id=None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    auth_time: datetime | None = None,
    commit: bool = True,
) -> None:
    """`code_hash`는 `generate_bootstrap_code()`로 미리 계산된 값을 받는다 — raw code는
    이 함수에 아예 전달되지 않는다(DB엔 hash만, 로그에도 절대 남기지 않는다).

    ⚠️story bea25062(§17d-1 BLOCKER 2): `auth_time`은 이 코드 발급의 근거가 된 원본 Firebase
    ID token의 실제 인증 시각 — 호출부가 반드시 검증된 토큰에서 뽑아 전달해야 한다.

    `commit=False`(C4 §7.5): bootstrap_issue 챌린지 소비+이 코드 생성+bootstrap_redeem
    챌린지 생성이 같은 트랜잭션이어야 한다 — 호출부가 마지막에 한 번만 커밋."""
    now = datetime.now(timezone.utc)
    row = AuthNativeBootstrapCode(
        user_id=user_id,
        firebase_uid=firebase_uid,
        project_id=project_id,
        code_hash=code_hash,
        installation_id=installation_id,
        key_version=key_version,
        redeem_challenge_id=redeem_challenge_id,
        auth_time=auth_time,
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
    )
    db.add(row)
    if commit:
        await db.commit()
    else:
        await db.flush()


@dataclass
class ConsumedBootstrapCode:
    user_id: object
    firebase_uid: str
    created_at: datetime  # 코드 발급 시각(TTL/감사용) — cutover 비교엔 쓰지 않는다.
    auth_time: datetime | None  # story bea25062: 원본 ID token 인증 시각 — cutover 비교 기준.
    installation_id: object | None
    key_version: int | None
    redeem_challenge_id: object | None


async def consume_bootstrap_code(
    db: AsyncSession,
    *,
    code: str,
    project_id: str,
    installation_id=None,
    commit: bool = True,
) -> ConsumedBootstrapCode | None:
    """원자적 1회 소비. 실패(만료/이미소비/project_id·installation_id 불일치/존재하지 않는
    코드) 시 전부 None — 사유 구분 없음. `commit=False`(C4 §7.5 consume 6조건 트랜잭션의
    일부)면 호출부가 나머지 조건부 mutation까지 전부 성공했을 때만 커밋한다."""
    code_hash = _hash_code(code)
    now = datetime.now(timezone.utc)

    conditions = [
        AuthNativeBootstrapCode.code_hash == code_hash,
        AuthNativeBootstrapCode.consumed_at.is_(None),
        AuthNativeBootstrapCode.expires_at > now,
        AuthNativeBootstrapCode.project_id == project_id,
    ]
    if installation_id is not None:
        conditions.append(AuthNativeBootstrapCode.installation_id == installation_id)

    stmt = (
        update(AuthNativeBootstrapCode)
        .where(*conditions)
        .values(consumed_at=now)
        .returning(
            AuthNativeBootstrapCode.user_id,
            AuthNativeBootstrapCode.firebase_uid,
            AuthNativeBootstrapCode.created_at,
            AuthNativeBootstrapCode.auth_time,
            AuthNativeBootstrapCode.installation_id,
            AuthNativeBootstrapCode.key_version,
            AuthNativeBootstrapCode.redeem_challenge_id,
        )
    )
    result = await db.execute(stmt)
    row = result.first()
    if commit:
        await db.commit()
    else:
        await db.flush()
    if row is None:
        return None
    return ConsumedBootstrapCode(
        user_id=row[0], firebase_uid=row[1], created_at=row[2], auth_time=row[3],
        installation_id=row[4], key_version=row[5], redeem_challenge_id=row[6],
    )
