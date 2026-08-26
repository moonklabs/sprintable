"""story #f2b66f32(3025, BE·상태 자가회수) — 해소·머지 완료된 대상의 pending merge-type 게이트가
영구 잔존하던 결함의 자가회수.

그라운딩(2026-08-24, 실측 `/api/v2/gates?status=pending` 56건 GROUP BY, 페드루 PO 확認 후 착수):
gate_type=merge(work_item_type=story) 33건 전건이 이미 target story.status=='done'인데 게이트만
pending 잔존했다 — 31건은 라인엔진 self-report merge-gate(workflow_line_engine._merge_gate_wrapper,
pr_number=0/repo="")라 애초에 웹훅 연결점이 구조적으로 없어 영구 미해소, 나머지 2건은 실 PR 연결인데
(PR#3350 MERGED·PR#3307 CLOSED, gh 실측) reconcile_merge_gate_with_real_evidence 웹훅 경로가 놓친
별도 회귀 — 둘 다 이 모듈로 동일하게 회수된다(원인 분리는 회귀 재발방지 별도 트랙).

doc_approval(8건)은 target doc.status가 여전히 pending이라(실측) 자가회수 대상이 아니다 — 이
모듈은 gate_type=merge만 다룬다. agent_decision_request(15건)는 work_item_id가 gate.id 자체라
"대상 상태" 개념이 구조적으로 없어 이 스토리 스코프 밖(별도 story #3032로 분리, PO 판정
2026-08-24) — 이 모듈이 절대 건드리지 않는다.

⚠️AC3(사람 승인 위조 금지): 이 모듈은 gate.status를 **절대 approved로 만들지 않는다** — 기존
`Gate._VALID_TRANSITIONS`에 이미 있는 pending→voided(S30 admin recovery용 전이, 신규 상태 발명
0)를 재사용한다. resolver_id는 항상 None(사람이 안 눌렀다는 사실 그대로 — void_gate()·
gates.py POST /{id}/void의 admin 수동 void와 달리, 이건 사람 caller가 없는 시스템 트리거라
그 함수를 그대로 재사용하지 않는다: void_gate()는 voider_id를 강제하고 ActivityLog
actor_type="human"을 하드코딩해 재사용하면 거짓 귀속이 된다).

재오픈 안전성(PO 요청 그라운딩, 2026-08-24 확認 완료 — 추가 코드 불요): merge_verdict_gate.
evaluate_merge_gate()가 이미 `gate.status in ("rejected", "voided")` 케이스를 "재제출 시 새 결재
사이클로 재오픈"(pending 복귀 + decision_history 보존)으로 처리한다. 즉 story가 재오픈되어
in-review→done을 다시 타면 이 모듈이 voided로 만든 게이트는 새 row 없이 같은 row가 그 기존
경로에서 자동으로 pending 재오픈된다.
"""
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate, is_valid_transition, set_gate_status

logger = logging.getLogger(__name__)

RECLAIM_RESOLUTION_NOTE = (
    "system_auto_reclaim: target story already done, merge gate never resolved (story #f2b66f32)"
)


async def reclaim_stale_merge_gates_for_story(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID,
) -> list[Gate]:
    """story가 방금 done으로 전이된 직후 호출 — 그 story에 걸린 pending merge-type 게이트를
    전부 voided로 회수한다(승인 위조 아님, AC3). 호출자(emit_story_status_changed)가 이미 개별
    try/except로 이 호출 전체를 감싸므로(fail-open 계약), 여기선 방어적 개별 게이트 단위
    try/except를 두지 않는다 — 한 게이트 처리 중 예외가 나면 그 story의 남은 게이트도 이번
    호출에서는 회수되지 않지만(다음 done 재전이 또는 별도 백필에서 재시도 가능), 예외가 story
    상태 전이 자체를 막지는 않는다."""
    gates = (await session.execute(
        select(Gate).where(
            Gate.org_id == org_id,
            Gate.work_item_id == story_id,
            Gate.work_item_type == "story",
            Gate.gate_type == "merge",
            Gate.status == "pending",
        )
    )).scalars().all()

    reclaimed: list[Gate] = []
    now = datetime.now(timezone.utc)
    for gate in gates:
        if not is_valid_transition(gate.status, "voided"):
            continue  # 방어적 — 위 쿼리가 이미 status=='pending'만 걸러 정상 경로에선 항상 참.

        set_gate_status(gate, "voided", now=now)
        gate.resolver_id = None  # 사람이 안 눌렀다는 사실 그대로 — 위조 금지(AC3).
        gate.resolution_note = RECLAIM_RESOLUTION_NOTE
        gate.resolved_at = now

        from app.services.workflow_line_resolution import find_active_step_run_for_gate
        from app.models.workflow_line import WorkflowLineStepRun

        sr_id = await find_active_step_run_for_gate(session, org_id, gate.id)
        if sr_id is not None:
            sr = (await session.execute(
                select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
            )).scalar_one_or_none()
            if sr is not None:
                sr.status = "skipped"
                sr.routing_reason = f"gate auto-voided: {RECLAIM_RESOLUTION_NOTE}"[:500]
                sr.resolved_at = now

        logger.info(
            "gate_auto_reclaimed org=%s gate=%s story=%s step_run=%s",
            org_id, gate.id, story_id, sr_id,
        )
        reclaimed.append(gate)

    if reclaimed:
        await session.flush()
    return reclaimed
