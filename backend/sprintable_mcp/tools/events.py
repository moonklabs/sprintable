"""이벤트 레지스트리 MCP 도구 (4개) — story #2634 + #2636.

publish_event → POST /api/v2/events/publish(#2633, publish_registry_event) 래퍼.
list_event_definitions → GET /api/v2/events/definitions(#2634) 래퍼.
register_event_definition/update_event_definition → POST/PATCH /api/v2/events/definitions
(#2636, org 커스텀 이벤트 등록) 래퍼 — "events" 그룹(publish/list)과 분리된 "admin" 그룹
(등록=org 관리 행위, PO 확定 §범위5 — server.py 등록·toolset.py 키워드 참조).

전부 신규 백엔드 로직 없음(순수 배선) — sprintable_emit_event(agent RUN 텔레메트리, POST
/api/v2/agent-runs)와 개념이 다르다: 그건 에이전트 실행 lifecycle 이벤트, 이건 event_
definitions 카탈로그(#2632) 기반 도메인 이벤트 발행/조회/등록이다. 이름이 비슷해 보여도
서로 무관한 두 개념(혼동 방지를 위해 아래 각 함수 docstring에서 다시 한 번 명시).
"""
from __future__ import annotations

import json

from mcp.types import TextContent

from ..api_client import client
from ..response import _default_serializer, err, ok
from ..schemas import SprintableInput


class PublishEventInput(SprintableInput):
    definition_key: str
    payload: dict
    # 정의의 routing.broadcast가 선언한 대상 외에 발행 시점 추가 공람 대상(옵션).
    extra_broadcast_member_ids: list[str] | None = None


class ListEventDefinitionsInput(SprintableInput):
    pass


async def publish_event(args: PublishEventInput) -> list[TextContent]:
    """이벤트 레지스트리(story #2632) 기반 프리셋/커스텀 이벤트 발행.

    ⚠️`sprintable_emit_event`(에이전트 RUN lifecycle 텔레메트리, POST /api/v2/agent-runs)와
    다른 도구다 — 이 도구는 event_definitions 카탈로그에 등록된 도메인 이벤트(예:
    preset.work.assigned)를 발행해 escalation/broadcast 대상에게 실제 챗 메시지로 전달한다
    (기존 send_message 파이프 그대로 위임 — 신규 전달 채널 아님, #2633 AC2).

    definition_key로 발행 가능한 정의 목록은 sprintable_list_event_definitions로 먼저
    조회하세요 — payload_schema가 요구하는 필드를 그 응답에서 확인할 수 있습니다.
    """
    body: dict = {"definition_key": args.definition_key, "payload": args.payload}
    if args.extra_broadcast_member_ids:
        body["extra_broadcast_member_ids"] = args.extra_broadcast_member_ids
    try:
        result = await client.post("/api/v2/events/publish", json=body)
        # story #2636(P1b) 갭 1호 처방 — 백엔드가 zero_reach_warning을 JSON 필드로만 실으면
        # 에이전트가 응답 JSON을 훑다가 그 한 필드를 놓치기 쉽다(발행 자체는 201·conversation_
        # id·message_id까지 정상으로 보임). MCP 표면에서 사람이 읽는 문장으로 앞에 강조해
        # "발행 성공·도달 0"이 조용히 지나가지 않게 한다.
        if isinstance(result, dict) and result.get("zero_reach_warning"):
            warning_line = (
                f"[경고] {result.get('warning', '발행은 성공했으나 도달 대상이 0명입니다.')}\n\n"
            )
            return [TextContent(
                type="text",
                text=warning_line + json.dumps(result, indent=2, ensure_ascii=False, default=_default_serializer),
            )]
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def list_event_definitions(args: ListEventDefinitionsInput) -> list[TextContent]:
    """발행 가능한 이벤트 정의 카탈로그 조회 — 플랫폼 프리셋(preset.*) ∪ 이 org 커스텀(org.*).

    각 항목의 payload_schema(JSON Schema)가 sprintable_publish_event 호출 시 payload가
    지켜야 할 계약입니다. enabled=false인 정의는 지금 발행이 거부됩니다(숨기지 않고 그대로
    노출 — 왜 안 보이는지가 아니라 왜 발행이 막히는지를 미리 알 수 있게).
    """
    try:
        return ok(await client.get("/api/v2/events/definitions"))
    except Exception as exc:
        return err(str(exc))


class RegisterEventDefinitionInput(SprintableInput):
    key: str
    payload_schema: dict
    routing: dict


class UpdateEventDefinitionInput(SprintableInput):
    definition_id: str
    payload_schema: dict | None = None
    routing: dict | None = None
    enabled: bool | None = None


async def register_event_definition(args: RegisterEventDefinitionInput) -> list[TextContent]:
    """org 커스텀 이벤트 정의 등록(story #2636) — org admin/owner 전용.

    key는 `org.{이 org의 slug}.{도메인}.{동작}` 형태만 허용됩니다(타 org 네임스페이스 도용
    자동 거부). payload_schema는 top-level `additionalProperties: false`를 반드시 선언해야
    합니다(미선언 시 등록 거부 — 모르는 필드를 조용히 통과시키는 스키마를 org 사용자 책임으로
    돌릴 수 없어서입니다). routing.escalation/broadcast는 각각 `{"kind":"payload_field",
    "member_id_field":"..."}`(payload의 특정 필드를 대상 member_id로 사용) 또는
    `{"kind":"server_derived","target":"none"}`(대상 없음 — org 커스텀에서 유일하게 허용되는
    server_derived 값)만 등록 가능합니다.

    ⚠️`sprintable_publish_event`(발행)와 별개 도구입니다 — 이건 org 관리 행위(admin 그룹),
    발행은 events 그룹입니다.
    """
    try:
        return ok(await client.post("/api/v2/events/definitions", json={
            "key": args.key, "payload_schema": args.payload_schema, "routing": args.routing,
        }))
    except Exception as exc:
        return err(str(exc))


async def update_event_definition(args: UpdateEventDefinitionInput) -> list[TextContent]:
    """org 커스텀 이벤트 정의 수정/비활성화(story #2636) — org admin/owner 전용.

    payload_schema/routing을 바꾸면 등록 시점과 동일한 게이트로 재검증되고 version이
    올라갑니다. `enabled=false`가 삭제 수단입니다(soft — 발행 이력이 이 정의를 참조하므로
    hard delete는 없습니다). 플랫폼 프리셋(preset.*)은 이 경로로 수정할 수 없습니다.
    """
    body: dict = {}
    if args.payload_schema is not None:
        body["payload_schema"] = args.payload_schema
    if args.routing is not None:
        body["routing"] = args.routing
    if args.enabled is not None:
        body["enabled"] = args.enabled
    try:
        return ok(await client.patch(f"/api/v2/events/definitions/{args.definition_id}", json=body))
    except Exception as exc:
        return err(str(exc))
