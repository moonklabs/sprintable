"""E-SPRINT-LOOP dc861e44: retro §5 계약 — hypotheses[] 평탄화 + L2 종합 + L3 다음가설.

design-first crux 반영(2026-07-03): synthesis/next_hypotheses는 on-demand·overwrite
저장(retro_sessions nullable JSONB — repository.update()가 그대로 처리, 이 모듈은
호출부가 저장할 dict/list를 만들어주기만 한다). LLM은 `llm_client.generate_text_claude`
(graceful: 인증불가/오류 시 None) + JSON 출력 지시 + 파싱 실패 시 graceful fallback —
S15(`hypothesis._draft_statement`)의 "LLM 실패해도 완전 실패 없음" 철학을 미러한다.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retro import RetroItem, RetroSession

logger = logging.getLogger(__name__)

_TOP_ITEMS_LIMIT = 8
_DEFAULT_MEASURE_DAYS = 14
_MAX_NEXT_HYPOTHESES = 3

_SOUL_LOCK_INSTRUCTION = (
    "반증된(falsified) 가설이나 부정적 회고 항목은 실패로 서술하지 마라 — "
    '"~을 확인했다", "~이 아님을 배웠다"처럼 학습 데이터로 서술하라. '
    '"실패했다"·"안 됐다" 같은 표현은 금지한다.'
)

_SYNTHESIS_INSTRUCTION = (
    "다음은 한 스프린트의 가설 검증 결과와 팀 회고 상위 의견이다. 이 정보만 근거로 "
    '"이번 스프린트에서 배운 것"을 2~4개의 불릿으로 한국어로 종합하라. 각 불릿은 반드시 '
    "근거(가설 statement 또는 회고 아이템 내용)를 함께 명시하라. " + _SOUL_LOCK_INSTRUCTION +
    " 맥락에 없는 사실/숫자를 지어내지 마라. 출력은 반드시 아래 JSON 배열 형식만 — "
    '다른 텍스트 절대 추가하지 마라:\n[{"text": "...", "source": "..."}]'
)

_NEXT_HYPOTHESES_INSTRUCTION = (
    "다음은 한 스프린트 회고의 종합(무엇을 배웠는지)이다. 이 종합만 근거로 다음 스프린트에서 "
    f"검증할 만한 가설 후보를 최대 {_MAX_NEXT_HYPOTHESES}개, 각각 " '"~할 것이다" 형태의 '
    "제안형 한국어 문장으로 작성하라. 각 후보에는 반드시 근거(종합의 어느 부분에서 나왔는지)를 "
    "rationale로 함께 제시하고, confidence(0.0~1.0, 확신도를 정직하게)를 매겨라. " +
    _SOUL_LOCK_INSTRUCTION + " 맥락에 없는 사실을 지어내지 마라. 출력은 반드시 아래 JSON "
    '배열 형식만 — 다른 텍스트 절대 추가하지 마라:\n'
    '[{"statement": "...", "rationale": "...", "confidence": 0.0}]'
)


def _extract_json(raw: str) -> Any | None:
    """LLM 출력이 ```json 코드펜스로 감싸져 오는 경우가 흔해 벗겨내고 파싱 시도."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text[:4].lower() == "json":
            text = text[4:]
        text = text.strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


async def build_hypotheses_items(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, sprint_id: uuid.UUID | None
) -> list[dict[str, Any]]:
    """§5 hypotheses[] — story 1의 sprint_id 필터 재사용(신규 쿼리 로직 없음). sprint 미연결
    회고는 빈 배열(N=0 graceful)."""
    if sprint_id is None:
        return []
    from app.services import hypothesis as hyp_svc

    hyps = await hyp_svc.list_hypotheses(session, org_id, project_id, sprint_id=sprint_id, limit=200)
    items: list[dict[str, Any]] = []
    for h in hyps:
        md = h.metric_definition or {}
        actual = (h.outcome_result or {}).get("actual") if h.outcome_result else None
        items.append({
            "id": h.id,
            "statement": h.statement,
            "status": h.status,
            "metric": md.get("metric"),
            "target": md.get("target"),
            "direction": md.get("direction"),
            "actual": actual,
            "href": f"/hypotheses/{h.id}",
        })
    return items


async def _top_voted_item_texts(session: AsyncSession, session_id: uuid.UUID) -> list[str]:
    from sqlalchemy import select

    rows = (await session.execute(
        select(RetroItem)
        .where(RetroItem.session_id == session_id, RetroItem.parent_item_id.is_(None))
        .order_by(RetroItem.vote_count.desc(), RetroItem.created_at.desc())
        .limit(_TOP_ITEMS_LIMIT)
    )).scalars().all()
    return [f"[{i.category}] {i.text} ({i.vote_count}표)" for i in rows]


def _build_synthesis_prompt(
    hypotheses_items: list[dict[str, Any]], item_texts: list[str]
) -> str | None:
    """S15와 동형 원칙 — 근거(가설·투표 아이템) 전무면 None(지어내라고 시키지 않음)."""
    if not hypotheses_items and not item_texts:
        return None
    lines = [_SYNTHESIS_INSTRUCTION, ""]
    if hypotheses_items:
        lines.append("가설 결과:")
        for h in hypotheses_items:
            actual_part = f" (실측 {h['actual']})" if h.get("actual") is not None else ""
            lines.append(f"- {h['statement']} — {h['status']}{actual_part}")
    if item_texts:
        lines.append("")
        lines.append("회고 상위 의견:")
        lines.extend(f"- {t}" for t in item_texts)
    return "\n".join(lines)


async def synthesize(session: AsyncSession, retro: RetroSession) -> dict[str, Any] | None:
    """L2 종합 생성 — 저장은 호출부(router)가 repo.update()로 overwrite.

    반환 None = **생성 실패**(호출부는 절대 저장하면 안 됨 — 기존 good 캐시가 있다면 그대로
    보존해야 함, PO 지적 2026-07-02 S28 캐시게이트 버그와 동형: "일시장애≠영구 no-result").
    구분: 근거(가설·투표 아이템) 전무는 **정당한 빈 결과**(learned=[])이지 실패가 아니다 —
    LLM을 아예 호출 안 하고 그대로 반환. 반면 호출까지 갔는데 응답이 없으면(None/빈 문자열/
    예외) 진짜 실패로 취급해 None 반환 — 조용히 learned=[]를 반환해 기존 캐시를 지우지 않는다."""
    from app.services.llm_client import generate_text_claude

    hypotheses_items = await build_hypotheses_items(
        session, retro.org_id, retro.project_id, retro.sprint_id
    )
    item_texts = await _top_voted_item_texts(session, retro.id)
    prompt = _build_synthesis_prompt(hypotheses_items, item_texts)
    now = datetime.now(timezone.utc)

    if prompt is None:
        return {"learned": [], "generated_at": now.isoformat(), "source": "ai_draft"}

    raw = None
    try:
        raw = generate_text_claude(prompt, reasoning="disabled")
    except Exception as exc:  # noqa: BLE001 — 예외도 "실패"로 수렴(None), 여기서 삼키지 않음.
        logger.warning("retro synthesize: LLM 호출 실패: %s", exc)

    if not raw:
        return None  # 근거는 있었는데 LLM이 실패 — 기존 캐시 보존(호출부 502·미저장).

    learned: list[dict[str, str]] = []
    parsed = _extract_json(raw)
    if isinstance(parsed, list):
        learned = [
            {"text": str(x["text"]), "source": str(x.get("source", ""))}
            for x in parsed
            if isinstance(x, dict) and isinstance(x.get("text"), str) and x["text"].strip()
        ]
    if not learned:
        # JSON 파싱 실패/스키마 불일치 — raw 자체는 실 LLM 응답(완전 실패 아님)이라 원문을
        # 단일 bullet로 래핑해 구제(S15 fallback 철학). "raw가 아예 없음"과는 다른 케이스.
        learned = [{"text": raw.strip()[:500], "source": "generated"}]

    return {"learned": learned, "generated_at": now.isoformat(), "source": "ai_draft"}


def _build_next_hypotheses_prompt(synthesis: dict[str, Any]) -> str | None:
    learned = synthesis.get("learned") or []
    if not learned:
        return None
    lines = [_NEXT_HYPOTHESES_INSTRUCTION, "", "종합:"]
    lines.extend(f"- {item.get('text', '')}" for item in learned if isinstance(item, dict))
    return "\n".join(lines)


async def recommend_next(synthesis: dict[str, Any]) -> list[dict[str, Any]] | None:
    """L3 다음가설 추천 — synthesis(§5 계약 dict, 이미 non-null임을 라우터가 보장) 기반.
    metric_definition/measure_after는 S15 draft_hypothesis와 동형으로 고정 템플릿(LLM이
    구조화 수치를 지어내지 않게) — statement/rationale/confidence만 LLM 생성.

    반환 None = **생성 실패**(호출부 미저장 — synthesize와 동일 원칙, 기존 good
    next_hypotheses 캐시를 빈 배열/garbage로 덮어쓰지 않는다). synthesis.learned가 애초에
    비어 있어 프롬프트 자체를 안 만든 경우만 정당한 빈 배열(LLM 미호출)."""
    from app.services.llm_client import generate_text_claude

    prompt = _build_next_hypotheses_prompt(synthesis)
    if prompt is None:
        return []

    raw = None
    try:
        raw = generate_text_claude(prompt, reasoning="disabled")
    except Exception as exc:  # noqa: BLE001
        logger.warning("retro recommend_next: LLM 호출 실패: %s", exc)
    if not raw:
        return None  # LLM 실패 — 기존 캐시 보존.

    parsed = _extract_json(raw)
    if not isinstance(parsed, list):
        return None  # 파싱 자체가 완전 실패(리스트가 아님) — synthesis처럼 원문 래핑 구제가
        # 불가(스키마상 statement 필수 필드라 텍스트 1줄로 대체 불가) → 명시 실패로 처리.

    measure_after = datetime.now(timezone.utc) + timedelta(days=_DEFAULT_MEASURE_DAYS)
    candidates: list[dict[str, Any]] = []
    for x in parsed[:_MAX_NEXT_HYPOTHESES]:
        if not isinstance(x, dict) or not isinstance(x.get("statement"), str) or not x["statement"].strip():
            continue
        confidence = x.get("confidence")
        candidates.append({
            "id": str(uuid.uuid4()),
            "statement": x["statement"].strip(),
            "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
            "measure_after": measure_after.isoformat(),
            "confidence": float(confidence) if isinstance(confidence, (int, float)) else None,
            "rationale": str(x.get("rationale", "")),
            "requires_confirmation": True,
        })
    if not candidates:
        # 응답은 JSON 배열이었지만 항목이 전부 스키마 불일치 — 사실상 생성 실패와 동급이라
        # 빈 배열을 "정답"으로 저장하지 않는다(기존 캐시 보존).
        return None
    return candidates
