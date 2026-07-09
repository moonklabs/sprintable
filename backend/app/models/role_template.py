"""role_templates — 제품-소유 글로벌 채용 카탈로그 (E-RECRUIT S1, story a47e7374).

org/project 에 속하지 않는 전역 카탈로그(pricing_versions 와 동형 — org_id/project_id 없음).
`is_builtin` 행은 이 seed 마이그가 심는 제품 기본 카탈로그(frontend/backend/qa/pm) — 향후
관리자가 커스텀 role_template 을 추가할 수 있는 여지(is_builtin=False)를 남겨둔다.

`role_behaviors`(markdown) = 자율 운영 지침("갖춰주고 → 자율 운영" — 블루프린트 개정 방향):
직무 정체성 + 스스로 판단해 claim→status→소통하는 운영법. 플랫폼이 매턴 지시하는 프롬프트가
아니라 에이전트가 알아서 굴러가게 하는 매뉴얼 — `get_workflow_guide` 를 스스로 pull 하는 습관도
포함한다(플랫폼 push 아님).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ARRAY, Boolean, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin


class RoleTemplate(Base, TimestampMixin):
    __tablename__ = "role_templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    # ~80직군 카탈로그(track C)는 이 컬럼을 영어로 저작 — description_i18n(0167)이 그 위
    # ko 오버레이(role_behaviors 와 오버레이 방향이 반대인 이유는 그 필드 주석 참고).
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 자율 운영 지침(markdown) — 큰 정적 프롬프트가 아니라 날씬한 매뉴얼(블루프린트 §3 개정).
    # 이 컬럼 자체가 "ko" 캐논 소스(오늘 유일한 실 콘텐츠) — role_behaviors_i18n은 그 위 오버레이.
    role_behaviors: Mapped[str] = mapped_column(Text, nullable=False)
    # E-I18N Phase B(story 11f1087c, migration 0164) — locale별 번역 오버레이({"en": "...", ...}).
    # 빈 dict가 기본(마이그 시점 백필 없음, 순수 구조 추가) — 소비 코드는
    # `role_behaviors_i18n.get(locale) or role_behaviors` 순서로 조회해 빈 키는 자동으로
    # role_behaviors(ko)로 폴백한다(Phase C 이후 배선 예정, 이 스키마 자체는 무관).
    role_behaviors_i18n: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # mcp_toolset.py 의 그룹 vocabulary(stories/tasks/epics/chat/docs/sprints/...) — admin/
    # destructive-only 그룹 제외(직무별 최소권한). API key scope 로 그대로 흘러간다(S2/S3 소비).
    default_tool_groups: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list
    )
    # workflow_recipes.slug 참조(느슨 — 코드 전용 builtin recipe 도 있어 FK 강제 안 함).
    default_workflow_recipe_slug: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 런타임별 오버라이드(파일명·MCP 배선 노트 등 — 블루프린트 §4 런타임 어댑터). 미정 = {}.
    runtime_overrides: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # true = 이 seed 마이그(제품 기본 카탈로그)가 심은 행 — 향후 커스텀 role_template 여지 남김.
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 카탈로그 노출 게이트 — false 면 GET 목록/단건에서 숨김(작업 중/철회 대비, 삭제 아님).
    is_published: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 과금 게이트 — 직접 갖추기(BYO)는 free 여도 항상 가능(블루프린트 §5), tier 는 "자동 채용"
    # (미래 recruit 서비스) 게이팅용 메타데이터일 뿐 이 S1 에선 아무 것도 강제하지 않는다.
    tier: Mapped[str] = mapped_column(Text, nullable=False, default="free")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # ~300직군 카탈로그 트랙 S1(문서 role-template-crud-api-crux §4): agency-agents 참고 상위
    # 산업/부문 분류(15~25개 목표) — category(기존, 좁은 기능軸: engineering/design/growth 등)와
    # 별개 축. curation 단계(S5)에서 값 확定, 지금은 nullable로 무회귀 확보.
    division: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 순수 표시용 시각코딩(agency-agents 차용) — 로직 무관.
    emoji: Mapped[str | None] = mapped_column(Text, nullable=True)
    # A2A 발견 키 — app.schemas.a2a.AgentSkill(id·name·description·tags·examples) 그대로 재사용
    # (신규 스키마 발명 안 함, A2A가 이미 소비하는 정확히 그 shape). S4에서 _build_agent_card가
    # 이 필드를 직접 소비하게 되면 persona 수작업 없이 스케일에서 발견-by-capability가 열린다.
    skills: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    # E-RECRUIT S24(story 25e8828d, migration 0167) — description locale 오버레이. 원본
    # description 이 이미 영어(track C 저작)라 role_behaviors_i18n 과 반대로 **en(=원본)이
    # canon, ko를 오버레이로 채운다**({"ko": "..."}). 소비 코드는 동일 원칙(
    # `description_i18n.get(locale) or description`) — ko 콘텐츠 없는 행은 영어로 무회귀 폴백.
    description_i18n: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
