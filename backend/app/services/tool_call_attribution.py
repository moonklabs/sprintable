"""story #3722(Trust·BE, 페드루 PO 確定 2026-09-09) — 에이전트 인증 요청 1건을 어느
`agent_runs` 행에 귀속시킬지 추측 0으로 판정한다.

체인(순서 그대로, 앞이 맞으면 뒤는 안 본다):
  ⓐ header  — 요청에 `X-Sprintable-Run-Id`가 있고 그 run이 이 agent 것이면 그것.
  ⓑ' story_scope — 요청이 story_id를 지니면(경로 템플릿 파라미터·쿼리·JSON body
    최상위 — task→story 역조회는 안 한다) 이 agent의 **그 story**에 대한 running run이
    정확히 1개일 때 그것.
  ⓑ single_running — story_id가 없거나(또는 있어도 그 story엔 running run이 0개라
    ⓑ'가 못 정했을 때) 이 agent 전체의 running run이 정확히 1개일 때 그것.
  ⓒ 미귀속(run_id=None) — 그 외 전부. attribution_reason으로 갈래를 가른다:
    - no_running_run: agent 전체 running run이 0개.
    - ambiguous_multi_run: agent 전체 running run이 2개 이상(story_scope도 못 정한 뒤).
    - ambiguous_multi_run_same_story: story_id는 있는데 **그 story**의 running run이
      2개 이상 — 이건 agent-wide ⓑ로 안 내려간다(페드루 PO 판정: story 문맥이 있는데
      거기서 이미 모호하면, 그 문맥을 버리고 agent 전체에서 다시 고르는 게 오히려 틀린
      run을 정직해 보이게 만든다 — story 스코프가 있었다는 사실 자체를 reason에 남긴다).

디디 판단(채택 — 페드루 PO 2026-09-09 06:22Z): story_id가 있는데 그 story의 running
run이 **0개**인 경우는 ambiguous도 no_running_run도 아니라서 그대로 agent-wide ⓑ로
내려간다(그 story 자체는 지금 안 도는 중일 뿐, agent 전체엔 다른 running run이 있을 수
있다 — «이 story 얘기는 아니지만 이 agent 얘기는 맞다»는 뜻). 단 이 낙하로 정해진 run은
정의상 그 story의 것이 아니므로(그랬다면 위에서 이미 story_running에 걸렸을 것) reason을
평범한 single_running과 갈라 **single_running_other_story**로 남긴다 — 「오귀속 의심」을
나중에 셀 수 있는 유일한 단서(페드루 PO 追加)."""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun

HEADER_NAME = "x-sprintable-run-id"


@dataclass(frozen=True)
class AttributionResult:
    run_id: uuid.UUID | None
    reason: str


async def attribute_tool_call(
    session: AsyncSession,
    *,
    agent_id: uuid.UUID,
    header_run_id: str | None,
    story_id: str | None,
) -> AttributionResult:
    # ⓐ header — 이 agent 소유가 아니면(다른 agent의 run_id를 사칭) 조용히 무시하고
    # 체인을 계속 진행한다(401/403을 던지지 않는다 — 이 미들웨어는 기록 축이지 인가
    # 축이 아니다, fail-open 원칙 그대로).
    if header_run_id:
        try:
            header_uuid = uuid.UUID(header_run_id)
        except ValueError:
            header_uuid = None
        if header_uuid is not None:
            owned = (await session.execute(
                select(AgentRun.id).where(AgentRun.id == header_uuid, AgentRun.agent_id == agent_id)
            )).scalar_one_or_none()
            if owned is not None:
                return AttributionResult(run_id=owned, reason="header")

    # ⓑ' story_scope
    story_fallthrough = False
    if story_id:
        try:
            story_uuid = uuid.UUID(story_id)
        except ValueError:
            story_uuid = None
        if story_uuid is not None:
            story_running = list((await session.execute(
                select(AgentRun.id).where(
                    AgentRun.agent_id == agent_id, AgentRun.story_id == story_uuid,
                    AgentRun.status == "running",
                )
            )).scalars().all())
            if len(story_running) == 1:
                return AttributionResult(run_id=story_running[0], reason="story_scope")
            if len(story_running) >= 2:
                return AttributionResult(run_id=None, reason="ambiguous_multi_run_same_story")
            # 0개 — story 문맥은 있으나 그 story엔 running run이 없다. agent-wide로 계속
            # (아래서 고르는 run은 정의상 이 story의 것이 아니다 — reason을 갈라 남긴다).
            story_fallthrough = True

    # ⓑ single_running(agent 전체)
    agent_running = list((await session.execute(
        select(AgentRun.id).where(AgentRun.agent_id == agent_id, AgentRun.status == "running")
    )).scalars().all())
    if len(agent_running) == 1:
        reason = "single_running_other_story" if story_fallthrough else "single_running"
        return AttributionResult(run_id=agent_running[0], reason=reason)
    if len(agent_running) == 0:
        return AttributionResult(run_id=None, reason="no_running_run")
    return AttributionResult(run_id=None, reason="ambiguous_multi_run")


def extract_story_id(
    *, route_path: str | None, path_params: dict[str, str] | None,
    query_params: dict[str, str] | None, body: dict[str, object] | None,
) -> str | None:
    """path 템플릿 파라미터 → 쿼리 → JSON body 최상위 순으로 story_id 후보를 찾는다
    (첫 발견을 쓴다 — 여러 축에서 다른 값이 오는 모순 상황은 이 스토리 범위 밖, path
    파라미터가 가장 신뢰도 높은 축이라 최우선). task→story 역조회는 하지 않는다(비용·
    정확성 트레이드오프, 스토리 명시).

    `/api/v2/stories/{id}`류(파라미터명이 `story_id`가 아니라 `id`)는 라우트 템플릿
    문자열에 `/stories/`가 있을 때만 그 `id`를 story_id로 본다 — `id`라는 이름만으로는
    어느 리소스인지 알 수 없다(예: `/api/v2/tasks/{id}`의 id는 task_id다)."""
    if path_params and path_params.get("story_id"):
        return str(path_params["story_id"])
    if path_params and path_params.get("id") and route_path and "/stories/" in route_path:
        return str(path_params["id"])
    if query_params and query_params.get("story_id"):
        return str(query_params["story_id"])
    if body and isinstance(body.get("story_id"), str):
        return body["story_id"]
    return None
