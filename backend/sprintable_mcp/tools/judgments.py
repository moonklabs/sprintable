"""story #2268(D단계, E-CONNECT — "판단 칸") MCP 도구(2개) — REST뿐이던 pull 진입점을
에이전트가 직접 쓰도록 노출. 오르테가 판단(2026-07-28 21:57): "쓰는 쪽이 아직 저 하나뿐이라
다른 에이전트도 쓸 수 있어야" — evidence.py와 동형(단순 REST 위임, 재구현 0)."""
from __future__ import annotations

import uuid

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class AddJudgmentInput(SprintableInput):
    scope: str  # "items" | "general"
    kind: str  # judgment | unmeasurable | retraction | refinement | method_error
    statement: str
    work_item_ids: list[str] = []
    # ⛔2026-07-30부터 선택(retraction/refinement/method_error 포함) — 이전 판정을 몰라도
    # 남길 수 있다(target_id는 "이전 판정의 id"인데 처음 쓰는 사람은 그게 없어 순환에 갇혔다).
    target_id: str | None = None
    method: str | None = None  # method_error 역추적 축
    source_message_id: str | None = None  # 이 판정이 나온 채팅 메시지(이미 적은 것을 다시 안 쓰게)


async def add_judgment(args: AddJudgmentInput) -> list[TextContent]:
    """판단(judgment)·못 잰 것(unmeasurable)·철회(retraction)·정련(refinement)·세는 법
    틀림(method_error)을 남긴다. Evidence와 별개 — "됐다"의 증거가 아니라 "이렇게 판단했다/
    이 판단은 틀렸다"는 판정 자체를 기록한다. scope="general"이면 work_item_ids는 비워야
    하고(특정 작업과 무관한 일반 교훈), scope="items"면 최소 1개 필요하다. target_id(무엇에
    대한 말인지)는 선택이다 — 있으면 이 org에 실재하는 판정이어야 한다(없으면 422). 이
    도구는 append-only다(수정/삭제 없음) — 잘못 남겼으면 retraction으로 새로 남긴다."""
    try:
        payload: dict = {
            "scope": args.scope, "kind": args.kind, "statement": args.statement,
            "work_item_ids": args.work_item_ids,
        }
        if args.target_id is not None:
            payload["target_id"] = args.target_id
        if args.method is not None:
            payload["method"] = args.method
        if args.source_message_id is not None:
            payload["source_message_id"] = args.source_message_id
        result = await client.post("/api/v2/judgments", json=payload)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


class ListJudgmentsInput(SprintableInput):
    work_item_id: str | None = None
    method: str | None = None
    scope: str | None = None  # "items" | "general"
    limit: int | None = None


async def list_judgments(args: ListJudgmentsInput) -> list[TextContent]:
    """pull 전용 — 「물으면 준다」(push 없음). `corrections`(retraction·refinement·
    method_error — 앞선 말에 대한 말 전부)는 상한과 무관하게 항상 전체(철회된 판단을 다시
    주장하지 않으려면 빠짐없이 봐야 한다). `active`(judgment/unmeasurable)는 recency
    기준으로 캡되며, `meta.active_omitted_count`가 실제로 몇 건 잘렸는지 알려준다(잘리는
    것은 항상 active뿐 — corrections는 절대 안 잘린다). ⛔각 원소(`active`·`corrections`
    둘 다)의 `correction_ids`가 비어있지 않으면 그 항목은 이미 정정됐다는 뜻 — 그대로
    믿지 말고 `corrections`에서 그 id를 찾아 무엇이 어떻게 정정됐는지 확인할 것(정정이
    다른 정정을 target하는 것도 정상 — method_error는 여러 말에 번지므로). `method` 필터는
    "같은 방법으로 낸 다른 말들"을 역추적할 때 쓴다(method_error를 남기기 전에 먼저 이걸로
    훑어보는 것을 권장)."""
    try:
        params: dict = {}
        if args.work_item_id is not None:
            params["work_item_id"] = args.work_item_id
        if args.method is not None:
            params["method"] = args.method
        if args.scope is not None:
            params["scope"] = args.scope
        if args.limit is not None:
            params["limit"] = args.limit
        result = await client.get("/api/v2/judgments", params=params)
        return ok(result)
    except Exception as exc:
        return err(str(exc))
