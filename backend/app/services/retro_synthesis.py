"""E-SPRINT-LOOP dc861e44: retro §5 계약 — hypotheses[] 평탄화 + L2 종합 + L3 다음가설.

design-first crux 반영(2026-07-03): synthesis/next_hypotheses는 on-demand·overwrite
저장(retro_sessions nullable JSONB — repository.update()가 그대로 처리, 이 모듈은
호출부가 저장할 dict/list를 만들어주기만 한다).

structured output(2026-07-03, 선생님/PO 지적·dev repro `84d63d5c` 실측): LLM 출력 형식은
프롬프트로 "JSON만 내라" 애원하는 밴드에이드가 아니라 `response_schema`로 구조적으로
강제한다 — 프리앰블/트레일링 프로즈를 붙이는 문제 자체가 스키마 레벨에서 소멸한다.
graceful 계약(data-loss 방지, #1863 RC)은 불변: 스키마가 유효 JSON을 보장해도
refusal/max_tokens/SDK 오류는 여전히 None(호출부 미저장·502).

Gemini 피벗(2026-07-03, 선생님/PO 지시): moonklabs org GCP credit이 Vertex Claude를
포함하지 않아 `generate_text_claude`(claude-sonnet-5)를 은퇴하고 `generate_text`
(Gemini, `response_json_schema`로 동일한 structured output 보장)로 전송 레이어만
교체 — 이 파일의 스키마(items-wrapping)·파싱·필터·#1863 원칙은 model-agnostic이라
전부 무변경(llm_client.py 참고)."""
from __future__ import annotations

import json
import logging
import math
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

# 출력 형식 지시("JSON만 내라")는 response_schema가 구조적으로 강제하므로 프롬프트에서
# 제거 — 프롬프트는 콘텐츠 규칙만 담당(관심사 분리, 밴드에이드 잔재 제거).
_SYNTHESIS_INSTRUCTION = (
    "다음은 한 스프린트의 가설 검증 결과와 팀 회고 상위 의견이다. 이 정보만 근거로 "
    '"이번 스프린트에서 배운 것"을 2~4개 항목으로 한국어로 종합하라. 각 항목은 반드시 '
    "근거(가설 statement 또는 회고 아이템 내용)를 함께 명시하라. " + _SOUL_LOCK_INSTRUCTION +
    " 맥락에 없는 사실/숫자를 지어내지 마라."
)

_NEXT_HYPOTHESES_INSTRUCTION = (
    "다음은 한 스프린트 회고의 종합(무엇을 배웠는지)이다. 이 종합만 근거로 다음 스프린트에서 "
    f"검증할 만한 가설 후보를 최대 {_MAX_NEXT_HYPOTHESES}개, 각각 " '"~할 것이다" 형태의 '
    "제안형 한국어 문장으로 작성하라. 각 후보에는 반드시 근거(종합의 어느 부분에서 나왔는지)를 "
    "rationale로 함께 제시하고, confidence(0.0~1.0, 확신도를 정직하게)를 매겨라. " +
    _SOUL_LOCK_INSTRUCTION + " 맥락에 없는 사실을 지어내지 마라."
)

# top-level은 object 권장(배열 직접 top-level 지양, PO 지시) — items 키로 배열을 감싼다.
_SYNTHESIS_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"text": {"type": "string"}, "source": {"type": "string"}},
                "required": ["text", "source"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["items"],
    "additionalProperties": False,
}

_NEXT_HYPOTHESES_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "statement": {"type": "string"},
                    "rationale": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["statement", "rationale", "confidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _parse_json_object(raw: str) -> dict[str, Any] | None:
    """response_schema가 유효 JSON object를 구조적으로 보장하므로 코드펜스 벗기기·bracket
    매칭 같은 방어적 파싱은 더 이상 불요(2026-07-03 PO 지시 — 밴드에이드 제거). 그래도
    SDK/스키마 컴파일 엣지케이스에 대비해 json.loads 실패는 흡수(None, 호출부가 실패 처리)."""
    try:
        parsed = json.loads(raw.strip())
    except (json.JSONDecodeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


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
    LLM을 아예 호출 안 하고 그대로 반환. 반면 호출까지 갔는데 응답이 없거나(None/빈 문자열/
    예외) **JSON 파싱 실패/스키마 불일치**면 진짜 실패로 수렴(None) — 까심 codex RC(2026-07-03):
    raw 텍스트를 단일 bullet로 "구제"하던 이전 fallback(S15 draft_hypothesis의 템플릿-fallback
    철학을 그대로 미러한 것)이 실은 **캐시-overwrite 맥락에서 garbage-persist**였다. S15는
    fallback 결과를 그 자리서 즉시 응답할 뿐 아무것도 지우지 않지만, 여기서는 라우터가
    non-None 반환값을 곧장 `repo.update()`로 **기존 good synthesis 위에 덮어쓴다** — 같은
    "완전 실패 없음" 철학이 정반대 결과(데이터 보존 vs 파괴)를 낳는 컨텍스트라 미러가 틀렸다."""
    from app.services.llm_client import generate_text

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
        raw = generate_text(prompt, response_schema=_SYNTHESIS_SCHEMA)
    except Exception as exc:  # noqa: BLE001 — 예외도 "실패"로 수렴(None), 여기서 삼키지 않음.
        logger.warning("retro synthesize: LLM 호출 실패: %s", exc)

    if not raw:
        return None  # 근거는 있었는데 LLM이 실패(또는 finish_reason!=STOP —
        # generate_text가 이미 걸러 None으로 수렴) — 기존 캐시 보존(호출부 502·미저장).

    parsed = _parse_json_object(raw)
    items = parsed.get("items") if parsed is not None else None
    learned: list[dict[str, str]] = []
    if isinstance(items, list):
        # 까심 codex RC(2026-07-03) — text는 걸렀는데 source(근거)는 안 걸러 근거 없는
        # 학습이 새어들 수 있었다. response_schema가 source를 required로 강제하니 빠진
        # 응답 = 스키마 위반 → #1863 원칙대로 그 item을 드롭(text와 대칭 검증).
        learned = [
            {"text": x["text"].strip(), "source": x["source"].strip()}
            for x in items
            if isinstance(x, dict)
            and isinstance(x.get("text"), str) and x["text"].strip()
            and isinstance(x.get("source"), str) and x["source"].strip()
        ]
    if not learned:
        # response_schema가 유효 object를 보장해도(2026-07-03 구조화 전환) items가 빈
        # 배열이거나 항목이 스키마 위반이면(방어적 케이스) 여전히 명시 실패(None) — raw-wrap
        # 구제 없이(까심 codex RC②) 기존 good synthesis를 저품질로 덮어쓰지 않는다. raw 원문을
        # 로그에 남겨(2026-07-03 dev repro 교훈) 다음 반례를 재현 없이 바로 확인 가능하게 한다.
        logger.warning(
            "retro synthesize: 유효 items 없음(raw 원문 앞 500자) — %s", raw.strip()[:500]
        )
        return None

    return {"learned": learned, "generated_at": now.isoformat(), "source": "ai_draft"}


def _build_next_hypotheses_prompt(synthesis: dict[str, Any]) -> str | None:
    """까심 QA MINOR(2026-07-03) — `_has_valid_synthesis`는 "≥1개 유효 아이템"만 요구하므로
    혼합 learned(예: [{"text":"진짜 내용"}, {"foo":"bar"}])가 게이트를 통과할 수 있다. 이전엔
    dict이기만 하면 `item.get('text','')`로 빈 문자열 bullet("- ")까지 프롬프트에 흘려보냈다
    — 게이트와 동일한 shape 검증(non-blank text)으로 garbage 아이템을 여기서도 드롭."""
    learned = synthesis.get("learned") or []
    valid_texts = [
        item["text"] for item in learned
        if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip()
    ]
    if not valid_texts:
        return None
    lines = [_NEXT_HYPOTHESES_INSTRUCTION, "", "종합:"]
    lines.extend(f"- {t}" for t in valid_texts)
    return "\n".join(lines)


async def recommend_next(synthesis: dict[str, Any]) -> list[dict[str, Any]] | None:
    """L3 다음가설 추천 — synthesis(§5 계약 dict, 이미 non-null임을 라우터가 보장) 기반.
    metric_definition/measure_after는 S15 draft_hypothesis와 동형으로 고정 템플릿(LLM이
    구조화 수치를 지어내지 않게) — statement/rationale/confidence만 LLM 생성.

    반환 None = **생성 실패**(호출부 미저장 — synthesize와 동일 원칙, 기존 good
    next_hypotheses 캐시를 빈 배열/garbage로 덮어쓰지 않는다). synthesis.learned가 애초에
    비어 있어 프롬프트 자체를 안 만든 경우만 정당한 빈 배열(LLM 미호출)."""
    from app.services.llm_client import generate_text

    prompt = _build_next_hypotheses_prompt(synthesis)
    if prompt is None:
        return []

    raw = None
    try:
        raw = generate_text(prompt, response_schema=_NEXT_HYPOTHESES_SCHEMA)
    except Exception as exc:  # noqa: BLE001
        logger.warning("retro recommend_next: LLM 호출 실패: %s", exc)
    if not raw:
        return None  # LLM 실패(또는 max_tokens/refusal) — 기존 캐시 보존.

    parsed = _parse_json_object(raw)
    items = parsed.get("items") if parsed is not None else None
    if not isinstance(items, list):
        # response_schema가 유효 object를 보장해도(2026-07-03 구조화 전환) items 키 자체가
        # 방어적 케이스로 리스트가 아닐 수 있음 — synthesize처럼 원문 래핑 구제가 불가(스키마상
        # statement 필수 필드라 텍스트 1줄로 대체 불가) → 명시 실패. raw 원문을 로그에 남김.
        logger.warning(
            "retro recommend_next: 유효 items 없음(raw 원문 앞 500자) — %s", raw.strip()[:500]
        )
        return None

    measure_after = datetime.now(timezone.utc) + timedelta(days=_DEFAULT_MEASURE_DAYS)
    candidates: list[dict[str, Any]] = []
    # 까심 codex RC round2(2026-07-03) — 전체 items를 순회하며 "유효한" 후보 수가
    # _MAX_NEXT_HYPOTHESES에 도달하면 멈춘다(raw 순서로 슬라이스 후 필터하면 앞쪽 malformed
    # item이 뒤쪽 valid item을 밀어내는 over-drop이 났다 — filter-then-cap이 정답).
    for x in items:
        if len(candidates) >= _MAX_NEXT_HYPOTHESES:
            break
        if not isinstance(x, dict) or not isinstance(x.get("statement"), str) or not x["statement"].strip():
            continue
        # response_schema가 rationale/confidence를 required로 강제하지만 JSON Schema
        # "number"는 범위(min/max)도, NaN/Infinity 배제도 못 한다(PO 실측: Vertex
        # structured output 제약 — json.loads는 표준 확장으로 NaN/Infinity를 파싱한다).
        # statement처럼 rationale은 non-blank 필수·confidence는 유한수만 [0.0,1.0] clamp
        # (범위 밖/비숫자/비유한은 스키마 위반과 동급 → item 드롭, #1863 원칙).
        rationale = x.get("rationale")
        if not isinstance(rationale, str) or not rationale.strip():
            continue
        confidence_raw = x.get("confidence")
        if (
            not isinstance(confidence_raw, (int, float))
            or isinstance(confidence_raw, bool)
            or not math.isfinite(confidence_raw)
        ):
            continue
        confidence = max(0.0, min(1.0, float(confidence_raw)))
        candidates.append({
            "id": str(uuid.uuid4()),
            "statement": x["statement"].strip(),
            "metric_definition": {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
            "measure_after": measure_after.isoformat(),
            "confidence": confidence,
            "rationale": rationale.strip(),
            "requires_confirmation": True,
        })
    if not candidates:
        # 응답은 JSON 배열이었지만 항목이 전부 스키마 불일치 — 사실상 생성 실패와 동급이라
        # 빈 배열을 "정답"으로 저장하지 않는다(기존 캐시 보존).
        return None
    return candidates
