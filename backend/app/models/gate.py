"""E-CAGE-REFEREE P3: HITL Gate 1급 객체.

상태기계(``is_valid_transition``/``transition_gate``/``void_gate``/``hold_gate`` — 사람·admin이
주체인 명시적 액션 축): pending → approved | rejected (human 해소)
         auto_passed → (불변, config allow_auto 시 즉시)
         approved | rejected → (이 축에서는 불변 — is_valid_transition에 rejected/approved발
         전이가 없다. void/override/hold 전부 ``status=="pending"`` 강제)

⚠️story #2150: 위 축과 **별개로**, ``gate_service.create_gate()``의 멱등 조회는 rejected 게이트를
재제출(work_item 동일 키로 재호출) 시 **같은 row를 재사용해 새 평가 사이클로 리셋**한다(사람의
명시적 전이가 아니라 시스템의 재평가 — is_valid_transition을 거치지 않는다. approved/voided는
이 리셋 대상이 아니다 — 근거는 gate_service._reopen_rejected_gate 참조). 즉 "rejected는 절대
안 바뀐다"는 이 파일의 서술은 **resolver 액션 축**에서만 참이고, 재제출 축에서는 참이 아니다 —
둘을 혼동하지 않을 것.

neutral_facts: 관찰 사실만 (touches_migration, diff_size 등).
               판정 아님 — 플랫폼은 위험도 판단 안 함.
"""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

GATE_STATUSES = frozenset({"pending", "approved", "rejected", "auto_passed", "voided", "held"})

# 합법 전이: (from, to). ⭐S30: pending→voided(admin recovery·voided≠approval·step_run skipped 해소).
# ⭐S31: pending↔held(admin hold/unhold·일시정지/재개·가역). held→approved/rejected 직접 금지 —
# 재개(held→pending) 후 정상 pending 서 결정(hold와 결정 혼동 방지·4종 모델 clean).
_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("pending", "approved"),
    ("pending", "rejected"),
    ("pending", "voided"),
    ("pending", "held"),       # S31 hold(일시정지·SLA pause)
    ("held", "pending"),       # S31 unhold(재개·SLA resume)
}
# story #2813(Gate→GitHub required check) — SHA 재-pending(승인 後 PR에 새 커밋 push 시 그 승인을
# 무효화)은 `_VALID_TRANSITIONS`/`transition_gate`(사람 결재 전용 FSM — ActivityLog·line resolution·
# doc-gate 등 사람 승인에만 맞는 부작용 체인이 딸림, RC#1)를 안 거친다. `resolve_gate_from_verdict`
# (시스템 자동판정)가 이미 쓰는 것과 동일한 경량 경로 — `set_gate_status()` 직접 호출(gate_github_
# check.py::reopen_gate_if_new_sha) — 을 재사용한다. 그래서 이 전이는 위 set에 없다(의도).


def is_valid_transition(from_status: str, to_status: str) -> bool:
    return (from_status, to_status) in _VALID_TRANSITIONS


# story #2303(2026-07-29): Gate.evidence_status(merge gate 재평가 결과)의 원자료→간소화값
# 매핑 — 원래 app/routers/glance.py의 hero 엔드포인트 전용 상수였다. app/repositories/goal.py
# (`?include=glance`의 focal_story.auto_verify)가 같은 매핑이 다시 필요해지면서 두 자리에
# 같은 dict를 각자 적어두면 오늘 하루 반복 관측된 twin-system 갭이 재발한다 — 모델 레이어를
# 단일 소유자로 삼고 양쪽(라우터·레포지토리)이 여기서 import한다.
AUTO_VERIFY_MAP: dict[str, str] = {"sufficient": "passed", "blocked": "failed"}


class Gate(Base):
    __tablename__ = "gate"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_type: Mapped[str] = mapped_column(String(20), nullable=False)
    gate_type: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="pending")
    resolver_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ⭐S31: hold 만료(시한부 보류). status='held' 일 때만 의미·무기한 hold 면 None. 0132 마이그(post-0096).
    # FE 가 gate 직독으로 held_until 배지 렌더(step_run 경유 leaky 회피)·step_run.held_until 도 SLA 동기화.
    held_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    neutral_facts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # H1-S3: merge verdict gate evidence metadata (0118).
    requires_human: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    evidence_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    decision_basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #2249: "이 상태에 들어간 시각" — updated_at(onupdate=func.now())은 이 목적에 못 쓴다
    # (실측: merge_verdict_gate.evaluate_merge_gate가 CI/PR 재평가마다 evidence_status를 같은
    # 값으로 재대입해도 onupdate가 발동 — updated_at은 "이 상태가 된 시각"이 아니라 "재평가
    # 횟수"를 재고 있었다). status/evidence_status는 서로 다른 축이라 컬럼도 분리한다. 값이
    # 실제로 바뀔 때만 세팅할 것 — set_gate_status()/gate_service.py의 evidence_status 대입
    # 지점에서 값 비교 후 조건부로만 갱신한다(gate.py 직접 대입 금지, SSOT 헬퍼 경유).
    status_entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    evidence_status_entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #2813(Gate→GitHub required check, 0262) — 이 게이트가 추적 중인 현재 GitHub
    # check-run id. 같은 SHA의 pending→success/failure는 이 id로 PATCH, 새 SHA(재-pending)는
    # 새 check-run 생성 후 이 값 교체.
    github_check_run_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # story #2813 — "이 승인이 귀속된 SHA"(AC②). synchronize 웹훅의 새 head_sha와 다르면
    # 재-pending(approved→pending) 트리거.
    approved_head_sha: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


def set_gate_status(gate: "Gate", new_status: str, *, now: datetime) -> None:
    """`gate.status = ...`를 직접 쓰지 말고 이걸 경유할 것 — status_entered_at은 값이 «실제로
    바뀔 때만» 갱신한다(같은 값 재대입은 no-op). #2249 AC4: 재평가/재제출로 같은 상태에 다시
    떨어져도 진입 시각이 리셋되지 않아야 한다는 요건을 이 한 곳에서만 지킨다."""
    if gate.status == new_status:
        return
    gate.status = new_status
    gate.status_entered_at = now


def set_gate_evidence_status(gate: "Gate", new_evidence_status: str | None, *, now: datetime) -> None:
    """evidence_status는 status와 별개 축(merge gate 재평가마다 갱신될 수 있음) — 같은 이유로
    값이 실제로 바뀔 때만 evidence_status_entered_at을 갱신한다."""
    if gate.evidence_status == new_evidence_status:
        return
    gate.evidence_status = new_evidence_status
    gate.evidence_status_entered_at = now
