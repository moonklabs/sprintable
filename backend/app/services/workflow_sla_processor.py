"""E-DECISION-GATE S13: SLA processor for human-gate (P1-3).

pending human-gate 가 방치되지 않게 **reminder → escalation → timeout** 정책으로 제품이 독촉한다
(오너 수동 "쳐노는지?" 패턴 제품화). HITL-timeout cron 레일 재사용·별도 endpoint.

보수적 기본: on_timeout 기본 ``keep_pending`` · ⭐auto_approve default off + high-risk/prod-touch/
story_points>=8/trust-unresolved 에서 금지 · ⭐system timeout transition 은 ``resolver_id=None``
(사람 결정이 아니므로 trust 환류 차단). SKIP LOCKED 로 cron 겹침 시 중복 reminder/escalation 방지.
"""
import uuid
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

# SLA 가 독촉하는 미해소 human-gate 대기 상태.
_SLA_GATE_STATUSES = ("gate_pending", "waiting_gate", "waiting_parallel", "reminded", "escalated", "held")
_TERMINAL_GATE = frozenset({"approved", "rejected"})


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
    """best-effort notification(실패는 SLA processor 비중단)."""
    if target_id is None:
        return
    try:
        from app.services.notification_dispatch import dispatch_notification
        await dispatch_notification(
            session, org_id=sr.org_id, event_type=event_type, target_member_ids=[target_id],
            title=title, body=f"{sr.entity_type} {sr.entity_id} {sr.from_status}→{sr.to_status}",
            reference_type=sr.entity_type, reference_id=sr.entity_id,
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
    from app.services.gate_service import transition_gate
    # ⭐resolver_id=None: system 자동승인은 사람 결정이 아니므로 trust 환류 차단(AC⑤).
    await transition_gate(session, sr.org_id, sr.gate_id, "approved", resolver_id=None)
    _record_event(session, sr, "auto_approved", payload={"reason": "sla_timeout_auto_approve"})
    return True


async def process_sla(session: AsyncSession, now: datetime | None = None) -> dict[str, int]:
    """미해소 human-gate step_run 을 SLA 정책대로 reminder/escalation/timeout 처리한다."""
    now = now or _now()
    rows = (await session.execute(
        select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.status.in_(_SLA_GATE_STATUSES),
        ).order_by(WorkflowLineStepRun.started_at.asc()).with_for_update(skip_locked=True)
    )).scalars().all()

    counts = {"reminded": 0, "escalated": 0, "auto_approved": 0, "kept_pending": 0,
              "unresolved": 0, "skipped": 0}
    for sr in rows:
        policy = await _resolve_sla_policy(session, sr)
        timeout_h = policy.get("timeout_hours")
        if not timeout_h:
            counts["skipped"] += 1
            continue
        elapsed_h = (now - sr.started_at).total_seconds() / 3600.0

        # ── 1) timeout ───────────────────────────────────────────────────────
        if elapsed_h >= timeout_h:
            on_timeout = policy.get("on_timeout", "keep_pending")
            if on_timeout == "auto_approve" and await _maybe_auto_approve(session, sr):
                counts["auto_approved"] += 1
                continue
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
                    continue
                # ⭐S14 fold-in: escalate_to(role/deputy)가 해소 안 되면 silent keep_pending 금지 →
                # unresolved_assignee 로 가시화(board badge·silent prison 아님·S14 AC⑥).
                sr.delivery_status = "unresolved_assignee"
                _record_event(session, sr, "escalated",
                              payload={"reason": "sla_timeout", "unresolved": True})
                counts["unresolved"] += 1
                continue
            counts["kept_pending"] += 1  # ⭐방치 아님·gate 유지(이미 escalate or escalate_to 없음)
            continue

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

    await session.commit()
    return counts


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
