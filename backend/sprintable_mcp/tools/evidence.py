"""Evidence 자기증명 MCP 도구(1개) — E-VERIFY V0-S1(story 5a5ba27b)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class AddEvidenceInput(SprintableInput):
    work_item_id: str
    work_item_type: str  # "story" | "task"
    type: str  # url | file | pr | deploy | metric | report (gate_approval은 시스템 전용)
    ref: str
    source: str | None = None
    note: str | None = None
    # story #2722(아티팩트·evidence 버전 pin) — 이 evidence가 아티팩트를 근거로 삼을 때 그
    # 아티팩트의 id. 버전은 여기서 고르지 않는다 — 서버가 이 호출 시각의 latest 버전을
    # 조회해 고정한다(같은 아티팩트가 나중에 새 버전으로 바뀌어도 이 evidence의 근거는
    # 그대로 남는다).
    artifact_id: str | None = None
    # story #3585(MCP·customer-zero, 페드루 PO 確定 2026-09-06) — REST `POST
    # /api/v2/evidence`는 이미 받는 구조화 페이로드(예: type="report"+
    # payload.kind="verification_sheet"+items[{name,verdict,note?}], 서버가
    # verified_by/verified_at을 강제 — story #3561)가 MCP엔 아예 없어 고객
    # 에이전트가 검증 시트를 MCP로 못 만들었다(3560/3561 계약의 에이전트 경로가
    # MCP에선 닫혀 있던 갭, 3573 표본 evidence 0건의 원인). additive — 생략 시
    # 기존 동작 완전 무변.
    #
    # verification_sheet 예시:
    # {"kind": "verification_sheet", "items": [{"name": "로그인 흐름", "verdict": "pass"}, {"name": "결제 흐름", "verdict": "fail", "note": "타임아웃"}]}
    payload: dict | None = None


async def add_evidence(args: AddEvidenceInput) -> list[TextContent]:
    """done을 스스로 증명하는 자기 서명 첨부(검사지 아님) — story/task에 evidence(PR·배포·지표·
    발행물 링크 등)를 남긴다. 강제 아닌 선택제(경고나 낙인은 없음, 없으면 현행과 동일).

    story #3585 — `payload`(예: 검증 시트)를 넘기면 REST와 동일하게 서버 검증
    (`EVIDENCE_PAYLOAD_INVALID` 422 등)을 그대로 통과시킨다(이 함수는 그 검증
    로직을 복제하지 않는다 — REST가 SSOT)."""
    try:
        payload = {
            "work_item_id": args.work_item_id,
            "work_item_type": args.work_item_type,
            "type": args.type,
            "ref": args.ref,
        }
        if args.source is not None:
            payload["source"] = args.source
        if args.note is not None:
            payload["note"] = args.note
        if args.artifact_id is not None:
            payload["artifact_id"] = args.artifact_id
        if args.payload is not None:
            payload["payload"] = args.payload
        result = await client.post("/api/v2/evidence", json=payload)
        return ok(result)
    except Exception as exc:
        return err(str(exc))
