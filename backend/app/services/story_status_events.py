"""스토리 status_changed side-effects 공유 발화 (41a6e294).

정상 board PATCH 경로와 gate-driven done(merge approve)이 **동일 side-effects**를 내도록 단일 helper로
추출 — events(publish→eventbus 소비=L1 `activity_events` 캡처)·webhook·L2 trigger·notification·
StoryActivity. gate-driven done이 status만 직접 set해 활동그래프에 누락되던 자기모순(게이트가 만든
done이 게이트 증거에 안 잡힘)을 닫고, 정상 경로와 parity(드리프트 0)를 보장한다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def _epic_title(db: AsyncSession, epic_id: uuid.UUID | None) -> str | None:
    if not epic_id:
        return None
    from app.models.pm import Goal

    result = await db.execute(select(Goal).where(Goal.id == epic_id).limit(1))
    epic = result.scalar_one_or_none()
    return epic.title if epic else None


async def stage_status_changed_sse_outbox(
    db: AsyncSession,
    org_id: uuid.UUID,
    story,
    old_status: str | None,
    *,
    actor_id: uuid.UUID | None = None,
    actor_name: str | None = None,
    actor_role: str | None = None,
    actor_type: str | None = None,
) -> None:
    """E-ARCH S3b(story #2078, SSE 좁힘 설계 2026-07-21): status_changed SSE만 outbox에 atomic
    적재 — **caller의 commit 전에 호출**해야 한다(그래야 caller의 commit에 outbox row가 같이
    실려 진짜 atomic). commit은 이 함수가 안 함(caller 책임).

    ⚠️webhook·L2 트리거·notification·StoryActivity는 이 함수의 스코프가 아니다 — 그것들은
    지금처럼 `emit_story_status_changed()`가 commit **후** best-effort로 계속 처리한다(오르테가군
    판정: "emit 누락 0" 목표는 SSE 1개만 atomic이면 달성, 5-effect 전부를 커밋 안에 넣는 건
    과잉 수술). `event_broker_outbox_enabled`(default False)가 꺼져 있으면 완전 no-op —
    `event_broker.publish_atomic()` 자체가 그 상태에서 아무것도 안 한다(무회귀). 켜져 있어도
    `emit_story_status_changed()`의 기존 `_push_to_agent` 루프는 **아직 안 건드림**(둘 다 켜진
    채 실 dispatch가 동시 활성화되면 LISTEN+Redis 공존 때와 동형 중복 위험 — 콜사이트 전원 이관
    완료 + 그 루프 제거가 동시 cutover여야 안전, 3b 후속 단계).
    """
    if old_status == story.status:
        return

    from app.services.event_broker import event_broker
    from app.services.project_auth import project_accessible_member_ids

    epic_title: str | None = None
    try:
        epic_title = await _epic_title(db, story.epic_id)
    except Exception:
        pass

    event_data = {
        "story_id": str(story.id),
        "story_title": story.title,
        "story_priority": story.priority,
        "epic_id": str(story.epic_id) if story.epic_id else None,
        "epic_title": epic_title,
        "status": story.status,
        "new_status": story.status,
        "old_status": old_status,
        "project_id": str(story.project_id),
        "org_id": str(org_id),
        "actor_id": str(actor_id) if actor_id else None,
        "actor_name": actor_name,
        "actor_role": actor_role,
        "source_agent_id": str(actor_id) if (actor_id and actor_type == "agent") else None,
        "assignees": [str(story.assignee_id)] if story.assignee_id else [],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event_type": "story.status_changed",
    }

    try:
        member_ids = await project_accessible_member_ids(db, org_id, story.project_id)
        for member_id in member_ids:
            await event_broker.publish_atomic(db, "agent", str(member_id), "story.status_changed", dict(event_data))
    except Exception:
        logger.warning(
            "status_changed SSE outbox 적재 실패(story=%s project=%s) — state 커밋은 이 실패와 무관하게 진행됨",
            story.id, story.project_id, exc_info=True,
        )


async def emit_story_status_changed(
    db: AsyncSession,
    org_id: uuid.UUID,
    story,
    old_status: str | None,
    *,
    actor_id: uuid.UUID | None = None,
    actor_name: str | None = None,
    actor_role: str | None = None,
    actor_type: str | None = None,
) -> None:
    """story status_changed의 side-effects 5종을 발화. old==new면 no-op.

    호출자가 story.status를 이미 새 값으로 설정한 뒤 호출한다. 각 side-effect는 best-effort(실패
    격리)로 status 전이 자체를 깨지 않는다. publish_event는 eventbus→L1 activity_events 캡처의
    진입점이므로 gate-driven done도 이걸 타야 활동그래프(=verdict 증거원)에 잡힌다.
    """
    if old_status == story.status:
        return
    # lazy import — service→router/pipeline 순환 회피.
    from app.models.pm import StoryActivity
    from app.routers.events import publish_event
    from app.services.member_resolver import canonicalize_member_id
    from app.services.notification_dispatch import dispatch_notification
    from app.services.rule_evaluator import EventContext
    from app.services.webhook_dispatch import fire_webhooks
    from app.services.workflow_pipeline import process_event

    epic_title: str | None = None
    try:
        epic_title = await _epic_title(db, story.epic_id)
    except Exception:
        pass

    event_data = {
        "story_id": str(story.id),
        "story_title": story.title,
        "story_priority": story.priority,
        "epic_id": str(story.epic_id) if story.epic_id else None,
        "epic_title": epic_title,
        "status": story.status,
        "new_status": story.status,
        "old_status": old_status,
        "project_id": str(story.project_id),
        "org_id": str(org_id),
        "actor_id": str(actor_id) if actor_id else None,
        "actor_name": actor_name,
        "actor_role": actor_role,
        "source_agent_id": str(actor_id) if (actor_id and actor_type == "agent") else None,
        "assignees": [str(story.assignee_id)] if story.assignee_id else [],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # c60dd33c: webhook 게이팅 기준 = 알림 대상(assignee/actor)과 동일 notify_ids. dispatch_notification
    # 과 공유하므로 fire_webhooks 호출 전에 먼저 산출한다.
    notify_ids: set[uuid.UUID] = set()
    if story.assignee_id:
        notify_ids.add(story.assignee_id)
    if actor_id and actor_id != story.assignee_id:
        notify_ids.add(actor_id)

    publish_event(str(org_id), "story.status_changed", event_data)

    # story #2059/#2067(까심군 라이브 실측 확定 — 별도 액터 PATCH+브라우저 raw SSE 로깅, 25초
    # 무수신): 위 publish_event()의 org-level fanout은 `_subscribers[org_id]`로 가는데 이 레지스트리에
    # `.add()`하는 코드가 저장소 전체 0곳이라 영구 빈 집합 — FE가 실제로 붙는 경로는
    # `_agent_connections[member_id]`(`_push_to_agent()`로만 채워짐)뿐이다. 선례(story
    # 9ef0f914·trust_pipeline.py `_maybe_emit`)와 동일하게 "레지스트리 통합"이 아니라 project
    # 인가 필터를 낀 수동 포워딩으로 그 갭을 메운다 — 순수 transient push(Event row 생성 0,
    # 연결 안 된 멤버는 `_push_to_agent` 자체가 조용히 no-op).
    try:
        from app.routers.events import _push_to_agent
        from app.services.project_auth import project_accessible_member_ids

        member_ids = await project_accessible_member_ids(db, org_id, story.project_id)
        sse_payload = {"event_type": "story.status_changed", **event_data}
        for member_id in member_ids:
            _push_to_agent(str(member_id), dict(sse_payload))
    except Exception:
        logger.warning(
            "status_changed SSE 포워딩 실패(story=%s project=%s) — org publish는 이미 발행됨",
            story.id, story.project_id, exc_info=True,
        )

    try:
        # AC2: story.status_changed 의 member-bound webhook 은 관련자(notify_ids)만 수신 → org-wide
        # 과다 fan-out 차단. member_id=null 진짜 activity-feed 브로드캐스트는 보존(preserve_broadcast).
        await fire_webhooks(
            db, org_id, "story.status_changed", event_data,
            recipient_member_ids=notify_ids,
        )
    except Exception:
        pass
    try:
        await process_event(
            db,
            org_id,
            story.project_id,
            EventContext(
                event_type="story.status_changed",
                trigger_type_slug="status_changed",
                actor_id=str(actor_id) if actor_id else None,
                metadata=event_data,
            ),
        )
    except Exception:
        pass

    if notify_ids:
        # notif도 best-effort 격리 — gate 경로는 flush後 commit前 emit이라 notif 실패가 story done을
        # 롤백할 수 있다. 나머지 4 side-effect와 동일하게 isolation.
        try:
            await dispatch_notification(
                db,
                org_id=org_id,
                event_type="story_status_changed",
                target_member_ids=list(notify_ids),
                title=f"스토리 상태 변경: {story.title} → {story.status}",
                body=None,
                reference_type="story",
                reference_id=story.id,
                # S2: 멀티프로젝트 에이전트 assignee를 스토리 프로젝트로 정확 라우팅
                source_project_id=story.project_id,
            )
        except Exception:
            pass

    if actor_id:
        try:
            db.add(
                StoryActivity(
                    story_id=story.id,
                    org_id=org_id,
                    project_id=story.project_id,
                    activity_type="status_changed",
                    old_value=old_status,
                    new_value=story.status,
                    created_by=(await canonicalize_member_id(actor_id, db)),
                )
            )
            await db.flush()
        except Exception:
            pass

    # P0-04(doc trust-pipeline-be-design §4 훅③): trust_stage 파생 재계산 — 변경 시에만
    # story.trust_stage_changed emit. best-effort 격리(다른 4종과 동일 — 실패해도 status 전이 무영향).
    try:
        from app.services.trust_pipeline import emit_on_story_status_change

        await emit_on_story_status_change(db, org_id, story.id, old_status, actor_id=actor_id)
    except Exception:
        pass


async def advance_story_to_done(
    db: AsyncSession,
    org_id: uuid.UUID,
    story,
    *,
    actor_id: uuid.UUID | None = None,
    actor_type: str | None = None,
    actor_name: str | None = None,
) -> bool:
    """story 를 done 으로 전이하는 **단일 idempotent 헬퍼**(E-GHAPP Bot-L.1).

    gate-approve(`_advance_story_on_merge_approve`)와 PR-merge close-on-merge 가 **공유**한다 — 상태전이
    정책을 한 곳에 둬 중복 advance/drift 를 막는다. story None/이미 done 이면 **no-op(False)**. 전이 시
    emit_story_status_changed 로 status_changed side-effects(events·webhook·L2·notification·activity)를
    동일하게 발화(board 경로와 parity). 호출자는 org-scope 로 story 를 조회해 넘긴다(anti-IDOR).
    """
    if story is None or story.status == "done":
        return False  # 멱등: 이미 done/부재 → no-op.
    old_status = story.status
    story.status = "done"
    await db.flush()
    await emit_story_status_changed(
        db, org_id, story, old_status,
        actor_id=actor_id, actor_type=actor_type, actor_name=actor_name,
    )
    return True
