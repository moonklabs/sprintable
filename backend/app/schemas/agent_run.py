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
    # story #3707 — 모델(agent_run.py)엔 error_message 컬럼이 실재하고 리퍼(agent_run_lifecycle.py
    # abandoned 전이)는 이걸 직접 쓰는데, 이 공개 API 스키마엔 필드가 아예 없어 MCP
    # emit_event/update_run_status가 실어 보내도 Pydantic이 조용히 버렸다(extra=ignore 기본값)
    # — dev 전 프로젝트에 「failed + error_message」 실행이 0건이던 근본.
    error_message: str | None = None
    # story #3719 — UpdateAgentRun엔 last_error_code가 있는데 CreateAgentRun엔 없어 생성
    # 시점(emit_event 경로)엔 처음부터 채울 수 없었다(3707과 동형 갭, 반대편 스키마).
    last_error_code: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # duration_ms(2a5f21d3): DB GENERATED ALWAYS(started/finished_at 파생)라 클라 입력 불가 —
    # 명시 세팅 시 GeneratedAlwaysError. 입력 표면에서 제거(응답 AgentRunResponse엔 read-only 유지).
    # story #3727 — MCP emit_event가 이미 보낼 준비가 돼 있었으나(sprintable_mcp/tools/
    # agent_runs.py) 이 스키마에 둘 다 없어 조용히 버려지고 있었다(2161이 UpdateAgentRun.
    # finished_at만 닫고 이쪽은 놓침 — 3707류 4·5번째 인스턴스). 라우터가 미제공 시 컬럼의
    # DB server_default(started_at=now())/NULL(finished_at)을 그대로 두도록 명시 제공 시에만
    # repo.create()에 넘긴다(생략과 명시 null을 가른다 — UpdateAgentRun의 exclude_unset과 동형
    # 원칙을 create 경로에도 적용).
    started_at: datetime | None = None
    finished_at: datetime | None = None


class UpdateAgentRun(BaseModel):
    status: str
    result_summary: str | None = None
    # story #3707 — CreateAgentRun과 동형 갭(위 코멘트 참조).
    error_message: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # duration_ms: GENERATED ALWAYS라 입력 불가(2a5f21d3) — 제거.
    last_error_code: str | None = None
    # story #3727 — MCP update_run_status가 이미 보낼 준비가 돼 있었으나(sprintable_mcp/
    # tools/agent_runs.py UPDATE_RUN_STATUS_FORWARD_FIELDS) 이 스키마에 없어 조용히
    # 버려지고 있었다(2161이 finished_at만 닫고 started_at은 놓침 — 3707류 6번째 인스턴스).
    started_at: datetime | None = None
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
    # story #3725 — 모델(agent_run.py)엔 컬럼이 실재하고 배포 라이프사이클/리퍼가 이미 직접
    # 쓰는데, 이 응답 스키마엔 5필드가 아예 없어 실행 상세의 재시도·실패 처분 UI가 늘
    # 폴백/미표시였다(3707류 — «있는데 응답에 안 실음»). additive(from_attributes=True라
    # ORM 속성명 그대로 자동 매핑, 값이 없으면 null — 지어내지 않는다).
    deployment_id: uuid.UUID | None = None
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    trigger: str
    model: str | None = None
    status: str
    result_summary: str | None = None
    # story #3707 — 위 CreateAgentRun/UpdateAgentRun 코멘트와 동형: 값이 있어도 응답 스키마에
    # 없으면 API 소비자(실행 상세 화면)는 절대 못 본다.
    error_message: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    duration_ms: int | None = None
    last_error_code: str | None = None
    # story #3725 — 위 deployment_id 코멘트와 동형 갭.
    failure_disposition: str | None = None
    # retry_count/max_retries는 DB NOT NULL(default 0/3, llm_call_count와 동형) — 항상 값이
    # 있다(null 아님).
    retry_count: int
    max_retries: int
    next_retry_at: datetime | None = None
    llm_call_count: int
    run_metadata: dict[str, Any]
    started_at: datetime
    # story #2161: 클라 가시성 확보(#1793 "실행 중" 배지가 실제 상태를 렌더링하려면 필요) —
    # 응답 스키마에 없어 API 소비자가 언제 끝났는지/기한이 언제인지 볼 방법이 없었다.
    finished_at: datetime | None = None
    deadline_at: datetime | None = None
    created_at: datetime
