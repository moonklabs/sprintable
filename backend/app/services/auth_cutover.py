"""story bea25062(E-AUTH-REBUILD auth_valid_after 코어 인프라·doc firebase-poc-q12-didi-
measurements §17d-1): cutover epoch authority — 활성화 게이트(6ae1ecac AC#2)와 Phase 4
coordinated forced reset의 공통 근본. 산티아고 §17d-1 "판정: 정합하다"를 그대로 구현한다.

**한 컬럼(`auth_migrations.auth_valid_after`)으로 두 용도를 표현**: 단일 사용자 보안 이벤트
revoke(이 모듈의 `revoke_user_sessions()`)와 Phase 4 대량 코호트 cutover(Story B, 별도)가
같은 검사 로직(`is_before_cutover`)을 공유한다.

⚠️§17d-1 명시: "로컬 epoch/state가 즉시 fail-closed 통제, Firebase revoke는 user-wide
defense-in-depth" — 순서가 중요하다. 로컬 auth_valid_after 기록+legacy RT revoke를 먼저
커밋해 즉시 효력을 발생시킨 뒤, Firebase revoke는 그 바깥에서 best-effort로 시도한다
(Firebase API 실패가 로컬 fail-closed를 막으면 안 됨 — DB 트랜잭션 안에 넣지 않는 이유).

**이번 스코프 축소 표기**: §17d-1이 요구하는 "idempotent outbox/retry"의 완전한 영속 재시도
큐(실패 시 나중에 자동 재시도)는 이 스토리엔 없다 — Firebase 호출은 1회 best-effort이고
실패는 로그만 남긴다. 로컬 epoch가 이미 authoritative fail-closed 통제이므로 이것만으로도
§17d-1의 "Firebase 실패가 접근 허용으로 이어지지 않는다" 요구는 충족되지만, 진짜 영속
재시도(Firebase 쪽 user-wide revoke가 끝내 실패해 남아있는 상태를 감지/재시도)는 Phase 4
대량 cutover 운영 도구(Story B) 스코프다.

⚠️**성능 트레이드오프(자체 발견, Santiago 리뷰에서 판단 필요)**: `_reject_if_before_cutover`가
매 legacy/Firebase 요청마다 DB를 직접 조회하면, revoke가 단 한 번도 없는 정상 상태(오늘의
현실 — 사용자 전원)에서도 **인증된 모든 요청에 DB 왕복 1회가 영구히 추가**된다(원래 legacy
JWT 검증은 서명/exp만 보고 DB를 전혀 안 건드렸다). `check_any_cutover_epoch_exists()`로
"지금까지 단 한 명이라도 revoke된 적 있는가"를 프로세스 전역 짧은 캐시(기본 30초)로 먼저
확인해 — **없으면(현재 100% 상태) DB를 아예 안 건드리고 즉시 통과**, 있으면(실제 보안
이벤트 발생 후) 그때부터 사용자별 정밀 검사로 전환한다. `revoke_user_sessions()` 호출
즉시 같은 프로세스의 캐시는 True로 갱신되지만, **다른 Cloud Run 인스턴스는 캐시 TTL(최대
30초)까지 갱신이 늦을 수 있다** — 이는 §17d-1이 요구하는 "즉시" fail-closed보다 느슨한
근사치다. 다만 legacy refresh_tokens 일괄 revoke는 이 캐시와 무관하게 즉시 커밋되므로
"revoke된 사용자가 신규 refresh는 절대 못 받는다"는 이미 즉시 보장되고, 이 캐시가 관장하는
건 "이미 발급된, 아직 안 만료된 access token(최대 60분)"의 즉시성뿐이다 — 캐시 없는 현재
설계(access token은 revoke 개념 자체가 아예 없음, doc H2 finding)보다는 명백히 개선.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_identity import AuthMigration
from app.models.user import RefreshToken

logger = logging.getLogger(__name__)

_ANY_CUTOVER_CACHE_SECONDS = 30
_any_cutover_epoch_exists: bool = False
_any_cutover_cache_expires_at: float = 0.0


def _reset_cutover_existence_cache_for_tests() -> None:
    """테스트 전용 — 프로세스 전역 캐시가 테스트 간 상태를 누출하지 않도록 초기화."""
    global _any_cutover_epoch_exists, _any_cutover_cache_expires_at
    _any_cutover_epoch_exists = False
    _any_cutover_cache_expires_at = 0.0


async def check_any_cutover_epoch_exists() -> bool:
    """전역 짧은-TTL 캐시 — auth_migrations에 auth_valid_after가 채워진 행이 하나라도
    있는지. False(현재 사실상 항상 이 값)면 호출부가 사용자별 DB 조회를 완전히 생략할 수
    있다. 요청의 db 세션을 재사용하지 않고 자체 단명 세션을 연다(캐시 값은 어느 요청과도
    무관한 프로세스 전역 상태라 특정 요청의 db 객체에 의존하면 안 됨 — mock/None db로
    호출되는 기존 단위 테스트들과도 독립적이어야 하는 이유)."""
    global _any_cutover_epoch_exists, _any_cutover_cache_expires_at
    now = time.time()
    if _any_cutover_cache_expires_at > now:
        return _any_cutover_epoch_exists

    from app.core.database import async_session_factory

    try:
        async with async_session_factory() as db:
            exists = (
                await db.execute(
                    select(AuthMigration.user_id).where(AuthMigration.auth_valid_after.is_not(None)).limit(1)
                )
            ).scalar_one_or_none() is not None
    except Exception:
        # DB 접속 불가 시 이 존재-확인 자체를 실패로 raise하면, 원래 DB를 전혀 안 건드리던
        # legacy JWT 검증 경로가 이 최적화 캐시 하나 때문에 죽는다(자체 발견 — mock/None db
        # 단위 테스트뿐 아니라 실 배포에서도 DB 일시 장애가 무관한 인증 전체를 막으면 안 됨).
        # 직전 캐시값을 그대로 유지하고(콜드 스타트면 기본 False=과거 100% 동작과 동일) 짧게
        # 재시도하도록 만료시각만 소폭 미룬다.
        logger.warning("auth.cutover.check_any_cutover_epoch_exists db_unavailable_fallback")
        _any_cutover_cache_expires_at = now + _ANY_CUTOVER_CACHE_SECONDS
        return _any_cutover_epoch_exists

    _any_cutover_epoch_exists = exists
    _any_cutover_cache_expires_at = now + _ANY_CUTOVER_CACHE_SECONDS
    return exists


def is_before_cutover(auth_valid_after: datetime | None, reference_time: datetime) -> bool:
    """reference_time(토큰 iat/auth_time/코드 발급시각)이 cutover epoch 이전(또는 동일)이면
    True(거부 대상). auth_valid_after가 None이면 제약 없음(False, 항상 통과)."""
    if auth_valid_after is None:
        return False
    return reference_time <= auth_valid_after


async def get_auth_valid_after(db: AsyncSession, user_id) -> datetime | None:
    """AuthMigration 행이 없으면(Phase 1~3 cohort 미편입 대부분의 현재 사용자) None —
    제약 없음과 동일하게 취급(기존 동작 무변화)."""
    migration = await db.get(AuthMigration, user_id)
    return migration.auth_valid_after if migration is not None else None


async def revoke_user_sessions(db: AsyncSession, user_id, *, firebase_uid: str | None = None) -> datetime:
    """단일 사용자 revoke primitive(§17d-1 ①②③, 대량 코호트 버전 아님 — Story B).

    1. auth_valid_after=now() 기록(행 없으면 생성) — **먼저 커밋**, 이게 즉시 fail-closed 통제.
    2. 해당 사용자 live legacy refresh_tokens 일괄 revoked_at=now().
    3. (커밋 후, best-effort) Firebase user-wide revoke — 실패해도 1·2가 이미 효력이 있어
       접근 허용으로 이어지지 않는다.
    """
    epoch = datetime.now(timezone.utc)

    migration = await db.get(AuthMigration, user_id)
    if migration is None:
        migration = AuthMigration(user_id=user_id, state="legacy", auth_valid_after=epoch)
        db.add(migration)
    else:
        migration.auth_valid_after = epoch

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=epoch)
    )
    await db.commit()
    logger.info("auth.cutover.revoke_user_sessions local_committed")

    # 이 프로세스는 즉시 정밀검사 모드로 전환(다른 인스턴스는 캐시 TTL까지 지연 — 모듈
    # 상단 docstring의 성능/즉시성 트레이드오프 설명 참조).
    global _any_cutover_epoch_exists, _any_cutover_cache_expires_at
    _any_cutover_epoch_exists = True
    _any_cutover_cache_expires_at = time.time() + _ANY_CUTOVER_CACHE_SECONDS

    if firebase_uid:
        from app.core.config import settings
        from app.services.firebase_session_mint import revoke_firebase_refresh_tokens

        try:
            ok = await revoke_firebase_refresh_tokens(firebase_uid, settings.firebase_project_id)
            if not ok:
                logger.warning("auth.cutover.revoke_user_sessions firebase_revoke_failed")
        except Exception:
            logger.warning("auth.cutover.revoke_user_sessions firebase_revoke_exception")

    return epoch
