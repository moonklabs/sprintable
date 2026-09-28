"""E-DECISION-GATE S18: runtime mode + allowlist + circuit breaker (P0-5/P0-1).

line engine 의 ⭐안전 롤아웃 control:
- ① settings(default-off) + org allowlist + mode(off|shadow|advisory|enforcing).
- ② org-level 해소: disabled/미allowlist → ``off``(엔진 미진입·plain_transition).
- ③ circuit breaker(P0-1): 5분 내 engine failure 5회+ → 그 org 를 15분간 ``advisory`` 로 자동 강등
  (보드 freeze 방지·S3 fail-open 정합). step_run(status='engine_failed') 기록을 sliding-window 로
  조회해 상태를 도출한다(별도 state/마이그 없음).
- 효과 mode = runtime(운영 ceiling) ∧ per-line config rollout_mode 의 **더 보수적인 쪽**(min·
  defense-in-depth — 어느 한쪽도 단독으로 의도 이상 escalate 못 함).
"""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.workflow_line import WorkflowLineStepRun

# off < shadow < advisory < enforcing (보수적 → 공격적). min 결합·강등에 사용.
_MODE_ORDER = ("off", "shadow", "advisory", "enforcing")
_MODE_RANK = {m: i for i, m in enumerate(_MODE_ORDER)}

_CB_WINDOW_MIN = 5      # engine failure 집계 창
_CB_THRESHOLD = 5       # 창 내 5회 이상 → trip
_CB_DEGRADE_MIN = 15    # advisory 강등 지속
_CB_LOOKBACK_MIN = _CB_WINDOW_MIN + _CB_DEGRADE_MIN  # trip 후 15분 hold 까지 커버
_ENGINE_FAILURE_STATUSES = ("engine_failed",)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def min_mode(a: str, b: str) -> str:
    """더 보수적인(랭크 낮은) mode 반환."""
    return a if _MODE_RANK.get(a, 0) <= _MODE_RANK.get(b, 0) else b


def _org_allowlist() -> frozenset[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for x in (settings.decision_gate_line_org_allowlist or "").split(","):
        x = x.strip()
        if not x:
            continue
        try:
            out.add(uuid.UUID(x))
        except ValueError:
            continue  # 무효 org_id 무시(allowlist 안전 파싱)
    return frozenset(out)


def _configured_mode() -> str:
    """settings 의 base runtime mode(disabled/미allowlist 게이트 통과 후)."""
    m = (settings.decision_gate_line_mode or "off").strip().lower()
    return m if m in _MODE_RANK else "off"


async def _circuit_open(session: AsyncSession, org_id: uuid.UUID, now: datetime) -> bool:
    """org 의 engine failure 가 5분 창에 5회+ 인 trip 이 최근 15분 내 발생했는지(강등 hold)."""
    rows = (await session.execute(
        select(WorkflowLineStepRun.started_at).where(
            WorkflowLineStepRun.org_id == org_id,
            WorkflowLineStepRun.status.in_(_ENGINE_FAILURE_STATUSES),
            WorkflowLineStepRun.started_at > now - timedelta(minutes=_CB_LOOKBACK_MIN),
        ).order_by(WorkflowLineStepRun.started_at.asc())
    )).scalars().all()
    if len(rows) < _CB_THRESHOLD:
        return False
    # sliding 5분 창: 어떤 창이든 THRESHOLD 이상이면 trip(그 trip 의 15분 hold 가 now 까지 유효).
    window = timedelta(minutes=_CB_WINDOW_MIN)
    for i in range(len(rows)):
        j = i + _CB_THRESHOLD - 1
        if j < len(rows) and rows[j] - rows[i] <= window:
            # 이 창의 마지막 실패(rows[j]) + 15분 강등이 now 를 덮으면 open.
            if rows[j] + timedelta(minutes=_CB_DEGRADE_MIN) >= now:
                return True
    return False


async def resolve_runtime_mode(
    session: AsyncSession, org_id: uuid.UUID, now: datetime | None = None,
) -> str:
    """org 의 효과 runtime mode 를 해소한다(off 면 호출부가 엔진 미진입·plain).

    disabled/미allowlist → off. 아니면 settings mode, 단 circuit breaker open 이면 advisory 로 cap.
    ⭐default-off(enabled=False)면 circuit breaker 쿼리조차 안 함(라이브 무영향·AC⑥).
    """
    if not settings.decision_gate_line_enabled:
        return "off"
    allow = _org_allowlist()
    if allow and org_id not in allow:
        return "off"
    base = _configured_mode()
    if base == "off":
        return "off"
    if await _circuit_open(session, org_id, now or _now()):
        return min_mode(base, "advisory")  # P0-1 강등: advisory 이상으로 안 올림
    return base
