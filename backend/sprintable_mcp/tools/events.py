"""이벤트 레지스트리 MCP 도구 (2개) — story #2634.

publish_event → POST /api/v2/events/publish(#2633, publish_registry_event) 래퍼.
list_event_definitions → GET /api/v2/events/definitions(#2634) 래퍼. 둘 다 신규 백엔드
로직 없음(순수 배선) — sprintable_emit_event(agent RUN 텔레메트리, POST /api/v2/agent-runs)와
개념이 다르다: 그건 에이전트 실행 lifecycle 이벤트, 이건 event_definitions 카탈로그(#2632)
기반 도메인 이벤트 발행/조회다. 이름이 비슷해 보여도 서로 무관한 두 개념(혼동 방지를 위해
아래 각 함수 docstring에서 다시 한 번 명시).
"""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
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
        return ok(await client.post("/api/v2/events/publish", json=body))
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
