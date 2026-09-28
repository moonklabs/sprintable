"""story #3999(3994/3997 후속) — 「시스템 발행」(runtime_type == 'system-publisher')은
조직마다 자동 생성되는 예약 멤버라 사람이 손으로 바꾸면 안 된다(런타임을 바꾸면 다음
자동 발행이 두 번째 「시스템 발행」을 만드는 실 결함까지 확認됨, story #3994 CHANGES-2
그라운딩). FE는 3994/3997이 진입점을 이미 읽기 전용/제외로 막았지만, FE 게이트는 직접
API 호출로 우회 가능하므로 서버가 정본이어야 한다(§3779: BE는 사람 문장을 싣지 않는다 —
코드형 409만). 페드루 PO 정정(2026-09-17) — FE 진입점 자체가 없어(3994/3997이 이미
숨김·제외) `apps/web`에 `SYSTEM_PUBLISHER_RESERVED` 소비처 0건 — 오직 직접 API 호출로만
도달하며, FE `KNOWN_ERRORS` labelKey 매핑은 없다(추가 필요도 없음, 생기면 그때 추가).

읽기 경로(키 목록/정책 조회 등)는 이 가드를 타지 않는다 — «시스템 발행에 키가 0개다」를
보는 것 자체는 무해하고, AC1의 관심사는 오직 예약 멤버의 상태를 바꾸는 쓰기 경로다.
"""
from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

SYSTEM_PUBLISHER_RUNTIME_TYPE = "system-publisher"


def assert_not_system_publisher(runtime_type: str | None) -> None:
    """쓰기(mutation) 경로 전용 — 대상 멤버의 runtime_type이 이미 조회돼 있을 때 이 함수 하나로
    409를 던진다. `detail`을 dict로 줘 `app.main.http_exception_handler`의 구조화-에러
    패스스루(코드 dict → `error.code`로 그대로 승격, AGENT_MESSAGE_POLICY_DENIED와 동일
    관례)를 타게 한다 — `error.code == "SYSTEM_PUBLISHER_RESERVED"`(§3779 — 사람 문장 0).
    페드루 PO 정정 — FE 진입점이 없어 직접 API 호출로만 도달, FE labelKey 매핑 없음(위
    모듈 docstring 참고)."""
    if runtime_type == SYSTEM_PUBLISHER_RUNTIME_TYPE:
        raise HTTPException(status_code=409, detail={"code": "SYSTEM_PUBLISHER_RESERVED"})


async def assert_member_id_not_system_publisher(session: AsyncSession, member_id: uuid.UUID) -> None:
    """`assert_agent_owner`를 안 쓰는 자리(project_access.py·webhooks.py — 이미 다른 축의
    ownership 게이트를 통과한 뒤 대상 member_id만 남는 경로)에서, 그 member_id 하나로
    runtime_type을 직접 재조회해 거부한다. 대상이 없으면(존재 검증은 호출부 몫) 통과
    (guard는 존재 확인 책임이 아니다 — 이미 존재를 전제로 도달한 자리에서만 쓴다)."""
    from app.models.member import Member

    runtime_type = (await session.execute(
        select(Member.runtime_type).where(Member.id == member_id)
    )).scalar_one_or_none()
    assert_not_system_publisher(runtime_type)
