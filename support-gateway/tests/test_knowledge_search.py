"""story #3262 — app/knowledge_search.py 코사인 유사도 검색. 실 임베딩 API를 태우지 않고
합성 벡터로 검색 로직(정렬·top_k·threshold 컷)만 검증한다."""
from __future__ import annotations

from app.knowledge.corpus import KnowledgeChunk
import app.knowledge_search as ks


def _fake_chunks_and_embeddings():
    chunks = [
        KnowledgeChunk(id="a", title="A", content="a content", source_note="test"),
        KnowledgeChunk(id="b", title="B", content="b content", source_note="test"),
        KnowledgeChunk(id="c", title="C", content="c content", source_note="test"),
    ]
    embeddings = {
        "a": [1.0, 0.0, 0.0],
        "b": [0.9, 0.1, 0.0],  # a와 가까움
        "c": [-1.0, 0.0, 0.0],  # a와 정반대
    }
    return chunks, embeddings


def test_search_returns_best_match_first(monkeypatch):
    chunks, embeddings = _fake_chunks_and_embeddings()
    monkeypatch.setattr(ks, "KNOWLEDGE_CHUNKS", chunks)
    monkeypatch.setattr(ks, "_embeddings_cache", embeddings)

    matches = ks.search([1.0, 0.0, 0.0], top_k=3)
    assert [m.chunk.id for m in matches] == ["a", "b"]  # c는 threshold 미달로 빠짐
    assert matches[0].score > matches[1].score


def test_search_below_threshold_returns_empty(monkeypatch):
    chunks, embeddings = _fake_chunks_and_embeddings()
    monkeypatch.setattr(ks, "KNOWLEDGE_CHUNKS", chunks)
    monkeypatch.setattr(ks, "_embeddings_cache", embeddings)

    matches = ks.search([0.0, 0.0, 1.0], top_k=3)  # 셋 다와 직교 — 전부 threshold 미달
    assert matches == []


def test_search_respects_top_k(monkeypatch):
    chunks = [
        KnowledgeChunk(id=str(i), title=str(i), content="x", source_note="test") for i in range(5)
    ]
    embeddings = {c.id: [1.0, 0.0] for c in chunks}  # 전부 완전 일치(score=1.0)
    monkeypatch.setattr(ks, "KNOWLEDGE_CHUNKS", chunks)
    monkeypatch.setattr(ks, "_embeddings_cache", embeddings)

    matches = ks.search([1.0, 0.0], top_k=2)
    assert len(matches) == 2


def test_search_skips_chunks_missing_from_embeddings(monkeypatch):
    """corpus.py에 새 청크를 추가했는데 embeddings.json을 재생성하기 전 상태 — 그 청크만
    조용히 검색 밖으로 빠져야 한다(크래시 금지, app/knowledge_search.py 주석 참고)."""
    chunks = [
        KnowledgeChunk(id="has-vec", title="A", content="a", source_note="test"),
        KnowledgeChunk(id="missing-vec", title="B", content="b", source_note="test"),
    ]
    embeddings = {"has-vec": [1.0, 0.0]}
    monkeypatch.setattr(ks, "KNOWLEDGE_CHUNKS", chunks)
    monkeypatch.setattr(ks, "_embeddings_cache", embeddings)

    matches = ks.search([1.0, 0.0], top_k=3)
    assert [m.chunk.id for m in matches] == ["has-vec"]


def test_cosine_zero_vector_is_zero_similarity():
    assert ks._cosine([0.0, 0.0], [1.0, 1.0]) == 0.0
