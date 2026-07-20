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

⚠️**HEAD 98d65136 RED 포워딩(산티아고·2026-07-16) BLOCKER 1 시정**: 최초 구현은 여기에
프로세스-전역 30초 negative existence-cache를 뒀다("revoke가 한 번도 없으면 DB 무접촉") —
산티아고 직접 probe로 (a) 다른 Cloud Run 인스턴스는 revoke 후 최대 30초까지 캐시가 갱신 안
돼 이미 발급된 pre-cutover 토큰이 통과하고 (b) 콜드 스타트/캐시 만료 중 DB 조회 실패 시
기본값 False를 반환해 **fail-open**(§17d-1이 요구하는 "즉시 local fail-closed authority"의
정면 위반)임을 실증했다. **캐시를 완전히 제거**한다 — `_reject_if_before_cutover`는 매
legacy/Firebase/SSE 요청마다 `AuthMigration`을 PK(user_id) 인덱스 조회로 직접 확인하고,
DB 조회 자체가 실패하면 예외를 그대로 전파해(auth 요청 실패) 절대 "허용"으로 떨어지지
않는다. 매 인증 요청에 DB 왕복 1회가 영구히 추가되는 성능 트레이드오프를 감수한다 —
산티아고가 명시적으로 이 최적화를 기각(공유 authoritative 캐시 없인 process-local TTL
불가 판정).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_identity import AuthMigration
from app.models.user import RefreshToken

logger = logging.getLogger(__name__)


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
       ⚠️산티아고 RED 조건 ⑦: ORM `get()`+조건부 mutate는 (a) 동시 두 revoke가 모두 "행 없음"을
       보고 동시 insert 시도하는 race, (b) 늦게 커밋된 오래된 epoch가 이미 기록된 더 최신
       epoch를 덮어쓰는 monotonicity 위반 둘 다에 취약하다. 단일 원자 UPSERT
       (`INSERT...ON CONFLICT(user_id) DO UPDATE SET auth_valid_after=GREATEST(...)`)로 교체 —
       PG가 충돌 시 row-level lock으로 직렬화하고, GREATEST가 "이 revoke가 기존 epoch보다
       늦더라도 절대 앞당겨지지 않는다"를 보장한다(NULL은 GREATEST가 무시 — 최초 삽입도 그대로
       동작).
    2. 해당 사용자 live legacy refresh_tokens 일괄 revoked_at=now().
    3. (커밋 후, best-effort) Firebase user-wide revoke — 실패해도 1·2가 이미 효력이 있어
       접근 허용으로 이어지지 않는다.
    """
    epoch = datetime.now(timezone.utc)

    upsert = pg_insert(AuthMigration).values(user_id=user_id, state="legacy", auth_valid_after=epoch)
    upsert = upsert.on_conflict_do_update(
        index_elements=[AuthMigration.user_id],
        set_={"auth_valid_after": func.greatest(AuthMigration.auth_valid_after, upsert.excluded.auth_valid_after)},
    ).returning(AuthMigration.auth_valid_after)
    stored_epoch = (await db.execute(upsert)).scalar_one()

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=epoch)
    )
    await db.commit()
    logger.info("auth.cutover.revoke_user_sessions local_committed")

    if firebase_uid:
        from app.core.config import settings
        from app.services.firebase_session_mint import revoke_firebase_refresh_tokens

        try:
            ok = await revoke_firebase_refresh_tokens(firebase_uid, settings.firebase_project_id)
            if not ok:
                logger.warning("auth.cutover.revoke_user_sessions firebase_revoke_failed")
        except Exception:
            logger.warning("auth.cutover.revoke_user_sessions firebase_revoke_exception")

    # stored_epoch(DB의 최종 authoritative 값)를 반환 — 동시 revoke 중 이 호출보다 늦게
    # 커밋된 더 최신 epoch가 이미 있었다면 GREATEST가 그걸 보존했을 수 있어 epoch와 다를
    # 수 있다(monotonicity 보장의 직접적 증거).
    return stored_epoch
