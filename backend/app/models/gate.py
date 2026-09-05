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

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String, Text, func, text
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
    # story #2893(0271) — 멱등 키 확장: (org_id, work_item_id, work_item_type, gate_type)
    # 1슬롯 공유가 「PR A 서명이 PR B의 SHA를 뭄」실사고(설계안 §2 A1)의 근본원인이었다.
    # NULL=PR 컨텍스트 없음(board-preflight no-substance 경로) 또는 애초에 PR 개념이 없는
    # gate_type(doc_approval 등) — 지어내지 않는다. DB 제약은 0271에서 부분 유니크 인덱스
    # 2개로 분리(NULL 구간=옛 계약 그대로, NOT NULL 구간=+pr_number). create_gate() 호출부
    # 전수는 gate_service.py 참조.
    pr_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # story #2932(HIGH1, 0272) — pr_number 단독은 repo 경계가 없어(전역이 아니라 스토리
    # 스코프 안에서도) 다른 repo의 같은 번호 PR이 슬롯을 공유할 수 있었다(cross-repo
    # 충돌). pr_number와 짝으로 멱등 키에 편입 — find_gate_slot_with_pr_fallback.py 참조.
    # NULL=pr_number와 동형 사유(PR 컨텍스트 없음/레거시 미백필).
    repo_full_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3478(0328) — 멱등 키 세 번째 축. 대부분의 gate_type(merge·HITL ask·doc
    # approval 등)은 이 컬럼이 항상 ""(공유 UNIQUE 인덱스 셋에 이 컬럼을 끼워 넣어도
    # ""뿐이라 구분력 무변, 회귀 0). `external_publish`만 site_posts.py·channel_posts.py
    # 호출부가 목적지(`str(draft.connection_id or "")`)를 채운다 — 같은 work_item이
    # WordPress·webhook 등 여러 목적지로 각각 독립 게이트를 갖게 된다(work_item당 1건
    # 제약이 site_post의 dual-destination AC를 구조적으로 막던 것의 근본수정).
    scope_key: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="pending")
    resolver_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #2985(PO 설계 확定 2026-08-24) — 「누가 해야 하는지」(사전 지정, resolver_id의
    # 대칭짝). 상신 시 지정하면 그 1인에게만 액션 카드·나머지 org/project owner+admin은
    # 정보성으로 강등(dispatch_approval_request_cards). 미지정(None)이면 현행(권한자 전원
    # 액션) 그대로 — 회귀 0. 지정자가 아니어도 owner/admin의 해소 권한 자체는 무변화(SoD와
    # 별개 축 — 이건 «기본 노출»만 좁힌다).
    designated_approver_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
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
    # check-run id. **check-run은 SHA당 1개가 정본**(카디르 QA③-c, 2026-08-19) — 발행 대상
    # SHA가 github_check_run_sha와 다르면 PATCH가 아니라 새 run을 만든다(안 그러면 새 head로는
    # 영원히 check가 안 생겨 required가 영구 미충족되는 데드엔드).
    github_check_run_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # story #2813 — 위 github_check_run_id가 "어느 SHA에 대해" 만들어졌는지(카디르 QA③-c).
    github_check_run_sha: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #2813 — "이 승인이 귀속된 SHA"(AC②). synchronize/opened/reopened/ready_for_review
    # 웹훅의 새 head_sha와 다르면 재-pending(approved→pending) 트리거(카디르 QA③-b: reopen 가드를
    # synchronize만이 아니라 네 액션 전부에서 돌림 — 다른 head로 돌아온 재오픈 PR도 잡는다).
    approved_head_sha: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #2932(완주조건 HIGH2, 0273) — GitHub `pull_request.updated_at`(실 PR 갱신마다
    # 단조증가) 워터마크. reopen_gate_if_new_sha가 이걸로 stale/순서역전 웹훅 배달을
    # 걸러 이미 최신 SHA로 승인된 게이트를 옛 배달로 부당 재-pending시키지 않는다.
    pr_head_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #3365(Phase0 S2, 마케팅운영) — external_publish 전용 sealing. approved_head_sha
    # (위, merge gate)와 동형 축: "이 승인이 귀속된 대상"을 서버가 상신 시점에 한 번 기록하고
    # 그 뒤로는 **비교만** 한다(어떤 갱신 경로도 열지 않는다 — story 본문 «봉인 값 불변» AC).
    # 최신 site_post_versions 행과 다르면(즉 승인 뒤 수정) 공개 서비스가 409로 거부하고,
    # 그 새 버전을 만든 트랜잭션이 이 gate를 pending으로 되돌린다(site_posts.py 참고).
    sealed_content_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sealed_content_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    sealed_content_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 정정2) — external_publish
    # 전용 두 번째 봉인 축(위 sealed_content_*와 같은 관례, 공유-nullable — 예약 개념이
    # 없는 다른 gate_type은 항상 null). "승인 후 예약 시각 변경=재승인"(블루프린트 §3)의
    # 비교 기준값. site_posts 등은 이 컬럼을 절대 안 씀.
    sealed_scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story 620beefc(Phase1·마케팅운영, 페드루 PO 決定 2026-09-04) — external_publish 전용
    # 세 번째 봉인 축(위 두 축과 같은 공유-nullable 관례). `ChannelPostVersion.image_sha256`과
    # 비교해 "승인 후 이미지 교체=재승인, 사유=MEDIA_CHANGED"를 sealed_content_sha256(본문)
    # 축과 독립적으로 판정하기 위함(AC4 판정 축 세분화 content|schedule|media).
    sealed_media_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③a) — external_
    # publish 전용 네 번째 봉인 축(위 세 축과 같은 공유-nullable 관례). site_post_drafts.
    # connection_id(null=hosted_site)와 비교해 "승인 후 목적지 변경=재승인"(블루프린트
    # §3 "목적지·불변 버전·예약 시각·예산을 참조 — 승인 후 변경 시 무효화")을 content/
    # schedule/media 축과 독립적으로 판정한다.
    sealed_destination_connection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # 승인 후 수정으로 시스템이 되돌린 pending인지(사람이 처음 상신한 pending과 구분 — S4가
    # "재승인 필요" 배지를 그릴 신호) — 새 명시 submit()이 재봉인하면 False로 복귀한다.
    reapproval_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
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
