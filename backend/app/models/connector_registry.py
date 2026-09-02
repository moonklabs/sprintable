"""story #3317(마케팅자동화·레시피 결함, PO 확定 2026-09-02①②) — 조직 커넥터 레지스트리.

플러그인 쪽 `describe_connector` MCP 도구(미르코, 0.7.0)가 반환하는 정본 스키마
`{connector_key, version, channel, fields:[{name, source, required, constraints, setup_hint}]}`
를 설정 스킬 실행 시 이 테이블에 등록한다. `fields`는 각 파라미터가 `content`(work item에서
옴)인지 `org_config`(조직이 미리 설정)인지 선언 — publish 단계에서 에이전트가 work item
content + 이 테이블의 org_config 값을 합성해 content_package를 만든다(#3288 설계정정 —
서버는 발행을 직접 안 부름, 합성은 에이전트 쪽).

⛔토큰/시크릿은 이 테이블에 절대 안 온다 — 플러그인 로컬 env가 유일 자리(PO 명시). 서버는
`org_config`에 쓸 수 있는 키를 `fields`에 `source="org_config"`로 선언된 이름으로만 강제
(services/connector_registry.py의 set_org_connector_config 참조) — 시크릿을 선언하는 것
자체는 플러그인 쪽 규약으로 막는다(서버는 "선언 안 된 키 거부"만 담당).

(org_id, connector_key) 축이 "이 org의 현재 등록"의 정체성이다 — 재등록(새 version)은 같은
행을 upsert(overwrite)한다(멀티버전 이력 테이블 아님, org_domain_label의 upsert 패턴과
동형). GET은 이 단일 행을 그대로 반환한다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgConnectorRegistry(Base):
    __tablename__ = "org_connector_registry"
    __table_args__ = (
        UniqueConstraint("org_id", "connector_key", name="uq_org_connector_registry_org_key"),
        Index("ix_org_connector_registry_org", "org_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    connector_key: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    # [{name, source: "content"|"org_config", type, required, constraints, setup_hint}] —
    # describe_connector 반환 그대로(플러그인·서버 양쪽이 같은 shape을 pin 테스트로 대조,
    # PO 지침). name은 dot-path("create.senderEmail")여도 서버는 쪼개지 않고 문자열 그대로
    # org_config의 키로 쓴다(중첩 조립은 에이전트 몫, PO 확定 2026-09-02③).
    fields: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    # PO 확定(2026-09-02②) — wire 최상위 requires_env: 이 커넥터가 필요로 하는 **환경변수
    # 이름**만(플러그인 로컬 env 자리 안내용, 예: "THREADS_ACCESS_TOKEN") — 값은 여기 절대
    # 안 온다(서버가 값처럼 보이는 항목을 거부, services/connector_registry.py 참조).
    requires_env: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    # source="org_config"로 선언된 필드 이름만 키로 가질 수 있고(쓰기 시점 강제), 값의
    # 파이썬 타입도 그 필드의 declared type과 일치해야 한다(services/connector_registry.py::
    # set_org_connector_config 참조). 시크릿 없음.
    org_config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
