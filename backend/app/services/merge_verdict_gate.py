"""H1-S2: Merge verdict gate service (블루프린트 E-H1-VERDICT-GATE S2).

기존 Cage(participation→verdict→trust→gate)를 머지 경로에 합성해, PR/CI 증거 + 멤버 trust +
조직 disposition으로 머지 decision(auto_merge|ask_human|block)을 산출한다. **신규 신설 0** —
participation/verdict/trust/gate 함수를 그대로 재사용한다.

설계: gate row = 조직 정책 disposition 아티팩트(audit·AC⑥·create_gate가 disposition→status 설정).
decision = 정책 + 증거(CI·PR·trust)를 합성한 service 산출(S3 merge hook가 소비). gate status를
override하지 않는다(auto_passed terminal 불변 보존). 둘은 별개 축이라 충돌 없이 Cage 재사용.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.participation import ParticipationRole
from app.services.gate_service import create_gate
from app.services.trust_score import compute_member_trust_scores
from app.services.verdict_capture import (
    capture_pr_ci_verdict,
    resolve_implementation_participation,
)

logger = logging.getLogger(__name__)

MERGE_GATE_TYPE = "merge"
# clean_pass_rate 하한 — config 필드가 없어 상수 기본값(param 오버라이드 가능). 블루프린트 지정값 시 교체.
DEFAULT_TRUST_THRESHOLD = 0.8

AUTO_MERGE = "auto_merge"
ASK_HUMAN = "ask_human"
BLOCK = "block"

# gate status(정책 disposition 아티팩트) → 원 disposition 역추론(관측용).
_STATUS_TO_DISPOSITION = {"auto_passed": "allow_auto", "pending": "ask", "rejected": "deny"}


@dataclass(frozen=True)
class MergeGateDecision:
    """머지 게이트 평가 결과. decision을 S3 merge hook가 소비한다."""

    decision: str  # auto_merge | ask_human | block
    reason: str
    gate_id: uuid.UUID | None
    gate_status: str | None  # 정책 disposition 아티팩트 status(auto_passed|pending|rejected)
    disposition: str | None  # allow_auto | ask | deny
    trust: float | None
    ci_result: str | None  # 정규화(pass|fail|None)


def _normalize_result(result: str | None) -> str | None:
    """pass|fail|None. capture_pr_ci_verdict와 동일 정규화(pass/success→pass, 그 외 비-None→fail)."""
    if result is None:
        return None
    return "pass" if result.strip().lower() in ("pass", "success") else "fail"


def _impl_trust(trust_result: dict[str, Any], role_key: str | None) -> float | None:
    """trust 결과에서 (지정 역할의) clean_pass_rate. verdict 없으면 None(AC③ trust None)."""
    scores = trust_result.get("scores") or []
    for s in scores:
        if role_key is None or s.get("role_key") == role_key:
            return s.get("clean_pass_rate")
    return None


def _decide(
    *,
    ci: str | None,
    pr: str | None,
    gate_status: str | None,
    trust: float | None,
    threshold: float,
    self_report_only: bool,
) -> tuple[str, str]:
    """정책(gate_status) + 증거(ci/pr/trust)를 합성해 (decision, reason)."""
    # AC①: CI 실패는 하드 차단.
    if ci == "fail":
        return BLOCK, "CI fail"
    # AC②⑦: CI 결과 미상(독립 verdict 없이 self-report만이면 verdict None) → 사람.
    if ci is None:
        return ASK_HUMAN, "CI unknown (self-report only)" if self_report_only else "CI unknown"
    # disposition=deny(gate rejected) → 차단.
    if gate_status == "rejected":
        return BLOCK, "policy disposition=deny"
    # AC③: trust 미측정(verdict 없음) → 사람.
    if trust is None:
        return ASK_HUMAN, "trust unmeasured (no verdict)"
    # AC④: allow_auto + CI pass + PR pass + trust≥threshold → 자동 머지.
    if gate_status == "auto_passed" and ci == "pass" and pr == "pass" and trust >= threshold:
        return AUTO_MERGE, f"allow_auto + CI pass + PR pass + trust {trust:.2f}>={threshold}"
    # AC⑤: ask posture → 사람 보류.
    if gate_status == "pending":
        return ASK_HUMAN, "policy disposition=ask"
    # 기본 안전 — 자동 조건 미충족(예: trust<threshold, PR fail).
    return ASK_HUMAN, "auto-merge conditions unmet"


async def _role_key(session: AsyncSession, role_id: uuid.UUID) -> str | None:
    role = await session.get(ParticipationRole, role_id)
    return role.key if role is not None else None


async def evaluate_merge_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    *,
    pr_number: int,
    repo: str,
    ci_result: str | None,
    pr_result: str | None = "pass",
    trust_threshold: float = DEFAULT_TRUST_THRESHOLD,
) -> MergeGateDecision:
    """story 머지 게이트를 평가해 decision(auto_merge|ask_human|block)을 산출한다.

    Cage 재사용: capture_pr_ci_verdict(독립 verdict 기록) + compute_member_trust_scores(trust) +
    create_gate(정책 disposition 아티팩트·AC⑥). 모든 평가는 gate row를 남긴다.
    """
    ci = _normalize_result(ci_result)
    pr = _normalize_result(pr_result)

    participation = await resolve_implementation_participation(session, org_id, story_id)
    if participation is None:
        # implementation participation 없음 → 누구의 trust인지 알 수 없어 사람에게(AC 안전).
        logger.info("merge gate: no implementation participation story=%s — ask_human", story_id)
        return MergeGateDecision(
            decision=ASK_HUMAN,
            reason="no implementation participation",
            gate_id=None,
            gate_status=None,
            disposition=None,
            trust=None,
            ci_result=ci,
        )
    member_id = participation.member_id
    role_id = participation.role_id
    role_key = await _role_key(session, role_id)

    # 1. 독립 verdict 포착(Cage) — pr/ci verdict 기록. self-report만이면 기록 0.
    capture = await capture_pr_ci_verdict(
        session, org_id, story_id, pr_number, repo, merged=(pr == "pass"), ci_result=ci_result
    )
    self_report_only = bool(capture.get("skipped_reason")) or not capture.get("recorded")

    # 2. trust(Cage) — implementation 역할 clean_pass_rate.
    trust_result = await compute_member_trust_scores(session, org_id, member_id, role_key=role_key)
    trust = _impl_trust(trust_result, role_key)

    # 3. 정책 disposition 아티팩트 gate row(Cage·AC⑥). create_gate가 disposition→status 설정·멱등.
    gate = await create_gate(
        session,
        org_id,
        story_id,
        "story",
        MERGE_GATE_TYPE,
        member_id,
        role_id,
        neutral_facts={
            "ci_result": ci,
            "pr_result": pr,
            "trust": trust,
            "trust_threshold": trust_threshold,
            "pr_number": pr_number,
            "repo": repo,
            "self_report_only": self_report_only,
        },
    )

    # 4. 정책 + 증거 합성 decision.
    decision, reason = _decide(
        ci=ci,
        pr=pr,
        gate_status=gate.status,
        trust=trust,
        threshold=trust_threshold,
        self_report_only=self_report_only,
    )
    logger.info(
        "merge gate story=%s decision=%s (%s) gate_status=%s trust=%s",
        story_id, decision, reason, gate.status, trust,
    )
    return MergeGateDecision(
        decision=decision,
        reason=reason,
        gate_id=gate.id,
        gate_status=gate.status,
        disposition=_STATUS_TO_DISPOSITION.get(gate.status),
        trust=trust,
        ci_result=ci,
    )
