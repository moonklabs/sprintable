"""story #4101(#4095 그라운딩 doc c65ce586 §3-1 후보A·§3-4·PO Q②병렬 確定, 2026-09-21) —
조직이 소유한 생성 모델(연산) provider 자격 원장. 리허설 1호 지름길②("제품 연산 슬롯이
비어 있어 에이전트가 자기 Vertex 스크립트로 대체")의 근본 처방 — org가 자기 생성
커넥터를 등록하면 레시피 stage가 그것을 가리킬 수 있다(RecipeRoleBinding.
generation_connector_id).

`org_connector_registry`(app/models/connector_registry.py)와 의도적으로 별개 테이블 —
그 레지스트리는 "시크릿/토큰은 절대 안 온다"는 명시 설계(story #3317, 발행 커넥터 스키마
선언 전용)라 credential을 실제로 보관하는 이 테이블은 재사용하지 않고 새로 연다(§1-4·
Q②). `channel_connections`(story #3373)와도 병렬 신설 — 그쪽은 발행 목적지, 이쪽은
생성 모델. 관계 형태는 스토리가 정하지 않아 FK로 안 묶는다(channel_connections/
org_connector_registry 선례와 동형 판단).

암호화는 `app/services/generation_connector_credential_crypto.py`(channel_credential_
crypto.py 미러) — 독립 시크릿, 새 암호화 패턴 발명 0."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin

# story #4101(§3-1) — provider_key 닫힌 집합(코드 레지스트리, 공급자 편애 없이 확장 가능한
# 표). 첫 값만 실제 지원(리허설이 쓴 Vertex Gemini) — 나머지는 커넥터 등록 API가 422로
# 거부(연다고 선언만 하고 실제 미지원 provider를 등록시키지 않는다).
GENERATION_CONNECTOR_PROVIDER_KEYS: frozenset[str] = frozenset({"vertex_gemini"})

GENERATION_CONNECTOR_STATUSES: frozenset[str] = frozenset({"active", "revoked"})


class OrgGenerationConnector(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "org_generation_connectors"
    __table_args__ = (
        UniqueConstraint("org_id", "label", name="uq_org_generation_connectors_org_label"),
        CheckConstraint(
            "status IN ('active', 'revoked')",
            name="ck_org_generation_connectors_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider_key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    # 모달리티별 모델 id(image/video/voice…) — provider별 자유 형식(닫힌 스키마를 이 시점에
    # 강제하지 않는다, §3-1 "공급자 편애 없이" 원칙 그대로 provider_key마다 다른 형태 허용).
    model_config_json: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    # story #4101 — Fernet(generation_connector_credential_crypto) 암호문. 응답에 절대
    # 미노출(write-only, gates.py::to_gate_response류 "단일 직렬화 통로" 선례처럼 이 값을
    # 만지는 Pydantic 응답 모델 자체에 필드를 안 둔다 — 실수로도 못 새게).
    encrypted_credentials: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
