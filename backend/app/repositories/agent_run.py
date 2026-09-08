from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun


class AgentRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(
        self,
        project_id: uuid.UUID,
        agent_id: uuid.UUID | None = None,
        story_id: uuid.UUID | None = None,
        status: str | None = None,
        from_dt: datetime | None = None,
        to_dt: datetime | None = None,
        limit: int = 50,
        cursor: datetime | None = None,
    ) -> list[AgentRun]:
        # story #8defd8d4(BE·보안·cross-project 노출, 카디르 재검수 발견) — 예전엔 caller가
        # 준 project_id로 "그 project에 grant된 agent 목록"을 구해 AgentRun.agent_id.in_(...)만
        # 대조했다. 두 project에 겸직 grant된 agent의 run은 run 자신의 project_id와 무관하게
        # 그 agent가 소속된 아무 project_id로 조회해도 새어 나왔다(agent membership ≠ run이
        # 실제로 속한 project). AgentRun.project_id(NOT NULL, run 생성 시점에 caller가 검증
        # 완료한 실측값)를 직접 대조하는 게 정본 — TeamMember join은 agent가 caller project_id
        # 소속인지와 무관한 narrowing이었을 뿐 인가 축이 아니었다(제거해도 결과가 정확해질
        # 뿐, agent_id 필터가 여전히 옵션 narrowing으로 아래에 남는다).
        q = select(AgentRun).where(AgentRun.project_id == project_id)
        if agent_id is not None:
            q = q.where(AgentRun.agent_id == agent_id)
        # story_id: 이미 project 소속 agent들의 run으로 bound된 집합을 story 단위로 좁히는
        # narrowing 필터(Workcell 실 run 배선용). 결과를 확장하지 않으므로 인가 축을 늘리지
        # 않는다 — 타 project의 story_id를 넣어도 그 project agent의 run은 agent_ids에 없어 0건.
        if story_id is not None:
            q = q.where(AgentRun.story_id == story_id)
        # story #3680 — status/from/to 전부 narrowing(AND)뿐, story_id와 동형(인가 축 신규 0).
        if status is not None:
            q = q.where(AgentRun.status == status)
        if from_dt is not None:
            q = q.where(AgentRun.created_at >= from_dt)
        if to_dt is not None:
            q = q.where(AgentRun.created_at <= to_dt)
        if cursor:
            q = q.where(AgentRun.created_at < cursor)
        q = q.order_by(AgentRun.created_at.desc()).limit(min(limit, 200))
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get(self, id: uuid.UUID) -> AgentRun | None:
        result = await self.session.execute(
            select(AgentRun).where(AgentRun.id == id)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        org_id: uuid.UUID,
        agent_id: uuid.UUID,
        trigger: str = "manual",
        **kwargs: Any,
    ) -> AgentRun:
        run = AgentRun(org_id=org_id, agent_id=agent_id, trigger=trigger, **kwargs)
        self.session.add(run)
        await self.session.flush()
        await self.session.refresh(run)
        return run

    async def update(self, id: uuid.UUID, **fields: Any) -> AgentRun | None:
        """⛔story #2346 AC1(2026-07-30): 예전엔 result_summary·last_error_code만 `v is not
        None or k in (...)` 특례로 «항상» 덮어썼다 — caller가 그 필드를 아예 안 준 요청도
        None으로 지웠다(생략 vs 명시적 null을 이 계층에서 구분 못 함). 이제 caller(라우터)가
        exclude_unset=True로 «실제로 요청에 있던 필드만» 넘긴다는 계약이므로, 이 메서드는
        받은 것을 그대로 적용하기만 한다 — 특례 불필요(fields에 있다는 것 자체가 "이 값으로
        설정하라"는 의도, None이 와도 그건 명시적 비우기)."""
        run = await self.get(id)
        if run is None:
            return None
        for k, v in fields.items():
            setattr(run, k, v)
        await self.session.flush()
        await self.session.refresh(run)
        return run
