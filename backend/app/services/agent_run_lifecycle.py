"""story #2161(2026-07-24, 오르테가군 판정) — agent_runs 'running' 영구정체 방지.

`POST /agent-runs`와 `PATCH /agent-runs/{id}`는 서로 모르는 두 독립 MCP 호출
(`sprintable_mcp/tools/agent_runs.py`: emit_event/update_run_status)이라, 종료 신호가 안 오면
(에이전트 크래시/kill/timeout) status='running'이 영원히 안 닫혔다(까심군 AC1 확定 — 부산물
증명: llm_call_count=0·tokens/cost/duration_ms 전부 NULL, 프로토콜 자체가 POST↔PATCH를 안 묶음).

`app/services/a2a_task_lifecycle.py`(story 2a57dc0f, A2ATask WORKING 영구정체 방지)와 동일
근본·동일 처방 — "시작할 때 이미 끝날 시각을 갖고 태어나게" 한다(오르테가군 지시). 까심군이
그때 QA로 잡았던 레이스(스위퍼가 SELECT 후 Python 뮤테이트→커밋 하는 사이 정상완료 커밋이
껴서 거짓 전이로 덮어씀, story 2a57dc0f HIGH 블로커 C)를 CAS로 선제 방지한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun

# 오르테가군 지시(2026-07-24) — 비용이 비대칭: 너무 짧으면 살아있는 실행을 죽이는(되돌릴 수
# 없는) 반대사고, 너무 길면 좀비가 조금 더 오래 남을 뿐(관측된 좀비가 이미 2일 3시간 —
# 24시간 경계만으로도 "영원히"는 확실히 깨짐). 첫 판은 "정확"이 아니라 "안전"이 목적이라
# 일부러 헐겁게 잡았다 — finished_at 갭(app/schemas/agent_run.py)이 고쳐져 실측 데이터가
# 쌓이면 그때 조인다. agent_run의 단위(도구 호출 1회 vs 세션)가 코드상 불명확해(session_id
# 컬럼 존재는 다건/세션을 시사하나 실측 미확認) 보수적 상한을 우선한다.
#
# 무너지는 조건(pinning 테스트 — tests/test_2161_agent_run_reaper.py 참조):
# "타임아웃보다 오래 걸리는 정상 실행이 실제로 관측되면" 이 설계는 틀어진다 — 그 경우
# 하트비트 방식(에이전트가 주기적으로 deadline_at을 갱신하는 PATCH 호출)으로 승격 필요.
# 이번 스코프는 하트비트 없이 간다.
AGENT_RUN_TIMEOUT_HOURS = 24


def effective_deadline(run: AgentRun) -> datetime:
    """deadline_at(명시 기록, story #2161 신규 컬럼, migration 0206) 우선 — NULL(마이그 이전
    레거시 run)이면 기존 stuck run도 사정권에 들게 started_at + 고정 타임아웃으로 폴백
    (a2a_task_lifecycle.effective_deadline과 동형)."""
    if run.deadline_at is not None:
        return run.deadline_at
    return run.started_at + timedelta(hours=AGENT_RUN_TIMEOUT_HOURS)


async def abandon_run_if_still_running(session: AsyncSession, run_id: uuid.UUID, reason: str) -> bool:
    """CAS — status='running'인 경우에만 'abandoned' 전이(조건부 UPDATE). a2a_task_lifecycle.
    fail_task_if_still_working과 동일 근본수정(까심 QA, story 2a57dc0f HIGH 블로커 C) 선제
    적용 — 스위퍼가 후보를 SELECT한 뒤 Python에서 판정하는 사이 진짜 완료 PATCH가 먼저
    커밋되면, 그 완료를 존중하고 스위퍼는 조용히 skip한다(영향행 0). 'completed'로 위장하지
    않음 — 'abandoned'은 completed/failed와 구분되는 제3의 종단 상태(오르테가군 지시, "위장
    금지" — 끝났는지 모르는 것을 성공적으로 끝난 것으로 둔갑시키면 거짓을 없애려던 수정이
    더 나쁜 거짓을 만든다).

    Returns:
        True면 이 호출이 실제로 abandoned 전이시켰음. False면 영향행 0(이미 다른 경로가 그
        run을 전이시킴 — 예: PATCH가 그 사이 completed로 커밋) — 그 결과를 존중하고 아무것도
        안 한다. 호출부는 commit 책임(트랜잭션 경계가 호출부마다 다를 수 있음).
    """
    now = datetime.now(timezone.utc)
    stmt = (
        update(AgentRun)
        .where(AgentRun.id == run_id, AgentRun.status == "running")
        .values(status="abandoned", finished_at=now, error_message=reason)
    )
    result = await session.execute(stmt)
    return result.rowcount > 0


async def sweep_expired_agent_runs(session: AsyncSession) -> dict:
    """story #2161 — cron 진입점(app/routers/cron.py). 폴링과 무관하게 기한 초과 'running'
    run을 능동적으로 'abandoned'으로 승격한다. SQL 레벨에서 deadline_at NULL(레거시)/non-NULL
    양쪽을 한 쿼리로 처리(a2a_task_lifecycle.sweep_expired_a2a_tasks와 동형 — 백필 마이그
    불요, 기존 stuck row도 자동 사정권).

    후보 목록은 SELECT로 뽑되, 실제 전이는 각 run마다 개별 CAS UPDATE로 — 다른 트랜잭션이
    그 사이 먼저 종결시킨 run은 조용히 skip."""
    now = datetime.now(timezone.utc)
    legacy_cutoff = now - timedelta(hours=AGENT_RUN_TIMEOUT_HOURS)

    result = await session.execute(
        select(AgentRun.id).where(
            AgentRun.status == "running",
            (
                (AgentRun.deadline_at.is_not(None)) & (AgentRun.deadline_at < now)
            ) | (
                (AgentRun.deadline_at.is_(None)) & (AgentRun.started_at < legacy_cutoff)
            ),
        )
    )
    candidate_ids = [row[0] for row in result.all()]

    reason = f"deadline sweep: no completion signal within {AGENT_RUN_TIMEOUT_HOURS}h of run start"
    swept_ids = []
    for run_id in candidate_ids:
        if await abandon_run_if_still_running(session, run_id, reason):
            swept_ids.append(run_id)

    await session.commit()
    return {"swept_count": len(swept_ids), "run_ids": [str(r) for r in swept_ids]}
