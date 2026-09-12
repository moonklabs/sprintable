"""story #3808(Phase3·3-3 PR3, 페드루 PO 確定 2026-09-11) — X 종량 API 지출 월 상한.
3498 생성 비용 한도(`generation_budget.py`) 계산 프리미티브(period_window+evidence
합산+거부 신호)를 그대로 재사용하되, **다른 지갑**이라 별도 evidence kind(`api_usage_
cost`)+규칙 네임스페이스(`org_content_rules.rules.api_usage_budget`)로 분리한다 —
같은 kind로 섞으면 두 예산 잔량이 서로 갉아먹는다(그라운딩 정정, 2026-09-11).

`unit_cost_minor`(세그먼트/게시물 1건당 단가) — 실 X 요금은 API 티어에 따라 바뀌는
값이라(2026-01 지식 컷오프 기준 Basic $100/월 정액이 아니라 게시물당 종량인 티어도
존재 — 정확한 현재가는 ⚠️미확認) «폐기된 전제로 정한 코드 상수»가 되면 안 된다(페드루
PO 追加 決定②, 2026-09-11 21:53Z) — `org_content_rules.rules.api_usage_budget.
unit_cost_minor` 규칙값을 우선하고, 관리자가 아직 설정 안 했으면 `_DEFAULT_UNIT_COST_
MINOR`(코드 기본값, 아래 ⚠️미확認 근거 그대로)로 폴백한다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.evidence import Evidence
from app.services.content_rules import get_org_content_rules
from app.services.generation_budget import GenerationBudgetExceededError, check_generation_budget_or_raise

API_USAGE_COST_KIND = "api_usage_cost"
API_USAGE_BUDGET_RULE_KEY = "api_usage_budget"

# ⚠️미확認(2026-09-11 그라운딩, 지식 컷오프 2026-01 기준 최선 추정) — X API v2 종량
# 티어 게시물당 단가($0.015/게시물로 문서에 인용된 값, KRW 환산 근사). 실 요금제
# 확定 전까지의 임시 기본값 — 관리자가 `api_usage_budget.unit_cost_minor`를 설정하면
# 이 상수는 전혀 안 쓰인다(설정값이 항상 우선).
_DEFAULT_UNIT_COST_MINOR = 20


def get_api_usage_unit_cost_minor(rules: dict | None) -> int:
    """`org_content_rules.rules.api_usage_budget.unit_cost_minor` 우선, 없으면 코드
    기본값(위 ⚠️미확認 상수). `rules`는 `OrgContentRule.rules`(규칙 행 자체가 없으면
    호출부가 None을 넘긴다 — 그 경우도 기본값으로 폴백, "규칙 없음"이 "단가 0"으로
    잘못 읽히지 않게 한다)."""
    budget = (rules or {}).get(API_USAGE_BUDGET_RULE_KEY) or {}
    unit_cost = budget.get("unit_cost_minor")
    if unit_cost is None:
        return _DEFAULT_UNIT_COST_MINOR
    return int(unit_cost)


async def check_api_usage_budget_or_raise(
    db: AsyncSession, *, org_id: uuid.UUID, estimated_cost_minor: int, now: datetime | None = None,
) -> None:
    """`channel_posts.py::publish_channel_post_draft`가 x/x_sandbox 채널에서 실 발행
    (create_container 등 provider 호출) 直前에 부르는 판정 지점 — 3498의 발행 재검사와
    같은 위치 축(그 옆 병렬 호출, 3498 체크는 무변경). `estimated_cost_minor`는
    호출부가 `get_api_usage_unit_cost_minor()` × 세그먼트 수로 미리 계산해 넘긴다."""
    await check_generation_budget_or_raise(
        db, org_id=org_id, estimated_cost_minor=estimated_cost_minor, now=now,
        kind=API_USAGE_COST_KIND, rule_key=API_USAGE_BUDGET_RULE_KEY,
    )


async def record_api_usage_cost_evidence(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, publication_id: uuid.UUID,
    sequence: int, cost_minor: int,
) -> None:
    """발행 성공 뒤 세그먼트당 1건 기록 — **publication_id+sequence로 멱등**(페드루 PO
    追加 決定④, 2026-09-11 21:53Z) — 재시도·재발행이 같은 (publication_id, sequence)
    조합으로 다시 호출해도 evidence가 중복 계상되지 않는다(이미 있으면 조용히 skip,
    이 함수 자체가 write 성공/스킵 여부를 신경 안 써도 되는 안전한 재호출 계약).
    이 조합이 이미 evidence 쓰기 시점에 유니크하다고 보는 근거: 한 (gate_id, version_id,
    sequence)는 channel_publications UNIQUE 제약(story #3808 PR2)이 이미 발행물 1건임을
    보장하므로, publication_id(그 행의 id)+sequence 조합도 자동으로 유니크하다 —
    별도 DB 제약 신설 없이 조회-후-삽입만으로 충분(경합은 이 평가 지점에서 실제로
    안 겹친다 — 같은 publication 행에 대한 evidence 기록은 그 발행 자체가 끝난
    뒤 순차로만 일어난다)."""
    existing = (await db.execute(
        select(Evidence.id).where(
            Evidence.org_id == org_id, Evidence.type == "metric",
            Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
            Evidence.payload["publication_id"].astext == str(publication_id),
            Evidence.payload["sequence"].astext == str(sequence),
        )
    )).scalar_one_or_none()
    if existing is not None:
        return
    # work_item_type="story" 고정 — ChannelPostDraft.work_item_id는 항상 Story를
    # 가리킨다(모델에 work_item_type 필드 자체가 없음, task 변형 0 — 그라운딩 확認).
    db.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="metric", ref=str(publication_id), source="platform",
        payload={
            "kind": API_USAGE_COST_KIND, "cost_minor": cost_minor,
            "publication_id": str(publication_id), "sequence": sequence,
        },
    ))
    await db.commit()


__all__ = [
    "API_USAGE_COST_KIND", "API_USAGE_BUDGET_RULE_KEY", "GenerationBudgetExceededError",
    "get_api_usage_unit_cost_minor", "check_api_usage_budget_or_raise", "record_api_usage_cost_evidence",
]
