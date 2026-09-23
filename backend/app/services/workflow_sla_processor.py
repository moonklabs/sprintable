"""E-DECISION-GATE S13: SLA processor for human-gate (P1-3).

pending human-gate 가 방치되지 않게 **reminder → escalation → timeout** 정책으로 제품이 독촉한다
(오너 수동 "쳐노는지?" 패턴 제품화). HITL-timeout cron 레일 재사용·별도 endpoint.

보수적 기본: on_timeout 기본 ``keep_pending`` · ⭐auto_approve default off + high-risk/prod-touch/
story_points>=8/trust-unresolved 에서 금지 · ⭐system timeout transition 은 ``resolver_id=None``
(사람 결정이 아니므로 trust 환류 차단). SKIP LOCKED 로 cron 겹침 시 중복 reminder/escalation 방지.
"""
import logging
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.workflow_line import (
    WorkflowLineDefinitionVersion,
    WorkflowLineStepRun,
    WorkflowLineStepRunEvent,
)

logger = logging.getLogger(__name__)

# SLA 가 독촉하는 미해소 human-gate 대기 상태.
_SLA_GATE_STATUSES = ("gate_pending", "waiting_gate", "waiting_parallel", "reminded", "escalated", "held")
_TERMINAL_GATE = frozenset({"approved", "rejected"})
# §6 봉합③(story #2461, finding #5) — 이전엔 이 FOR UPDATE SKIP LOCKED 조회에 상한이 없었다
# ("무제한 배치"). L2TriggerWorker.batch_limit(200)과 동급으로 tick당 상한을 명시한다 — 폭주
# 방지(embedding_backlog.py/event_broker.py outbox 등 기존 배치워커도 전부 명시 상한 보유).
_SLA_BATCH_SIZE = 200


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _resolve_sla_policy(session: AsyncSession, sr: WorkflowLineStepRun) -> dict[str, Any]:
    """step_run 이 가리키는 published config step 의 sla_policy(없으면 {})."""
    if sr.line_definition_id is None:
        return {}
    version = (await session.execute(
        select(WorkflowLineDefinitionVersion).where(
            WorkflowLineDefinitionVersion.line_definition_id == sr.line_definition_id,
            WorkflowLineDefinitionVersion.status == "published",
        ).order_by(WorkflowLineDefinitionVersion.version.desc()).limit(1)
    )).scalar_one_or_none()
    config = dict(version.config) if version and isinstance(version.config, dict) else {}
    for step in config.get("steps") or []:
        if (isinstance(step, dict) and step.get("to_status") == sr.to_status
                and step.get("from_status") in (sr.from_status, None)):
            pol = step.get("sla_policy")
            return pol if isinstance(pol, dict) else {}
    return {}


def _auto_approve_allowed(sr: WorkflowLineStepRun, story_points: int | None) -> bool:
    """⭐auto_approve 금지조건(AC④): high-risk/prod-touch/sp>=8/trust-unresolved 면 False."""
    risk = sr.risk_snapshot or {}
    if risk.get("prod_touch") is True or risk.get("high_risk") is True:
        return False
    if story_points is not None and story_points >= 8:
        return False
    trust = sr.trust_snapshot or {}
    # cold_start / 미해소 trust(hit_rate None) 면 자동승인 금지(보수적).
    if trust.get("cold_start") is True or trust.get("unresolved") is True:
        return False
    if "hit_rate" in trust and trust.get("hit_rate") is None:
        return False
    return True


def _record_event(session: AsyncSession, sr: WorkflowLineStepRun, event_type: str,
                  *, target_id: uuid.UUID | None = None, payload: dict | None = None) -> None:
    session.add(WorkflowLineStepRunEvent(
        org_id=sr.org_id, project_id=sr.project_id, step_run_id=sr.id, event_type=event_type,
        target_member_id=target_id, payload=payload or {}, correlation_id=sr.correlation_id,
    ))


async def _notify(session: AsyncSession, sr: WorkflowLineStepRun, target_id: uuid.UUID | None,
                  event_type: str, title: str) -> None:
    """best-effort notification(실패는 SLA processor 비중단).

    §6 봉합③(story #2461, finding #5) — 이 호출은 `process_sla()`의 FOR UPDATE SKIP LOCKED
    락이 걸린 트랜잭션 안에서 일어난다. `via_outbox=True`(story #2460 인프라 재사용)로 개인
    webhook·Expo push 실배달을 `delivery_jobs`에 enqueue만 하고 `delivery_dispatcher.py`
    워커에 위임한다 — 이 락이 실 webhook POST/Expo 발송(외부 I/O, 대상당 최대 수 초) 동안
    열려 있지 않게 된다(enqueue는 순수 INSERT라 빠름)."""
    if target_id is None:
        return
    try:
        from app.services.notification_dispatch import dispatch_notification
        await dispatch_notification(
            session, org_id=sr.org_id, event_type=event_type, target_member_ids=[target_id],
            title=title, body=f"{sr.entity_type} {sr.entity_id} {sr.from_status}→{sr.to_status}",
            reference_type=sr.entity_type, reference_id=sr.entity_id,
            # story #1953: sr.project_id NOT NULL — 신규 조회 없이 그대로 실음.
            source_project_id=sr.project_id,
            via_outbox=True,
        )
    except Exception:  # noqa: BLE001 — notification 실패는 비중단(best-effort).
        pass


async def _maybe_auto_approve(session: AsyncSession, sr: WorkflowLineStepRun) -> bool:
    """on_timeout=auto_approve + 허용조건 충족 시 system transition(resolver_id=None). 성공 시 True."""
    if sr.gate_id is None:
        return False
    gate = (await session.execute(
        select(Gate).where(Gate.id == sr.gate_id, Gate.org_id == sr.org_id)
    )).scalar_one_or_none()
    if gate is None or gate.status in _TERMINAL_GATE:
        return False
    story_points = None
    from app.models.pm import Story  # 순환 회피 lazy import.
    story = await session.get(Story, sr.entity_id)
    if story is not None:
        story_points = getattr(story, "story_points", None)
    if not _auto_approve_allowed(sr, story_points):
        return False
    from app.services.gate_service import _is_recipe_external_publish_gate, transition_gate

    # story #4190(까디르 4564 CHANGES ②) — «사람 승인은 그 사람이 본 내용에만». 레시피 발행 게이트는 승인 화면이 그린
    # 초안 버전을 싣고 사람이 승인해야 한다(없으면 transition_gate가 409 예외 → process_sla 배치가 끊긴다) — 시스템 자동
    # 승인 대상이 아니다. 건너뛰고 한 줄 남긴 뒤 호출부의 기존 폴백(escalate / keep_pending)으로 간다.
    # (항목별 실패 격리 자체는 story #4228 — 배치를 한 세션에서 잠그는 구조라 SAVEPOINT로는 못 닫는다.)
    if _is_recipe_external_publish_gate(gate):
        _record_event(session, sr, "auto_approve_skipped", payload={"reason": "requires_human_reviewed_draft"})
        return False
    # ⭐resolver_id=None: system 자동승인은 사람 결정이 아니므로 trust 환류 차단(AC⑤).
    await transition_gate(session, sr.org_id, sr.gate_id, "approved", resolver_id=None)
    _record_event(session, sr, "auto_approved", payload={"reason": "sla_timeout_auto_approve"})
    return True


async def process_sla(session: AsyncSession, now: datetime | None = None) -> dict[str, int]:
    """미해소 human-gate step_run 을 SLA 정책대로 reminder/escalation/timeout 처리한다.

    story #4228 — 항목마다 **자기 트랜잭션**. 예전엔 한 세션에서 배치 행을 `FOR UPDATE SKIP LOCKED`로 잡고 끝에 한 번 커밋해,
    ① 한 항목의 예외가 배치 전체를 끊었고(앞 항목 처리분까지 롤백) ② 항목 안 훅의 중간 `commit()`(스토리 게이트 자동 승인 →
    라인 해소 → 상태변경 프리셋 → send_message)이 앞 항목까지 확정하고 **배치 행 잠금을 풀어** 겹친 cron이 같은 행을 또
    처리했다. 이제:
    - 배치는 대상 id만 잠금 없이 고른다.
    - 항목마다 새 세션(`session`과 같은 엔진)에서 그 행을 **상태 필터와 함께** `FOR UPDATE SKIP LOCKED`로 다시 잡는다 — 다른
      cron이 잡고 있거나 이미 해소돼 SLA 상태가 아니면 건너뛴다(`skipped`).
    - 처리 뒤 그 세션만 커밋한다. 카운트는 그 커밋이 성공한 뒤에만 더하고, 실패 항목은 그 세션만 롤백·`error`로 센다.
    - 호출자 `session`은 id 조회에만 쓰고(쓰기 0) 곧바로 트랜잭션을 끝내 커넥션을 돌려준다 — 항목당 동시 커넥션은 최대 2
      (항목 세션 + 항목 안 격리 세션)로, 워커 풀(기본 2+1=3)을 혼자 다 잡지 않는다. 대기 중 에이전트 wake 목록(event_seq)도 항목 세션마다 따로라, 한 항목의
      롤백이 다른 항목의 wake를 지우지 않는다."""
    now = now or _now()
    ids = list((await session.execute(
        select(WorkflowLineStepRun.id).where(
            WorkflowLineStepRun.status.in_(_SLA_GATE_STATUSES),
        ).order_by(WorkflowLineStepRun.started_at.asc())
        .limit(_SLA_BATCH_SIZE)
    )).scalars().all())
    # 호출자 세션의 트랜잭션을 여기서 끝내 커넥션을 풀에 돌려준다(쓰기 0이라 무해). 열어 두면 항목 세션 · 항목 안 격리 세션과
    # 겹쳐 항목 하나에 커넥션 3개 = 워커 풀(기본 2+1) 전부라, 다른 cron과 겹치면 `pool_timeout`으로 항목이 error가 된다.
    await session.commit()

    counts = {"reminded": 0, "escalated": 0, "auto_approved": 0, "kept_pending": 0,
              "unresolved": 0, "skipped": 0, "error": 0}
    for sr_id in ids:
        item_counts: Counter[str] = Counter()
        try:
            async with AsyncSession(bind=session.bind, expire_on_commit=False) as item:
                sr = (await item.execute(
                    select(WorkflowLineStepRun).where(
                        WorkflowLineStepRun.id == sr_id,
                        WorkflowLineStepRun.status.in_(_SLA_GATE_STATUSES),
                    ).with_for_update(skip_locked=True)
                )).scalar_one_or_none()
                if sr is None:
                    # 다른 cron이 지금 잡고 있거나, 조회 뒤 이미 해소됐다 — 이번 틱엔 손대지 않는다.
                    item_counts["skipped"] = 1
                else:
                    await _process_one_step_run(item, sr, now, item_counts)
                    await item.commit()
        except Exception:
            logger.warning("SLA 처리 실패 — 이 step_run만 되돌리고 다음으로(step_run=%s)", sr_id, exc_info=True)
            counts["error"] += 1
            continue
        for key, value in item_counts.items():
            counts[key] = counts.get(key, 0) + value
    return counts


async def _process_one_step_run(
    session: AsyncSession, sr: WorkflowLineStepRun, now: datetime, counts: Counter[str],
) -> None:
    """`process_sla`의 한 항목(reminder / escalation / timeout). `session`은 이 항목만의 세션이다(호출부가 커밋)."""
    # ⭐S31 hold = SLA pause: held step_run 은 reminder/escalation/timeout 일시정지(skip). admin 이
    # 수동 unhold(→gate_pending) 하면 다음 스캔서 정상 처리 재개. ⚠️held 가 이미 _SLA_GATE_STATUSES
    # 라 스캔엔 들어오므로 여기서 per-step skip. (held_until 만료 자동 재개는 S13 통합 followup —
    # 그때 여기서 now>=held_until 이면 gate_pending 복귀시켜 처리.)
    if sr.status == "held":
        counts["skipped"] += 1
        return
    policy = await _resolve_sla_policy(session, sr)
    timeout_h = policy.get("timeout_hours")
    if not timeout_h:
        counts["skipped"] += 1
        return
    elapsed_h = (now - sr.started_at).total_seconds() / 3600.0

    # ── 1) timeout ───────────────────────────────────────────────────────
    if elapsed_h >= timeout_h:
        on_timeout = policy.get("on_timeout", "keep_pending")
        if on_timeout == "auto_approve" and await _maybe_auto_approve(session, sr):
            counts["auto_approved"] += 1
            return
        # keep_pending(기본) 또는 auto_approve 금지 → 보수적: escalate 1회 후 pending 유지.
        escalate_to = policy.get("escalate_to")
        if escalate_to and sr.escalated_to_member_id is None:
            target = await _resolve_escalation(session, sr, escalate_to, now)
            if target is not None:
                sr.escalated_to_member_id = target
                sr.status = "escalated"
                _record_event(session, sr, "escalated", target_id=target,
                              payload={"reason": "sla_timeout"})
                await _notify(session, sr, target, "gate_escalated", "Gate escalated — SLA timeout")
                counts["escalated"] += 1
                return
            # ⭐S14 fold-in: escalate_to(role/deputy)가 해소 안 되면 silent keep_pending 금지 →
            # unresolved_assignee 로 가시화(board badge·silent prison 아님·S14 AC⑥).
            # ⭐멱등(산티아고 SME·S8 동류): cron 재실행마다 append-only escalated(unresolved) event
            # 중복 기록 방지 — 이미 unresolved 표시됐으면 재기록/재카운트 skip.
            if sr.delivery_status != "unresolved_assignee":
                sr.delivery_status = "unresolved_assignee"
                _record_event(session, sr, "escalated",
                              payload={"reason": "sla_timeout", "unresolved": True})
                counts["unresolved"] += 1
            else:
                counts["kept_pending"] += 1  # 이미 가시화됨·중복 event 0
            return
        counts["kept_pending"] += 1  # ⭐방치 아님·gate 유지(이미 escalate or escalate_to 없음)
        return

    # ── 2) reminder ──────────────────────────────────────────────────────
    reminder_after = policy.get("reminder_after_hours")
    max_reminders = policy.get("max_reminders", 0)
    if (reminder_after is not None and elapsed_h >= reminder_after
            and sr.reminder_count < max_reminders
            and (sr.next_reminder_at is None or now >= sr.next_reminder_at)):
        _record_event(session, sr, "reminded", payload={"reminder_count": sr.reminder_count + 1})
        await _notify(session, sr, sr.resolved_member_id, "gate_reminder", "Gate reminder — still pending")
        sr.reminder_count += 1
        every = policy.get("reminder_every_hours") or reminder_after
        sr.next_reminder_at = now + timedelta(hours=every)
        if sr.status != "escalated":
            sr.status = "reminded"
        counts["reminded"] += 1


async def _resolve_escalation(
    session: AsyncSession, sr: WorkflowLineStepRun, escalate_to: Any, now: datetime,
) -> uuid.UUID | None:
    """escalate_to 를 member_id 로 해소.

    UUID(직지정)는 그대로, 비-UUID 는 role_key 로 보고 S14 ``resolve_role_candidate`` 로 deputy/
    availability/SoD 해소(prefer_human·현 assignee 는 SoD 제외). 미해소면 None → 호출부가
    unresolved_assignee 로 가시화(silent keep_pending 금지).
    """
    if isinstance(escalate_to, uuid.UUID):
        return escalate_to
    if isinstance(escalate_to, str):
        try:
            return uuid.UUID(escalate_to)  # UUID 직지정
        except ValueError:
            pass  # role_key → resolver
        from app.services.workflow_role_resolver import resolve_role_candidate
        sod = {sr.resolved_member_id} if sr.resolved_member_id else set()
        cand = await resolve_role_candidate(
            session, sr.org_id, escalate_to, project_id=sr.project_id,
            prefer_human=True, sod_exclude=sod, now=now,
        )
        return cand.member_id if cand is not None else None
    return None
