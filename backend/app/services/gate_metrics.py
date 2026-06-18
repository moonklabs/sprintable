"""E-HITL-GATING S-GATE-5: HITL 게이트 dogfood 측정 readout. 정책 §5.

소스 = `agent_hitl_requests`(request_type='gate_approval') — enforce_gate(S-GATE-2/3) **ask 경로가
persist 하는 유일 DB 흔적**. auto(통과)/block(409)은 미persist(구조화 로그만)라 coverage·auto-pass
카운트는 DB 불가 — enforcement audit 테이블은 후속(마이그·§decision). 여기선 ask 경로의 **가치 숫자**:
- prevented_bad_pass = 사람 심사가 **reject**한 전이(게이트가 막은 나쁜 통과)
- ask 해소시간(분) = responded_at - created_at 평균
- rubber_stamp_rate = approved 중 ≤30s(고무도장) 비율 — 높으면 게이트가 형식적
- self_approval_caught = 승인자==원 트리거 actor 인 approved(enforce-time 차단되는 self-approval 적발)

merge_gate_metrics 동형(_ratio·_window·window dict·null=데이터없음/0.0=실제0).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import String, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hitl import HitlGateAudit, HitlRequest

_GATE_REQUEST_TYPE = "gate_approval"
_RUBBER_STAMP_SECONDS = 30  # gate_service._RUBBER_STAMP_SECONDS 와 동일 임계(동형)
# S-GATE-5.1 audit outcome 집합(enforce_gate 가 기록하는 전 outcome).
_OUTCOMES = ("auto", "blocked", "ask_queued", "resumed", "rejected_blocked", "self_blocked")


def _ratio(num: int, denom: int) -> float | None:
    """denom 0/None → None(데이터 없음). denom>0·num=0 → 0.0(실제 0)."""
    if not denom:
        return None
    return num / denom


def _window(stmt, col, start: datetime | None, end: datetime | None):
    if start is not None:
        stmt = stmt.where(col >= start)
    if end is not None:
        stmt = stmt.where(col <= end)
    return stmt


@dataclass(frozen=True)
class HitlGateMetrics:
    ask_total: int
    pending: int
    approved: int
    rejected: int
    prevented_bad_pass: int  # = rejected(사람 심사가 막은 나쁜 통과)
    ask_resolution_minutes: float | None
    rubber_stamp_rate: float | None
    self_approval_caught: int
    coverage: float | None  # true ratio(enforced/전체 전이)는 stories 분모 필요 — §3 2차/skip(None)
    # S-GATE-5.1: hitl_gate_audit 기반(auto/block 포함 전 outcome).
    enforced_total: int = 0  # 게이트 친 전이 수(flag active 시 enforce 호출 = audit 1행)
    outcomes: dict | None = None  # outcome 분포(auto·blocked·ask_queued·resumed·rejected_blocked·self_blocked)
    auto_rate: float | None = None  # auto / enforced_total(게이트가 그냥 통과시킨 비율)


async def compute_hitl_gate_metrics(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
) -> HitlGateMetrics:
    def _base(stmt):
        stmt = stmt.where(
            HitlRequest.org_id == org_id,
            HitlRequest.request_type == _GATE_REQUEST_TYPE,
            HitlRequest.deleted_at.is_(None),
        )
        if project_id is not None:
            stmt = stmt.where(HitlRequest.project_id == project_id)
        return stmt

    _dur = func.extract("epoch", HitlRequest.responded_at - HitlRequest.created_at)

    # 볼륨(status별·created_at window)
    vol_stmt = _window(
        _base(select(HitlRequest.status, func.count())).group_by(HitlRequest.status),
        HitlRequest.created_at, start, end,
    )
    counts = {s: c for s, c in (await session.execute(vol_stmt)).all()}
    pending = int(counts.get("pending", 0))
    approved = int(counts.get("approved", 0))
    rejected = int(counts.get("rejected", 0))
    ask_total = pending + approved + rejected

    # QA HIGH②: **단일 window 기준=created_at**(볼륨과 동일 cohort) — "이 기간에 생성된 ask" 코호트의
    # 해소/rubber/self 통계. responded_at 기준이면 볼륨(created_at)과 cohort 불일치(외부생성·내부응답이
    # 끼고, 내부생성·외부응답이 누락)라 지표 간 정합 깨짐. 해소시간은 그 코호트 중 responded 된 것만 평균.
    dur_stmt = _window(
        _base(select(func.avg(_dur / 60.0))).where(HitlRequest.responded_at.isnot(None)),
        HitlRequest.created_at, start, end,
    )
    avg_minutes = (await session.execute(dur_stmt)).scalar_one_or_none()

    # rubber_stamp + approved-resolved 분모(created_at window·approved만)
    rs_stmt = _window(
        _base(
            select(
                func.count(),
                func.count().filter(_dur <= _RUBBER_STAMP_SECONDS),
                func.count().filter(
                    HitlRequest.responded_by.isnot(None)
                    & (cast(HitlRequest.responded_by, String) == HitlRequest.hitl_metadata["actor_id"].astext)
                ),
            ).where(HitlRequest.status == "approved", HitlRequest.responded_at.isnot(None))
        ),
        HitlRequest.created_at, start, end,
    )
    approved_resolved, rubber_count, self_approval = (await session.execute(rs_stmt)).one()

    # S-GATE-5.1: hitl_gate_audit 기반 outcome 분포(auto/block 포함·created_at window).
    audit_filters = [HitlGateAudit.org_id == org_id]
    if project_id is not None:
        audit_filters.append(HitlGateAudit.project_id == project_id)
    audit_stmt = _window(
        select(HitlGateAudit.outcome, func.count()).where(*audit_filters).group_by(HitlGateAudit.outcome),
        HitlGateAudit.created_at, start, end,
    )
    audit_counts = {o: int(c) for o, c in (await session.execute(audit_stmt)).all()}
    outcomes = {k: audit_counts.get(k, 0) for k in _OUTCOMES}
    enforced_total = sum(outcomes.values())

    return HitlGateMetrics(
        ask_total=ask_total,
        pending=pending,
        approved=approved,
        rejected=rejected,
        prevented_bad_pass=rejected,
        ask_resolution_minutes=float(avg_minutes) if avg_minutes is not None else None,
        rubber_stamp_rate=_ratio(int(rubber_count or 0), int(approved_resolved or 0)),
        self_approval_caught=int(self_approval or 0),
        coverage=None,  # true ratio(enforced/전체 전이)는 stories 분모 필요 — §3 deferred
        enforced_total=enforced_total,
        outcomes=outcomes,
        auto_rate=_ratio(outcomes["auto"], enforced_total),
    )
