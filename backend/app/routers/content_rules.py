"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05)·#3490(2026-09-05 정정) —
조직 콘텐츠 규칙 API. GET은 org 멤버(휴먼·에이전트 모두) — 에이전트가 톤·택소노미·
채널 우선순위·브랜드 킷 선언 슬롯을 읽어야 하는 축(PO 確定 "에이전트: 위반 경고·개선
제안"). PUT은 휴먼 owner **또는 admin**(story #3490 — 원래 "owner만"이 채널 연결
생성(CHANNEL_CONNECTION_HUMAN_ONLY, owner/admin)과 비대칭이었다: dev org 유일
owner가 대표뿐이라 admin 운영자가 규칙을 못 넣어 운영 요청이 owner에게 쌓이는
구조였다)."""
from __future__ import annotations

import uuid

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_content_rule import OrgContentRule
from app.services.content_rules import (
    ContentRulesVersionConflictError, get_org_content_rules, put_org_content_rules,
)
from app.services.generation_budget import compute_generation_budget_status
from app.services.x_publish_budget import API_USAGE_BUDGET_RULE_KEY, API_USAGE_COST_KIND
from app.services.member_resolver import resolve_member, resolve_member_display_name
from app.services.project_auth import assert_target_in_caller_org

router = APIRouter(prefix="/api/v2/organizations", tags=["content-rules"])


async def _require_owner_or_admin(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """story #3490 — channel_connections.py::_require_owner와 동형 권한 폭(owner|admin).
    member·에이전트는 여전히 403(회귀 0)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human" or resolved.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CONTENT_RULES_ADMIN_ONLY",
                "message": "콘텐츠 규칙 편집은 조직 owner·admin만 가능합니다.",
            },
        )
    return resolved


class ContentRulesUpdatedBy(BaseModel):
    member_id: uuid.UUID
    name: str | None


class ContentRulesResponse(BaseModel):
    org_id: uuid.UUID
    rules: dict
    version: int
    # story #3747(ⓑ, 페드루 PO 確定 2026-09-09) — 지금까지 409 충돌 응답에서만
    # 이름을 해소해 실었다(#3501). 화면 헤더 부제 「마지막 변경 {날짜}·{이름}」가
    # 평상시(GET·PUT 성공)에도 이 값을 필요로 해 노출을 넓힌다 — 컬럼은 이미 있음
    # (updated_at·updated_by_member_id, #3501), 새 필드 직렬화만.
    updated_at: str | None = None
    updated_by: ContentRulesUpdatedBy | None = None


class GenerationBudgetRule(BaseModel):
    """story #3498(페드루 PO 決定 2026-09-05) — 생성 비용 한도 정책값(Sprintable
    결제 원장과 무접촉, 3471 슬롯 확장). limit_minor=0은 "정지"(모든 추정치가 즉시
    거부) — 필드 자체가 없음(«규칙 없음»)과는 다른 신호(generation_budget.py 참고)."""

    model_config = ConfigDict(extra="forbid")

    # 페드루 PO REQUIRED(2026-09-05, PR#3847 리뷰③) — limit_minor 음수는 "정지"보다
    # 더 이상한 상태(잔량이 시작부터 음수)라 애초에 저장을 막는다. currency/period는
    # Literal이 이미 422를 강제(3종 검증 테스트로 확認).
    limit_minor: int = Field(ge=0)
    currency: Literal["KRW", "USD"] = "KRW"
    period: Literal["month"] = "month"


class ApiUsageBudgetRule(BaseModel):
    """story #3808(Phase3·3-3 PR3, 페드루 PO 確定 2026-09-11) — X 종량 API 지출 월
    상한(3498 GenerationBudgetRule과 동형 계약, 별도 지갑). `unit_cost_minor`(세그먼트/
    게시물 1건당 단가) 필드가 3498 대비 유일한 추가 — 실 X 요금이 티어에 따라 바뀌는
    값이라 관리자가 여기서 덮어쓸 수 있어야 한다(미설정이면 x_publish_budget.py의
    코드 기본값으로 폴백)."""

    model_config = ConfigDict(extra="forbid")

    limit_minor: int = Field(ge=0)
    currency: Literal["KRW", "USD"] = "KRW"
    period: Literal["month"] = "month"
    unit_cost_minor: int | None = Field(default=None, ge=0)


class UtmRules(BaseModel):
    """story #3506(페드루 PO 確定 2026-09-05) — UTM 자동 부착 정책값. source/medium은
    «어댑터 하드코딩 위에 조직 override»(미설정이면 channel_adapters.py의 어댑터별
    상수 그대로, app/services/utm.py::attach_utm 호출부가 그 우선순위로 넘긴다).

    `campaign_from`은 지금은 순수 서술용이다 — 실 campaign 해소는 여전히
    `resolve_utm_campaign()`의 기존 규칙(블로그 경로면 slug·아니면 draft_id) 그대로다
    (PO 確定 "기존 resolve 규칙 유지" — 이 필드가 그 규칙을 바꾸지 않는다, 값이
    뭐든 동작 무변경). `content_from="none"`이면 utm_content 자체를 안 붙인다."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    default_source: str | None = None
    default_medium: str | None = None
    campaign_from: Literal["campaign_slug", "draft_id"] = "campaign_slug"
    content_from: Literal["draft_id", "none"] = "draft_id"


class ContentRulesFields(BaseModel):
    """페드루 PO 리뷰 보정(2026-09-05, PR#3825) — `rules: dict`가 무형식이라
    `banned_terms`에 문자열 "spam"을 그대로 넣으면 `lint_content()`의
    `for term in banned_terms`가 글자 단위(s·p·a·m)로 돌아 오타가 조용히 통과했다
    (「오타로 써도 통과하나」의 자리). `extra="forbid"`로 모르는 키도 거부 —
    휴먼이 실수로 다른 철자를 쳐도 그 값이 조용히 무시되는 대신 422로 알린다."""

    model_config = ConfigDict(extra="forbid")

    banned_terms: list[str] = []
    require_utm: bool = False
    tone: str | None = None
    taxonomy: list[str] = []
    channel_priority: list[str] = []
    brand_kit: dict | None = None
    generation_budget: GenerationBudgetRule | None = None
    api_usage_budget: ApiUsageBudgetRule | None = None
    utm_rules: UtmRules | None = None
    # story #3359 CHANGES(카디르 발견, 페드루 PO 리뷰 2026-09-08) — 리졸버
    # (channel_connector_map.py::resolve_connector_key_for_channel)의 org override
    # 우선순위①이 이 필드가 없어 죽은 경로였다: extra="forbid"라 PUT body에
    # channel_connector_map을 실으면 422로 거부돼, org가 blog/newsletter 같은
    # 별칭을 «영원히» 등록할 방법이 없었다(리졸버는 읽기만 살아있고 쓰기 계약이
    # 없었다). 편집 UI는 여전히 후속(#3359 AC 스코프 경계 그대로)이지만, 이 스키마
    # 필드(기존 content-rules API로 쓸 수 있게 하는 것)는 리졸버가 실제로 살아
    # 있으려면 필수라 여기 포함한다.
    channel_connector_map: dict[str, str] | None = None


class PutContentRulesRequest(BaseModel):
    rules: dict
    # story #3501(PO 確定, doc a0da40c9 §20) — 낙관적 잠금. 필수 필드라 누락 시
    # pydantic이 자동 422(별도 처리 불필요, AC1 "누락 422"는 이 자체가 답).
    expected_version: int


# story #3747(ⓑ, 페드루 PO 確定 2026-09-09) — GET·PUT 성공 응답 공용 조립. 409
# 충돌 경로(#3501)와 같은 "이름은 있으면만 싣는다" 규율 — orphan 멤버라 해소
# 실패하면 name을 None으로(화면이 "누가"를 지어내지 않는다).
#
# story #3747 CHANGES①(페드루 PO 지적, 2026-09-09) — 처음엔 `resolve_member_identity()`를
# 썼는데, 그 함수의 grant-only 휴먼(OrgMember만 있고 TeamMember 없음) 분기가 표시명이
# 없으면 이메일로 채워 넣어(member_resolver.py:599) 이 화면 부제·409 배너 둘 다에
# 이메일이 그대로 샜다(라이브 캡처로 실측). `resolve_member_display_name()`(표시명
# 전용, 이메일·id 폴백 0)으로 교체 — None이면 FE가 "이름 모름"(날짜만) 갈래로 정직하게
# 떨어진다. member_id는 행에 이미 있어(row.updated_by_member_id) 해소 성공 여부와
# 무관하게 항상 실을 수 있다.
async def _build_content_rules_response(
    row: OrgContentRule, db: AsyncSession,
) -> ContentRulesResponse:
    updated_by = None
    if row.updated_by_member_id is not None:
        name = await resolve_member_display_name(row.updated_by_member_id, row.org_id, db)
        updated_by = ContentRulesUpdatedBy(member_id=row.updated_by_member_id, name=name)
    return ContentRulesResponse(
        org_id=row.org_id, rules=row.rules, version=row.version,
        updated_at=row.updated_at.isoformat(), updated_by=updated_by,
    )


@router.get("/{org_id}/content-rules", response_model=ContentRulesResponse)
async def get_content_rules_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ContentRulesResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    row = await get_org_content_rules(db, org_id=org_id)
    if row is None:
        return ContentRulesResponse(org_id=org_id, rules={}, version=0)
    return await _build_content_rules_response(row, db)


@router.put("/{org_id}/content-rules", response_model=ContentRulesResponse)
async def put_content_rules_endpoint(
    org_id: uuid.UUID,
    body: PutContentRulesRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ContentRulesResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner_or_admin(db, auth, org_id)

    # story #3471(페드루 PO 確定) — 이 리소스는 org_id 자신이 식별자라 target org가
    # 항상 caller org와 같다(구조적으로 spoof 불가) — meetings.py::cancel_meeting과
    # 동형으로 직접 호출해 PATH_ID 뮤테이션 스캐너 가시성을 미리 확보한다(#3806 CI
    # 재발 방지, 실 동작은 무변).
    assert_target_in_caller_org(org_id, org_id)

    try:
        validated = ContentRulesFields.model_validate(body.rules)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CONTENT_RULES_INVALID", "message": str(exc)},
        ) from exc

    try:
        row = await put_org_content_rules(
            db, org_id=org_id, rules=validated.model_dump(), updated_by_member_id=resolved.id,
            expected_version=body.expected_version,
        )
    except ContentRulesVersionConflictError as exc:
        # story #3501(doc a0da40c9 §20-2) — "서버가 «누가»를 주면 그때 이름을 쓴다"
        # PO 決定: updated_by_member_id가 있으면 이름을 해소해 싣고, 없으면(row가
        # 아직 없던 경우) updated_by를 아예 안 싣는다 — 화면이 "누가"를 지어내지
        # 않는다(§20-2 규율 그대로). story #3747 CHANGES①(2026-09-09) — 이름 해소는
        # `resolve_member_display_name()`(표시명 전용, 이메일 폴백 0)으로. 이유는
        # `_build_content_rules_response`와 동일(이메일 노출 사고 재발 방지).
        updated_by = None
        if exc.updated_by_member_id is not None:
            name = await resolve_member_display_name(exc.updated_by_member_id, org_id, db)
            updated_by = ContentRulesUpdatedBy(member_id=exc.updated_by_member_id, name=name)
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CONTENT_RULES_VERSION_CONFLICT",
                "current_version": exc.current_version,
                "updated_by": updated_by.model_dump(mode="json") if updated_by else None,
            },
        ) from exc
    return await _build_content_rules_response(row, db)


class GenerationBudgetStatusResponse(BaseModel):
    """story #3498 조각①(미르코 FE 3500 그라운딩, 페드루 PO 決定 2026-09-05) — 잔량
    조회. limit_minor가 null이면(«규칙 없음») 전부 null — 지어내지 않는다(compute_
    generation_budget_status()가 None을 돌려주는 그 신호를 그대로 반영)."""

    limit_minor: int | None
    currency: str | None
    period: str | None
    period_start: str | None
    period_end: str | None
    spent_minor: int | None
    remaining_minor: int | None


@router.get("/{org_id}/generation-budget", response_model=GenerationBudgetStatusResponse)
async def get_generation_budget_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> GenerationBudgetStatusResponse:
    """content-rules GET과 동일 권한 축(org 멤버 누구나 — 휴먼·에이전트 모두, write
    없음). compute_generation_budget_status() 그대로 재사용(submit/발행 체크포인트와
    같은 계산 함수 — 화면이 보는 값과 서버가 실제로 거부 판정에 쓰는 값이 항상
    같다는 보장)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    status = await compute_generation_budget_status(db, org_id=org_id)
    if status is None:
        return GenerationBudgetStatusResponse(
            limit_minor=None, currency=None, period=None, period_start=None, period_end=None,
            spent_minor=None, remaining_minor=None,
        )
    return GenerationBudgetStatusResponse(
        limit_minor=status["limit_minor"], currency=status["currency"], period=status["period"],
        period_start=status["period_start"].isoformat(), period_end=status["period_end"].isoformat(),
        spent_minor=status["spent_minor"], remaining_minor=status["remaining_minor"],
    )


@router.get("/{org_id}/api-usage-budget", response_model=GenerationBudgetStatusResponse)
async def get_api_usage_budget_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> GenerationBudgetStatusResponse:
    """story #3808(Phase3·3-3 PR3) — get_generation_budget_endpoint와 동형(같은
    권한 축·같은 응답 모양) — kind/rule_key만 X 종량 축으로 넘긴다. 화면이 보는
    값과 발행 직전 실제 거부 판정에 쓰는 값이 항상 같다는 보장도 동형으로 유지."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    status = await compute_generation_budget_status(
        db, org_id=org_id, kind=API_USAGE_COST_KIND, rule_key=API_USAGE_BUDGET_RULE_KEY,
    )
    if status is None:
        return GenerationBudgetStatusResponse(
            limit_minor=None, currency=None, period=None, period_start=None, period_end=None,
            spent_minor=None, remaining_minor=None,
        )
    return GenerationBudgetStatusResponse(
        limit_minor=status["limit_minor"], currency=status["currency"], period=status["period"],
        period_start=status["period_start"].isoformat(), period_end=status["period_end"].isoformat(),
        spent_minor=status["spent_minor"], remaining_minor=status["remaining_minor"],
    )
