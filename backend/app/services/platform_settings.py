"""story #2728(P0·과금) — platform_settings 싱글턴 조회.

이 테이블은 정확히 1행(마이그 0255가 고정 id로 시드)만 갖는다는 게 설계 불변식 — 애플리케이션
코드는 이 헬퍼로만 읽고, 새 행을 만들지 않는다(mutation은 sprintable-admin/internal-api 전용,
app/models/platform_setting.py 모듈 docstring 참고)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.platform_setting import PlatformSetting


async def get_platform_settings(session: AsyncSession) -> PlatformSetting:
    """싱글턴 행 조회. 행 자체가 없으면(마이그 미적용 등 이상 상태) 명시 실패 —
    "없으면 안전하게 기본값"처럼 조용히 넘기지 않는다(카디르 결함사냥 교훈 — 불명확한
    상태를 안전측 추정으로 덮으면 재발한다)."""
    row = (await session.execute(select(PlatformSetting))).scalars().first()
    if row is None:
        raise RuntimeError(
            "platform_settings 테이블에 행이 없음 — migration 0255 미적용 또는 삭제됨"
        )
    return row
