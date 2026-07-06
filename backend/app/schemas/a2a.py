"""E-A2A-POC S1(story 480e81fb): A2A v1.0 wire shapes — gh api로 a2aproject/A2A(main)
`specification/a2a.proto` + `docs/specification.md`를 직접 fetch해 실측(PO 크럭스 확認,
2026-07-06). story AC의 `message/send`/`tasks/get`(구초안 lowercase-slash 표기)이 아니라
**현재 spec의 PascalCase JSON-RPC 메소드명**(`SendMessage`/`GetTask`) + camelCase 필드 +
`TASK_STATE_`/`ROLE_` 접두 enum을 기준으로 구현한다. PoC는 필수 필드 + AgentInterface만
채우고, provider/securitySchemes/signatures 등 선택 필드는 생략(Phase 3, 인증/signed Card
붙을 때 추가).

E-A2A-PROTO(2026-07-06, PO 크럭스 P0): v1.0.1 태그(gh api, main과 byte-identical) 재실측으로
발견한 누락 필드 추가 — `AgentCapabilities.extensions`(AgentExtension 목록, uri/description/
required/params)·`Message.extensions`/`reference_task_ids`·`Part.raw`(base64 bytes)/`metadata`·
`Artifact.metadata`/`extensions`. 전부 옵셔널/기본 빈값이라 회귀 없음 — `AgentCapabilities.
extensions`는 향후 E-A2A-EXT(Sprintable 차별화를 A2A extension으로 정의) 축의 진입점."""
from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ── Agent Discovery (§4.4, §8.5) ──────────────────────────────────────────────


class AgentInterface(BaseModel):
    url: str
    protocol_binding: Literal["JSONRPC", "GRPC", "HTTP+JSON"] = Field(alias="protocolBinding")
    protocol_version: str = Field(alias="protocolVersion")
    tenant: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class AgentExtension(BaseModel):
    uri: str
    description: str | None = None
    required: bool = False
    params: dict | None = None

    model_config = ConfigDict(populate_by_name=True)


class AgentCapabilities(BaseModel):
    streaming: bool = False
    push_notifications: bool = Field(default=False, alias="pushNotifications")
    extensions: list[AgentExtension] = Field(default_factory=list)
    extended_agent_card: bool = Field(default=False, alias="extendedAgentCard")

    model_config = ConfigDict(populate_by_name=True)


class AgentSkill(BaseModel):
    id: str
    name: str
    description: str
    tags: list[str]
    examples: list[str] | None = None

    model_config = ConfigDict(populate_by_name=True)


class AgentCard(BaseModel):
    name: str
    description: str
    supported_interfaces: list[AgentInterface] = Field(alias="supportedInterfaces")
    version: str
    capabilities: AgentCapabilities
    default_input_modes: list[str] = Field(alias="defaultInputModes")
    default_output_modes: list[str] = Field(alias="defaultOutputModes")
    skills: list[AgentSkill]

    model_config = ConfigDict(populate_by_name=True)


# ── Core Objects (§4.1) ───────────────────────────────────────────────────────


class Part(BaseModel):
    text: str | None = None
    raw: str | None = None
    url: str | None = None
    data: Any | None = None
    metadata: dict | None = None
    filename: str | None = None
    media_type: str | None = Field(default=None, alias="mediaType")

    model_config = ConfigDict(populate_by_name=True)


class Message(BaseModel):
    message_id: str = Field(alias="messageId")
    context_id: str | None = Field(default=None, alias="contextId")
    task_id: str | None = Field(default=None, alias="taskId")
    role: Literal["ROLE_USER", "ROLE_AGENT", "ROLE_UNSPECIFIED"]
    parts: list[Part]
    metadata: dict | None = None
    extensions: list[str] = Field(default_factory=list)
    reference_task_ids: list[str] = Field(default_factory=list, alias="referenceTaskIds")

    model_config = ConfigDict(populate_by_name=True)


TaskState = Literal[
    "TASK_STATE_UNSPECIFIED",
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_AUTH_REQUIRED",
]


class TaskStatus(BaseModel):
    state: TaskState
    message: Message | None = None
    timestamp: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class Artifact(BaseModel):
    artifact_id: str = Field(alias="artifactId")
    name: str | None = None
    description: str | None = None
    parts: list[Part]
    metadata: dict | None = None
    extensions: list[str] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class Task(BaseModel):
    id: str
    context_id: str = Field(alias="contextId")
    status: TaskStatus
    artifacts: list[Artifact] = Field(default_factory=list)
    history: list[Message] = Field(default_factory=list)
    metadata: dict | None = None

    model_config = ConfigDict(populate_by_name=True)


# ── JSON-RPC 2.0 envelope (§9) ─────────────────────────────────────────────────


class SendMessageConfiguration(BaseModel):
    accepted_output_modes: list[str] | None = Field(default=None, alias="acceptedOutputModes")
    history_length: int | None = Field(default=None, alias="historyLength")

    model_config = ConfigDict(populate_by_name=True)


class SendMessageParams(BaseModel):
    tenant: str | None = None
    message: Message
    configuration: SendMessageConfiguration | None = None
    metadata: dict | None = None

    model_config = ConfigDict(populate_by_name=True)


class GetTaskParams(BaseModel):
    tenant: str | None = None
    id: uuid.UUID
    history_length: int | None = Field(default=None, alias="historyLength")

    model_config = ConfigDict(populate_by_name=True)


class JsonRpcRequest(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    id: str | int
    method: str
    params: dict | None = None


class JsonRpcError(BaseModel):
    code: int
    message: str
    data: list[dict] | None = None


class JsonRpcResponse(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    id: str | int
    result: dict | None = None
    error: JsonRpcError | None = None
