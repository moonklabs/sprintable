"""L2-S4: Phase 1 휴리스틱 evaluator (deadline / drought / velocity).

블루프린트 §2·§5 S4. L1 활동 스트림과 엔티티 상태로부터 L2 트리거 후보를 산출하는 **순수
(pure)·read-only** 휴리스틱 모듈. LLM·네트워크·DB I/O를 일절 하지 않는다(AC①) — 워커(S5)가 상태를
조회해 입력 dataclass로 넘기면, 이 모듈은 threshold만 적용해 `TriggerDecision` 리스트를 반환한다.

휴리스틱 3종:
  ① 데드라인  — Sprint.end_date≤24h · Epic.target_date≤3d · Hypothesis.measure_after≤24h
                (terminal 상태 done/closed/n_a는 skip). story-level due_date는 없음(AC④).
  ② 이벤트 가뭄 — story in-progress 24h · in-review 12h · sprint 36h 무활동.
  ③ 속도 급변  — lag(elapsed≥30% & done<expected*0.5) · spike(done>expected*2.5) ·
                scope_creep(committed>capacity*120%).

threshold는 env로 오버라이드(AC②). decision은 trigger_type/target_agent_id/anchor_type/
anchor_id/reason/source_activity_seq를 담는다(AC③).
"""
from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

def _norm_status(status: str | None) -> str:
    return (status or "").strip().lower().replace(" ", "-").replace("_", "-").replace("/", "-")


# AC① / AC④: terminal 상태는 데드라인·가뭄 평가에서 제외(이미 종료된 작업은 nudge 불필요).
_TERMINAL_STATUSES = frozenset({"done", "closed", "n-a", "na", "cancelled", "canceled"})


def _is_terminal(status: str | None) -> bool:
    return _norm_status(status) in _TERMINAL_STATUSES


def _hours_until(target: datetime, now: datetime) -> float:
    """target까지 남은 시간(h). 음수면 이미 초과(overdue)."""
    return (target - now).total_seconds() / 3600.0


def _hours_since(past: datetime, now: datetime) -> float:
    return (now - past).total_seconds() / 3600.0


# ── 산출물 / 설정 계약 ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TriggerDecision:
    """휴리스틱 1건의 트리거 결정(AC③). source_activity_seq는 활동-구동 평가에서만 채워진다."""

    trigger_type: str
    target_agent_id: uuid.UUID
    anchor_type: str
    anchor_id: uuid.UUID
    reason: str
    source_activity_seq: int | None = None


@dataclass(frozen=True)
class HeuristicThresholds:
    """휴리스틱 임계값 — env로 오버라이드(AC②). 시간 단위는 시간(h), 비율은 0..1+ 배수."""

    # ① 데드라인 — 남은 시간이 이 값 이하이면 발사.
    deadline_sprint_end_h: float = 24.0
    deadline_epic_target_h: float = 72.0  # 3d
    deadline_measure_after_h: float = 24.0
    # ② 이벤트 가뭄 — 무활동 시간이 이 값 이상이면 발사.
    drought_in_progress_h: float = 24.0
    drought_in_review_h: float = 12.0
    drought_sprint_h: float = 36.0
    # ③ 속도 급변.
    velocity_lag_elapsed_ratio: float = 0.30  # 경과율 하한.
    velocity_lag_done_ratio: float = 0.50     # 기대 대비 done 비율 하한.
    velocity_spike_factor: float = 2.5        # 기대 대비 done 배수 상한.
    velocity_scope_creep_factor: float = 1.20  # capacity 대비 committed 배수 상한.

    @classmethod
    def from_env(cls, env: dict | None = None) -> "HeuristicThresholds":
        """`L2_*` env 키로 기본값을 오버라이드. 파싱 실패 시 기본값으로 폴백(startup 안전)."""
        src = env if env is not None else os.environ
        defaults = cls()

        def num(key: str, default: float) -> float:
            raw = src.get(key)
            if raw is None or str(raw).strip() == "":
                return default
            try:
                return float(raw)
            except (TypeError, ValueError):
                logger.warning("L2 threshold %s 파싱 실패(%r) — 기본값 %s 사용", key, raw, default)
                return default

        return cls(
            deadline_sprint_end_h=num("L2_DEADLINE_SPRINT_END_H", defaults.deadline_sprint_end_h),
            deadline_epic_target_h=num("L2_DEADLINE_EPIC_TARGET_H", defaults.deadline_epic_target_h),
            deadline_measure_after_h=num("L2_DEADLINE_MEASURE_AFTER_H", defaults.deadline_measure_after_h),
            drought_in_progress_h=num("L2_DROUGHT_IN_PROGRESS_H", defaults.drought_in_progress_h),
            drought_in_review_h=num("L2_DROUGHT_IN_REVIEW_H", defaults.drought_in_review_h),
            drought_sprint_h=num("L2_DROUGHT_SPRINT_H", defaults.drought_sprint_h),
            velocity_lag_elapsed_ratio=num("L2_VELOCITY_LAG_ELAPSED_RATIO", defaults.velocity_lag_elapsed_ratio),
            velocity_lag_done_ratio=num("L2_VELOCITY_LAG_DONE_RATIO", defaults.velocity_lag_done_ratio),
            velocity_spike_factor=num("L2_VELOCITY_SPIKE_FACTOR", defaults.velocity_spike_factor),
            velocity_scope_creep_factor=num("L2_VELOCITY_SCOPE_CREEP_FACTOR", defaults.velocity_scope_creep_factor),
        )


# ── 입력 계약(워커 S5가 조회해 채워 넘김 — 평가기는 read-only) ───────────────────


@dataclass(frozen=True)
class DeadlineTarget:
    """데드라인 평가 대상. entity_type ∈ {sprint, epic, hypothesis}, deadline은 해당 마감 timestamp."""

    entity_type: str
    entity_id: uuid.UUID
    deadline: datetime | None
    status: str | None
    target_agent_id: uuid.UUID | None


@dataclass(frozen=True)
class DroughtTarget:
    """가뭄 평가 대상. entity_type ∈ {story, sprint}. story는 status로 in-progress/in-review 구분."""

    entity_type: str
    entity_id: uuid.UUID
    status: str | None
    last_activity_at: datetime | None
    target_agent_id: uuid.UUID | None


@dataclass(frozen=True)
class VelocityTarget:
    """속도 평가 대상(sprint). elapsed_ratio=(now-start)/(end-start) [0..1+], 포인트는 SP."""

    sprint_id: uuid.UUID
    target_agent_id: uuid.UUID | None
    elapsed_ratio: float
    done_points: float
    committed_points: float
    capacity_points: float | None = None


class HeuristicEvaluator:
    """threshold를 주입받아 휴리스틱 3종을 평가하는 순수 evaluator(AC①: I/O·LLM 없음)."""

    def __init__(self, thresholds: HeuristicThresholds | None = None) -> None:
        self.t = thresholds or HeuristicThresholds.from_env()

    # ── ① 데드라인 ──────────────────────────────────────────────────────────────
    def evaluate_deadline(
        self, target: DeadlineTarget, now: datetime, *, source_activity_seq: int | None = None
    ) -> list[TriggerDecision]:
        if target.target_agent_id is None or target.deadline is None:
            return []  # 알릴 대상/마감이 없으면 발사 불가.
        if _is_terminal(target.status):
            return []  # done/closed/n_a skip(AC①·④).

        kind = _norm_status(target.entity_type)
        window = {
            "sprint": self.t.deadline_sprint_end_h,
            "epic": self.t.deadline_epic_target_h,
            "hypothesis": self.t.deadline_measure_after_h,
        }.get(kind)
        if window is None:
            return []  # 데드라인 소스는 sprint/epic/hypothesis만(AC④).

        remaining_h = _hours_until(target.deadline, now)
        if remaining_h > window:
            return []  # 아직 윈도우 밖.

        if remaining_h < 0:
            reason = f"{kind} 마감이 {abs(remaining_h):.0f}h 초과됨"
        else:
            reason = f"{kind} 마감까지 {remaining_h:.0f}h 남음(임계 {window:.0f}h)"
        return [
            TriggerDecision(
                trigger_type="deadline_approaching",
                target_agent_id=target.target_agent_id,
                anchor_type=kind,
                anchor_id=target.entity_id,
                reason=reason,
                source_activity_seq=source_activity_seq,
            )
        ]

    # ── ② 이벤트 가뭄 ───────────────────────────────────────────────────────────
    def evaluate_drought(
        self, target: DroughtTarget, now: datetime, *, source_activity_seq: int | None = None
    ) -> list[TriggerDecision]:
        if target.target_agent_id is None or target.last_activity_at is None:
            return []  # 알릴 대상/활동 기준점이 없으면 평가 불가.

        etype = _norm_status(target.entity_type)
        status = _norm_status(target.status)
        if etype == "story":
            if status == "in-progress":
                threshold = self.t.drought_in_progress_h
            elif status == "in-review":
                threshold = self.t.drought_in_review_h
            else:
                return []  # 가뭄은 진행/리뷰 중 story만(terminal·todo 제외).
        elif etype == "sprint":
            threshold = self.t.drought_sprint_h
        else:
            return []

        idle_h = _hours_since(target.last_activity_at, now)
        if idle_h < threshold:
            return []
        return [
            TriggerDecision(
                trigger_type="event_drought",
                target_agent_id=target.target_agent_id,
                anchor_type=etype,
                anchor_id=target.entity_id,
                reason=f"{etype}{'/' + status if status else ''} {idle_h:.0f}h 무활동(임계 {threshold:.0f}h)",
                source_activity_seq=source_activity_seq,
            )
        ]

    # ── ③ 속도 급변 ─────────────────────────────────────────────────────────────
    def evaluate_velocity(
        self, target: VelocityTarget, now: datetime, *, source_activity_seq: int | None = None
    ) -> list[TriggerDecision]:
        if target.target_agent_id is None:
            return []

        decisions: list[TriggerDecision] = []
        elapsed = target.elapsed_ratio
        committed = target.committed_points
        done = target.done_points
        expected = committed * elapsed if committed > 0 else 0.0

        def mk(trigger_type: str, reason: str) -> TriggerDecision:
            return TriggerDecision(
                trigger_type=trigger_type,
                target_agent_id=target.target_agent_id,  # type: ignore[arg-type]
                anchor_type="sprint",
                anchor_id=target.sprint_id,
                reason=reason,
                source_activity_seq=source_activity_seq,
            )

        # lag: 충분히 경과했는데(≥30%) done이 기대의 절반 미만.
        if (
            elapsed >= self.t.velocity_lag_elapsed_ratio
            and expected > 0
            and done < expected * self.t.velocity_lag_done_ratio
        ):
            decisions.append(
                mk(
                    "velocity_lag",
                    f"경과 {elapsed * 100:.0f}%인데 done {done:.0f}SP < 기대 {expected:.0f}SP의 "
                    f"{self.t.velocity_lag_done_ratio * 100:.0f}%",
                )
            )

        # spike: done이 기대를 크게 초과(과소추정·범위 누락 신호).
        if expected > 0 and done > expected * self.t.velocity_spike_factor:
            decisions.append(
                mk(
                    "velocity_spike",
                    f"done {done:.0f}SP가 기대 {expected:.0f}SP의 {self.t.velocity_spike_factor:.1f}x 초과",
                )
            )

        # scope creep: committed가 capacity를 120% 초과.
        cap = target.capacity_points
        if cap is not None and cap > 0 and committed > cap * self.t.velocity_scope_creep_factor:
            decisions.append(
                mk(
                    "scope_creep",
                    f"committed {committed:.0f}SP가 capacity {cap:.0f}SP의 "
                    f"{self.t.velocity_scope_creep_factor * 100:.0f}% 초과",
                )
            )

        return decisions
