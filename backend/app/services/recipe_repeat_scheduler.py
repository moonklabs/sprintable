"""story #3337(선생님 4바퀴 실사고, 페드루 PO 설계 확定 2026-09-02) — cron tick 실행부.
`recipe_repeat_schedule.py`가 stage 발행 시점에 세운/최신화한 스케줄 행을 훑어 다음 회차
collect 이벤트를 발행한다.

트리거는 GCP Cloud Scheduler(레포 밖 SSOT, 페드루 확定) → `GET /api/v2/internal/cron/
recipe-repeat-tick`(cron.py, 이 파일과 짝) — `workflow_sla_processor.py`(SKIP LOCKED 배치·
tick당 상한)와 동형 관례.

정지 조건 3종(페드루 확定):
1. consecutive_failure_count >= 3 → paused + owner 통지.
2. 정의 비활성/삭제(EventDefinition 조회 실패 또는 enabled=False) → paused(통지 — 정지 원인이
   달라도 "정지됐다"는 사실 자체는 알려야 함).
3. project 소프트삭제(archived 개념이 이 스키마엔 없음 — Project.deleted_at을 그 대용으로
   씀, 그라운딩에서 확認: SoftDeleteMixin뿐, 별도 archived 컬럼 없음) → paused.
   (org 자체의 "archived" 상태도 이 스키마엔 없다 — org가 통째로 없어지는 경우만 방어.)

성공 발행은 이 파일이 스케줄 행을 직접 안 건드린다 — 발행이 같은 파이프(`publish_preset_event`
→ `_publish_registry_event_core`)를 타면서 `maybe_upsert_repeat_schedule`의 "첫 stage+repeat"
분기가 그대로 다시 돌아 next_run_at/consecutive_failure_count를 자연히 리셋한다(같은 훅
재사용, 이 파일에 이중 로직 없음)."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.recipe_repeat_schedule import RecipeRepeatSchedule

logger = logging.getLogger(__name__)

_TICK_BATCH_SIZE = 200


async def _resolve_definition(db: AsyncSession, *, org_id: uuid.UUID, key: str):
    from app.models.event_definition import EventDefinition
    from sqlalchemy import or_

    return (await db.execute(
        select(EventDefinition).where(
            EventDefinition.key == key,
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        ).order_by(EventDefinition.org_id.is_(None)).limit(1)
    )).scalars().first()


async def _resolve_project_active(db: AsyncSession, *, project_id: uuid.UUID) -> bool:
    from app.models.project import Project

    project = (await db.execute(
        select(Project).where(Project.id == project_id)
    )).scalar_one_or_none()
    return project is not None and project.deleted_at is None


async def _notify_owner_paused(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, definition_key: str, reason: str,
) -> None:
    """정지 알림 — story #3340이 만든 relay_owner 폴백(project owner→org owner→admin)과
    같은 자격 해소를 재사용. system publisher가 보낸 DM(승인카드 DM 패턴과 동형 인프라
    재사용 — approval_delivery.py::_get_or_create_approval_dm)."""
    try:
        from app.services.project_auth import resolve_project_relay_owner

        owner_id = await resolve_project_relay_owner(db, project_id, org_id)
        if owner_id is None:
            logger.warning(
                "recipe_repeat_scheduler: 정지 알림 대상(owner) 없음 org=%s project=%s definition=%s",
                org_id, project_id, definition_key,
            )
            return

        from app.routers.events import _get_or_create_system_publisher
        from app.services.approval_delivery import _get_or_create_approval_dm
        from app.models.conversation import ConversationMessage

        # story #3337 — 알림 실패가 정지 처리 자체(뮤테이션, 호출부가 이미 반영한 status=
        # paused/consecutive_failure_count)를 되돌리면 안 된다(best-effort, maybe_create_
        # stage_gate의 카드발송 실패 처리와 동형 관례) — SAVEPOINT로 이 알림 쓰기만 격리한다
        # (feedback_savepoint_failopen_session_poison 교훈 — 보조 write 실패가 세션 전체를
        # poison하지 않게 begin_nested로 명시 경계를 긋는다).
        async with db.begin_nested():
            # _get_or_create_system_publisher는 Member 객체를 반환한다(id 아님) — 그대로
            # requester_id/sender_id에 넣으면 SQL 바인딩 시점에 ArgumentError로 죽는다.
            system_member = await _get_or_create_system_publisher(db, org_id)
            conv = await _get_or_create_approval_dm(
                db, org_id=org_id, project_id=project_id, requester_id=system_member.id, approver_id=owner_id,
            )
            db.add(ConversationMessage(
                conversation_id=conv.id, sender_id=system_member.id,
                content=f"[반복 스케줄 정지] '{definition_key}' 정의의 반복 발행이 멈췄습니다 — {reason}",
                mentioned_ids=[owner_id],
            ))
    except Exception:
        logger.warning(
            "recipe_repeat_scheduler: 정지 알림 발행 실패(org=%s project=%s definition=%s)",
            org_id, project_id, definition_key, exc_info=True,
        )


async def _publish_next_collect_event(db: AsyncSession, *, org_id: uuid.UUID, definition_key: str, payload: dict) -> None:
    """`publish_preset_event`(events.py)와 동형이되, 그 함수의 **BackgroundTasks 실행 실패를
    "발행 실패"로 안 센다**는 한 가지가 다르다. 이유(실측 확認, story #3337 자체 발견) —
    `publish_preset_event`가 `background_tasks()`를 즉시 동기 await하는데, 그 배경 태스크
    (Discord relay·mark_agent_replied 등, 전역 pg_pubsub/채널 라우팅 — 이 함수의 관심사인
    "다음 회차가 실제로 생겼는가"와 무관한 side-channel)가 실패하면 예외가 그대로
    `publish_preset_event` 밖으로 샌다. `_publish_gate_verdict_notification`(gate_service.py)
    처럼 알림 하나가 실패해도 무해한 자리라면 그 실패를 통째로 삼켜도 되지만, 이 함수의
    호출부(process_recipe_repeat_ticks)는 그 예외를 "이번 회차 발행 실패"로 해석해 **이미
    커밋 대기 중인 새 Story·collect 이벤트 메시지까지 롤백**하고 consecutive_failure_count를
    올린다 — side-channel 노이즈로 진짜 회차가 유실되고 3번 반복되면 스케줄까지 정지되는
    사고가 난다. 그래서 여기서 `_publish_registry_event_core`(진짜 발행 본체)와
    `background_tasks()`(side-channel)를 분리해, 후자의 실패만 별도로 삼킨다."""
    from fastapi import BackgroundTasks

    from app.dependencies.auth import AuthContext
    from app.models.event_definition import EventDefinition
    from app.routers.events import _get_or_create_system_publisher, _publish_registry_event_core
    from sqlalchemy import or_

    definition_row = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.key == definition_key,
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        ).limit(1)
    )).scalars().first()
    if definition_row is None:
        raise ValueError(f"definition not found/disabled at publish time: {definition_key!r}")

    system_member = await _get_or_create_system_publisher(db, org_id)
    auth = AuthContext(
        user_id=str(system_member.id), email=None,
        claims={"app_metadata": {"api_key_id": "system-publisher"}}, org_id=str(org_id),
    )
    background_tasks = BackgroundTasks()
    # 진짜 발행 본체 — 여기서 던지는 예외만 "회차 발행 실패"로 취급한다.
    await _publish_registry_event_core(db, org_id, auth, definition_key, payload, background_tasks)
    try:
        await background_tasks()
    except Exception:
        logger.warning(
            "recipe_repeat_scheduler: 회차 발행 자체는 성공, background task(Discord relay 등)만 "
            "실패(org=%s definition=%s) — best-effort, 회차 발행 실패로 안 침", org_id, definition_key,
            exc_info=True,
        )


async def _build_next_collect_payload(schedule: RecipeRepeatSchedule, *, new_work_item_id: uuid.UUID, stage: str) -> dict:
    payload: dict[str, Any] = {
        "work_item_type": schedule.work_item_type, "work_item_id": str(new_work_item_id),
        "stage": stage, "repeat": schedule.repeat,
    }
    payload.update(schedule.last_payload_snapshot or {})
    return payload


async def _create_next_story(db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, schedule: RecipeRepeatSchedule, definition_name: str) -> uuid.UUID:
    """story #3337 AC — 매 회차 새 Story 자동 생성(기본, 정의별 override는 후속). assignee는
    직전 회차 story에서 승계(story #3340 도달 원칙과 정합 — 새 Story도 미배정으로 안 태어남)."""
    from app.models.pm import Story

    assignee_id = None
    if schedule.last_story_id is not None:
        prev = (await db.execute(
            select(Story.assignee_id).where(Story.id == schedule.last_story_id, Story.org_id == org_id)
        )).scalar_one_or_none()
        assignee_id = prev

    now = datetime.now(timezone.utc)
    title = f"{definition_name} — {now.strftime('%Y-%m-%d')}"
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id,
    )
    db.add(story)
    await db.flush()
    return story.id


async def process_recipe_repeat_ticks(db: AsyncSession) -> dict[str, int]:
    """cron 진입점 — 만료된(next_run_at<=now) active 스케줄을 훑어 다음 회차를 발행한다.
    SKIP LOCKED로 동시 tick 겹침을 방어(workflow_sla_processor.py와 동형 관례) — 같은 행을
    두 워커가 동시에 집으면 한쪽만 잠금을 얻는다."""
    now = datetime.now(timezone.utc)
    rows = (await db.execute(
        select(RecipeRepeatSchedule)
        .where(RecipeRepeatSchedule.status == "active", RecipeRepeatSchedule.next_run_at <= now)
        .order_by(RecipeRepeatSchedule.next_run_at.asc())
        .limit(_TICK_BATCH_SIZE)
        .with_for_update(skip_locked=True)
    )).scalars().all()

    counts = {"fired": 0, "paused_definition_disabled": 0, "paused_project_deleted": 0, "paused_max_failures": 0, "failed": 0}

    # story #3337 — 행마다 독립 커밋(workflow_sla_processor.py의 "tick 끝에 한 번" 관례와
    # 다르게 간다: publish_preset_event()가 내부에서 send_message()의 background task를
    # 동기 await하고, 그 task가 session 상태에 개입한다 — SAVEPOINT(begin_nested)로 감싸면
    # "closed transaction inside context manager"로 깨진다(실측 확인). 대신 한 행 = 한
    # top-level commit/rollback 단위로 격리한다 — 앞선 행이 이미 commit된 뒤에는 뒷행의
    # rollback이 앞행을 되돌릴 수 없다(각자 자기 트랜잭션에서 끝남).
    for schedule in rows:
        definition = await _resolve_definition(db, org_id=schedule.org_id, key=schedule.definition_key)
        if definition is None or not definition.enabled:
            schedule.status = "paused"
            await db.commit()
            await _notify_owner_paused(
                db, org_id=schedule.org_id, project_id=schedule.project_id,
                definition_key=schedule.definition_key, reason="정의가 비활성화되었거나 삭제되었습니다",
            )
            await db.commit()
            counts["paused_definition_disabled"] += 1
            continue

        if not await _resolve_project_active(db, project_id=schedule.project_id):
            schedule.status = "paused"
            await db.commit()
            await _notify_owner_paused(
                db, org_id=schedule.org_id, project_id=schedule.project_id,
                definition_key=schedule.definition_key, reason="프로젝트가 삭제(archive)되었습니다",
            )
            await db.commit()
            counts["paused_project_deleted"] += 1
            continue

        stage_prop = (definition.payload_schema.get("properties") or {}).get("stage") or {}
        enum = stage_prop.get("enum")
        first_stage = enum[0] if isinstance(enum, list) and enum else None
        if first_stage is None:
            # 정의가 그새 사이클형이 아니게(payload_schema 수정) — 스케줄 자체가 무의미해짐.
            schedule.status = "paused"
            await db.commit()
            await _notify_owner_paused(
                db, org_id=schedule.org_id, project_id=schedule.project_id,
                definition_key=schedule.definition_key, reason="정의가 더 이상 사이클형이 아닙니다",
            )
            await db.commit()
            counts["paused_definition_disabled"] += 1
            continue

        # story #3337(실측 확認) — rollback()은 세션의 모든 객체를 expire한다. except 블록에서
        # schedule.* 를 다시 읽으면 SQLAlchemy가 동기 컨텍스트에서 lazy-reload를 시도해
        # MissingGreenlet으로 죽는다 — rollback 前에 필요한 값을 평범한 로컬 변수로 미리 뽑아둔다.
        _schedule_id, _org_id, _definition_key = schedule.id, schedule.org_id, schedule.definition_key
        try:
            new_story_id = await _create_next_story(
                db, org_id=schedule.org_id, project_id=schedule.project_id, schedule=schedule,
                definition_name=definition.name or definition.key,
            )
            payload = await _build_next_collect_payload(schedule, new_work_item_id=new_story_id, stage=first_stage)

            await _publish_next_collect_event(
                db, org_id=schedule.org_id, definition_key=schedule.definition_key, payload=payload,
            )
            await db.commit()
            counts["fired"] += 1
        except Exception:
            await db.rollback()
            logger.warning(
                "recipe_repeat_scheduler: 회차 발행 실패(schedule_id=%s definition=%s org=%s)",
                _schedule_id, _definition_key, _org_id, exc_info=True,
            )
            # rollback이 이전 SELECT...FOR UPDATE 잠금까지 풀어버린다 — 실패 카운터 증가는
            # 별도의 짧은 재조회+갱신 트랜잭션으로(그 잠금 없이도 안전 — 이 tick 배치 자체가
            # SKIP LOCKED라 동시 tick이 같은 행을 다시 잡으면 그쪽이 자연히 skip한다).
            refreshed = (await db.execute(
                select(RecipeRepeatSchedule).where(RecipeRepeatSchedule.id == _schedule_id)
            )).scalar_one_or_none()
            if refreshed is not None:
                refreshed.consecutive_failure_count += 1
                if refreshed.consecutive_failure_count >= 3:
                    refreshed.status = "paused"
                    await db.commit()
                    await _notify_owner_paused(
                        db, org_id=refreshed.org_id, project_id=refreshed.project_id,
                        definition_key=refreshed.definition_key,
                        reason=f"연속 {refreshed.consecutive_failure_count}회 발행 실패",
                    )
                    await db.commit()
                    counts["paused_max_failures"] += 1
                else:
                    await db.commit()
            counts["failed"] += 1

    return counts
