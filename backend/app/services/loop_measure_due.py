"""story #2829(loop-closure P0, doc loop-closure-first-class-signal-design §1) — 「닫히지
않은 루프」 감지 + preset.loop.measure_due 발행.

대상 2류(설계 doc §1 그대로, 새 판정축 발명 0):
    ①measure_after 도과 hypothesis(status active|measuring) — measuring 도과 = 채점
      실패/미지원(hypothesis_scorer.py가 measuring 유지)라 이 축이 그 사각을 대신 신호한다.
    ①measure_after 도과 goal(status active)
    ②outcome 판정 없이 done된 goal(outcome_status='n_a')

발행은 대상당 **1회**(loop_measure_due_notified_at set-once — 컬럼 주석 참조, 무한
재발행 방지=AC③). outcome이 실제로 해소되면(hypothesis status 전이·goal outcome_status
갱신) 조회 조건 자체를 벗어나 자연 소멸 — 별도 "해제" 로직 불요.

owner_member_id가 없으면(goal 미배정) 발행 대상에서 제외(escalation routing이 payload_
field라 받는 쪽이 없으면 발행 자체가 무의미) — 카운터 API(§3, command_center.py)는 이
필터와 무관하게 항상 실물 그대로 센다(발행 성패가 "닫히지 않았다"는 사실을 안 바꾼다).

⛔못 잡는 것(AC⑤, 페드루 PO 판정 2026-08-20 — P0 관측 단계에선 fix 대신 선언으로 수용):
set-once가 「재도과」를 못 잡는다 — 한 번 발행돼 notified_at이 찍힌 뒤, 그 hypothesis/goal의
outcome이 해소되지 않은 채 owner가 measure_after를 미래로 늘려 잡았다가 그 새 날짜도 다시
지나면, notified_at이 이미 non-NULL이라 재발행이 안 된다(조회 조건 `IS NULL`을 영원히
못 만족). 카운터 API(§3)는 measure_after<=now만 보므로 이 케이스도 N에는 여전히 잡히지만
(관측 축은 안전), preset 이벤트(액션 알림 축)만 조용히 죽는다. P1(outcome 커플링) 이후
재검토 — 지금은 "발행 1회 보장"이 "매 재도과마다 재알림"보다 단순·안전(무한루프 방지 원칙과
직접 충돌)하므로 이 gap을 의도적으로 수용한다.

⛔SAVEPOINT로 감싸지 않는다(hypothesis_scorer.py와 달리) — publish_preset_event는 내부
send_message()가 자체 commit을 이미 수행하는 자기완결 트랜잭션이라, 이걸 session.
begin_nested()로 한 번 더 감싸면 그 내부 commit이 바깥 SAVEPOINT까지 닫아버려 "closed
transaction" 오류가 난다(실측 확認). 개별 try/except만으로 격리한다 — 실제 자매 호출부
(cron.py의 preset.goal.measured 발행)도 동일하게 SAVEPOINT 없이 try/except뿐이다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import Hypothesis
from app.models.pm import Goal

logger = logging.getLogger(__name__)

_PRESET_KEY = "preset.loop.measure_due"
_ACTIVE_HYPOTHESIS_STATUSES = ("active", "measuring")


async def _publish_one(
    session: AsyncSession, *, org_id, payload: dict,
) -> None:
    from app.routers.events import publish_preset_event

    await publish_preset_event(session, org_id, _PRESET_KEY, payload)


async def detect_unclosed_loops(session: AsyncSession) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    published: list[dict] = []
    failed: list[dict] = []
    skipped_no_owner = 0

    # ① 도과 hypothesis(active·measuring)
    hyp_rows = (
        await session.execute(
            select(Hypothesis).where(
                Hypothesis.status.in_(_ACTIVE_HYPOTHESIS_STATUSES),
                Hypothesis.measure_after <= now,
                Hypothesis.loop_measure_due_notified_at.is_(None),
            )
        )
    ).scalars().all()
    for hyp in hyp_rows:
        if not hyp.owner_member_id:
            skipped_no_owner += 1
            continue
        payload = {
            "work_item_type": "hypothesis",
            "work_item_id": str(hyp.id),
            "owner_member_id": str(hyp.owner_member_id),
            "measure_after": hyp.measure_after.isoformat(),
            "overdue_days": (now - hyp.measure_after).days,
            "reason": "measure_after_overdue",
        }
        try:
            await _publish_one(session, org_id=hyp.org_id, payload=payload)
            hyp.loop_measure_due_notified_at = now
            published.append({"type": "hypothesis", "id": str(hyp.id)})
        except Exception as exc:  # noqa: BLE001 — best-effort(호출자 계약, publish_preset_event docstring).
            logger.warning("loop.measure_due 발행 실패 hypothesis=%s: %s", hyp.id, exc, exc_info=True)
            failed.append({"type": "hypothesis", "id": str(hyp.id), "error": str(exc)})

    # ① 도과 goal(active)
    overdue_goal_rows = (
        await session.execute(
            select(Goal).where(
                Goal.status == "active",
                Goal.measure_after.isnot(None),
                Goal.measure_after <= now,
                Goal.loop_measure_due_notified_at.is_(None),
            )
        )
    ).scalars().all()
    for goal in overdue_goal_rows:
        if not goal.assignee_id:
            skipped_no_owner += 1
            continue
        payload = {
            "work_item_type": "epic",  # 실체=Goal, project 해소 SSOT 리터럴(payload_schema 주석 참조).
            "work_item_id": str(goal.id),
            "owner_member_id": str(goal.assignee_id),
            "measure_after": goal.measure_after.isoformat(),
            "overdue_days": (now - goal.measure_after).days,
            "reason": "measure_after_overdue",
        }
        try:
            await _publish_one(session, org_id=goal.org_id, payload=payload)
            goal.loop_measure_due_notified_at = now
            published.append({"type": "goal", "id": str(goal.id), "reason": "measure_after_overdue"})
        except Exception as exc:  # noqa: BLE001
            logger.warning("loop.measure_due 발행 실패 goal=%s: %s", goal.id, exc, exc_info=True)
            failed.append({"type": "goal", "id": str(goal.id), "error": str(exc)})

    # ② outcome 판정 없이 done된 goal — story #2843: "n_a"(손 안 댐) + "unmeasured"(done 전이 시
    # 판정 미제공 자동 마킹) 둘 다 대상. command_center.py의 동형 카운터와 정합(unmeasurable은
    # 명시 선언이라 제외 — AC②).
    done_no_outcome_rows = (
        await session.execute(
            select(Goal).where(
                Goal.status == "done",
                Goal.outcome_status.in_(("n_a", "unmeasured")),
                Goal.loop_measure_due_notified_at.is_(None),
            )
        )
    ).scalars().all()
    for goal in done_no_outcome_rows:
        if not goal.assignee_id:
            skipped_no_owner += 1
            continue
        payload = {
            "work_item_type": "epic",  # 실체=Goal, project 해소 SSOT 리터럴(payload_schema 주석 참조).
            "work_item_id": str(goal.id),
            "owner_member_id": str(goal.assignee_id),
            "measure_after": goal.measure_after.isoformat() if goal.measure_after else None,
            "overdue_days": None,
            "reason": "done_without_outcome",
        }
        try:
            await _publish_one(session, org_id=goal.org_id, payload=payload)
            goal.loop_measure_due_notified_at = now
            published.append({"type": "goal", "id": str(goal.id), "reason": "done_without_outcome"})
        except Exception as exc:  # noqa: BLE001
            logger.warning("loop.measure_due 발행 실패 goal(done)=%s: %s", goal.id, exc, exc_info=True)
            failed.append({"type": "goal", "id": str(goal.id), "error": str(exc)})

    return {
        "published": published,
        "failed": failed,
        "skipped_no_owner": skipped_no_owner,
        "total_scanned": len(hyp_rows) + len(overdue_goal_rows) + len(done_no_outcome_rows),
    }


async def list_measure_due_queue(
    session: AsyncSession,
    org_id: uuid.UUID,
    *,
    project_id: uuid.UUID | None = None,
    unclaimed_only: bool = False,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """story #2845(loop-closure P2) — 「닫히지 않은 루프」 큐(읽기전용).

    detect_unclosed_loops()와 동일 3축 union을 그대로 재사용하되(새 판정축 발명 0) 발행
    부작용은 0(publish_preset_event 미호출·notified_at 미기록) — command_center.py의
    attention_item 요약(타입당 limit=20, 대시보드 nudge용)과 달리 이 큐는 **전량**을
    페이지네이션으로 노출한다(claim 가능한 큐 자체가 목적).

    claim은 신규 엔드포인트 0 — 기존 PATCH /hypotheses/{id}(owner_member_id)·
    PATCH /goals/{id}(assignee_id)가 이미 이 필드를 authz 검증 하에 갱신 가능(§AC⑤, 페드루
    PO 판정 2026-08-20). 이 함수가 하는 일은 «보이게» 뿐 — claim 실행은 그 기존 경로로.
    """
    now = datetime.now(timezone.utc)
    items: list[dict[str, Any]] = []

    hyp_q = select(
        Hypothesis.id, Hypothesis.statement, Hypothesis.measure_after,
        Hypothesis.owner_member_id, Hypothesis.project_id,
    ).where(
        Hypothesis.org_id == org_id,
        Hypothesis.status.in_(_ACTIVE_HYPOTHESIS_STATUSES),
        Hypothesis.measure_after <= now,
    )
    if project_id is not None:
        hyp_q = hyp_q.where(Hypothesis.project_id == project_id)
    if unclaimed_only:
        hyp_q = hyp_q.where(Hypothesis.owner_member_id.is_(None))
    for hyp_id, statement, measure_after, owner_id, p_id in (await session.execute(hyp_q)).all():
        items.append({
            "work_item_type": "hypothesis", "work_item_id": str(hyp_id), "title": statement,
            "owner_member_id": str(owner_id) if owner_id else None,
            "_sort_key": measure_after,
            "overdue_days": (now - measure_after).days if measure_after else None,
            "reason": "measure_after_overdue",
            "project_id": str(p_id) if p_id else None,
        })

    goal_q = select(
        Goal.id, Goal.title, Goal.measure_after, Goal.assignee_id, Goal.project_id,
    ).where(
        Goal.org_id == org_id, Goal.status == "active",
        Goal.measure_after.isnot(None), Goal.measure_after <= now,
    )
    if project_id is not None:
        goal_q = goal_q.where(Goal.project_id == project_id)
    if unclaimed_only:
        goal_q = goal_q.where(Goal.assignee_id.is_(None))
    for goal_id, title, measure_after, assignee_id, p_id in (await session.execute(goal_q)).all():
        items.append({
            "work_item_type": "epic", "work_item_id": str(goal_id), "title": title,
            "owner_member_id": str(assignee_id) if assignee_id else None,
            "_sort_key": measure_after,
            "overdue_days": (now - measure_after).days if measure_after else None,
            "reason": "measure_after_overdue",
            "project_id": str(p_id) if p_id else None,
        })

    done_q = select(
        Goal.id, Goal.title, Goal.updated_at, Goal.assignee_id, Goal.project_id,
    ).where(
        Goal.org_id == org_id, Goal.status == "done",
        Goal.outcome_status.in_(("n_a", "unmeasured")),
    )
    if project_id is not None:
        done_q = done_q.where(Goal.project_id == project_id)
    if unclaimed_only:
        done_q = done_q.where(Goal.assignee_id.is_(None))
    for goal_id, title, updated_at, assignee_id, p_id in (await session.execute(done_q)).all():
        items.append({
            "work_item_type": "epic", "work_item_id": str(goal_id), "title": title,
            "owner_member_id": str(assignee_id) if assignee_id else None,
            "_sort_key": updated_at,
            "overdue_days": None,
            "reason": "done_without_outcome",
            "project_id": str(p_id) if p_id else None,
        })

    items.sort(key=lambda it: it["_sort_key"] or now)
    total = len(items)
    page = items[offset:offset + limit]
    for it in page:
        del it["_sort_key"]
    return {"items": page, "total": total, "limit": limit, "offset": offset}
