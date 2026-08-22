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
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.gate import Gate, set_gate_evidence_status, set_gate_status
from app.models.participation import ParticipationRole
from app.services.gate_resolver import (
    SOURCE_MEMBER_OVERRIDE,
    SOURCE_ORG_OVERRIDE,
    SOURCE_ORG_POLICY,
    resolve_disposition,
)
from app.services.gate_service import (
    create_gate,
    find_gate_slot_with_pr_fallback,
    resolve_work_item_project_id,
)
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


async def _is_meaningfully_explicit_ask(
    session: AsyncSession, org_id: uuid.UUID, source: str,
) -> bool:
    """SID 301ee45d/#2047 PO 리뷰(2026-07-20): resolve_disposition의 ``source``는 "어느
    precedence 단계에서 나왔나"(출처)만 말하지 "그 값을 실제로 골랐나"(값)는 말하지 않는다.
    ``member_gate_override``/``org_gate_override``는 gate_type 단위로 콕 집어 만든 행이라
    존재 자체가 의사표시지만, ``org_gate_policy.posture``는 ``PUT /gate-config/policy``에
    본문을 `{}`로 보내도 pydantic 기본값 "balanced"가 그대로 저장되고(``OrgGatePolicyCreate.
    posture: str = "balanced"``) balanced→ask로 매핑된다 — 조직이 아무 말도 안 했는데 "명시
    ask"로 오판해 원 버그와 같은 계열의 함정에 빠진다. ``balanced``/``permissive``는 아무도
    의도 없이도 얻는 값이라 명시로 인정하지 않고, 아무도 기본으로 얻지 않는 ``conservative``만
    명시로 인정한다."""
    if source in (SOURCE_MEMBER_OVERRIDE, SOURCE_ORG_OVERRIDE):
        return True
    if source == SOURCE_ORG_POLICY:
        from app.models.hitl_config import OrgGatePolicy

        r = await session.execute(
            select(OrgGatePolicy.posture).where(OrgGatePolicy.org_id == org_id).limit(1)
        )
        return r.scalar_one_or_none() == "conservative"
    return False


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
    # 기본 안전 — 자동 조건(gate_status==auto_passed·ci==pass·pr==pass·lower_bound>=threshold)
    # 중 실제로 미충족된 항목만 정확히 명시(#1388: 이전엔 항상 lower_bound 미달로 표시돼 pr==fail
    # 등 다른 실제 사유를 오분류했다). 동시에 여러 조건이 미충족일 수 있어 전부 열거한다(단일 사유로
    # 단순화 금지 — 그러면 미달로 표시 안 된 나머지 조건에서 동일한 부정확 문제가 재발한다).
    unmet: list[str] = []
    if gate_status != "auto_passed":
        unmet.append(f"policy disposition!=allow_auto (gate_status={gate_status})")
    if ci != "pass":
        unmet.append(f"CI!=pass (ci={ci})")
    if pr != "pass":
        unmet.append(f"PR!=pass (pr={pr})")
    if outcome.lower_bound < threshold:
        unmet.append(f"outcome lower_bound {outcome.lower_bound:.2f}<{threshold}")
    return ASK_HUMAN, (
        f"auto-merge conditions unmet ({', '.join(unmet)}, basis={TRUST_BASIS})"
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
    head_sha: str | None = None,
) -> MergeGateDecision:
    """story 머지 게이트를 평가해 decision(auto_merge|ask_human|block)을 산출한다.

    Cage 재사용: capture_pr_ci_verdict(독립 verdict 기록) + compute_member_trust_scores(trust) +
    create_gate(정책 disposition 아티팩트·AC⑥). 모든 평가는 gate row를 남긴다.

    ``head_sha``(story #2813, 카디르 R2 CRITICAL·R3 HIGH) — 이 평가의 **실 판정이
    `_decide()`==AUTO_MERGE**일 때만(아래 §4) `gate.approved_head_sha`를 이 값으로 즉시
    확定한다. ⛔`gate.status=="auto_passed"`(정책 disposition 축) 시점에 찍으면 안 된다 —
    status="auto_passed"이면서 CI 미완/trust 표본 부족으로 실판정은 ASK_HUMAN인 게이트가
    실재한다(카디르 QA PR#2902②·#2156이 이미 고정한 두 축 구분). 사람 승인(gates.py
    transition_gate_endpoint)이 승인 트랜잭션에서 anchor를 즉시 박는 것과 동일한 불변식 —
    "success를 받을 수 있는 SHA는 anchor 단 하나"가 approved/AUTO_MERGE 둘 다에서 성립해야
    publish_gate_check의 anchor 검증이 의미가 있다. 호출자가 head_sha를 모르면(board
    preflight/report-done처럼 웹훅 컨텍스트가 없는 경로) None — anchor 없음(fail-closed, publish
    가 success 발행을 skip)."""
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
    # 게이트는 **실 신호(CI 결과 · 연결 PR · 명시 deny 정책 · 명시 ask 정책)**가 있을 때만 만든다.
    # CI/PR 증거가 둘 다 없을 때만 정책을 확인하고, deny도 아니고 명시 ask도 아니면(=시스템 기본
    # ask거나 allow_auto) 사람이 판단할 게 없는 빈 shell이 되므로 **게이트를 만들지 않는다**(no-gate·
    # row 0·done 통과). 실 CI 증거는 GitHub 앱(S5)이 native 당김. 3 트리거(board preflight·
    # report-done·line-engine) 모두 이 단일 chokepoint를 거쳐 일관 적용. (증거 있으면
    # resolve_disposition 호출조차 생략.)
    #
    # SID 301ee45d/#2047(선생님 지시 2026-07-20 — P0): resolve_disposition이 이제 (disposition,
    # source)를 돌려준다. 과거엔 'ask'가 SYSTEM_DEFAULT든 조직이 명시 설정했든 구분 없이 여기서
    # no-gate로 우회됐다 — "코드가 아닌 일(콘텐츠·마케팅 등, PR/CI 자체가 없는 작업)에는 조직이
    # '반드시 사람이 서명'이라고 ask를 명시해도 사람 결재가 원리적으로 안 걸리는" 결함이었다(댄
    # 어윈 실측 반증). ⚠️PO 리뷰: source가 SYSTEM_DEFAULT가 아니라는 것만으로는 부족하다 —
    # org_gate_policy.posture는 PUT 본문을 비워도 pydantic 기본값("balanced")이 저장돼 "출처는
    # org_policy(명시 행 있음)이지만 값은 아무도 안 고른 기본값"인 경우가 생긴다. 그래서
    # `_is_meaningfully_explicit_ask()`가 출처(source)와 별개로 **값 자체가 골라졌는지**까지
    # 판정한다 — member/org override는 gate_type 단위로 콕 집은 행이라 존재=의사표시지만,
    # org_policy는 posture=='conservative'(아무도 기본으로 얻지 않는 값)일 때만 명시로 인정한다.
    # **설정 안 한 조직(SYSTEM_DEFAULT) + balanced/permissive posture는 지금과 동일하게 게이트가
    # 안 생긴다** — 빈 shell 박멸 의도는 그대로 보존.
    if ci is None and pr_number <= 0:
        disposition, disposition_source = await resolve_disposition(
            session, org_id, member_id, role_id, MERGE_GATE_TYPE
        )
        explicit_ask = disposition == "ask" and await _is_meaningfully_explicit_ask(
            session, org_id, disposition_source
        )
        if disposition != "deny" and not explicit_ask:
            logger.info(
                "merge gate: no substance (ci=None pr_number=0 disposition=%s source=%s) story=%s "
                "— gate not materialized (no-gate)",
                disposition, disposition_source, story_id,
            )
            return MergeGateDecision(
                decision=AUTO_MERGE,
                reason="no-substance: no CI/PR evidence and policy is not deny/explicit-ask — gate not materialized",
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
    facts = {
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
    }
    # story #1968: 이 함수는 story_id(uuid)만 갖고 Story 객체를 로드하지 않으므로(participation/
    # verdict/trust 경로 전부 story_id만 소비) resolve_work_item_project_id()로 신규 조회.
    project_id = await resolve_work_item_project_id(session, org_id, "story", story_id)
    # story #2893(설계안 §2 A1) — pr_number<=0(no-substance/board-preflight, PR 컨텍스트
    # 자체가 없음)은 DB에 0을 지어내지 않고 NULL로 정직하게 유지. 0271의 부분 유니크
    # 인덱스가 NULL 구간=옛 "스토리+gate_type당 1행" 계약을 그대로 지킨다.
    db_pr_number = pr_number if pr_number > 0 else None
    # story #2932(HIGH1) — pr_number와 짝으로 repo도 정직하게: 빈 문자열("", no-substance
    # self-report shell의 관례값)은 "모름"이지 실 repo가 아니므로 None으로 정규화.
    db_repo_full_name = repo or None
    # story #2118(E-DG-REAL ②): create_gate()가 이미 pending인 기존 gate를 멱등 반환할 때(예:
    # report-done/board-preflight가 이 함수를 반복 호출)마다 승인요청 카드를 중복 배달하지 않으려면
    # "이 호출에서 방금 pending이 됐는지"(신규 생성 또는 rejected/voided→재오픈)를 알아야 한다 —
    # create_gate()는 그 신호를 반환하지 않으므로(반환형 변경은 8개 호출부 전체에 영향, 스코프 밖)
    # 호출 *전* 상태를 가볍게 먼저 조회해 비교한다(create_gate 내부의 멱등 조회와 동형 SELECT).
    # story #2893 — pr_number를 키에 편입(0271): 안 넣으면 "이 PR의 게이트가 방금
    # pending이 됐는지"가 아니라 "같은 스토리 다른 PR의 상태"를 잘못 비교해 카드
    # 배달 판정이 어긋난다(그 PR 실사고류와 동일 클래스). 카디르 QA(PR#3349 CI 실패①,
    # 2026-08-22) — 정확매치 only는 이 바로 아래 create_gate() 호출이 찾을 행(NULL-슬롯
    # 승격 포함)과 다른 답을 낼 수 있어 fallback 헬퍼로 통일한다(같은 물음엔 같은 답).
    _prior_gate = await find_gate_slot_with_pr_fallback(
        session, org_id=org_id, work_item_id=story_id, work_item_type="story",
        gate_type=MERGE_GATE_TYPE, pr_number=db_pr_number, repo_full_name=db_repo_full_name,
    )
    _prior_status = _prior_gate.status if _prior_gate is not None else None
    gate = await create_gate(
        session,
        org_id,
        story_id,
        "story",
        MERGE_GATE_TYPE,
        member_id,
        role_id,
        project_id=project_id,
        neutral_facts=facts,
        pr_number=db_pr_number,
        repo_full_name=db_repo_full_name,
    )

    # 재제출 re-open(doc-gate 48f064e5 선례 이식): uq(work_item,gate_type)=1행 + terminal=immutable
    # → create_gate 멱등이 rejected/voided gate 를 그대로 반환하면 아래 _decide 가 deny BLOCK 을
    # 영구 반환한다(void/override 는 pending 전용이라 API 복구 경로 0 — reject→수정→재제출 불가).
    # 재제출=새 결재 사이클: 이전 결재를 decision_history 로 보존(감사)하고 pending re-open + 새
    # 평가 facts 로 갱신. approved 는 landed 작업이라 유지(기존 결재 무효화 금지). resolver 해소
    # 필드는 transition_gate 가 재해소 시 다시 채운다.
    if gate.status in ("rejected", "voided"):
        prior = {
            "status": gate.status,
            "resolver_id": str(gate.resolver_id) if gate.resolver_id else None,
            "resolved_at": gate.resolved_at.isoformat() if gate.resolved_at else None,
            "resolution_note": gate.resolution_note,
        }
        reopened_facts = dict(facts)
        reopened_facts["decision_history"] = [
            *((gate.neutral_facts or {}).get("decision_history") or []),
            prior,
        ]
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.resolver_id = None
        gate.resolved_at = None
        gate.resolution_note = None
        gate.neutral_facts = reopened_facts  # JSONB in-place 변경 미감지 — 재할당.
        await session.flush()
        logger.info(
            "merge gate re-opened on resubmit story=%s gate=%s prior=%s",
            story_id, gate.id, prior["status"],
        )

    # story #2118(E-DG-REAL ②) — doc.py의 dispatch_approval_request_cards(#2604) 패턴을 merge
    # gate까지 확장: 이 호출에서 gate가 «방금» pending이 된 경우만(_prior_status와 비교, 위 주석
    # 참조) 승인자별 1:1 DM에 카드를 배달한다. 승인 자격자 = project owner/admin(project_id
    # 해소 실패 시 org owner/admin — project_auth.list_gate_approver_ids, gates.py
    # _non_doc_gate_approvable과 동일 규칙). 카드 배달 자체는 best-effort(project_auth 조회
    # 실패가 게이트 생성/decision을 막지 않음) — doc.py와 동일 관례.
    if gate.status == "pending" and _prior_status != "pending":
        try:
            from app.models.pm import Story
            from app.services.approval_delivery import dispatch_approval_request_cards
            from app.services.project_auth import list_gate_approver_ids

            story_title = (await session.execute(
                select(Story.title).where(Story.id == story_id, Story.org_id == org_id)
            )).scalar_one_or_none() or f"#{str(story_id)[:8]}"
            approver_ids = await list_gate_approver_ids(
                session, org_id, project_id, exclude_id=member_id,
            )
            await dispatch_approval_request_cards(
                session, org_id=org_id, work_item_type="story", work_item_id=story_id,
                project_id=project_id, title=story_title, gate_id=gate.id,
                requester_id=member_id, approver_ids=approver_ids,
            )
        except Exception:  # noqa: BLE001 — 카드 배달 실패는 게이트 생성/decision을 막지 않음.
            logger.warning(
                "merge gate 승인요청 카드 배달 실패 story=%s gate=%s", story_id, gate.id, exc_info=True,
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
    set_gate_evidence_status(gate, _evidence_status(decision), now=datetime.now(timezone.utc))
    gate.decision_basis = reason
    gate.auto_decision_reason = decision

    # story #2813(카디르 R3 HIGH) — anchor는 **실 판정이 AUTO_MERGE일 때만** 확定한다.
    # ⛔최초 fix는 `gate.status == "auto_passed"`(정책 disposition 축) 시점에 찍었는데, 그건
    # `_decide()`의 실 증거 기반 verdict(이 axis)와 다른 필드다(카디르 QA PR#2902②·#2156이
    # 이미 고정한 구분 — status="auto_passed"이면서 CI 미완/trust 표본 부족으로 실판정은
    # ASK_HUMAN인 게이트가 실재한다). 그 상태에서 anchor를 찍으면 "사람이 봐야 하는" SHA에도
    # success가 나갈 수 있었다 — AUTO_MERGE로 옮기면 그런 상태는 anchor가 안 생겨
    # publish_gate_check의 불변식이 자연히 success를 막는다(fail-closed 정합).
    # story #2813(카디르 R4①) — 같은 SHA 재평가로 decision이 AUTO_MERGE에서 이탈하면(CI
    # 재실패·trust 하락 등) 이전 auto-pass anchor는 더 이상 유효하지 않다 — 지운다.
    # ⚠️스코프: `gate.status=="auto_passed"`(정책이 여전히 allow_auto인 "자동 축")일 때만 —
    # 사람이 승인한 anchor(`gate.status=="approved"`, gates.py `transition_gate_endpoint`가
    # 세팅)는 이 시스템 재평가가 **절대 못 건드린다**(건드리면 사람 결재를 시스템이 역전시키는
    # 사고). head_sha를 모르는 호출자의 AUTO_MERGE 재확認은 기존 anchor를 그대로 둔다(새로
    # 세우지도 지우지도 않음 — "모른다"는 "무효"가 아니다).
    if decision == AUTO_MERGE:
        if head_sha:
            gate.approved_head_sha = head_sha
            # story #2932 완주조건 HIGH2(4라운드) — AUTO_MERGE도 writer 3곳 중 하나(순환
            # import 회피 위해 함수-로컬 import — gate_github_check.py가 이 모듈의
            # MERGE_GATE_TYPE을 이미 module-level로 가져다 쓴다).
            from app.services.gate_github_check import seed_pr_head_watermark
            seed_pr_head_watermark(gate)
    elif gate.status == "auto_passed" and gate.approved_head_sha:
        logger.info(
            "gate=%s: 재평가로 decision이 AUTO_MERGE 이탈(%s) — auto-axis anchor(%s) 무효화",
            gate.id, decision, gate.approved_head_sha,
        )
        gate.approved_head_sha = None
        # story #2853(AC②, PO 확定 2026-08-20) — anchor-clear의 진실한 의미는 "증거가
        # AUTO_MERGE를 더는 지지하지 않는다"이지 "누가 거부했다"가 아니다. status="rejected"는
        # 사람 어휘를 시스템이 쓰는 것이라 reconcile의 자기 필터(위 status IN (pending,
        # auto_passed))를 우연 상속해 이 gate를 미래 재평가에서 영구 제외시킨다. status=
        # "auto_passed" 방치는 보드가 거짓을 말하는 것(증거 무너졌는데 통과 표시). →
        # reopen_gate_if_new_sha(새 SHA 재-pending)와 동일 의미론의 "같은 SHA·증거 회귀" 판으로
        # pending 재전이. publish_gate_check()의 기존 pending 발행 경로가 그대로 태워진다
        # (gh_status="in_progress" — 새 Checks-API 코드 0).
        #
        # ⚠️AC③(PO 확定 — 처음엔 "self-healing 유지"라 썼다가 디디 실측으로 철회) — **자동
        # 복귀는 없다.** create_gate()(gate_service.py)의 멱등 반환(`existing.status !=
        # "rejected"`면 그대로 반환·disposition 재확認 0)이 이 시스템의 구조적 불변식이다 —
        # gate.status가 일단 "pending"이 되면(신규 생성이든 이 재전이든) org policy가 여전히
        # allow_auto여도 다음 reconcile이 `_decide(gate_status="pending", ...)`를 볼 뿐
        # `_decide()`의 AUTO_MERGE 조건(gate_status=="auto_passed")엔 다시 못 닿는다(probe
        # 실측 확認, 2026-08-20). 즉 CI가 나중에 회복돼도 이 gate는 auto-axis로 자동 복귀
        # 안 하고 — 결재함에 pending으로 재노출되니 **사람이 다시 승인**하는 게 재개 경로다
        # (rejected보다 pending을 고른 이유는 여전히 유효: 사람 어휘 비오염+결재함 재노출·
        # reconcile이 계속 "본다"는 점만 다르지 자동 재승격 여부는 rejected와 동일하게 없음).
        gate.status = "pending"

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


async def reconcile_merge_gate_with_real_evidence(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    *,
    pr_number: int,
    repo: str,
    ci_result: str | None,
    merged: bool,
    head_sha: str | None = None,
) -> MergeGateDecision | None:
    """story #2156 AC2(2026-08-07) — GitHub 웹훅이 잡은 실 CI/PR verdict를 merge-type
    게이트에 반영한다.

    그라운딩(디디, 2026-08-07 라이브 DB 조회): SID/#번호 해소(story #2327, 07-30)는 이미
    완결이라 `Verdict`엔 실 증거가 정확히 쌓이는데(dev 118건 ci/pr pass 확認), `resolve_
    gate_from_verdict`의 `_SOURCE_TO_GATE_TYPE`엔 ci/pr→pr_review 매핑만 있고 **merge는
    없다** — 그래서 그 증거가 done 전이를 막는 merge-type 게이트엔 한 번도 안 닿았다
    (`_preflight_merge_gate`/board-done 경로는 컨텍스트가 없어 ci_result=None으로만 게이트를
    만드니 매번 "CI unknown (self-report only)"로 굳는 게 근본).

    pending 또는 auto_passed인 merge-type 게이트가 있을 때만 `evaluate_merge_gate`를 실
    증거로 재호출 — 새 판정 로직 0개, 기존 `_decide()`/trust/outcome을 그대로 재사용한다.
    story가 이미 board-done으로 먼저 넘어가 있어도 이 재평가는 gate row(audit) 갱신만 하고
    story.status는 건드리지 않는다 — advisory(관측)/enforcing(집행) 축과 분리(그건 선생님
    판단 축).

    ⭐카디르 QA(PR#2902, 2026-08-07)②: `status` 축(정책 disposition)과 `requires_human` 축
    (증거 기반 decision)이 서로 다른 필드다 — `create_gate` 시점 `status="auto_passed"`(정책이
    allow_auto)였어도 이후 `evaluate_merge_gate`가 self-report(ci=None) 등으로 재평가하며
    `requires_human=True`(decision=ask_human)를 남겼을 수 있다. `status=="pending"`만 보면
    이런 "auto_passed인데 실은 사람이 봐야 하는" 게이트를 놓친다 — `status IN
    (pending, auto_passed)`로 넓힌다. `rejected`/`voided`/`held`는 의도적으로 제외한다(사람이
    이미 명시 결정했거나 일시정지한 것을 CI 이벤트로 조용히 재오픈/간섭하면 안 된다 —
    `create_gate`의 rejected 멱등 재오픈 분기가 웹훅 이벤트로 우발 트리거되는 것을 막는다).

    ⚠️호출 위치 주의 — `evaluate_merge_gate` 자신이 내부에서 `capture_pr_ci_verdict`를 이미
    부른다. 이 함수를 `capture_pr_ci_verdict` 본문 안에서 부르면 무한 재귀가 된다 — 반드시
    그 호출부(웹훅 핸들러 등) 쪽에서, `capture_pr_ci_verdict` 리턴 後에 별도로 부를 것.
    """
    # story #2893(설계안 §2 A1) — pr_number를 키에 편입: 안 넣으면 "이 웹훅이 나른 PR B의
    # CI/merge 증거"로 story의 아무 pending/auto_passed 게이트(실은 PR A 것일 수 있음)를
    # 재평가해버린다 — 실사고1/2와 정확히 같은 클래스(엉뚱한 PR의 SHA/증거가 다른 PR의
    # 게이트에 새는 것).
    # 카디르 QA(PR#3349 CI 실패②, 2026-08-22) — 정확매치 only 조회는 line-engine/board-
    # preflight self-report shell(pr_number 모름, NULL로 생성)이 나중에 실 PR로 reconcile
    # 되는 정상 경로를 놓친다(gate_service.find_gate_slot_with_pr_fallback 참조).
    existing = await find_gate_slot_with_pr_fallback(
        session, org_id=org_id, work_item_id=story_id, work_item_type="story",
        gate_type=MERGE_GATE_TYPE, pr_number=(pr_number if pr_number > 0 else None),
        repo_full_name=(repo or None),
    )
    if existing is None or existing.status not in ("pending", "auto_passed"):
        return None
    return await evaluate_merge_gate(
        session, org_id, story_id,
        pr_number=pr_number, repo=repo, ci_result=ci_result,
        pr_result=("pass" if merged else None),
        head_sha=head_sha,
    )


async def trigger_gate_creation_for_late_participation(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID,
) -> None:
    """story #2893 후속(카디르 4라운드 verdict, PR#3357 qa:changes) — 순서 조합 갭: PR
    opened(참여 無)→라벨정렬(웹훅 트리거는 실행되나 evaluate_merge_gate가 "no implementation
    participation"으로 gate_id=None 즉시반환)→참여등록(재평가 훅 0)→이후 웹훅 이벤트 없음
    → **게이트 row가 영구 미생성**된다(2893 원 증상 — close/reopen 강제 그대로 재현. B3
    재평가 API도 gate id가 없어 호출 불가하므로 이 순서에선 탈출구가 없었다).

    참여 생성 공유 chokepoint(`ensure_implementation_participation`— assignee 자동참여·
    story claim 양쪽이 공유·`add_participation` 라우터의 직접 생성) 양쪽에서 이 훅을 불러,
    지금 story에 연결된 PR마다 게이트가 아직 없으면 즉시 만든다(B3의 원격 GitHub 조회
    조합을 그대로 재사용 — get_pull_request로 현재 head SHA/merged를, fetch_status_check_
    rollup으로 CI를 읽어 evaluate_merge_gate 재호출. 새 규칙 발명 0).

    ⚠️호출자의 세션을 그대로 받는다(별도 세션 아님) — 방금 `flush`된(아직 커밋 前) participation
    행을 evaluate_merge_gate가 같은 트랜잭션 안에서 즉시 봐야 하기 때문(실측: 별도 세션으로
    분리했더니 그 세션엔 아직 안 보이는 미커밋 행 탓에 "no implementation participation"으로
    재실패 — read-your-own-write가 세션 경계를 못 넘는다). 대신 **세션 오염은 SAVEPOINT로
    막는다**(카디르 QA②) — 링크마다 `session.begin_nested()`로 감싸, 그 PR의 DB 예외가
    SAVEPOINT까지만 롤백되고 호출자의 participation flush·다른 링크의 처리·최종 commit에는
    전혀 새지 않는다.

    카디르 QA(PR#3357 재재verdict, 2026-08-22) 3건 하드닝:
    ①**link별 예외 격리** — 하나의 PR 처리 실패가 나머지 PR을 막으면 안 된다(전체를 감싸던
    단일 try를 per-link try로 분리).
    ②**세션 오염 차단** — 위 SAVEPOINT 격리(개별 세션이 아니라 개별 SAVEPOINT — 이유는
    docstring 서두 참조).
    ③**soft-delete 필터** — `resolve_pr_link`(canonical reader)와 동일하게
    `deleted_at IS NULL`만 조회한다 — 없으면 사용자가 명시로 끊은 연결(explicit unlink)이
    이 훅으로 되살아나는 의미 결함이었다.

    best-effort — 어느 PR이 실패해도 다른 PR·호출자의 참여 등록 자체를 절대 막지 않는다.
    링크된 PR이 없거나(board-preflight 전용 story 등) GitHub installation이 없으면 조용히
    no-op(fail-closed: 외부 신호를 지어내지 않는다)."""
    from app.models.github_installation import GithubInstallation
    from app.models.pull_request_story_link import PullRequestStoryLink
    from app.services.github_app import get_installation_token, get_pull_request
    from app.services.verdict_capture import fetch_status_check_rollup

    try:
        links = (
            await session.execute(
                select(PullRequestStoryLink).where(
                    PullRequestStoryLink.org_id == org_id,
                    PullRequestStoryLink.story_id == story_id,
                    PullRequestStoryLink.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        if not links:
            return
        installation = (
            await session.execute(
                select(GithubInstallation).where(
                    GithubInstallation.org_id == org_id, GithubInstallation.suspended_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if installation is None:
            return
        installation_id = installation.installation_id
    except Exception:  # noqa: BLE001 — best-effort: 준비 단계 실패도 참여 등록을 안 막는다.
        logger.warning(
            "story=%s: 참여등록 후 게이트 생성 재시도 준비 단계 실패(best-effort)",
            story_id, exc_info=True,
        )
        return

    for link in links:
        try:
            async with session.begin_nested():  # SAVEPOINT — 이 링크만 롤백, 호출자 트랜잭션은 무영향.
                existing = await find_gate_slot_with_pr_fallback(
                    session, org_id=org_id, work_item_id=story_id, work_item_type="story",
                    gate_type=MERGE_GATE_TYPE, pr_number=link.pr_number,
                    repo_full_name=link.repo_full_name,
                )
                if existing is not None:
                    continue  # 이미 게이트가 있음 — 이 훅이 고치려는 갭이 아니다.
                token = await get_installation_token(installation_id)
                if not token:
                    continue
                pr = await get_pull_request(installation_id, link.repo_full_name, link.pr_number)
                if pr is None:
                    continue
                head_sha = (pr.get("head") or {}).get("sha")
                if not head_sha:
                    continue
                ci_result, _reason = await fetch_status_check_rollup(link.repo_full_name, head_sha, token)
                await evaluate_merge_gate(
                    session, org_id, story_id,
                    pr_number=link.pr_number, repo=link.repo_full_name,
                    ci_result=ci_result, head_sha=head_sha,
                )
        except Exception:  # noqa: BLE001 — 이 링크만 실패 처리(SAVEPOINT 롤백), 다른 링크·호출자 세션엔 무영향.
            logger.warning(
                "story=%s pr=%s: 참여등록 후 게이트 생성 재시도 실패(best-effort, 다른 PR·참여 등록 자체엔 무영향)",
                story_id, link.pr_number, exc_info=True,
            )
