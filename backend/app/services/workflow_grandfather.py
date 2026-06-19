"""E-DECISION-GATE S19: in-flight grandfather + advisory backfill (P0-5 완성).

line engine 을 켜는 순간 이미 in-flight(in-progress/in-review)인 story 가 새 gate 에 갇혀 board
freeze 나지 않게:
- ① enable 시점 non-terminal story 를 ``grandfathered`` step_run 으로 마킹. 첫 다음 transition 은
  엔진이 막지 않고(``_consume_grandfather`` → plain) marker 를 소비한다(다음 transition 부터 거버닝).
- ② backfill 은 read-only/advisory — ``would_grandfather`` step_run 만 만들고 ⭐**Gate/approval row 는
  만들지 않는다**(라이브 무영향).
- ③ org enable 단위·idempotent(이미 open marker 있으면 skip·재실행 안전).
- ⑤ S18 runtime mode 정합 — runtime off(미enable)인 org 는 backfill skip.
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.models.workflow_line import WorkflowLineStepRun

# enable 시점 in-flight(새 gate 에 갇힐 수 있는) 상태(AC①).
_GRANDFATHER_STATUSES = ("in-progress", "in-review")
_GRANDFATHER_MARKER = "grandfathered"
_GRANDFATHER_APPLIED = "grandfathered_applied"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _has_open_grandfather(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> bool:
    r = await session.execute(
        select(WorkflowLineStepRun.id).where(
            WorkflowLineStepRun.org_id == org_id,
            WorkflowLineStepRun.entity_type == "story",
            WorkflowLineStepRun.entity_id == entity_id,
            WorkflowLineStepRun.status == _GRANDFATHER_MARKER,
        ).limit(1)
    )
    return r.scalar_one_or_none() is not None


async def backfill_grandfather(
    session: AsyncSession, org_id: uuid.UUID, now: datetime | None = None,
) -> dict[str, int]:
    """org 의 in-flight story 를 grandfather 마킹(read-only·Gate 0·idempotent).

    ⭐runtime off(미enable) org 는 skip(AC⑤). 이미 marker 있는 story 는 skip(idempotent·AC③).
    """
    now = now or _now()
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    if await resolve_runtime_mode(session, org_id, now) == "off":
        return {"grandfathered": 0, "gate_created": 0, "scanned": 0, "skipped_disabled": 1}

    # ⭐동시 cron 직렬화(SME): org 단위 tx-scoped advisory lock 으로 check-then-insert TOCTOU 차단
    # → duplicate open marker 0(commit 시 자동 해제·S8 동시성 동류). 두 번째 cron 은 대기 후 idempotent skip.
    await session.execute(
        sa.text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"wf_grandfather:{org_id}"},
    )

    stories = (await session.execute(
        select(Story).where(
            Story.org_id == org_id,
            Story.status.in_(_GRANDFATHER_STATUSES),
        )
    )).scalars().all()

    created = 0
    for st in stories:
        if await _has_open_grandfather(session, org_id, st.id):
            continue  # idempotent — 이미 마킹됨
        # ⭐Gate/approval row 0 — step_run audit marker 만(read-only·라이브 무영향·AC②).
        session.add(WorkflowLineStepRun(
            org_id=org_id, project_id=st.project_id, entity_type="story", entity_id=st.id,
            from_status=st.status, to_status=st.status, status=_GRANDFATHER_MARKER, mode="advisory_only",
            routing_decision="would_grandfather", routing_reason="in-flight at enable (advisory backfill)",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        ))
        created += 1
    await session.flush()
    await session.commit()
    return {"grandfathered": created, "gate_created": 0, "scanned": len(stories), "skipped_disabled": 0}


async def resolve_backfill_orgs(session: AsyncSession) -> list[uuid.UUID]:
    """backfill 대상 org 목록(B1·까심 QA): allowlist 지정 시 그 org, **allowlist 빈 + enabled(=전 org
    활성) 시 in-flight story 보유 org 전체** 열거(global-enable 미커버 갭 방지). disabled → []."""
    from app.core.config import settings
    if not settings.decision_gate_line_enabled:
        return []
    allow: list[uuid.UUID] = []
    for x in (settings.decision_gate_line_org_allowlist or "").split(","):
        x = x.strip()
        if not x:
            continue
        try:
            allow.append(uuid.UUID(x))
        except ValueError:
            continue
    if allow:
        return allow
    # global-enable(allowlist 빈): in-flight story 보유 org 전체(freeze 대상만·과대 스캔 회피).
    rows = (await session.execute(
        select(Story.org_id).where(Story.status.in_(_GRANDFATHER_STATUSES)).distinct()
    )).scalars().all()
    return list(rows)


async def consume_grandfather(
    session: AsyncSession, org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID,
    from_status: str | None, to_status: str,
) -> bool:
    """story 에 open grandfather marker 가 있으면 소비(applied 로 전환)하고 True.

    첫 다음 transition 을 비차단으로 통과시키기 위해 엔진이 호출한다(이후 transition 은 marker 없어
    정상 거버닝). 멱등: applied 로 바뀌면 재소비 안 됨.
    """
    if entity_type != "story":
        return False
    # ⭐open marker 를 limit(1) 아니라 **전부** atomic 하게 close(SME): backfill 중복이 있어도 첫
    # transition 에서 모두 applied 로 닫혀 plain 은 정확히 1회만(이후 transition 은 open 0→정상 거버닝).
    res = await session.execute(
        update(WorkflowLineStepRun)
        .where(
            WorkflowLineStepRun.org_id == org_id,
            WorkflowLineStepRun.entity_type == "story",
            WorkflowLineStepRun.entity_id == entity_id,
            WorkflowLineStepRun.status == _GRANDFATHER_MARKER,
        )
        .values(status=_GRANDFATHER_APPLIED, from_status=from_status, to_status=to_status,
                resolved_at=_now())
    )
    await session.flush()
    return (res.rowcount or 0) > 0
