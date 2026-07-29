"""story #2268(E-CONNECT, C-10) MCP 도구 — REST뿐이던 GET /api/v2/session-context를
에이전트가 직접 쓰도록 노출. PO 판정(2026-07-29): "REST로만 있으면 내가(오르테가) 못 쓴다 —
MCP로만 붙는다" — 만들어졌는데 도는 자리가 없는 것(오늘 하루 반복 잡은 실패 클래스)을
피한다. judgments.py/dashboard(core.py)와 동형(단순 REST 위임, 재구현 0)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class SessionContextInput(SprintableInput):
    member_id: str | None = None
    # ⭐PO 지시(2026-07-29): 이 필드 설명이 곧 관례다 — 안 적으면 아무도 안 쓴다.
    since: str | None = None  # 마지막 세션 종료 시각(ISO 8601)을 주면 그 뒤 활동만 온다.
    activity_limit: int | None = None


async def get_session_context(args: SessionContextInput) -> list[TextContent]:
    """세션 시작 컨텍스트 — "여기까지 했고 · 판단/정정 · 최근 활동"을 한 호출로 받는다.
    progress.txt 같은 제품 밖 파일 대신 이 도구가 그 자리를 대신한다(story #2268).

    `since`에 **직전 세션이 끝난 시각**(ISO 8601, 예: "2026-07-29T14:00:00Z")을 주면
    `recent_activity_by_work_item`에 그 뒤로 내 stories/tasks에 일어난 일(action·actor·
    created_at)만 담겨 온다 — ⛔안 주면 이 필드는 `null`이다(빈 목록이 아니다: "안 물어봤다"와
    "물어봤는데 없었다"는 다른 사실이라 섞으면 거짓이 된다). 매 세션 시작마다 **직전 호출
    이후 시각**을 넘기는 것을 권장한다(pull 전용 — 이 도구가 알아서 "마지막 세션"을 기억하지
    않는다, 에이전트는 잊으므로 받은 시점을 스스로 못 지킨다).

    `judgments_by_work_item`은 내 story/task마다 거기 붙은 판단(judgment)과 정정
    (retraction/refinement/method_error)을 함께 준다 — `active` 목록의 각 원소가 이미
    `correction_ids`로 자신을 철회한 정정을 인라인 표시하므로, `active`만 읽어도 "이건
    철회됐다"를 놓칠 수 없다(story #2308/#2611). `active`는 recency로 캡되고
    `meta.active_omitted_count`가 잘린 개수를 사실 그대로 준다(비율 아님) — `corrections`는
    캡 예외로 항상 전량이다.
    """
    try:
        member = args.member_id or client.member_id
        params: dict = {"member_id": member, "project_id": client.require_project_id()}
        if args.since is not None:
            params["since"] = args.since
        if args.activity_limit is not None:
            params["activity_limit"] = args.activity_limit
        return ok(await client.get("/api/v2/session-context", params=params))
    except Exception as exc:
        return err(str(exc))
