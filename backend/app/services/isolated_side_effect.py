"""story #4214(PR #4573 PO 수정) — 주 기록을 커밋한 **뒤** 붙는 부수 작업(레시피 다음 단계 이벤트 등)을 **별도 세션**에서 돌린다.

왜 별도 세션인가: 크론 워커(process_due_publication_commands)는 한 세션으로 배치를 돌며 건마다 커밋하고, 커밋 뒤에도 그 세션의
ORM 객체(`command.status` 등)를 읽는다. 부수 작업을 워커 세션에서 돌리다 실패해 `rollback()`하면 워커 세션의 객체가 전부
만료돼, 워커가 다음 줄에서 속성을 읽다 async 지연 적재(MissingGreenlet)로 배치 밖까지 튀었다 — 같은 배치에서 이미
`in_progress`로 잡힌 다른 명령들이 처리되지 않은 채 남고 자가 복구가 없어 영구히 멈춘다(#3953 구조). 롤백을 안 해도 SQL 오류가
난 트랜잭션은 aborted라 워커 커밋이 조용히 ROLLBACK이 된다.

규칙: 워커 세션은 주 기록 커밋까지만 책임진다. 부수 작업은 같은 엔진의 새 세션에서 돌고, 실패는 그 세션 안에서 끝난다
(로그만 · 예외를 워커로 올리지 않음 · 워커 세션 rollback 0). 채널 게시 예약 발행(publication_command.py, #4093)도 같은 모양으로
이 헬퍼를 쓰면 된다(#4192).
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def run_side_effect_in_own_session(
    db: AsyncSession, work: Callable[[AsyncSession], Awaitable[None]], *, describe: str,
) -> bool:
    """`work(side_session)`을 `db`와 같은 엔진의 새 세션에서 돌리고 커밋한다. 성공 True · 실패 False(로그만).

    호출 전에 주 기록은 `db`에서 이미 커밋돼 있어야 한다 — 이 함수는 `db`를 건드리지 않는다(쓰기·커밋·롤백 전부 0)."""
    try:
        async with AsyncSession(bind=db.bind, expire_on_commit=False) as side:
            await work(side)
            await side.commit()
        return True
    except Exception:
        logger.warning("%s — 부수 작업 실패(주 기록은 이미 커밋 · 되돌리지 않음 · 재시도 없음)", describe, exc_info=True)
        return False
