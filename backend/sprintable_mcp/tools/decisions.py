"""비동기 결정 요청(story #2709) — AskUserQuestion류 블로킹 질문을 논블로킹 결재 사이클로
승격. 새 게이트 메커니즘 발명 0(Gate/approval-request-card/approvals-queue 전부 재사용) —
`POST /api/v2/gates/decisions`가 self-referencing standalone anchor를 원자 생성하는 것만
신규. 답변은 기존 `poll_events`가 실어나른다(별도 왕복 배관 불요, gate_service.py의
`_notify_doc_gate_requester` 일반화가 이미 `_dispatch_conversation_event`→Event INSERT를
탄다)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class RequestDecisionInput(SprintableInput):
    question: str
    assumption: str  # 필수 — 답을 못 받아도 이 가정으로 계속 진행한다는 선언.
    options: list[str] | None = None  # 힌트로만 렌더(강제 아님) — 사람은 자유텍스트로도 답함.
    related_work_item_type: str | None = None
    related_work_item_id: str | None = None


async def request_decision(args: RequestDecisionInput) -> list[TextContent]:
    """사람 판단이 필요한 순간, AskUserQuestion처럼 블로킹 대기하지 말고 이 도구로 결정을
    발행한 뒤 즉시 `assumption`대로 계속 일한다 — 결재함+해당 채팅에 카드로 뜨고(approve=
    가정 확인, reject=note에 실제 답), 답이 오면 poll_events로 왕복한다. 즉답을 강제하지
    않는다(원탭 승인 — 서명/근거열람 불요, 빠른 확인이 이 도구의 존재 이유)."""
    try:
        body: dict = {"question": args.question, "assumption": args.assumption}
        if args.options:
            body["options"] = args.options
        if args.related_work_item_type and args.related_work_item_id:
            body["related_work_item_type"] = args.related_work_item_type
            body["related_work_item_id"] = args.related_work_item_id
        result = await client.post("/api/v2/gates/decisions", json=body)
        return ok(result)
    except Exception as exc:
        return err(str(exc))
