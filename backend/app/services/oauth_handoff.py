"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)): OAuth 완결→
웹뷰 세션 핸드오프 단회코드 발급/소비. `app/services/native_bootstrap.py`(attested §7.5)와
동형 패턴이나 물리적으로 분리된 테이블/코드 경로 — installation/challenge 바인딩 대신 PKCE
`code_challenge`(S256 base64url)에 바인딩된다.

⚠️미르코 실측 정정(2026-07-16): 발급 대상은 Firebase 세션쿠키가 아니라 레거시 self-issued
JWT(access/refresh) — `firebase_uid`/`project_id` 개념 없음, `user_id`만으로 충분(BFF가
`oauth_callback()`으로 이미 해소한 서버-확定 subject를 그대로 넘긴다).

**발급**: 256bit CSPRNG(`secrets.token_urlsafe(32)`) — code_hash(SHA-256)만 저장, raw code는
호출부 응답으로만 반환. TTL 30~60초(기본 45초, native_bootstrap과 동일 산티아고 §9 계약).

**소비**: 단일 원자적 `UPDATE ... WHERE code_hash=? AND code_challenge=? AND consumed_at IS
NULL AND expires_at>now() RETURNING`(check-then-insert TOCTOU 없음). 실패 사유(만료/이미소비/
PKCE verifier 불일치/존재하지 않는 코드)는 전부 "0 rows updated"로 수렴 — enumeration 방지."""
from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.oauth_handoff_code import OAuthHandoffCode

DEFAULT_TTL_SECONDS = 45  # 산티아고 §9 계약과 동일(native_bootstrap.py DEFAULT_TTL_SECONDS)

# 산티아고 §10.1.1/.7(2026-07-16 조건부 GREEN MUST): 이 테이블의 모든 행은 이 고정 purpose만
# 가진다 — attested 코드와 물리적으로 다른 테이블일 뿐 아니라, consume 쿼리 자체도 이 값을
# 조건으로 명시해 "일반 assertion consume의 optional 분기로 구현 금지"를 코드로 재확인한다.
PURPOSE_NATIVE_OAUTH_HANDOFF = "native_oauth_handoff"


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def pkce_challenge_from_verifier(code_verifier: str) -> str:
    """PKCE S256: base64url(SHA256(code_verifier)), no padding — RFC 7636 §4.2와 동일 인코딩."""
    digest = hashlib.sha256(code_verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def generate_handoff_code() -> tuple[str, str]:
    """순수 함수(DB 무접촉) — (raw_code, code_hash) 반환."""
    code = secrets.token_urlsafe(32)  # 256bit 이상 엔트로피
    return code, _hash_code(code)


async def issue_handoff_code(
    db: AsyncSession,
    *,
    code_hash: str,
    user_id,
    code_challenge: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    commit: bool = True,
) -> None:
    """`code_hash`는 `generate_handoff_code()`로 미리 계산된 값 — raw code는 이 함수에
    전달되지 않는다(DB엔 hash만, 로그에도 남기지 않는다)."""
    now = datetime.now(timezone.utc)
    row = OAuthHandoffCode(
        user_id=user_id,
        code_hash=code_hash,
        purpose=PURPOSE_NATIVE_OAUTH_HANDOFF,
        code_challenge=code_challenge,
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
    )
    db.add(row)
    if commit:
        await db.commit()
    else:
        await db.flush()


@dataclass
class ConsumedHandoffCode:
    user_id: object
    created_at: datetime  # 코드 발급(=OAuth 완결 직후) 시각 — consume 시점 cutover 재검증 기준.


async def consume_handoff_code(
    db: AsyncSession,
    *,
    code: str,
    code_verifier: str,
    commit: bool = True,
) -> ConsumedHandoffCode | None:
    """원자적 1회 소비 — code_hash 일치 + PKCE(code_verifier→challenge 재계산) 일치를 같은
    WHERE절에 넣어 단일 쿼리로 검증+소비한다(TOCTOU 없음). 실패(만료/이미소비/verifier
    불일치/존재하지 않는 코드) 시 전부 None — 사유 구분 없음(enumeration 방지,
    native_bootstrap.consume_bootstrap_code와 동일 관례)."""
    code_hash = _hash_code(code)
    expected_challenge = pkce_challenge_from_verifier(code_verifier)
    now = datetime.now(timezone.utc)

    stmt = (
        update(OAuthHandoffCode)
        .where(
            OAuthHandoffCode.code_hash == code_hash,
            OAuthHandoffCode.purpose == PURPOSE_NATIVE_OAUTH_HANDOFF,
            OAuthHandoffCode.code_challenge == expected_challenge,
            OAuthHandoffCode.consumed_at.is_(None),
            OAuthHandoffCode.expires_at > now,
        )
        .values(consumed_at=now)
        .returning(OAuthHandoffCode.user_id, OAuthHandoffCode.created_at)
    )
    result = await db.execute(stmt)
    row = result.first()
    if commit:
        await db.commit()
    else:
        await db.flush()
    if row is None:
        return None
    return ConsumedHandoffCode(user_id=row[0], created_at=row[1])
