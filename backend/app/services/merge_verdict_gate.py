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
import math
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.participation import ParticipationRole
from app.services.gate_resolver import resolve_disposition
from app.services.gate_service import create_gate
from app.services.trust_score import compute_member_trust_scores
from app.services.verdict_capture import (
    capture_pr_ci_verdict,
    resolve_implementation_participation,
)

logger = logging.getLogger(__name__)

MERGE_GATE_TYPE = "merge"
# HO-S6: outcome hit-rate Wilson 하한 임계. auto_merge는 '충분 표본 + 높은 하한'만(상수 기본·param
# 오버라이드 가능). hit_rate 점추정이 아닌 lower-bound라 표본이 적으면 자동으로 보수적이 된다.
DEFAULT_TRUST_THRESHOLD = 0.8
# HO-S6(AC④): outcome 표본이 이 미만이면 hit_rate가 높아도 auto 금지(ask_human). cold-start 가드.
MIN_OUTCOME_SAMPLE = 3
# decision reason/메타에 명시할 신뢰 근거(AC⑥). CI clean-pass가 아니라 가설 적중 이력이 근거임을 못박는다.
TRUST_BASIS = "hypothesis_outcome"

AUTO_MERGE = "auto_merge"
ASK_HUMAN = "ask_human"
BLOCK = "block"

# gate status(정책 disposition 아티팩트) → 원 disposition 역추론(관측용).
_STATUS_TO_DISPOSITION = {"auto_passed": "allow_auto", "pending": "ask", "rejected": "deny"}


def _evidence_status(decision: str) -> str:
    """decision → gate.evidence_status(S3 evidence 메타)."""
    if decision == AUTO_MERGE:
        return "sufficient"
    if decision == BLOCK:
        return "blocked"
    return "insufficient"


def _gate_org_allowlist() -> frozenset[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for x in (settings.h1_merge_gate_org_allowlist or "").split(","):
        x = x.strip()
        if not x:
            continue
        try:
            out.add(uuid.UUID(x))
        except ValueError:
            logger.warning("H1 merge gate allowlist 무효 org_id 무시: %r", x)
    return frozenset(out)


def merge_gate_active(org_id: uuid.UUID) -> bool:
    """H1 머지 게이트 활성 여부 — report-done·board 전 게이트의 단일 스위치(롤아웃 안전).

    default-off(`H1_MERGE_GATE_ENABLED`). enabled여도 allowlist 지정 시 해당 org만(비면 전 org).
    off면 게이트 미호출 → 기존 PATCH/머지 동작 무변경(team stall 방지).
    """
    if not settings.h1_merge_gate_enabled:
        return False
    allow = _gate_org_allowlist()
    return (not allow) or (org_id in allow)


def merge_gate_advisory() -> bool:
    """advisory(B) 모드 여부. True면 게이트가 eval/decision/gate row/metrics는 그대로 기록하되
    →done 차단(409/202)을 면제한다(관측만·done 통과). 미설정=enforcing(A) 보존."""
    return bool(settings.h1_merge_gate_advisory)


@dataclass(frozen=True)
class MergeGateDecision:
    """머지 게이트 평가 결과. decision을 S3 merge hook가 소비한다."""

    decision: str  # auto_merge | ask_human | block
    reason: str
    gate_id: uuid.UUID | None
    gate_status: str | None  # 정책 disposition 아티팩트 status(auto_passed|pending|rejected)
    disposition: str | None  # allow_auto | ask | deny
    trust: float | None  # HO-S6: outcome hit_rate(점추정·관측용). auto 판정은 lower_bound로.
    ci_result: str | None  # 정규화(pass|fail|None)
    # HO-S6(AC⑥): 신뢰 근거 명시 — CI clean-pass가 아닌 가설 적중 이력(hypothesis_outcome).
    trust_basis: str = TRUST_BASIS
    outcome_resolved: int = 0
    outcome_hit_rate: float | None = None
    outcome_pending: int = 0
    outcome_lower_bound: float = 0.0
    outcome_regret: float | None = None


def _normalize_result(result: str | None) -> str | None:
    """pass|fail|None. capture_pr_ci_verdict와 동일 정규화(pass/success→pass, 그 외 비-None→fail)."""
    if result is None:
        return None
    return "pass" if result.strip().lower() in ("pass", "success") else "fail"


def _wilson_lower_bound(hits: int, n: int, z: float = 1.96) -> float:
    """outcome hit-rate의 Wilson score 하한(기본 95% 신뢰). n이 작으면 하한이 낮아져 자동으로
    보수적(표본-인지). n=0이면 0.0."""
    if n <= 0:
        return 0.0
    phat = hits / n
    denom = 1 + z * z / n
    centre = phat + z * z / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n)
    return max(0.0, (centre - margin) / denom)


@dataclass(frozen=True)
class _OutcomeStats:
    """implementation 역할의 가설 outcome 신뢰 근거(HO-S5 trust_score per-role outcome 필드)."""

    hit: int
    resolved: int
    pending: int
    hit_rate: float | None      # hit / resolved (점추정·관측용)
    lower_bound: float          # Wilson 하한(auto 판정 기준)
    regret: float | None        # miss rate = (resolved-hit)/resolved (적중 못한 비율·AC⑥)


def _outcome_stats(trust_result: dict[str, Any], role_key: str | None) -> _OutcomeStats:
    """HO-S6: trust 결과(HO-S5)에서 지정 역할의 outcome 신뢰 근거를 추출.

    CI clean-pass가 아니라 **가설 적중 이력(hypothesis_outcome_*)**을 신뢰 근거로 명시 배선한다.
    resolved=0이면 표본 없음 → cold-start(AC④).
    """
    scores = trust_result.get("scores") or []
    for s in scores:
        if role_key is None or s.get("role_key") == role_key:
            hit = int(s.get("hit") or 0)
            resolved = int(s.get("resolved") or 0)
            pending = int(s.get("pending") or 0)
            hit_rate = s.get("hit_rate")
            regret = round((resolved - hit) / resolved, 4) if resolved > 0 else None
            return _OutcomeStats(
                hit=hit, resolved=resolved, pending=pending, hit_rate=hit_rate,
                lower_bound=_wilson_lower_bound(hit, resolved), regret=regret,
            )
    return _OutcomeStats(hit=0, resolved=0, pending=0, hit_rate=None, lower_bound=0.0, regret=None)


def _decide(
    *,
    ci: str | None,
    pr: str | None,
    gate_status: str | None,
    outcome: _OutcomeStats,
    threshold: float,
    min_sample: int,
    self_report_only: bool,
) -> tuple[str, str]:
    """정책(gate_status) + 증거(ci/pr) + **outcome trust**를 합성해 (decision, reason).

    신뢰 근거는 가설 적중 이력(trust_basis=hypothesis_outcome)이며, auto_merge는 표본이 충분하고
    Wilson 하한이 임계 이상일 때만(AC⑤⑦). CI pass만으로는 절대 auto가 되지 않는다.
    """
    # AC②: CI 실패는 하드 차단(trust 무관).
    if ci == "fail":
        return BLOCK, "CI fail"
    # AC③: CI 결과 미상(독립 verdict 없이 self-report만이면 verdict None) → 사람.
    if ci is None:
        return ASK_HUMAN, "CI unknown (self-report only)" if self_report_only else "CI unknown"
    # disposition=deny(gate rejected) → 차단.
    if gate_status == "rejected":
        return BLOCK, "policy disposition=deny"
    # AC④: outcome 표본 부족(해소 가설 없음/적음) → cold-start, 사람.
    if outcome.resolved < min_sample:
        return ASK_HUMAN, (
            f"outcome sample insufficient (resolved {outcome.resolved}<{min_sample}, "
            f"basis={TRUST_BASIS})"
        )
    # AC⑤⑦: allow_auto + CI pass + PR pass + outcome Wilson 하한≥임계만 자동(CI pass만으론 불가).
    if (
        gate_status == "auto_passed"
        and ci == "pass"
        and pr == "pass"
        and outcome.lower_bound >= threshold
    ):
        return AUTO_MERGE, (
            f"allow_auto + CI pass + PR pass + outcome lower_bound {outcome.lower_bound:.2f}"
            f">={threshold} (hit {outcome.hit}/{outcome.resolved}, basis={TRUST_BASIS})"
        )
    # ask posture → 사람 보류.
    if gate_status == "pending":
        return ASK_HUMAN, "policy disposition=ask"
    # 기본 안전 — 자동 조건 미충족(하한<임계, PR fail 등). 근거 명시.
    return ASK_HUMAN, (
        f"auto-merge conditions unmet (outcome lower_bound {outcome.lower_bound:.2f}<{threshold}, "
        f"basis={TRUST_BASIS})"
    )


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

    # P0(E-DG-REAL 1ff89d23): evidence-driven materialization — 빈 'CI unknown' shell 양산 박멸.
    # 게이트는 **실 신호(CI 결과 · 연결 PR · 명시 deny 정책)**가 있을 때만 만든다. CI/PR 증거가
    # 둘 다 없을 때만 정책을 확인하고, deny가 아니면(ask=시스템 기본이라 그 자체론 신호 아님) 사람이
    # 판단할 게 없는 빈 shell이 되므로 **게이트를 만들지 않는다**(no-gate·row 0·done 통과). 실 CI
    # 증거는 GitHub 앱(S5)이 native 당김. 3 트리거(board preflight·report-done·line-engine) 모두
    # 이 단일 chokepoint를 거쳐 일관 적용. (증거 있으면 resolve_disposition 호출조차 생략.)
    if ci is None and pr_number <= 0:
        disposition = await resolve_disposition(session, org_id, member_id, role_id, MERGE_GATE_TYPE)
        if disposition != "deny":
            logger.info(
                "merge gate: no substance (ci=None pr_number=0 disposition=%s) story=%s "
                "— gate not materialized (no-gate)",
                disposition, story_id,
            )
            return MergeGateDecision(
                decision=AUTO_MERGE,
                reason="no-substance: no CI/PR evidence and policy is not deny — gate not materialized",
                gate_id=None,
                gate_status=None,
                disposition=disposition,
                trust=None,
                ci_result=ci,
            )

    # 1. trust(Cage) — implementation 역할 clean_pass_rate. **capture보다 먼저** 계산한다.
    #    ⚠️ capture_pr_ci_verdict는 현재 PR/CI verdict를 session에 add한다. SQLAlchemy autoflush=True
    #    기본이라 그 뒤에 trust 쿼리(select)를 돌리면 방금 add한 *현재* verdict가 flush돼 딸려들어가,
    #    신규 contributor가 현재 PR 하나로 trust=1.0(1/1)을 자기-부트스트랩 → allow_auto org서 첫
    #    평가가 auto_merge가 돼 "초기 전원 ask·auto_merge 0" 보장이 깨진다. trust는 **이전 이력만**
    #    봐야 하므로 현재 verdict 기록 前에 계산한다.
    trust_result = await compute_member_trust_scores(session, org_id, member_id, role_key=role_key)
    # HO-S6: 신뢰 근거를 가설 outcome 적중 이력으로 명시 배선(trust_basis=hypothesis_outcome).
    outcome = _outcome_stats(trust_result, role_key)
    trust = outcome.hit_rate  # 관측용 점추정. auto 판정은 outcome.lower_bound로.

    # 2. 독립 verdict 포착(Cage) — 현재 pr/ci verdict를 *이후 평가용*으로 기록. self-report만이면 기록 0.
    capture = await capture_pr_ci_verdict(
        session, org_id, story_id, pr_number, repo, merged=(pr == "pass"), ci_result=ci_result
    )
    self_report_only = bool(capture.get("skipped_reason")) or not capture.get("recorded")

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
            # HO-S6(AC⑥): 신뢰 근거 = 가설 적중 이력(CI clean-pass 아님). 명시 노출.
            "trust_basis": TRUST_BASIS,
            "trust": trust,  # outcome hit_rate(점추정)
            "outcome_hit_rate": outcome.hit_rate,
            "outcome_lower_bound": round(outcome.lower_bound, 4),
            "outcome_resolved": outcome.resolved,
            "outcome_hit": outcome.hit,
            "outcome_pending": outcome.pending,
            "outcome_regret": outcome.regret,
            "trust_threshold": trust_threshold,
            "min_outcome_sample": MIN_OUTCOME_SAMPLE,
            "pr_number": pr_number,
            "repo": repo,
            "self_report_only": self_report_only,
        },
    )

    # 4. 정책 + 증거(CI/PR) + outcome trust 합성 decision.
    decision, reason = _decide(
        ci=ci,
        pr=pr,
        gate_status=gate.status,
        outcome=outcome,
        threshold=trust_threshold,
        min_sample=MIN_OUTCOME_SAMPLE,
        self_report_only=self_report_only,
    )
    # H1-FIX-1: decision 메타(S3 evidence 컬럼)를 gate row에 write-back — 모든 호출자(S4 report-done·
    # S5 board preflight)가 영속화한다. 재평가 시 동일 키로 멱등 갱신. (이전엔 MergeGateDecision 리턴엔
    # 있으나 gate row 영속화 0 → FE S8이 null을 읽어 GateInbox 액션 미노출 = dogfood 적발 버그.)
    gate.requires_human = decision != AUTO_MERGE
    gate.evidence_status = _evidence_status(decision)
    gate.decision_basis = reason
    gate.auto_decision_reason = decision
    await session.flush()

    logger.info(
        "merge gate story=%s decision=%s (%s) gate_status=%s basis=%s hit=%s/%s lb=%.2f",
        story_id, decision, reason, gate.status, TRUST_BASIS,
        outcome.hit, outcome.resolved, outcome.lower_bound,
    )
    return MergeGateDecision(
        decision=decision,
        reason=reason,
        gate_id=gate.id,
        gate_status=gate.status,
        disposition=_STATUS_TO_DISPOSITION.get(gate.status),
        trust=trust,
        ci_result=ci,
        trust_basis=TRUST_BASIS,
        outcome_resolved=outcome.resolved,
        outcome_hit_rate=outcome.hit_rate,
        outcome_pending=outcome.pending,
        outcome_lower_bound=round(outcome.lower_bound, 4),
        outcome_regret=outcome.regret,
    )
