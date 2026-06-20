"""E-DECISION-GATE S4: trust-routing resolver (우리 moat).

라인 라우팅 입력(routing_context) + outcome-trust snapshot 을 구성한다. ERP 는 금액으로 분기하지만
우리는 **검증된 신뢰(hypothesis outcome)** 로 분기하는 게 차별점이다. S4 는 context/snapshot
**생산 + shadow 관측 기록**까지이며, 실제 auto/ask/block enforcement 는 S5(gate 통합)다.

핵심 불변식:
- ⭐**cold-start ≠ 0점**: outcome 표본이 없으면 ``cold_start=True``·``hypothesis_hit_rate=None`` 으로
  내려보낸다. 0.0 으로 깔면 신규 멤버가 "신뢰 낮음"으로 오판돼 잘못 라우팅된다.
- ⭐**trust-before-capture**(P1-3 gaming 방어): trust 는 **이전 이력만** 본다. resolver 는 어떤
  verdict 도 session 에 add 하지 않으며, 엔진은 step_run insert *전에* trust 를 계산한다(autoflush 가
  pending row 를 trust 쿼리에 끌어들여 자기-부트스트랩하는 것 방지·merge_verdict_gate.py:254-260 동형).
- ⭐**risk 불확실 → safe default**: prod-touch 여부를 판정할 수 없으면 ``None``(False 로 추정 금지)·
  ``uncertain=True`` → ``suggested_default='ask_human'``. 단 S4 에서는 snapshot/decision material 로만
  남기고 board 전이는 막지 않는다(S3 fail-open 정합).
"""
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.services.trust_score import compute_member_trust_scores
from app.services.workflow_readiness_matrix import get_readiness, record_unsupported_entity_attempt

# story_points 가 이 이상이면 high-effort 신호(휴리스틱·S5 에서 정교화).
_HIGH_EFFORT_POINTS = 8


def _story_predicate(story: Story | None) -> dict[str, Any]:
    """라우팅 입력으로 쓰는 현 Story 모델 필드(pm.py:101-115)."""
    if story is None:
        return {}
    return {
        "priority": story.priority,
        "story_points": story.story_points,
        "has_success_hypothesis": bool(story.success_hypothesis),
        "has_metric_definition": story.metric_definition is not None,
        "has_measure_after": story.measure_after is not None,
        "outcome_status": story.outcome_status,
        "has_outcome_result": story.outcome_result is not None,
        "is_excluded": bool(getattr(story, "is_excluded", False)),
    }


def _risk_flags(story: Story | None) -> dict[str, Any]:
    """위험 신호. ⭐prod-touch 는 본 컨텍스트서 판정 불가 → None(False 추정 금지·AC⑤)."""
    sp = story.story_points if story is not None else None
    return {
        "prod_touch": None,                       # 불명 — False 로 추정하지 않는다
        "high_effort": sp is not None and sp >= _HIGH_EFFORT_POINTS,
        "story_points": sp,
        "uncertain": story is None or sp is None,  # 정보 부족 = 불확실 → safe default
    }


async def resolve_trust_snapshot(
    session: AsyncSession, org_id: uuid.UUID, member_id: uuid.UUID | None, role_key: str | None = None
) -> dict[str, Any]:
    """outcome-trust snapshot(이전 이력만·현 verdict 미포함). cold-start 는 None 으로 보존."""
    if member_id is None:
        return {
            "primary_source": "hypothesis_outcome", "cold_start": True, "reason": "no_member",
            "hypothesis_hit_rate": None, "resolved": 0, "hit": 0, "pending": 0,
            "captured_before_verdict": True,
        }
    # trust-before-capture: resolver 는 verdict 를 add 하지 않고 이력만 읽는다.
    result = await compute_member_trust_scores(session, org_id, member_id, role_key=role_key)
    resolved = int(result.get("resolved") or 0)
    return {
        "primary_source": result.get("primary_source"),        # hypothesis_outcome
        "hypothesis_hit_rate": result.get("hypothesis_hit_rate"),  # None if cold-start (⭐0점 금지)
        "resolved": resolved,
        "hit": int(result.get("hit") or 0),
        "pending": int(result.get("pending") or 0),
        "cold_start": resolved == 0,                            # ⭐AC④ outcome 표본 없음
        "role_key": role_key,
        "captured_before_verdict": True,                        # ⭐AC⑥ trust-before-capture marker
    }


async def resolve_routing_context(
    session: AsyncSession, org_id: uuid.UUID, *, entity_type: str, entity_id: uuid.UUID,
    actor_member_id: uuid.UUID | None = None, actor_type: str | None = None,
    role_key: str | None = None,
) -> dict[str, Any]:
    """라우팅 컨텍스트 = entity · story predicate · actor · risk_flags · trust.

    S21: gating_eligible 엔티티(현 story)만 full context 생산. 비-eligible(doc/hyp/epic/sprint)은
    readiness matrix 의 blocking_reason 으로 unsupported context 를 내려보내고 시도를 로그로 남긴다
    (no-op 이 silent 아닐 것·fail-open). story 경로는 거동 불변.
    """
    desc = get_readiness(entity_type)
    if desc is None or not desc.gating_eligible:
        record_unsupported_entity_attempt(entity_type, entity_id=entity_id)
        return {
            "entity_type": entity_type, "entity_id": str(entity_id),
            "supported": False,
            "reason": desc.blocking_reason if desc else "unknown_entity_type",
            "risk_flags": {"prod_touch": None, "uncertain": True},
            "trust": {"cold_start": True, "captured_before_verdict": True},
            "suggested_default": "ask_human",
        }
    # S23 LOW fix: story predicate 는 story 전용. 비-story eligible(hypothesis)은 Story 조회 안 함
    # (entity_id 로 Story get → None → entity_type 오기록 방지·observability 정합).
    story = await session.get(Story, entity_id) if entity_type == "story" else None
    risk_flags = _risk_flags(story)
    trust = await resolve_trust_snapshot(session, org_id, actor_member_id, role_key)
    # safe default: 위험 불확실 또는 cold-start → ask_human 제안(S4 는 표기만·비차단).
    suggested = "ask_human" if (risk_flags.get("uncertain") or trust.get("cold_start")) else None
    return {
        "entity_type": entity_type, "entity_id": str(entity_id), "supported": True,
        "story": _story_predicate(story),
        "actor": {
            "member_id": str(actor_member_id) if actor_member_id else None,
            "type": actor_type,
        },
        "risk_flags": risk_flags,
        "trust": trust,
        "suggested_default": suggested,
    }
