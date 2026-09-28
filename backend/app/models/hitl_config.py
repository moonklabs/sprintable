"""E-CAGE-REFEREE P3: HITL gate config 모델.

설계 원칙: 플랫폼은 위험도 판정 안 함(risk_level 없음).
"뭐가 위험한가"는 조직 정책 — 공정한 링.

posture: conservative | balanced | permissive → default disposition 결정.
disposition: allow_auto | ask | deny.
gate_type: pr_review | qa | merge | deploy (확장 가능 String).
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

POSTURES = frozenset({"conservative", "balanced", "permissive"})
DISPOSITIONS = frozenset({"allow_auto", "ask", "deny"})
# story #2709(2026-08-17) — agent_decision_request 포함: gates.py의 GateCreateRequest 필드
# validator가 이 세트만 통과시켜 등재 필요. _ALWAYS_MANUAL_GATE_TYPES(gate_service.py)가
# posture 무관 항상 pending으로 덮으므로 여기 등재가 disposition 자동판정에 실제로 영향은
# 안 준다 — 순수히 「generic POST /api/v2/gates로 생성 허용」 관문 통과 목적.
GATE_TYPES = frozenset({
    "pr_review", "qa", "merge", "deploy", "workflow_config_publish", "agent_decision_request",
    # story #3291(M1·마케팅자동화) — 불가역 외부 발신(SNS/광고 게시). gate_service.py의
    # _ALWAYS_MANUAL_GATE_TYPES에도 등재해 org posture 무관 항상 pending 강제(순수히
    # 여기 등재만으론 disposition 자동판정에 영향 없음 — 위 agent_decision_request 주석 참고).
    "external_publish",
    # story #3561(Phase2·BE, 페드루 PO 確定 2026-09-06) — doc(개념/컨셉 자료)을 근거로
    # 다른 work_item(Story/Task)을 휴먼이 승인하는 게이트. external_publish와 동일 근거로
    # _ALWAYS_MANUAL_GATE_TYPES에도 등재(항상 pending — deliberate approval, disposition
    # auto-pass 대상 아님).
    "concept_approval",
})

# story #4080(E-RECIPE-1, PO 라이브 실측 2026-09-20·PO 방향정정) — 조회 필터
# (routers/gates.py::list_gates)가 이 GATE_TYPES(generic POST 생성 허용 세트, "그 gate_
# type으로 새 게이트를 **만들 수 있는지**"만 정의)를 조회 값 검증 SSOT로 재사용해
# generation_budget처럼 전용 서비스코드가 create_gate()를 직접 호출해(generic POST를
# 안 거쳐) 만드는 gate_type을 422로 거부했다(실사고 — 예산 게이트 ⓒ를 필터로 못 골랐음).
# 더 깊게는 recipe_gate_hooks.py의 `gate_decl["type"]`(stage_metadata[stage].gate.type)가
# org가 직접 짓는 완전 개방 문자열이라(validate_stage_metadata는 "비어있지 않은 문자열"만
# 강제, 닫힌 어휘 아님) "gate_type 전수"는 애초에 코드 레벨 고정 enum으로 못 담는다 —
# 그래서 **조회 필터는 이 GATE_TYPES(또는 어떤 다른 closed set)에도 기대지 않는다**(PO
# 確定): 형식(식별자 패턴+길이 상한)만 검증하고, 소속 여부는 안 본다 — 모르는 값은 그냥
# 빈 결과(정직한 "필터된 결과", #2864가 막은 "파라미터 자체를 무시"와는 다른 결).
# GATE_TYPES는 generic POST 생성 관문 목적으로만 무변경 유지.

_POSTURE_DEFAULT: dict[str, str] = {
    "conservative": "ask",
    "balanced": "ask",
    "permissive": "allow_auto",
}
SYSTEM_DEFAULT_DISPOSITION = "ask"


def posture_to_disposition(posture: str) -> str:
    return _POSTURE_DEFAULT.get(posture, SYSTEM_DEFAULT_DISPOSITION)


class OrgGatePolicy(Base):
    """org 수준 기본 posture — org당 1행."""
    __tablename__ = "org_gate_policy"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True, index=True)
    posture: Mapped[str] = mapped_column(String(20), nullable=False, server_default="balanced")
    # story #3319(2026-09-02, 선생님 처방 확定) — 머지 게이트가 designated_approver_id=None으로
    # 생성돼 rule B(gates.py::_non_doc_gate_approvable)가 project owner/admin 전원(org owner
    # 포함)에게 «승인 가능»으로 노출했다(실사고: PR#3706 머지 게이트를 QA 前에 선생님이 서명).
    # 이 값(org 멤버·nullable)을 설정하면 머지 게이트 생성 시 designated_approver_id로 채워져
    # rule B가 그 멤버 1인에게만 승인 자격을 좁힌다(gates.py::_non_doc_can_approve 변경 참조).
    # 미설정(None, 기본값)은 현행 무변경(회귀 0). 사람 멤버만 허용(에이전트는 requires_human
    # 게이트에 구조적으로 서명 불가) — 쓰기 시점(routers/hitl_config.py::upsert_org_policy)에서
    # is_org_owner_or_admin과 동형 NOT EXISTS 패턴으로 검증(422).
    merge_gate_default_approver_member_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True,
    )
    # story #4083(E-RECIPE-1, PO 확定 2026-09-21) — merge_gate_default_approver_member_id와
    # 동일 패턴·동일 검증(routers/hitl_config.py::_is_eligible_gate_default_approver_member
    # 재사용). 레시피 stage 게이트(recipe_gate_hooks.py::_resolve_org_owner)가 이 값이
    # 있으면 그 멤버를 designated_approver로, 없으면 기존 org owner 그대로(회귀 0) —
    # "org_owner 하드코딩" 실사고 처방(org owner≠마케팅 담당인 org에서 사람 게이트가
    # 항상 owner 결재함으로만 가던 것).
    recipe_gate_default_approver_member_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class OrgGateOverride(Base):
    """org 수준 역할(role) × gate_type 오버라이드."""
    __tablename__ = "org_gate_override"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("participation_role.id", ondelete="CASCADE"), nullable=False
    )
    gate_type: Mapped[str] = mapped_column(String(50), nullable=False)
    disposition: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MemberGateOverride(Base):
    """개별 member × gate_type 예외 — org override보다 우선."""
    __tablename__ = "member_gate_override"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    gate_type: Mapped[str] = mapped_column(String(50), nullable=False)
    disposition: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
