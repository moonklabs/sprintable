"""story #3261 — Execution 워커 3종(Blueprint §1.1/§1.2: 지식 Task·org 상태 Task·에스컬레이션
Task). Interaction Agent가 이 함수들을 "Task"로 호출한다(개별 API를 노출하지 않고 이 좁은
계약 뒤로 접는다 — §1.2 원칙).

⛔지식 Task·org 상태 Task는 **골격만**(story #3259 injection_defense.py와 동형 패턴) — 지식원
자체(story #4, 임베딩 검색층)와 org 상태 read-only 위임 토큰 소비 API(story #1 계약은 있으나
실제 backend 측 read-only 엔드포인트는 미도입)가 없어 내용을 못 채운다. 호출 지점과 로그
남기는 계약만 지금 고정 — "아직 없다"를 사용자에게 정직하게 말하는 것도 이 Task들의 정직한
동작이다(BAO/S "모르면 모른다" 원칙, Blueprint §0).

에스컬레이션 Task만 **실 구현** — AC2가 이 스토리 스코프에 명시적으로 포함."""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SupportEscalation, SupportExecutionLog


async def knowledge_task(db: AsyncSession, *, conversation_id: uuid.UUID, org_id: uuid.UUID, query: str) -> str:
    log = SupportExecutionLog(
        conversation_id=conversation_id,
        org_id=org_id,
        task_type="knowledge",
        model="n/a",
        summary=f"stub — query={query[:80]!r}",
    )
    db.add(log)
    return "아직 지식원이 연결되지 않아 이 질문에 확실히 답할 수 없습니다(story #4 예정)."


async def org_status_task(db: AsyncSession, *, conversation_id: uuid.UUID, org_id: uuid.UUID, question: str) -> str:
    log = SupportExecutionLog(
        conversation_id=conversation_id,
        org_id=org_id,
        task_type="org_status",
        model="n/a",
        summary=f"stub — question={question[:80]!r}",
    )
    db.add(log)
    return "아직 조직 상태 조회 기능이 연결되지 않았습니다."


async def escalation_task(
    db: AsyncSession, *, conversation_id: uuid.UUID, org_id: uuid.UUID, reason: str, detail: str
) -> SupportEscalation:
    escalation = SupportEscalation(conversation_id=conversation_id, org_id=org_id, reason=reason, detail=detail)
    db.add(escalation)
    log = SupportExecutionLog(
        conversation_id=conversation_id,
        org_id=org_id,
        task_type="escalation",
        model="n/a",
        summary=f"reason={reason} detail={detail[:80]!r}",
    )
    db.add(log)
    return escalation
