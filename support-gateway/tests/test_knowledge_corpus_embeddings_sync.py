"""story #3262 AC3(릴리즈 연동 갱신 규칙) — corpus.py 내용이 바뀌었는데
`scripts/embed_corpus.py`를 재실행 안 해 embeddings.json이 낡은 채로 남는 드리프트를 구조적
으로 잡는다. content_hash가 다르면(=코드는 고쳤는데 재생성을 깜빡함) 이 테스트가 RED."""
from __future__ import annotations

import json
from pathlib import Path

from app.knowledge.corpus import KNOWLEDGE_CHUNKS


def test_embeddings_json_hash_matches_current_corpus_content():
    import importlib

    embed_corpus = importlib.import_module("scripts.embed_corpus")
    embeddings_path = Path(__file__).parent.parent / "app" / "knowledge" / "embeddings.json"
    data = json.loads(embeddings_path.read_text())

    assert data["content_hash"] == embed_corpus.content_hash(), (
        "app/knowledge/corpus.py 내용이 app/knowledge/embeddings.json 생성 시점 이후 바뀌었습니다 — "
        "`uv run python scripts/embed_corpus.py`를 재실행해 embeddings.json을 갱신하세요."
    )


def test_embeddings_json_has_a_vector_for_every_chunk():
    embeddings_path = Path(__file__).parent.parent / "app" / "knowledge" / "embeddings.json"
    data = json.loads(embeddings_path.read_text())
    vector_ids = set(data["vectors"].keys())
    corpus_ids = {c.id for c in KNOWLEDGE_CHUNKS}
    assert corpus_ids <= vector_ids, f"embeddings.json에 벡터가 없는 청크: {corpus_ids - vector_ids}"
