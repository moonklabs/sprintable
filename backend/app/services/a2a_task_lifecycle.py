"""E-A2A-완성 S-A1(story 2a57dc0f, blueprint `a2a-completion-blueprint` Phase H): WORKING
영구정체 방지 + 실패 계약 — task 기한 판정/전이 로직의 단일 SSOT.

실 delegate(CC) 완료는 model-mediated(비결정적)라 회신 누락이 구조적으로 가능하다 — 이
모듈은 그 비결정성을 "정직한 상태 계약"(기한 초과 → FAILED + 사유 artifact)으로 감싼다.

`app/routers/a2a.py`(GetTask 인라인 반응형 판정)와 `app/routers/cron.py`(능동 스위퍼)가
이 모듈의 `fail_task_in_place`/`effective_deadline`을 공유 — 두 경로가 서로 다른 사유
문구/Artifact 포맷을 만들지 않는다(SSOT 원칙).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
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


def fail_task_in_place(task: A2ATask, reason: str) -> None:
    """WORKING task를 FAILED로 전이 — task_metadata.failure_reason(기존 소비자 호환) + 실
    Artifact 둘 다 기록. flush/commit은 호출부 책임(호출부마다 트랜잭션 경계가 다름 — GetTask
    인라인은 요청-스코프 세션, 스위퍼는 배치 세션)."""
    task.state = "TASK_STATE_FAILED"
    task.task_metadata = {**(task.task_metadata or {}), "failure_reason": reason}
    task.artifacts = [*task.artifacts, build_failure_artifact(reason)]


async def sweep_expired_a2a_tasks(session: AsyncSession) -> dict:
    """S-A1 AC1: 능동 스위퍼 — GetTask 폴링과 무관하게 기한 초과 WORKING task를 FAILED로
    승격한다(cron 진입점, `app/routers/cron.py`). SQL 레벨에서 deadline_at NULL(레거시)/
    non-NULL 양쪽을 한 쿼리로 처리 — Python 필터링 없이 DB가 판정(대량 스캔 안전)."""
    now = datetime.now(timezone.utc)
    legacy_cutoff = now - timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES)

    result = await session.execute(
        select(A2ATask).where(
            A2ATask.state == "TASK_STATE_WORKING",
            (
                (A2ATask.deadline_at.is_not(None)) & (A2ATask.deadline_at < now)
            ) | (
                (A2ATask.deadline_at.is_(None)) & (A2ATask.created_at < legacy_cutoff)
            ),
        )
    )
    expired = list(result.scalars().all())

    for task in expired:
        fail_task_in_place(
            task,
            f"deadline sweep: no agent response within "
            f"{A2A_TASK_TIMEOUT_MINUTES}m of task creation",
        )

    await session.commit()
    return {"swept_count": len(expired), "task_ids": [str(t.id) for t in expired]}
