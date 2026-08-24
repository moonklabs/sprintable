"""스토리 status_changed side-effects 공유 발화 (41a6e294).

정상 board PATCH 경로와 gate-driven done(merge approve)이 **동일 side-effects**를 내도록 단일 helper로
추출 — events(publish→eventbus 소비=L1 `activity_events` 캡처)·webhook·L2 trigger·notification·
StoryActivity. gate-driven done이 status만 직접 set해 활동그래프에 누락되던 자기모순(게이트가 만든
done이 게이트 증거에 안 잡힘)을 닫고, 정상 경로와 parity(드리프트 0)를 보장한다.
"""
from __future__ import annotations

import logging
import time
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
    request_received_at: float | None = None,
) -> None:
    """story status_changed의 side-effects를 발화. old==new면 no-op.

    호출자가 story.status를 이미 새 값으로 설정한 뒤 호출한다. 각 side-effect는 best-effort(실패
    격리)로 status 전이 자체를 깨지 않는다.

    ⚠️계약(story #2173, 2026-07-24 — «결함인지 아닌지 가르기» 판정): 이 함수는 **호출자에게
    예외를 전파하지 않는다** — SSE·webhook·L2·notification·StoryActivity·trust_pipeline 전부
    개별 try/except로 감싸져 있다(tests/test_emit_story_status_changed_isolation.py로 고정).
    이 계약 덕에 `update_story_status`(단건 PATCH)는 이 호출을 try/except로 안 감싸도 안전하고,
    `bulk_update_stories`의 item별 try/except는 emit 신뢰성이 아니라 순수 다건성(한 item 실패가
    나머지를 막으면 안 됨) 때문이다 — 두 콜사이트의 차이는 우연이 아니라 이 계약에서 파생된다.
    무너지는 조건: 나중에 이 함수에 개별 try/except 없는 새 side-effect가 추가되면 이 계약이
    깨진다 — 추가하는 사람이 그 자리도 감싸야 한다(또는 두 콜사이트 재검토).

    `request_received_at`(#2176 AC1, 2026-07-24): 미르코 실측 — 칸반 상태변경이 액터 호출부터
    화면 도착까지 10초(전달 4.7초+렌더 5.0초)였는데, "액터 호출 시작"이 MCP 발신 시각이라 그
    안에 BE 처리·발행이 전부 섞여 있어 #2158의 순수 SSE 전송 400ms대와 기준선이 다르다는
    caveat이 있었다 — 쪼개지 않고 "전달이 느리다"로 가면 엉뚱한 곳을 파게 된다. 호출자(route
    handler)가 요청 수신 직후 `time.time()`을 넘기면, 이 함수가 "요청 수신→emit 착수" 구간과
    "emit 착수→fan-out 완료"(recipient 수·#2157 팬아웃 겹침 여부 판단용) 구간을 로그 한 줄로
    가른다. 순수 logging(DB/Redis 호출 0)이라 #2123이 비운 hot-path에 부하를 다시 안 얹는다.

    ⚠️story #2132(2026-07-23) 정정 — 이 docstring이 예전에 "publish_event는 eventbus→L1
    activity_events 캡처의 진입점"이라 주장했으나 **사실이 아니었다**: L1 capture(
    `extract_activities_best_effort`)는 전부 `Event(...)` DB row 생성 직후 명시 호출로만
    이뤄지고(events.py/stories.py:story_assigned/conversations.py/agent_dispatch.py/
    notification_dispatch.py), story.status_changed는 그 어디에도 안 걸려 있었다 — publish_event()
    (org-level in-process fanout, `_subscribers` 영구 죽은 레지스트리)를 지금 삭제해도 이 사실엔
    아무 영향이 없다(원래도 L1에 안 잡히고 있었다). status_changed를 L1에 새로 잡을지는 이
    스토리(#2132) 스코프 밖 — 별도 판단 필요."""
    if old_status == story.status:
        return
    # lazy import — service→router/pipeline 순환 회피.
    from app.models.pm import StoryActivity
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

    # story #2059/#2067(까심군 라이브 실측 확定 — 별도 액터 PATCH+브라우저 raw SSE 로깅, 25초
    # 무수신) + #2132(2026-07-23 근본수정): 구 `publish_event()`의 org-level fanout은
    # `_subscribers[org_id]`로 가는데 이 레지스트리에 `.add()`하는 코드가 저장소 전체 0곳이라
    # 영구 빈 집합이었다 — 그 함수 자체를 삭제했다. FE가 실제로 붙는 경로는
    # `_agent_connections[member_id]`(`_push_to_agent()`로만 채워짐)뿐이라, 선례(story
    # 9ef0f914·trust_pipeline.py `_maybe_emit`)와 동일하게 project 인가 필터를 낀 수동
    # 포워딩만 남긴다 — 순수 transient push(Event row 생성 0, 연결 안 된 멤버는
    # `_push_to_agent` 자체가 조용히 no-op).
    # #2176 AC1(오르테가군 PR 리뷰 지적): 여기 `time.monotonic()`이 아니라 `time.time()`이
    # 맞는 선택이다 — 이 값은 duration 계산에만 쓰이는 게 아니라 **절대 시각으로 로그에
    # 찍혀** 미르코군의 클라측 `Date.now()` 타임스탬프와 맞대볼 수 있어야 한다.
    # monotonic은 프로세스-로컬 기준점이라 절대 의미가 없어 그 크로스-프로세스 대조가
    # 안 된다 — "정석은 monotonic 아닌가"로 나중에 고치면 이 대조 능력이 깨진다.
    _emit_started_at = time.time()
    try:
        from app.routers.events import _push_to_agent
        from app.services.project_auth import project_accessible_member_ids

        member_ids = await project_accessible_member_ids(db, org_id, story.project_id)
        sse_payload = {"event_type": "story.status_changed", **event_data}
        for member_id in member_ids:
            _push_to_agent(str(member_id), dict(sse_payload))
    except Exception:
        logger.warning(
            "status_changed SSE 포워딩 실패(story=%s project=%s)",
            story.id, story.project_id, exc_info=True,
        )
    finally:
        # #2176 AC1: 구간 계측 로그(순수 logging, DB/Redis 호출 0 — hot-path 무부하).
        # request_received_at 미전달 콜사이트(advance_story_to_done 등)는 그 구간을 None으로
        # 남긴다 — 이 함수 자체는 그 값의 유무를 몰라도 되게 설계(호출자 계약 확장 없음).
        try:
            _emit_completed_at = time.time()
            _server_processing_ms = (
                round((_emit_started_at - request_received_at) * 1000, 1)
                if request_received_at is not None else None
            )
            logger.info(
                "story status_changed emit timing",
                extra={"structured": {
                    "story_id": str(story.id),
                    "old_status": old_status,
                    "new_status": story.status,
                    "request_received_at": request_received_at,
                    "emit_started_at": _emit_started_at,
                    "emit_completed_at": _emit_completed_at,
                    "recipient_count": len(member_ids) if "member_ids" in locals() else None,
                    # 요청 수신 → emit 착수(처리+commit 구간, AC1 핵심)
                    "server_processing_ms": _server_processing_ms,
                    # emit 착수 → fan-out 완료(recipient 순회 자체가 느린지, #2157 팬아웃 겹침 여부용, AC5)
                    "emit_fanout_ms": round((_emit_completed_at - _emit_started_at) * 1000, 2),
                }},
            )
        except Exception:  # noqa: BLE001 — 계측 실패가 이미 발화된 side-effect를 되돌리면 안 됨.
            pass

    try:
        # AC2: story.status_changed 의 member-bound webhook 은 관련자(notify_ids)만 수신 → org-wide
        # 과다 fan-out 차단. member_id=null 진짜 activity-feed 브로드캐스트는 보존(preserve_broadcast).
        # story #2460(§6 봉합②): 외부 I/O(webhook POST)를 요청 트랜잭션 밖으로 — outbox 경유.
        await fire_webhooks(
            db, org_id, "story.status_changed", event_data,
            recipient_member_ids=notify_ids,
            via_outbox=True,
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
                # story #2460(§6 봉합②): 개인 webhook·Expo push 실배달을 요청 트랜잭션 밖으로.
                via_outbox=True,
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

    # story #2791(P0, event-workflow-unification-design-2790) — preset.work.status_changed
    # 서버 자동발행. 구계통(위 5-effect)과 **병행**(대체 아님) — 이벤트 레지스트리 발행
    # 대화 메시지를 하나 더 추가할 뿐 기존 SSE/webhook/notification은 무변경. best-effort
    # 격리는 여기(호출자)의 몫 — publish_preset_event 자체는 예외를 안 삼킨다.
    try:
        from app.routers.events import publish_preset_event

        # ⛔실버그(디디군 교차QA, 2026-08-19) — payload_schema(0245)의 changed_by_member_id는
        # `{"type":"string","format":"uuid"}`로 non-nullable(assigned_by_member_id와 달리
        # null 허용 union이 아님). actor_id 없는 전이(시스템/자동 전이 — 바로 이 P0 자동발행
        # 자체가 그 사례)에서 값을 None으로 실으면 스키마 위반 400 → 발행이 영구 불발됐었다.
        # 키가 required는 아니므로 값이 없으면 아예 안 싣는다(스키마상 정직한 표현).
        payload = {
            "work_item_type": "story",
            "work_item_id": str(story.id),
            "from_status": old_status,
            "to_status": story.status,
        }
        if actor_id:
            payload["changed_by_member_id"] = str(actor_id)
        await publish_preset_event(db, org_id, "preset.work.status_changed", payload)
    except Exception:
        logger.warning(
            "preset.work.status_changed 자동발행 실패(story=%s org=%s)",
            story.id, org_id, exc_info=True,
        )

    # story #f2b66f32(3025, BE·상태 자가회수) — done 전이 시 이 story에 걸린 pending merge-type
    # 게이트를 voided로 자가회수(승인 위조 아님, AC3 — gate_self_reclamation.py 모듈 docstring
    # 참조). best-effort 격리(다른 side-effect들과 동일 — 실패해도 status 전이 무영향).
    if story.status == "done":
        try:
            from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story

            await reclaim_stale_merge_gates_for_story(db, org_id, story.id)
        except Exception:
            logger.warning(
                "merge gate 자가회수 실패(story=%s org=%s)",
                story.id, org_id, exc_info=True,
            )


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

    story #2965(2026-08-23)·story #2327(2026-07-30) — 예전엔 gate-approve(구
    `_advance_story_on_merge_approve`, 제거됨)와 PR-merge close-on-merge(정지됨) 둘 다 이 헬퍼를
    이벤트 하나만으로 직접 불렀다. 둘 다 "머지/승인 ≠ done, done은 사람 확認 後" 규율 위반으로
    PO가 정지시켜, **현재 이 함수를 부르는 자리는 board의 사람 명시 status PATCH 경로뿐**이다.
    함수 자체는 삭제하지 않는다 — 조직 단위 auto-done on/off 설정이 생기면(아직 없음) 그 설정을
    읽어 조건부로 재배선할 단일 idempotent 헬퍼로 의도적으로 남겨둔다. story None/이미 done
    이면 **no-op(False)**. 전이 시 emit_story_status_changed 로 status_changed side-effects
    (events·webhook·L2·notification·activity)를 발화(board 경로와 parity). 호출자는 org-scope
    로 story 를 조회해 넘긴다(anti-IDOR).
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
