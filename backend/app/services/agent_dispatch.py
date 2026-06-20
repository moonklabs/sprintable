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
from app.models.pm import Epic, Story
from app.routers.agent_gateway import wake_agent
from app.routers.events import _event_to_payload, _push_to_agent
from app.services.activity_stream import extract_activities_best_effort
from app.services.event_seq import assign_recipient_seq
from app.services.member_resolver import resolve_member_identity
from app.services.notification_dispatch import dispatch_notification
from app.services.workflow_readiness_matrix import READINESS_MATRIX

# S21: dispatch 가능 엔티티는 readiness matrix 의 dispatch_capable SSOT 에서 도출(현 epic/story/doc).
# hypothesis/sprint fetch 추가(S23/S26) 시 matrix descriptor 만 바꾸면 자동 확장. _fetch_entity 분기는
# 그때 함께 확장(현 byte-동일).
_ENTITY_TYPES = {e for e, d in READINESS_MATRIX.items() if d.dispatch_capable}


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
            select(Epic.assignee_id, Epic.title, Epic.description, Epic.project_id).where(
                Epic.id == entity_id, Epic.org_id == org_id
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
    else:
        return None, None, None, None

    if r is None:
        return None, None, None, None
    return r[0], r[1], r[2], r[3]


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
    from app.services.hypothesis import format_anchor_line, resolve_dispatch_anchor
    hypothesis_anchor = await resolve_dispatch_anchor(db, org_id, entity_type, entity_id)

    # E-EVENT-INJECT S1: connector가 content 없는 이벤트를 드롭하므로 top-level content 부여.
    _detail = (message or description or "").strip()
    content = f"[{entity_type}] {title}" + (f" — {_detail}" if _detail else "")
    if hypothesis_anchor is not None:
        content += "\n" + format_anchor_line(hypothesis_anchor)
    payload: dict[str, Any] = {
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "title": title,
        "description": (description or "")[:500],
        "message": message,
        "content": content,
        "hypothesis_anchor": hypothesis_anchor,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if trigger_metadata is not None:
        payload["trigger_metadata"] = trigger_metadata  # AC③: L2 트리거 출처 additive

    event = Event(
        project_id=project_id,
        org_id=org_id,
        event_type=EventType.dispatched.value,
        source_entity_type=entity_type,
        source_entity_id=entity_id,
        sender_id=sender_id,
        recipient_id=assignee_id,
        recipient_type=member_type,
        payload=payload,
        status="pending",
    )
    db.add(event)
    await db.flush()
    # per-recipient dense seq 발급 (agent recipient만 — commit 순서 직렬화 보장)
    if member_type == "agent":
        await assign_recipient_seq(db, event)

    # L1 BE-3: direct dispatch event → activity_events 1행(best-effort·delivery 무영향).
    await extract_activities_best_effort(db, [event.id])

    if member_type != "agent":
        await dispatch_notification(
            db,
            org_id=org_id,
            event_type="dispatched",
            target_member_ids=[assignee_id],
            title=f"[{entity_type}] {title}",
            body=message or (description or "")[:200] or None,
            reference_type=entity_type,
            reference_id=entity_id,
        )

    # E-DG S7: commit=False면 호출자 트랜잭션에 합류 — 여기서 commit/wake 하지 않는다(P1-2
    # partial-failure 방지). 호출자가 status/step_run/event 를 한 트랜잭션으로 commit 한 뒤 wake 한다
    # (recipient_seq 확정 commit 후 wake 불변식). event.id/recipient_seq 는 위 flush 로 이미 확정.
    if commit:
        await db.commit()  # commit 후 seq 확정
        # agent: commit 후 wake (gateway_seq 확정 보장, 이중전달 방지)
        if member_type == "agent":
            if event.recipient_seq is not None:
                wake_agent(str(assignee_id), event.recipient_seq)
            else:
                _push_to_agent(str(assignee_id), _event_to_payload(event))

    response = DispatchResponse(
        dispatched=True,
        event_id=event.id,
        assignee_id=assignee_id,
        assignee_type=member_type,
        recipient_seq=event.recipient_seq,
        reason="ok",
    )
    # 1f01c1ad: CC 릴레이(member webhook) 주입 파라미터 — 호출자가 스케줄(라우터=background_tasks).
    delivery = {
        "org_id": org_id,
        "recipient_id": assignee_id,
        "content": content,
        "event_type": "dispatched",
        "source_entity_type": entity_type,
        "source_entity_id": entity_id,
        "hypothesis_anchor": hypothesis_anchor,
    }
    return response, delivery


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
) -> DispatchResponse:
    """S22: entity assignee 와 무관하게 **특정 member**(예: doc author=created_by)에게 dispatched
    이벤트 생성 + (agent) wake. ``dispatch_entity_to_assignee`` 의 member-dispatch core 를 author-wake
    용으로 분리한 lower-level helper(assignee 고정 우회). 순서/불변식 동일(flush→seq→commit 후 wake).
    ⚠️ commit=False 면 호출자 트랜잭션 합류(여기서 commit/wake 안 함·P1-2)."""
    member = await resolve_member_identity(member_id, org_id, db)
    if member is None:
        return DispatchResponse(dispatched=False, assignee_id=member_id, reason="unresolved_member")
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

    event = Event(
        project_id=project_id,
        org_id=org_id,
        event_type=EventType.dispatched.value,
        source_entity_type=source_entity_type,
        source_entity_id=source_entity_id,
        sender_id=sender_id,
        recipient_id=member_id,
        recipient_type=member_type,
        payload=payload,
        status="pending",
    )
    db.add(event)
    await db.flush()
    if member_type == "agent":
        await assign_recipient_seq(db, event)
    await extract_activities_best_effort(db, [event.id])

    if commit:
        await db.commit()
        if member_type == "agent":
            if event.recipient_seq is not None:
                wake_agent(str(member_id), event.recipient_seq)
            else:
                _push_to_agent(str(member_id), _event_to_payload(event))
    return DispatchResponse(
        dispatched=True, event_id=event.id, assignee_id=member_id,
        assignee_type=member_type, recipient_seq=event.recipient_seq, reason="ok",
    )
