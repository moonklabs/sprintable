"""L2-S1: dispatch 핵심 로직 서비스 추출 (블루프린트 §3·§5).

`/api/v2/dispatch` 라우터의 핵심(entity → assignee dispatched 이벤트 생성 + 전달 + wake)을
재사용 가능한 service로 분리한다. L2 휴리스틱 트리거가 같은 경로로 에이전트를 깨우기 위해
소비한다(라우터/HTTP·auth와 무관하게 호출 가능). 거동·순서는 기존 라우터와 동일.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc
from app.models.event import Event, EventType
from app.models.hypothesis import Hypothesis
from app.models.pm import Goal, Sprint, Story
from app.routers.agent_gateway import wake_agent
from app.routers.events import _event_to_payload, _push_to_agent
from app.services.activity_stream import extract_activities_best_effort
from app.services.event_seq import assign_recipient_seq
from app.services.member_resolver import resolve_member_identity
from app.services.notification_dispatch import dispatch_notification
from app.services.workflow_readiness_matrix import READINESS_MATRIX

# S21/S27: dispatch 가능 엔티티는 readiness matrix 의 dispatch_capable SSOT 에서 도출.
_ENTITY_TYPES = {e for e, d in READINESS_MATRIX.items() if d.dispatch_capable}


async def _resolve_sprint_dispatch_owner(
    db: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
) -> uuid.UUID | None:
    """Sprint 은 assignee 컬럼이 없어 전이 wake 를 프로젝트 relay-owner 로 보낸다(S27).

    owner 해소는 member-SSOT(project_auth.resolve_project_relay_owner) 단일 경로 — ad-hoc
    TeamMember.role 리졸버 금지(grant/admin 403 드리프트 회피). 부재 시 None(no_assignee 가시화·
    가짜 fallback 금지). 반환 canonical member id 는 resolve_member_identity 의 human/agent 분기에 위임.
    """
    from app.services.project_auth import resolve_project_relay_owner

    return await resolve_project_relay_owner(db, project_id, org_id)


class DispatchResponse(BaseModel):
    dispatched: bool
    event_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    assignee_type: str | None = None
    # 7f8066a3: dispatched=False 사유 구분 → FE 가 no_assignee(담당자 미지정·info 안내)와
    # unresolved_assignee(신원 해소 실패·error)를 다르게 표시. additive·null default 하위호환.
    reason: str | None = None
    # E-DG S7: commit=False 호출자가 commit 후 wake 하려면 recipient_seq 필요(agent). additive.
    recipient_seq: int | None = None


async def _fetch_entity(
    db: AsyncSession,
    entity_type: str,
    entity_id: uuid.UUID,
    org_id: uuid.UUID,
) -> tuple[uuid.UUID | None, str | None, str | None, uuid.UUID | None]:
    """(assignee_id, title, description, project_id) 반환."""
    if entity_type == "epic":
        row = await db.execute(
            select(Goal.assignee_id, Goal.title, Goal.description, Goal.project_id).where(
                Goal.id == entity_id, Goal.org_id == org_id
            )
        )
        r = row.one_or_none()
    elif entity_type == "story":
        row = await db.execute(
            select(Story.assignee_id, Story.title, Story.description, Story.project_id).where(
                Story.id == entity_id, Story.org_id == org_id
            )
        )
        r = row.one_or_none()
    elif entity_type == "doc":
        row = await db.execute(
            select(Doc.assignee_id, Doc.title, Doc.content, Doc.project_id).where(
                Doc.id == entity_id, Doc.org_id == org_id, Doc.deleted_at.is_(None)
            )
        )
        r = row.one_or_none()
    elif entity_type == "hypothesis":
        # S23: assignee=owner_member_id(책임 human)·title=statement·description 컬럼 없음(None).
        row = await db.execute(
            select(Hypothesis.owner_member_id, Hypothesis.statement, Hypothesis.project_id).where(
                Hypothesis.id == entity_id, Hypothesis.org_id == org_id
            )
        )
        r0 = row.one_or_none()
        r = (r0[0], r0[1], None, r0[2]) if r0 is not None else None
    elif entity_type == "sprint":
        row = await db.execute(
            select(Sprint.title, Sprint.status, Sprint.project_id).where(
                Sprint.id == entity_id, Sprint.org_id == org_id
            )
        )
        r0 = row.one_or_none()
        if r0 is None:
            r = None
        else:
            assignee_id = await _resolve_sprint_dispatch_owner(db, org_id, r0.project_id)
            r = (assignee_id, r0.title, f"status={r0.status}", r0.project_id)
    else:
        return None, None, None, None

    if r is None:
        return None, None, None, None
    return r[0], r[1], r[2], r[3]


async def _finalize_dispatch(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    entity_type: str,
    entity_id: uuid.UUID,
    recipient_id: uuid.UUID,
    member_type: str,
    sender_id: uuid.UUID | None,
    payload: dict[str, Any],
    content: str,
    title: str,
    message: str | None,
    commit: bool,
    hypothesis_anchor: dict[str, Any] | None = None,
    context_pack: str | None = None,
) -> tuple[DispatchResponse, dict[str, Any] | None]:
    """ccbcd9da(A-2): Event 생성+flush+seq+활동추출+notification+(commit 시)wake 의 **단일 공통 경로**.

    ``dispatch_entity_to_assignee``/``dispatch_payload_to_member`` 두 형제함수가 이 로직을 각자
    따로 구현해온 것 자체가 재발 원인(#1364 는 한쪽만 고쳐짐 — [[project_dispatch_payload_to_member_silent_gap]]).
    이후 이 경로를 고치면 두 형제 모두 자동 반영돼 재이원화가 구조적으로 불가능해진다.

    commit=False 면 여기서 commit/wake 하지 않는다(호출자 트랜잭션 합류·P1-2) — 단 delivery 는
    **항상** 반환하므로 호출자가 자기 commit 후 스케줄한다(#1364 선례와 동일 계약).
    """
    event = Event(
        project_id=project_id,
        org_id=org_id,
        event_type=EventType.dispatched.value,
        source_entity_type=entity_type,
        source_entity_id=entity_id,
        sender_id=sender_id,
        recipient_id=recipient_id,
        recipient_type=member_type,
        payload=payload,
        status="pending",
    )
    db.add(event)
    await db.flush()
    if member_type == "agent":
        await assign_recipient_seq(db, event)

    await extract_activities_best_effort(db, [event.id])

    if member_type != "agent":
        await dispatch_notification(
            db,
            org_id=org_id,
            event_type="dispatched",
            target_member_ids=[recipient_id],
            title=title,
            body=message or None,
            reference_type=entity_type,
            reference_id=entity_id,
        )

    if commit:
        await db.commit()  # commit 후 seq 확정
        if member_type == "agent":
            if event.recipient_seq is not None:
                wake_agent(str(recipient_id), event.recipient_seq)
            else:
                _push_to_agent(str(recipient_id), _event_to_payload(event))

    response = DispatchResponse(
        dispatched=True,
        event_id=event.id,
        assignee_id=recipient_id,
        assignee_type=member_type,
        recipient_seq=event.recipient_seq,
        reason="ok",
    )
    # 1f01c1ad: CC 릴레이(member webhook) 주입 파라미터 — 호출자가 스케줄(commit=True 도 delivery
    # 는 항상 반환·라우터가 background_tasks 로 스케줄하는 기존 계약 유지).
    delivery = {
        "org_id": org_id,
        "recipient_id": recipient_id,
        "content": content,
        "event_type": "dispatched",
        "source_entity_type": entity_type,
        "source_entity_id": entity_id,
        "hypothesis_anchor": hypothesis_anchor,
        "context_pack": context_pack,
    }
    return response, delivery


async def dispatch_entity_to_assignee(
    db: AsyncSession,
    org_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    message: str | None = None,
    trigger_metadata: dict[str, Any] | None = None,
    sender_id: uuid.UUID | None = None,
    commit: bool = True,
) -> tuple[DispatchResponse, dict[str, Any] | None]:
    """entity의 assignee에게 dispatched 이벤트 생성 + 알림 전달 + (agent) wake.

    순서(기존 라우터와 동일): assignee resolve → resolve_dispatch_anchor → Event(dispatched) →
    flush → agent면 assign_recipient_seq → L1 활동 추출(best-effort) → human이면
    dispatch_notification → commit → agent면 commit 후 wake_agent.

    반환: (DispatchResponse, delivery). delivery는 dispatched=True일 때 CC 릴레이 webhook
    파라미터(없으면 None) — 호출자(라우터는 background_tasks, L2 워커는 직접 await)가 스케줄한다.
    sender_id는 auth 의존이라 호출자가 해소해 넘긴다. trigger_metadata는 payload에 additive 동봉.
    """
    if entity_type not in _ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"entity_type must be one of {_ENTITY_TYPES}")

    assignee_id, title, description, entity_project_id = await _fetch_entity(db, entity_type, entity_id, org_id)
    if title is None:
        raise HTTPException(status_code=404, detail="Entity not found")
    if not assignee_id:
        # 7f8066a3 (a): 담당자 미지정 — 실패 아님(info).
        return DispatchResponse(dispatched=False, reason="no_assignee"), None
    project_id = entity_project_id

    # E-MEMBER-SSOT AC2-2: TeamMember-only가 아니라 resolve_member_identity(TM∪OM) — grant-only
    # 휴먼/polymorphic assignee도 수용해 dispatched:False 오탐 방지 (7f8066a3).
    assignee_member = await resolve_member_identity(assignee_id, org_id, db)
    if assignee_member is None:
        return DispatchResponse(dispatched=False, assignee_id=assignee_id, reason="unresolved_assignee"), None
    member_type = assignee_member.type

    # E1-S6 L4: 대표 가설 anchor 주입 (epic/story) — additive.
    from app.services.hypothesis import (
        format_anchor_line,
        resolve_dispatch_anchor,
        resolve_dispatch_context_pack,
    )
    hypothesis_anchor = await resolve_dispatch_anchor(db, org_id, entity_type, entity_id)
    # E-LOOP-LEDGER P1-S11: Context Pack(S7 markdown brief) 주입 — additive, hypothesis-only 스코프.
    context_pack = await resolve_dispatch_context_pack(db, org_id, entity_type, entity_id)

    # E-EVENT-INJECT S1: connector가 content 없는 이벤트를 드롭하므로 top-level content 부여.
    _detail = (message or description or "").strip()
    content = f"[{entity_type}] {title}" + (f" — {_detail}" if _detail else "")
    if hypothesis_anchor is not None:
        content += "\n" + format_anchor_line(hypothesis_anchor)
    if context_pack is not None:
        content += "\n\n" + context_pack
    payload: dict[str, Any] = {
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "title": title,
        "description": (description or "")[:500],
        "message": message,
        "content": content,
        "hypothesis_anchor": hypothesis_anchor,
        "context_pack": context_pack,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if trigger_metadata is not None:
        payload["trigger_metadata"] = trigger_metadata  # AC③: L2 트리거 출처 additive

    # E-DG S7: commit=False면 호출자 트랜잭션에 합류 — 여기서 commit/wake 하지 않는다(P1-2
    # partial-failure 방지). 호출자가 status/step_run/event 를 한 트랜잭션으로 commit 한 뒤 wake 한다
    # (recipient_seq 확정 commit 후 wake 불변식).
    return await _finalize_dispatch(
        db,
        org_id=org_id,
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id,
        recipient_id=assignee_id,
        member_type=member_type,
        sender_id=sender_id,
        payload=payload,
        content=content,
        title=f"[{entity_type}] {title}",
        message=message or (description or "")[:200] or None,
        commit=commit,
        hypothesis_anchor=hypothesis_anchor,
        context_pack=context_pack,
    )


async def dispatch_payload_to_member(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    *,
    title: str,
    content: str,
    source_entity_type: str,
    source_entity_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
    message: str | None = None,
    trigger_metadata: dict[str, Any] | None = None,
    sender_id: uuid.UUID | None = None,
    commit: bool = True,
) -> tuple[DispatchResponse, dict[str, Any] | None]:
    """S22: entity assignee 와 무관하게 **특정 member**(예: doc author=created_by)에게 dispatched
    이벤트 생성 + notification(human) + (agent) wake. ``dispatch_entity_to_assignee`` 와 동일한
    ``_finalize_dispatch`` 공통 경로 사용(ccbcd9da A-2 — 형제함수 이원화가 #1364 부분수정 재발 원인).

    반환: (DispatchResponse, delivery) — ``dispatch_entity_to_assignee`` 와 동형 계약. delivery 는
    commit 여부와 무관하게 dispatched=True 일 때 항상 반환되므로, commit=False 호출자는 **자기
    commit 후** delivery 로 wake/webhook 을 스케줄해야 한다(전엔 이 반환 자체가 없어 무음이었음).
    ⚠️ commit=False 면 여기서 commit/wake 하지 않는다(호출자 트랜잭션 합류·P1-2)."""
    member = await resolve_member_identity(member_id, org_id, db)
    if member is None:
        return DispatchResponse(dispatched=False, assignee_id=member_id, reason="unresolved_member"), None
    member_type = member.type

    payload: dict[str, Any] = {
        "entity_type": source_entity_type,
        "entity_id": str(source_entity_id),
        "title": title,
        "message": message,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if trigger_metadata is not None:
        payload["trigger_metadata"] = trigger_metadata  # 새 event type 금지·trigger_metadata additive

    return await _finalize_dispatch(
        db,
        org_id=org_id,
        project_id=project_id,
        entity_type=source_entity_type,
        entity_id=source_entity_id,
        recipient_id=member_id,
        member_type=member_type,
        sender_id=sender_id,
        payload=payload,
        content=content,
        title=title,
        message=message,
        commit=commit,
    )
