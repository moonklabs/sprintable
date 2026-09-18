"""story #3359(레시피·채널 확장, 페드루 PO 確定 2026-09-08) — 마케팅 파이프라인 정의의
publish/measure capability가 connector_key="threads"로 고정돼 payload.channel(threads·
blog·newsletter 등)이 승인 카드 표시용으로만 쓰이고 실제 커넥터 선택엔 안 쓰이던 갭.

이 리졸버가 진리원천 하나 — 트리거 지점 둘(_render_gate_verdict_message의 publish
다음-행동 문구·apply_recipe_role_bindings의 정적 경고) 전부 이 함수 하나를 거친다.

기본 매핑(_DEFAULT_CHANNEL_CONNECTOR_MAP)은 sprintable-agent-plugins의 커넥터 정본
descriptor(*.schema.ts의 connectorKey/channel 필드)를 실측 대조해서만 넣는다 — threads·
instagram·site_git·stibee 네 커넥터 전부 declared channel이 자기 connectorKey와 1:1
그대로(threads→threads·instagram→instagram·site_git→site_git·stibee→stibee)라 이
항등 매핑(channel 라벨이 곧 connector_key인 경우, 기존 정의 전부가 이 형태로 써 왔다
— apply_recipe_role_bindings의 capability.connector_key가 원래 실 connector_key값
그 자체였다, 회귀 0 유지 필수)은 안전하게 기본값으로 박는다.

story 본문이 예로 든 blog→site_git·newsletter→stibee 같은 **별칭**(channel 라벨 ≠
connector_key)은 커넥터 레지스트리 어디에도 'blog'·'newsletter'라는 declared channel이
없다 — 그 라벨은 recipe/조직이 붙이는 의미일 뿐 레지스트리가 보증하는 사실이 아니다.
불확실한 별칭을 기본값으로 지어내면 발행이 조용히 틀린 커넥터로 샐 수 있어(PO 지적),
항등이 아닌 별칭은 org override가 없는 한 항상 None(→ 호출부가 "매핑 없음" 에러로
삼키지 않고 명시한다)."""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.content_rules import get_org_content_rules

# sprintable-agent-plugins/plugins/sprintable/connectors/{threads,instagram,site_git,
# stibee}.schema.ts 실측(2026-09-08) — 네 커넥터 전부 `channel` 필드가 자신의
# `connectorKey`와 문자 그대로 같다(항등 매핑). 'blog'/'newsletter' 같은 별칭은 그
# 레지스트리 어디에도 declared되지 않아 여기 없다(org가 명시로 등록해야 한다 —
# 지어내지 않는다).
_DEFAULT_CHANNEL_CONNECTOR_MAP: dict[str, str] = {
    "threads": "threads",
    "instagram": "instagram",
    "site_git": "site_git",
    "stibee": "stibee",
}


async def resolve_connector_key_for_channel(
    db: AsyncSession, *, org_id: uuid.UUID, channel: str,
) -> str | None:
    """channel(payload.channel, 예: threads·blog·newsletter·instagram)을 org가 발행에
    실제로 쓸 connector_key로 해소한다. 우선순위: ①org_content_rules.rules.
    channel_connector_map(org가 화면/API로 등록한 override) ②검증된 기본 매핑
    ③없음(None) — 지어내지 않는다, 호출부가 "channel=X 매핑 없음"을 명시한다."""
    row = await get_org_content_rules(db, org_id=org_id)
    if row is not None:
        org_map = (row.rules or {}).get("channel_connector_map")
        if isinstance(org_map, dict):
            override = org_map.get(channel)
            if isinstance(override, str) and override:
                return override
    return _DEFAULT_CHANNEL_CONNECTOR_MAP.get(channel)
