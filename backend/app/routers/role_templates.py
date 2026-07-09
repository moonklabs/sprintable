"""Role Templates API — E-RECRUIT S1 (story a47e7374): 채용 카탈로그 조회.

GET /api/v2/role-templates        발행된 role_template 목록
GET /api/v2/role-templates/{slug} 단건 조회(role_behaviors 포함)

E-RECRUIT S24(story 25e8828d, 선생님 결정 B — 카탈로그 카드 완전 KO): locale 서빙 —
`resolve_locale_from_request`(release_notes/recruit와 동형: 명시 `?locale=` →
`Accept-Language` 헤더 폴백 → DEFAULT_LOCALE)로 정규화한 locale에 맞춰:
- `role_behaviors`: `role_behaviors_i18n.get(locale) or role_behaviors`(ko가 원본/canon,
  en 오버레이 — compose_kit과 동일 폴백).
- `description`: `description_i18n.get(locale) or description`(migration 0167 — 반대
  방향: en이 원본/canon(track C 저작이 영어), ko 오버레이). PO 병행 저작·주입 전엔 ko
  콘텐츠가 비어있어 자동으로 기존 영어로 무회귀 폴백.
- `division`: 12개 고정 enum 값을 `_DIVISION_DISPLAY_NAMES`(코드 상수 — 값 자체가 유한
  집합이라 no-PR-for-data 무관, agent_recruiter의 다른 locale dict와 동형)로 표시명 매핑.
`name`/`category`는 이번 스코프 제외 — category는 78개 거의 1:1 세분류 태그라 브라우징
그룹핑 축이 아님(division이 그 역할), name은 고유명사라 영어 유지(PO+유나 합의).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.role_template import RoleTemplate
from app.schemas.a2a import AgentSkill
from app.services.agent_onboarding_config import resolve_locale_from_request

router = APIRouter(prefix="/api/v2/role-templates", tags=["role-templates"])

# S24(story 25e8828d) — division 12개 고정값 → ko 표시명(PO 제공·선생님 확認 2026-07-09).
# en(기본)은 저장된 원문 그대로(매핑 불요) — ko 요청시에만 이 dict로 치환.
_DIVISION_DISPLAY_NAMES_KO: dict[str, str] = {
    "Content": "콘텐츠",
    "Data": "데이터",
    "Design": "디자인",
    "Engineering": "엔지니어링",
    "Growth": "그로스",
    "Marketing": "마케팅",
    "Operations": "오퍼레이션",
    "Platform / DevOps": "플랫폼/DevOps",
    "Product": "프로덕트",
    "Quality": "품질",
    "Sales": "세일즈",
    "Security": "보안",
}


def _localize_division(division: str | None, locale: str) -> str | None:
    """알려지지 않은/미래 division 값은 매핑 미스여도 원문 그대로(무회귀 폴백) — reject 안 함."""
    if division is None or locale != "ko":
        return division
    return _DIVISION_DISPLAY_NAMES_KO.get(division, division)


class RoleTemplateSummary(BaseModel):
    """목록 응답 — role_behaviors(md 본문) 제외(목록 페이로드 절감, chat/story 패턴과 동형)."""

    id: uuid.UUID
    slug: str
    name: str
    category: str
    description: str | None
    default_tool_groups: list[str]
    default_workflow_recipe_slug: str | None
    is_builtin: bool
    tier: str
    version: int
    # ~300직군 카탈로그 트랙 S1(문서 role-template-crud-api-crux §4) — division/emoji nullable,
    # skills는 app.schemas.a2a.AgentSkill 그대로 재사용(신규 스키마 발명 안 함).
    division: str | None = None
    emoji: str | None = None
    skills: list[AgentSkill] = []

    model_config = {"from_attributes": True}


class RoleTemplateDetail(RoleTemplateSummary):
    """단건 응답 — role_behaviors(자율 운영 지침 본문) + runtime_overrides 포함."""

    role_behaviors: str
    runtime_overrides: dict
    created_at: datetime
    updated_at: datetime


def _to_summary_response(rt: RoleTemplate, locale: str) -> RoleTemplateSummary:
    """release_notes `_to_response`/`compose_kit`과 동형 폴백 — i18n 오버레이가 그 locale에
    콘텐츠가 없으면 원문으로 무회귀 폴백."""
    description = (rt.description_i18n or {}).get(locale) or rt.description
    return RoleTemplateSummary(
        id=rt.id, slug=rt.slug, name=rt.name, category=rt.category, description=description,
        default_tool_groups=rt.default_tool_groups,
        default_workflow_recipe_slug=rt.default_workflow_recipe_slug, is_builtin=rt.is_builtin,
        tier=rt.tier, version=rt.version, division=_localize_division(rt.division, locale),
        emoji=rt.emoji, skills=[AgentSkill.model_validate(s) for s in rt.skills],
    )


def _to_detail_response(rt: RoleTemplate, locale: str) -> RoleTemplateDetail:
    role_behaviors = (rt.role_behaviors_i18n or {}).get(locale) or rt.role_behaviors
    description = (rt.description_i18n or {}).get(locale) or rt.description
    return RoleTemplateDetail(
        id=rt.id, slug=rt.slug, name=rt.name, category=rt.category, description=description,
        default_tool_groups=rt.default_tool_groups,
        default_workflow_recipe_slug=rt.default_workflow_recipe_slug, is_builtin=rt.is_builtin,
        tier=rt.tier, version=rt.version, division=_localize_division(rt.division, locale),
        emoji=rt.emoji, skills=[AgentSkill.model_validate(s) for s in rt.skills],
        role_behaviors=role_behaviors, runtime_overrides=rt.runtime_overrides,
        created_at=rt.created_at, updated_at=rt.updated_at,
    )


@router.get("", response_model=list[RoleTemplateSummary])
async def list_role_templates(
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[RoleTemplateSummary]:
    """발행된(is_published) role_template 카탈로그 — org/project 무관 전역 조회.

    Header() DI 마커는 라우트 경계에서만 받고 실 로직은 ``_list_role_templates()``(plain
    str만)로 위임 — 직접-호출 realdb 테스트가 ASGI 파이프라인 없이도 Header sentinel leak
    없이 부를 수 있게 한다(recruit 엔드포인트 S19/E-I18N 선례와 동형)."""
    return await _list_role_templates(session=session, locale=locale, accept_language=accept_language)


async def _list_role_templates(
    *, session: AsyncSession, locale: str | None = None, accept_language: str | None = None,
) -> list[RoleTemplateSummary]:
    """``description``·``division``이 locale에 맞춰 선택/매핑된다(``category``/``name``은
    이번 스코프 제외 — 모듈 docstring 참고)."""
    resolved_locale = resolve_locale_from_request(locale, accept_language)
    result = await session.execute(
        select(RoleTemplate)
        .where(RoleTemplate.is_published.is_(True))
        .order_by(RoleTemplate.category, RoleTemplate.name)
    )
    return [_to_summary_response(rt, resolved_locale) for rt in result.scalars().all()]


@router.get("/{slug}", response_model=RoleTemplateDetail)
async def get_role_template(
    slug: str,
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> RoleTemplateDetail:
    """단건 조회 — Header() DI 마커는 라우트 경계에서만, 실 로직은 ``_get_role_template()``
    (plain str)로 위임(위 list와 동일 이유)."""
    return await _get_role_template(slug, session=session, locale=locale, accept_language=accept_language)


async def _get_role_template(
    slug: str, *, session: AsyncSession, locale: str | None = None, accept_language: str | None = None,
) -> RoleTemplateDetail:
    """미발행(is_published=False) 행은 404(카탈로그와 동일 가시성 규칙).

    ``role_behaviors``는 ``?locale=``(명시) → ``Accept-Language``(폴백) → ko(기본)로 정규화한
    locale에 맞춰 ``role_behaviors_i18n``에서 선택(recruit ``compose_kit``과 동일 원칙) —
    en 콘텐츠가 없으면 자동으로 ko 원문 폴백(무회귀)."""
    role_template = (await session.execute(
        select(RoleTemplate).where(RoleTemplate.slug == slug, RoleTemplate.is_published.is_(True))
    )).scalar_one_or_none()
    if role_template is None:
        raise HTTPException(status_code=404, detail="Role template not found")
    resolved_locale = resolve_locale_from_request(locale, accept_language)
    return _to_detail_response(role_template, resolved_locale)
