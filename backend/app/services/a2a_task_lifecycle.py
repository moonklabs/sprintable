"""E-A2A-완성 S-A1(story 2a57dc0f, blueprint `a2a-completion-blueprint` Phase H): WORKING
영구정체 방지 + 실패 계약 — task 기한 판정/전이 로직의 단일 SSOT.

실 delegate(CC) 완료는 model-mediated(비결정적)라 회신 누락이 구조적으로 가능하다 — 이
모듈은 그 비결정성을 "정직한 상태 계약"(기한 초과 → FAILED + 사유 artifact)으로 감싼다.

`app/routers/a2a.py`(GetTask 인라인 반응형 판정)·`app/routers/cron.py`(능동 스위퍼)·
`app/services/conversation_webhook.py`(AC2 즉시-FAILED 훅) 세 경로가 이 모듈의
`fail_task_if_still_working`/`effective_deadline`을 공유 — 두 경로가 서로 다른 사유
문구/Artifact 포맷을 만들지 않는다(SSOT 원칙).

까심 QA(2026-07-09, story 2a57dc0f 리스크축 검증) HIGH 블로커 C: 스위퍼가 SELECT로 대상을
로드한 뒤 Python에서 상태를 뮤테이트하고 마지막에 한 번 커밋하는 구조라, 그 사이(로드~커밋)
같은 task가 다른 트랜잭션(GetTask의 정상 완료 커밋)에서 이미 COMPLETED로 전이됐어도 스위퍼가
그 사실을 모른 채 stale 상태 기준으로 FAILED를 덮어썼다 — 정상 완료된 task가 거짓 FAILED로
오염되고, 이후 `state=='WORKING'` 게이트에 걸려 아무 경로도 재교정하지 않는 자가치유 불가
버그였다(재현: 실 PG 2세션 직접 검증). fix = **CAS(compare-and-swap)**: FAILED로 쓰는 모든
경로(스위퍼·GetTask 반응형·AC2 훅)를 `UPDATE ... WHERE id=X AND state='TASK_STATE_WORKING'`
조건부로 바꾼다 — 영향행 0이면 이미 다른 경로가 그 task를 전이시켰다는 뜻이라(COMPLETED 등)
그 결과를 존중하고 skip한다. 비관적 락(`with_for_update`)이나 버전 컬럼보다 경량 — Postgres
READ COMMITTED 하에서 각 UPDATE 문은 실행 시점의 최신 커밋 상태를 보고 WHERE를 재평가하므로
원자적 CAS가 된다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import cast, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.a2a_task import A2ATask
from app.schemas.a2a import Artifact, Part

# P1-S2(story 7b93eb10, PO 크럭스 승인): model-mediated 완료신호 부재의 백스톱 — 이 시간 안에
# task-thread 답신이 없으면 FAILED로 전이한다(영구 WORKING 정체 방지). ⚠️tradeoff(정직히
# 문서화, PO 지시): CC가 30분 넘게 조용히 오래 작업하는 정상 케이스도 false-FAIL될 수 있다
# (interim ack 없는 model-mediated 구조의 근본 제약) — 실사용 데이터가 쌓이면 튜닝한다.
A2A_TASK_TIMEOUT_MINUTES = 30


def effective_deadline(task: A2ATask) -> datetime:
    """S-A1: task.deadline_at(명시 기록, 신규 행) 우선 — NULL(마이그 이전 레거시 행)이면
    기존 반응형 판정과 동일하게 created_at + 고정 타임아웃으로 폴백(무회귀)."""
    if task.deadline_at is not None:
        return task.deadline_at
    return task.created_at + timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES)


def build_failure_artifact(reason: str) -> dict:
    """FAILED 전이 사유를 구조화 Artifact로(A2A 스펙상 COMPLETED/FAILED엔 artifact가 정본 —
    task_metadata.failure_reason만으론 스펙 정합이 부족했던 기존 갭)."""
    return Artifact(
        artifact_id=str(uuid.uuid4()),
        name="failure-reason",
        parts=[Part(text=reason)],
    ).model_dump(by_alias=True, mode="json")


async def fail_task_if_still_working(session: AsyncSession, task_id: uuid.UUID, reason: str) -> bool:
    """CAS — WORKING인 경우에만 FAILED 전이(조건부 UPDATE, 까심 QA HIGH C fix). task_metadata는
    JSONB `||`(얕은 병합, failure_reason 키 추가/덮어씀)·artifacts는 JSONB `||`(배열 concat)로
    DB 레벨에서 원자적으로 갱신 — Python이 먼저 읽은 값을 그대로 되돌려쓰지 않으므로 그 사이
    다른 트랜잭션이 커밋한 변경을 덮어쓸 수 없다.

    Returns:
        True면 이 호출이 실제로 FAILED 전이시켰음. False면 영향행 0(이미 다른 경로가 그 task를
        전이시킴, 예: GetTask가 그 사이 COMPLETED로 커밋) — 그 결과를 존중하고 아무것도 안 한다.
        호출부는 flush/commit 책임(트랜잭션 경계가 호출부마다 다름 — GetTask 인라인은 요청-스코프
        세션, 스위퍼/AC2 훅은 각자의 배치·백그라운드 세션).
    """
    artifact = build_failure_artifact(reason)
    stmt = (
        update(A2ATask)
        .where(A2ATask.id == task_id, A2ATask.state == "TASK_STATE_WORKING")
        .values(
            state="TASK_STATE_FAILED",
            task_metadata=A2ATask.task_metadata.op("||")(cast({"failure_reason": reason}, JSONB)),
            artifacts=A2ATask.artifacts.op("||")(cast([artifact], JSONB)),
        )
    )
    result = await session.execute(stmt)
    return result.rowcount > 0


async def sweep_expired_a2a_tasks(session: AsyncSession) -> dict:
    """S-A1 AC1: 능동 스위퍼 — GetTask 폴링과 무관하게 기한 초과 WORKING task를 FAILED로
    승격한다(cron 진입점, `app/routers/cron.py`). SQL 레벨에서 deadline_at NULL(레거시)/
    non-NULL 양쪽을 한 쿼리로 처리 — Python 필터링 없이 DB가 판정(대량 스캔 안전).

    후보 목록은 SELECT로 뽑되, 실제 전이는 각 task마다 개별 CAS UPDATE로 — 다른 트랜잭션이
    그 사이 먼저 종결시킨 task는 조용히 skip(까심 QA HIGH C fix)."""
    now = datetime.now(timezone.utc)
    legacy_cutoff = now - timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES)

    result = await session.execute(
        select(A2ATask.id).where(
            A2ATask.state == "TASK_STATE_WORKING",
            (
                (A2ATask.deadline_at.is_not(None)) & (A2ATask.deadline_at < now)
            ) | (
                (A2ATask.deadline_at.is_(None)) & (A2ATask.created_at < legacy_cutoff)
            ),
        )
    )
    candidate_ids = [row[0] for row in result.all()]

    reason = f"deadline sweep: no agent response within {A2A_TASK_TIMEOUT_MINUTES}m of task creation"
    swept_ids = []
    for task_id in candidate_ids:
        if await fail_task_if_still_working(session, task_id, reason):
            swept_ids.append(task_id)

    await session.commit()
    return {"swept_count": len(swept_ids), "task_ids": [str(t) for t in swept_ids]}
