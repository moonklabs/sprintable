"""story #3769(BE+MCP·소형, 페드루 PO 確定 2026-09-10) — 조직 콘텐츠 규칙 읽기 MCP 도구.

`app/services/content_rules.py:4-7`의 docstring(PO 確定, story #3471)은 「톤·택소노미·채널
우선순위·브랜드 킷은 에이전트가 GET으로 읽고 스스로 지키는 선언 슬롯」이라고 선언하지만,
`backend/sprintable_mcp/tools/*` 전수에 그 GET을 부를 길이 0건이었다(BE는 이미 org 멤버
자격으로 열려 있었다 — `routers/content_rules.py::get_content_rules_endpoint`, admin 게이트는
PUT만). 이 도구가 그 갭을 메운다 — 신규 BE 엔드포인트 0(기존 GET 둘을 그대로 호출·병합).

응답 낱말은 두 BE 응답의 필드명 그대로다(`ContentRulesResponse`: org_id·rules·version,
`GenerationBudgetStatusResponse`: limit_minor 등) — rules 본문 키(tone·taxonomy·
channel_priority·brand_kit·banned_terms·require_utm·generation_budget·utm_rules)를 이
파일에서 재선언하지 않는다(정의가 둘이면 갈린다, PO 明示 — content_rules.py의
`ContentRulesFields`가 유일한 형상 SSOT)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class GetContentRulesInput(SprintableInput):
    pass


async def get_content_rules(args: GetContentRulesInput) -> list[TextContent]:
    """조직 콘텐츠 규칙(참고 넷+기계검사 둘)과 생성 예산 상태를 함께 읽는다. org는
    `client.org_id`(호출자 인증 컨텍스트)로 고정 — 다른 org를 지정할 입력 자체가 없어
    타 org 조회가 구조적으로 불가능하다(withdraw_channel_post_draft와 동형 org-scoped
    URL 조립 패턴, channel_posts.py 참고).

    규칙을 한 번도 PUT 안 한 조직은 `rules: {}`·`version: 0`(BE가 빈 상태를 그대로
    반환 — 「없다」를 지어내지 않는다). 생성 예산도 미설정이면 전부 null(compute_
    generation_budget_status의 None 신호 그대로, generation-budget GET과 동일 계약)."""
    try:
        org_id = client.org_id
        rules_resp = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
        budget_resp = await client.get(f"/api/v2/organizations/{org_id}/generation-budget")
        return ok({**rules_resp, "generation_budget_status": budget_resp})
    except Exception as exc:
        return err(str(exc))
