"""story #3262(지원v1·4지식원) — 지식 검색층(Blueprint §1.2 "지식 Task"의 검색 단계).
`app/knowledge/embeddings.json`(사전 계산, `scripts/embed_corpus.py` 산출물)에 대해 질의
임베딩과의 코사인 유사도로 top-k를 뽑는다. 문서 임베딩을 요청마다 다시 계산하지 않는다 —
정본 문서가 배포 사이에 안 바뀌는 정적 콘텐츠라(release-linked 갱신 규칙, corpus.py 참고)
매 요청 임베딩 호출은 순수 비용 낭비다.

AC4 실측(2026-08-31, gemini-embedding-001 실호출) — 관련 없는 질문 5종(날씨·결제·비밀번호·
벨로시티·환불) top1 유사도가 0.52~0.58에 몰린 반면, 실제 관련 질문 3종은 0.70~0.80로
뚜렷이 분리됐다. 0.5 근방은 이 임베딩 공간의 "무관계 기저값"이다.

story #3268/#3281(지원v1·후속, 2026-09-01) 통합 설계 — 예전엔 이 실측을 단일 threshold
(0.65, 그 사이 아무 값)로 뭉뚱그렸으나, 그러면 "무관 청크가 threshold를 겨우 넘는"
경계 사례(카디르 QA PR#3651 재현, score=0.66)를 못 거른다. 두 값으로 명시적으로 쪼갠다:
- `NEAR_MISS_FLOOR`(0.60, 무관 기저 0.52~0.58 바로 위) — 이 아래는 검색 결과 자체에서
  제외(노이즈 취급, 근접 제안 대상도 아님).
- `SELECTED_MATCH_CONFIDENCE_THRESHOLD`(0.70, 관련 질문 실측 분포 하단) — 이 이상이고
  LLM도 선택해야 "정확 매치"(execution_tasks.py 이중 게이트).
- 그 사이(0.60~0.70)는 "근접"(story #3281) — 정확 매치는 아니지만 관련될 수 있는 안내로
  code-조립 제시+구체화 역질문 1회."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from app.knowledge.corpus import KNOWLEDGE_CHUNKS, KnowledgeChunk

_EMBEDDINGS_PATH = Path(__file__).parent / "knowledge" / "embeddings.json"

NEAR_MISS_FLOOR = 0.60
SELECTED_MATCH_CONFIDENCE_THRESHOLD = 0.70


@dataclass(frozen=True)
class SearchMatch:
    chunk: KnowledgeChunk
    score: float


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


_embeddings_cache: dict[str, list[float]] | None = None


def _load_embeddings() -> dict[str, list[float]]:
    global _embeddings_cache
    if _embeddings_cache is None:
        data = json.loads(_EMBEDDINGS_PATH.read_text())
        _embeddings_cache = data["vectors"]
    return _embeddings_cache


def search(query_vector: list[float], *, top_k: int = 3, min_score: float = NEAR_MISS_FLOOR) -> list[SearchMatch]:
    """story #3268/#3281 — min_score 기본값이 NEAR_MISS_FLOOR라, 호출부(knowledge_task)가
    이 한 번의 호출로 "정확 매치 후보"와 "근접 후보" 풀을 동시에 받는다(이중 호출 없음) —
    최종 등급(정확/근접/무관)은 knowledge_task가 SELECTED_MATCH_CONFIDENCE_THRESHOLD와
    비교해 가른다."""
    embeddings = _load_embeddings()
    scored: list[SearchMatch] = []
    for chunk in KNOWLEDGE_CHUNKS:
        vector = embeddings.get(chunk.id)
        if vector is None:
            continue  # embeddings.json이 corpus.py보다 뒤처진 상태 — 조용히 스킵(그 청크만 검색 밖).
        scored.append(SearchMatch(chunk=chunk, score=_cosine(query_vector, vector)))
    scored.sort(key=lambda m: m.score, reverse=True)
    return [m for m in scored[:top_k] if m.score >= min_score]
