"""E-LOOP-LEDGER P1-S6: context-pack 유사도 검색 서비스 단위 테스트(mock session, 블루프린트 §P1).

핵심 불변식: status='ready'만 대상(서비스 함수 자체는 SQL WHERE로 위임하므로 여기선 orphan
필터링만 직접 검증) — archived hypothesis/soft-deleted loop을 가리키는 stale embedding은 결과에서
드롭. loop_artifact는 삭제 개념이 없어 항상 유지. 빈 배치는 조기 반환(추가 쿼리 0).
"""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import context_pack_search as svc


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _emb_row(entity_type, entity_id, distance, embedding_text="text"):
    emb = SimpleNamespace(entity_type=entity_type, entity_id=entity_id, embedding_text=embedding_text)
    return SimpleNamespace(Embedding=emb, distance=distance)


class _FakeSession:
    def __init__(self, embed_rows, alive_hyp_ids, alive_loop_ids):
        self._embed_rows = embed_rows
        self._alive_hyp_ids = alive_hyp_ids
        self._alive_loop_ids = alive_loop_ids
        self.executed = []

    async def execute(self, stmt, params=None):
        self.executed.append(stmt)
        text_str = str(stmt)
        result = MagicMock()
        if "SET LOCAL" in text_str or "hnsw" in text_str.lower():
            return result
        if "hypotheses" in text_str.lower():
            result.scalars.return_value.all.return_value = list(self._alive_hyp_ids)
            return result
        if "loop_runs" in text_str.lower():
            result.scalars.return_value.all.return_value = list(self._alive_loop_ids)
            return result
        # embeddings 메인 쿼리
        result.all.return_value = self._embed_rows
        return result


async def test_orphaned_hypothesis_dropped_alive_kept():
    alive_id = uuid.uuid4()
    dead_id = uuid.uuid4()  # archived → alive set에서 제외
    rows = [_emb_row("hypothesis", alive_id, 0.1), _emb_row("hypothesis", dead_id, 0.2)]
    session = _FakeSession(rows, alive_hyp_ids={alive_id}, alive_loop_ids=set())
    out = await svc.search_similar_embeddings(session, uuid.uuid4(), uuid.uuid4(), [0.0] * 768)
    assert len(out) == 1
    assert out[0].entity_id == alive_id
    assert out[0].similarity == pytest.approx(0.9)


async def test_orphaned_loop_dropped_alive_kept():
    alive_id = uuid.uuid4()
    dead_id = uuid.uuid4()  # soft-deleted → alive set에서 제외
    rows = [_emb_row("loop", alive_id, 0.3), _emb_row("loop", dead_id, 0.4)]
    session = _FakeSession(rows, alive_hyp_ids=set(), alive_loop_ids={alive_id})
    out = await svc.search_similar_embeddings(session, uuid.uuid4(), uuid.uuid4(), [0.0] * 768)
    assert [r.entity_id for r in out] == [alive_id]


async def test_loop_artifact_never_filtered_no_deletion_concept():
    aid = uuid.uuid4()
    rows = [_emb_row("loop_artifact", aid, 0.15)]
    session = _FakeSession(rows, alive_hyp_ids=set(), alive_loop_ids=set())
    out = await svc.search_similar_embeddings(session, uuid.uuid4(), uuid.uuid4(), [0.0] * 768)
    assert [r.entity_id for r in out] == [aid]


async def test_empty_backlog_returns_empty_no_extra_queries():
    session = _FakeSession([], alive_hyp_ids=set(), alive_loop_ids=set())
    out = await svc.search_similar_embeddings(session, uuid.uuid4(), uuid.uuid4(), [0.0] * 768)
    assert out == []
    # SET LOCAL + 메인 embeddings 쿼리 2회만(orphan 배치조회는 후보 0이라 스킵).
    assert len(session.executed) == 2
