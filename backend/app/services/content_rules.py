"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 저장·
초안 lint. 블루프린트 v3 §2(f)·처분표(3b9960cb) 8행.

주어 가르기(PO 確定) — 제품이 기계로 검사하는 것은 금칙어(`banned_terms`)·UTM 필수
(`require_utm`) 둘뿐이다. 톤(`tone`)·택소노미(`taxonomy`)·채널 우선순위
(`channel_priority`)·브랜드 킷(`brand_kit`)은 에이전트가 GET으로 읽고 스스로 지키는
선언 슬롯 — 제품은 저장·노출만 하고 `lint_content()`가 그 키들을 아예 보지 않는다."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_content_rule import OrgContentRule

_REQUIRED_UTM_PARAMS = ("utm_source", "utm_medium", "utm_campaign")
# 페드루 PO 정정(2026-09-05, #3825 리뷰) — 3471 본문 최초값 `/settings/content-rules`가
# 틀렸다(FE org 설정 자리는 `/organization/...` 동형, `/organization/channels`와 짝 —
# 3472 본문에서 이미 고쳐짐). 이 파일이 유일한 발신처라 상수 한 곳으로 고정.
_SETTINGS_PATH = "/organization/content-rules"


class ContentRuleViolationError(Exception):
    """상신(submit) 시점 재검사에서 위반이 있으면 이 예외 — 라우터가 422
    `CONTENT_RULE_VIOLATION`으로 감싼다(금지 AC=서버 거부, story #3471 확定)."""

    def __init__(self, *, rules_version: int, violations: list[dict]):
        self.rules_version = rules_version
        self.violations = violations
        super().__init__(f"콘텐츠 규칙 위반 {len(violations)}건(rules_version={rules_version})")


async def get_org_content_rules(db: AsyncSession, *, org_id: uuid.UUID) -> OrgContentRule | None:
    return (await db.execute(
        select(OrgContentRule).where(OrgContentRule.org_id == org_id)
    )).scalar_one_or_none()


async def put_org_content_rules(
    db: AsyncSession, *, org_id: uuid.UUID, rules: dict, updated_by_member_id: uuid.UUID,
) -> OrgContentRule:
    """upsert — org당 1행(UNIQUE org_id). PUT마다 `version` +1(이력 테이블 없음, 감사는
    이 값+`updated_by_member_id`로 충분 — story #3397 "파생 가능한 값은 별도 저장 안
    한다" 원칙과 동형)."""
    existing = await get_org_content_rules(db, org_id=org_id)
    if existing is None:
        row = OrgContentRule(
            id=uuid.uuid4(), org_id=org_id, rules=rules, version=1,
            updated_by_member_id=updated_by_member_id,
        )
        db.add(row)
    else:
        existing.rules = rules
        existing.version += 1
        existing.updated_by_member_id = updated_by_member_id
        row = existing
    await db.commit()
    await db.refresh(row)
    return row


def lint_content(rules: dict | None, *, text: str, link_url: str | None) -> list[dict]:
    """순수 함수(DB 접근 없음) — channel_post/site_post 양쪽이 같은 함수를 호출한다
    (PO 確定 "같은 스토리·호출 한 줄"). `rules`가 None(조직이 아직 규칙을 한 번도 PUT
    안 함)이면 위반 0건(빈 규칙=lint 없음, 존재 비강제).

    반환은 `[{code, field, value, hint_key, settings_path}, ...]`(story #3471 확定
    형 — #3343 구조화 warnings 설계와 같은 사상, 그 스토리 자체는 아직 backlog라
    코드 재사용은 없음·형만 준용)."""
    if not rules:
        return []
    violations: list[dict] = []

    banned_terms = rules.get("banned_terms") or []
    text_lower = text.lower()
    for term in banned_terms:
        # 페드루 PO 정정(2026-09-05, #3825 리뷰) — PutContentRulesRequest가 이제
        # banned_terms: list[str]를 pydantic으로 강제하지만, 방어를 이 순수 함수
        # 자체에도 한 줄 둔다(호출부가 라우터를 안 거치는 경로가 생겨도 비문자열이
        # .lower()에서 500을 내지 않게).
        if isinstance(term, str) and term and term.lower() in text_lower:
            violations.append({
                "code": "banned_term", "field": "text", "value": term,
                "hint_key": "content_rules.banned_term", "settings_path": _SETTINGS_PATH,
            })

    # story #3506(페드루 PO 確定 2026-09-05 ⓕ) — utm_rules.enabled=true면 발행 시점에
    # 서버가 자동 부착을 보장하므로(build_tagged_link), submit 시점에 사람이 손으로
    # 넣었는지 검사하는 이 축은 «자동 충족»으로 통과시킨다(require_utm 자체는 폐기
    # 안 함 — 수동 규칙으로 계속 쓸 수 있게 남긴다, PO 明示).
    utm_rules = rules.get("utm_rules") or {}
    if rules.get("require_utm") and link_url and not utm_rules.get("enabled"):
        missing = [p for p in _REQUIRED_UTM_PARAMS if f"{p}=" not in link_url]
        if missing:
            violations.append({
                "code": "utm_missing", "field": "link_url", "value": ",".join(missing),
                "hint_key": "content_rules.utm_missing", "settings_path": _SETTINGS_PATH,
            })

    return violations
