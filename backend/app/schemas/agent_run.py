from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class CreateAgentRun(BaseModel):
    agent_id: uuid.UUID
    # project_id(2a5f21d3): agent_run 필수 개념(DB NOT NULL 정합). 라우터가 caller의
    # has_project_access를 resource-actual로 검증(body-claimed 금지·신규 mutation 인가 표면).
    project_id: uuid.UUID
    trigger: str = "manual"
    model: str | None = None
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    status: str = "running"
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # duration_ms(2a5f21d3): DB GENERATED ALWAYS(started/finished_at 파생)라 클라 입력 불가 —
    # 명시 세팅 시 GeneratedAlwaysError. 입력 표면에서 제거(응답 AgentRunResponse엔 read-only 유지).


class UpdateAgentRun(BaseModel):
    status: str
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # duration_ms: GENERATED ALWAYS라 입력 불가(2a5f21d3) — 제거.
    last_error_code: str | None = None
    # story #2161: MCP update_run_status는 이미 finished_at을 보낼 준비가 돼 있었으나(
    # sprintable_mcp/tools/agent_runs.py) 이 스키마에 필드가 없어 조용히 버려지고 있었다 —
    # 정상 종료조차 duration_ms(GENERATED, started/finished_at 파생)가 영구 NULL이던 근본.
    # 생략 시 라우터가 status가 종단 상태(completed/failed/abandoned)면 now()로 채운다(server-
    # authority, 클라 미제공을 신뢰하지 않는 기존 관례 — S7 attachments와 동형).
    finished_at: datetime | None = None


class AgentRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    agent_id: uuid.UUID
    # story #4725d9c0(라이브 결함) — 유나 배포 53 라이브: 목록/상세 전 행이 「알 수 없는
    # 에이전트」였다(서버는 agent_id로 실재 멤버를 아는데 응답에 이름을 안 실었다). additive
    # (agent_id 자체는 그대로 정본) — team_members에서 조인해 채우고, 못 찾으면(예: 멤버 삭제)
    # null(지어내지 않는다).
    agent_name: str | None = None
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    trigger: str
    model: str | None = None
    status: str
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    duration_ms: int | None = None
    last_error_code: str | None = None
    llm_call_count: int
    run_metadata: dict[str, Any]
    started_at: datetime
    # story #2161: 클라 가시성 확보(#1793 "실행 중" 배지가 실제 상태를 렌더링하려면 필요) —
    # 응답 스키마에 없어 API 소비자가 언제 끝났는지/기한이 언제인지 볼 방법이 없었다.
    finished_at: datetime | None = None
    deadline_at: datetime | None = None
    created_at: datetime
