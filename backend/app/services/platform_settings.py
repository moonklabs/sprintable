"""story #2728(P0·과금) — platform_settings 싱글턴 조회 + 결제 게이팅 판정.

이 테이블은 정확히 1행(마이그 0255가 고정 id로 시드)만 갖는다는 게 설계 불변식 — 애플리케이션
코드는 이 헬퍼로만 읽고, 새 행을 만들지 않는다(mutation은 sprintable-admin/internal-api 전용,
app/models/platform_setting.py 모듈 docstring 참고)."""
from __future__ import annotations

from fastapi import HTTPException
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


def require_billing_checkout_enabled(settings: PlatformSetting) -> None:
    """story #2728(PO 확定, 2026-08-24) — 결제 처리형 엔드포인트 전부가 이 함수 하나로
    판정한다. 거부는 403+명시 에러코드로 구조화(평문 문자열이 아니라
    `{"code": "BILLING_NOT_LIVE", "message": ...}`) — 클라이언트가 「기능 비활성」을
    다른 4xx 사유(org 권한 없음 등)와 구별 처리할 수 있게(app/main.py의 전역
    http_exception_handler가 dict detail의 "code"를 그대로 패스스루 — admin_billing.py의
    AdminBillingError 응답과 동형).

    카디르 QA(PR#3460) REQUEST_CHANGES — 처음엔 org_subscription_checkout.py 안에만
    로컬 헬퍼로 뒀는데, 그 파일의 6개 진입점 밖에도 결제 처리형 엔드포인트가 더 있었다
    (billing_packs.py POST /packs·ee/routers/billing.py POST /checkout(Polar 구세계,
    EE 환경서 라이브 등록)) — 전부 실측 확認. 「판정이 갈라지면 그 자체가 결함」이라
    로컬 헬퍼 재복제 대신 이 서비스 모듈로 승격해 3개 라우터 파일이 전부 이 함수
    하나를 공유한다."""
    if not settings.billing_checkout_enabled:
        raise HTTPException(
            status_code=403,
            detail={"code": "BILLING_NOT_LIVE", "message": "billing checkout is not yet enabled"},
        )
