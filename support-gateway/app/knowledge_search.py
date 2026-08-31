"""story #3262(지원v1·4지식원) — 지식 검색층(Blueprint §1.2 "지식 Task"의 검색 단계).
`app/knowledge/embeddings.json`(사전 계산, `scripts/embed_corpus.py` 산출물)에 대해 질의
임베딩과의 코사인 유사도로 top-k를 뽑는다. 문서 임베딩을 요청마다 다시 계산하지 않는다 —
정본 문서가 배포 사이에 안 바뀌는 정적 콘텐츠라(release-linked 갱신 규칙, corpus.py 참고)
매 요청 임베딩 호출은 순수 비용 낭비다.

임계치 미만이면 빈 리스트 — 호출부(app/execution_tasks.py)가 이걸 "모른다"로 정직하게
취급한다. threshold=0.65는 AC4 실측 보정값(2026-08-31, gemini-embedding-001 실호출) —
관련 없는 질문 5종(날씨·결제·비밀번호·벨로시티·환불) top1 유사도가 0.52~0.58에 몰린 반면,
실제 관련 질문 3종은 0.70~0.80로 뚜렷이 분리됐다. 0.5 근방은 이 임베딩 공간의 "무관계
기저값"이라 threshold로 쓰면 안 된다(오탐 유발 확認 — story #3262 초기 시도)."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from app.knowledge.corpus import KNOWLEDGE_CHUNKS, KnowledgeChunk

_EMBEDDINGS_PATH = Path(__file__).parent / "knowledge" / "embeddings.json"

SIMILARITY_THRESHOLD = 0.65


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


def search(query_vector: list[float], *, top_k: int = 3) -> list[SearchMatch]:
    embeddings = _load_embeddings()
    scored: list[SearchMatch] = []
    for chunk in KNOWLEDGE_CHUNKS:
        vector = embeddings.get(chunk.id)
        if vector is None:
            continue  # embeddings.json이 corpus.py보다 뒤처진 상태 — 조용히 스킵(그 청크만 검색 밖).
        scored.append(SearchMatch(chunk=chunk, score=_cosine(query_vector, vector)))
    scored.sort(key=lambda m: m.score, reverse=True)
    return [m for m in scored[:top_k] if m.score >= SIMILARITY_THRESHOLD]
