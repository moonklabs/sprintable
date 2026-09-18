"""story #3685(Trust·customer-zero, 페드루 PO 確定 2026-09-07) — 에이전트 run을
"지침"이 아니라 "메커니즘"으로 기록한다.

3683 그라운딩(코드 X) — run 생성 경로는 전수 1곳(`POST /api/v2/agent-runs`)뿐이고,
"왜 안 찍히나"의 실체는 코드가 막은 게 아니라 fleet 아무도 착수/PR/완료 어디서도
그 경로(MCP `sprintable_emit_event`/`update_run_status`)를 부른 적이 없었다는
것이었다. PO 確定 — 지침(AGENTS.md 한 줄)은 "잊으면 다시 0행"이라 거부하고,
플랫폼이 이미 보는 생애주기 이벤트(claim_story·in-progress 전이·in-review/done
전이·PR 머지)에서 run을 자동 유도한다.

이 파일의 두 함수는 그 생애주기 훅들이 공유하는 유일한 쓰기 지점이다(중복 재발명
금지). 둘 다 **best-effort** — 예외를 삼키고 로그만 남긴다: run 기록 실패가 스토리
전이·웹훅 처리·claim/unclaim을 막으면 "일을 못 한다"는 새 결함이 "run이 안
찍힌다"는 원 결함보다 나쁘다.

페드루 PO CHANGES(2026-09-07) — 최초 버전은 이 쓰기를 바깥 세션의 트랜잭션
그대로에 `session.add`+`flush`만 try/except로 감쌌다. flush가 DB 오류(제약·연결)로
터지면 예외는 삼켜져도 **세션 자체**가 실패 상태(SQLAlchemy가 트랜잭션을 이미
invalidate)로 남아, 바로 뒤 호출부(스토리 전이·웹훅 처리)의 commit이
"transaction has been rolled back"으로 터진다 — "run 실패가 일을 막는다"는 이
파일이 막으려던 바로 그 결함의 새 버전이었다(SAVEPOINT fail-open 세션 poison
클래스). `session.begin_nested()`(SAVEPOINT)로 격리해 이 함수 안의 실패가
SAVEPOINT만 롤백시키고 바깥 트랜잭션은 그대로 살게 한다."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun
from app.services.agent_run_lifecycle import AGENT_RUN_TIMEOUT_HOURS

logger = logging.getLogger(__name__)


async def ensure_agent_run_started(
    session: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID,
    agent_id: uuid.UUID, story_id: uuid.UUID, trigger: str = "story_lifecycle",
) -> None:
    """(agent_id, story_id)에 열린 run(`finished_at IS NULL`)이 이미 있으면 그대로 둔다 —
    이 dedupe 축이 emit_event로 외부 런타임이 직접 만든 run과의 중복도 함께 막는다(같은
    축이라 새 판정 로직 0). 없으면 새로 연다. `deadline_at`은 `POST /api/v2/agent-runs`
    라우터와 동일하게 지금부터 `AGENT_RUN_TIMEOUT_HOURS` 뒤로 잡아, 이 메커니즘이 연 run도
    리퍼(sweep_expired_agent_runs)의 자가회수 대상이 되게 한다(완료 훅이 어떤 이유로든
    한 번 새도 영구 stuck 'running'으로 안 남는다)."""
    run: AgentRun | None = None
    try:
        async with session.begin_nested():
            existing = (await session.execute(
                select(AgentRun.id).where(
                    AgentRun.agent_id == agent_id, AgentRun.story_id == story_id,
                    AgentRun.finished_at.is_(None),
                ).limit(1)
            )).scalar_one_or_none()
            if existing is not None:
                return
            run = AgentRun(
                org_id=org_id, project_id=project_id, agent_id=agent_id, story_id=story_id,
                trigger=trigger, status="running",
                deadline_at=datetime.now(timezone.utc) + timedelta(hours=AGENT_RUN_TIMEOUT_HOURS),
            )
            session.add(run)
            await session.flush()
    except Exception:  # noqa: BLE001 — best-effort(위 docstring).
        # begin_nested()의 SAVEPOINT 롤백은 그 SAVEPOINT 안에서 session.add()한 pending
        # 객체를 SQLAlchemy가 이미 자동으로 세션에서 떼어낸다(실측 확認 — CHECK 위반
        # 재현 중 session.expunge(run)이 "Instance is not present in this Session"으로
        # 터졌다) — 그래서 `run in session`으로 아직 붙어 있는 경우만 방어적으로
        # expunge한다(SAVEPOINT 실패 전, 예: 데드록/타임아웃처럼 flush 자체가 SAVEPOINT
        # 밖에서 실패하는 다른 예외 경로를 위한 안전망).
        if run is not None and run in session:
            session.expunge(run)
        logger.warning(
            "agent_run 자동 시작 실패(비차단) agent_id=%s story_id=%s", agent_id, story_id, exc_info=True,
        )


async def close_agent_runs_for_story(
    session: AsyncSession, *, story_id: uuid.UUID, status: str, agent_id: uuid.UUID | None = None,
) -> None:
    """그 story_id의 열린 run을 닫는다. `agent_id`를 주면 그 에이전트 것만(unclaim처럼
    "누구를" 이미 아는 호출부용) — 생략하면 그 스토리의 열린 run 전부(in-review/done
    전이·PR 머지처럼 "닫는 행위자"와 "run의 주인"이 다를 수 있는 호출부용 — 사람이
    PR을 머지해도 그 안에서 일한 에이전트의 run은 끝난 게 맞다). 열린 run이 없으면
    조용히 no-op(멱등 — 같은 전이가 두 번 와도 안전)."""
    try:
        async with session.begin_nested():
            q = select(AgentRun).where(AgentRun.story_id == story_id, AgentRun.finished_at.is_(None))
            if agent_id is not None:
                q = q.where(AgentRun.agent_id == agent_id)
            rows = list((await session.execute(q)).scalars().all())
            if not rows:
                return
            now = datetime.now(timezone.utc)
            for run in rows:
                run.status = status
                run.finished_at = now
            await session.flush()
    except Exception:  # noqa: BLE001 — best-effort(위 docstring). rows는 기존 추적 중이던
        # 행이라(신규 add 아님) SAVEPOINT 롤백이 그 in-memory 속성 변경도 되돌린다 —
        # ensure_agent_run_started와 달리 expunge 대상이 없다(새로 만든 pending 객체가
        # 아니라 이미 세션이 알던 행일 뿐).
        logger.warning(
            "agent_run 자동 종료 실패(비차단) story_id=%s status=%s", story_id, status, exc_info=True,
        )
