"""story #2532(E-FLOW-V4 S2): 작업(스토리)이 «가설 OR 목표» 중 무엇에 매달릴지 자동제안.

조직 원리 doc `flow-board-v4-hypothesis-scale` §4-1(v3 「구조적 결부」) — 명시적 block은
안 한다. 대신 작업 생성/조회 時 «어느 쪽에 매달릴지» 자동제안해 마찰 0으로 유도한다
(v3.4 §3-3 "매번 폼 금지").

이 모듈은 `model_family.py`와 동형으로 **결정론적**이다 — LLM 호출·네트워크·DB 접근 0.
분류(`classify_attachment_type`)는 순수 키워드 매칭, 랭킹(`rank_candidates`)은 순수 토큰
overlap 카운트다. 후보 데이터(project 내 open goal/hypothesis 목록)는 라우터가 조회해
넘긴다 — 이 모듈은 그 리스트를 스코어링만 한다(DB 접근 0 유지).

⛔PO 판정(2026-08-08, story #2532 AC 락): v1은 키워드 overlap으로 GO — ①결정론·재현가능·
LLM 0(model_family.py 스타일 일관) ②후보는 「제안」이지 정답이 아니라 사람이 한 번
확認하면 됨(완벽 불요) ③정교한 매칭(임베딩/의미)은 실사용 데이터가 쌓인 뒤 개선(지금
지어내면 검증 못 함). overlap 0인 후보는 내지 않는다(빈 제안 금지 — 억지 후보보다 "후보
없음"이 정직하다).
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Literal

# 유지보수·결함·인프라 신호 → 목표(에픽)로 분류. 정공법: 「모든 작업이 가설」은 부자연
# (버그fix는 가설이 아니다 — doc §4-1).
_GOAL_KEYWORDS: frozenset[str] = frozenset({
    "fix", "bug", "hotfix", "patch", "infra", "infrastructure", "outage", "incident",
    "버그", "수정", "고침", "인프라", "유지보수", "핫픽스", "패치", "오류", "장애",
    "안정화", "복구", "결함", "회귀", "regression",
})

# 탐구·실험 신호 → 가설로 분류.
_HYPOTHESIS_KEYWORDS: frozenset[str] = frozenset({
    "experiment", "hypothesis", "test", "ab test", "a/b", "validate", "measure",
    "실험", "가설", "테스트", "검증", "측정", "조사", "리서치", "research", "가정",
})

_TOKEN_RE = re.compile(r"[\w가-힣]+")
# 순수 토큰이라 봐도 의미 없는 흔한 조사/기능어 — overlap 점수를 오염시키지 않게 제외.
_STOPWORDS: frozenset[str] = frozenset({
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "it",
    "이", "가", "을", "를", "은", "는", "의", "에", "와", "과", "도", "및", "그",
})

AttachmentType = Literal["goal", "hypothesis", "ambiguous"]

_MIN_TOKEN_LEN = 2  # 1글자 토큰(조사 파편 등)은 과매칭을 낳아 제외.


def _tokenize(text: str | None) -> set[str]:
    if not text:
        return set()
    return {
        t for t in _TOKEN_RE.findall(text.lower())
        if t not in _STOPWORDS and len(t) >= _MIN_TOKEN_LEN
    }


def classify_attachment_type(title: str, description: str | None = None) -> AttachmentType:
    """제목+설명의 키워드로 goal/hypothesis/ambiguous 셋 중 하나를 판정한다.

    둘 다 매치되거나(예: "실험 인프라 정비") 아무것도 안 매치되면 ambiguous — 이 경우
    라우터가 goal_candidates·hypothesis_candidates 둘 다 채운다(AC 양성대조: 애매한
    작업엔 두 후보 리스트 다 나와야 한다)."""
    haystack = f"{title} {description or ''}".lower()
    goal_hit = any(kw in haystack for kw in _GOAL_KEYWORDS)
    hyp_hit = any(kw in haystack for kw in _HYPOTHESIS_KEYWORDS)
    if goal_hit and not hyp_hit:
        return "goal"
    if hyp_hit and not goal_hit:
        return "hypothesis"
    return "ambiguous"


@dataclass(frozen=True)
class RankableCandidate:
    """랭킹 대상 1건 — goal이면 title, hypothesis면 statement를 text로 넘긴다."""
    id: uuid.UUID
    text: str


@dataclass(frozen=True)
class ScoredCandidate:
    id: uuid.UUID
    text: str
    score: int = field(compare=False)


def rank_candidates(
    story_title: str, story_description: str | None,
    candidates: list[RankableCandidate], *, top_n: int = 5,
) -> list[ScoredCandidate]:
    """토큰 overlap 개수로 후보를 스코어링해 상위 top_n만 반환한다. overlap 0인 후보는
    아예 내지 않는다(빈 제안 금지 — PO 판정, 억지 후보보다 정직한 "후보 없음")."""
    story_tokens = _tokenize(story_title) | _tokenize(story_description)
    if not story_tokens:
        return []
    scored = [
        ScoredCandidate(id=c.id, text=c.text, score=len(story_tokens & _tokenize(c.text)))
        for c in candidates
    ]
    scored = [c for c in scored if c.score > 0]
    scored.sort(key=lambda c: c.score, reverse=True)
    return scored[:top_n]
