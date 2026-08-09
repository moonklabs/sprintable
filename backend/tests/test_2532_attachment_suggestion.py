"""story #2532(E-FLOW-V4 S2): `attachment_suggestion.py` 순수 함수 — I/O 0.

classify_attachment_type: fix/infra→goal, 실험→hypothesis, 애매하면 ambiguous.
rank_candidates: 토큰 overlap 스코어링, overlap 0인 후보는 안 낸다(빈 제안 금지).
"""
from __future__ import annotations

import uuid

from app.services.attachment_suggestion import (
    RankableCandidate,
    classify_attachment_type,
    rank_candidates,
)


# --- classify_attachment_type ------------------------------------------------------


def test_fix_keyword_classifies_as_goal():
    assert classify_attachment_type("로그인 버그 fix") == "goal"


def test_infra_keyword_classifies_as_goal():
    assert classify_attachment_type("DB 커넥션 풀 인프라 안정화") == "goal"


def test_experiment_keyword_classifies_as_hypothesis():
    assert classify_attachment_type("온보딩 이메일 제목 A/B 실험") == "hypothesis"


def test_validation_keyword_classifies_as_hypothesis():
    assert classify_attachment_type("신규 가설 검증 착수") == "hypothesis"


def test_no_keyword_match_is_ambiguous():
    """⭐AC 양성대조: 어느 쪽 키워드도 안 걸리면 ambiguous — 라우터가 두 후보 리스트
    다 채우는 근거가 되는 케이스."""
    assert classify_attachment_type("사용자 프로필 페이지 개편") == "ambiguous"


def test_both_keywords_match_is_ambiguous():
    """⭐AC 양성대조: goal·hypothesis 키워드가 둘 다 걸려도 ambiguous(어느 한쪽으로
    강제 안 함) — "실험 인프라 정비"류 혼합 작업."""
    assert classify_attachment_type("실험 환경 인프라 정비") == "ambiguous"


def test_description_alone_can_trigger_classification():
    assert classify_attachment_type("제목만 봐선 모름", description="이건 버그 수정입니다") == "goal"


def test_empty_description_does_not_crash():
    assert classify_attachment_type("제목만 있음", description=None) == "ambiguous"


# --- rank_candidates ----------------------------------------------------------------


def test_rank_candidates_orders_by_token_overlap_desc():
    high = RankableCandidate(id=uuid.uuid4(), text="결제 시스템 안정화 목표")
    low = RankableCandidate(id=uuid.uuid4(), text="완전히 무관한 다른 주제")
    ranked = rank_candidates("결제 시스템 오류 수정", None, [low, high])
    assert [c.id for c in ranked] == [high.id]  # low는 overlap 0 → 아예 안 나옴


def test_rank_candidates_excludes_zero_overlap_candidates():
    """⭐빈 제안 금지 원칙 — overlap 0인 후보는 억지로라도 안 낸다(PO 판정)."""
    unrelated = RankableCandidate(id=uuid.uuid4(), text="전혀 다른 이야기")
    ranked = rank_candidates("결제 시스템 오류 수정", None, [unrelated])
    assert ranked == []


def test_rank_candidates_respects_top_n():
    candidates = [
        RankableCandidate(id=uuid.uuid4(), text=f"결제 시스템 후보{i}")
        for i in range(10)
    ]
    ranked = rank_candidates("결제 시스템 오류", None, candidates, top_n=3)
    assert len(ranked) == 3


def test_rank_candidates_empty_story_text_returns_empty():
    """스토리 제목·설명 둘 다 토큰이 없으면(공백뿐 등) overlap 계산 불가 — 빈 리스트로
    안전 폴백(에러 아님)."""
    candidates = [RankableCandidate(id=uuid.uuid4(), text="아무 후보")]
    assert rank_candidates("   ", None, candidates) == []


def test_rank_candidates_uses_description_tokens_too():
    cand = RankableCandidate(id=uuid.uuid4(), text="정산 배치 재처리")
    ranked = rank_candidates("제목만 봐선 모름", "정산 배치 재처리가 필요합니다", [cand])
    assert [c.id for c in ranked] == [cand.id]
