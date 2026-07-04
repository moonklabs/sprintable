"""E-LOOP-LEDGER P1-S7: Context Pack 조립 서비스 단위 테스트(mock, 블루프린트 §P1).

핵심 불변식: embed 불가/검색 예외/0건 매칭 모두 예외를 밖으로 흘리지 않고 Doc 콘텐츠 3갈래로
흡수 — assemble_context_pack_briefing은 어떤 경우에도 Doc id를 반환한다.

⚠️까심 QA CRITICAL 지적(2026-07-02): 이 파일의 mock RuntimeError 테스트는 Python 예외만 시뮬레이션
할 뿐 실 Postgres 트랜잭션 상태(server-level aborted)를 재현하지 못하는 masking test다 — SAVEPOINT
가 실제로 트랜잭션을 격리하는지(status='briefing' 전이가 실 DB 에러에도 살아남는지)는 이 파일이
아니라 tests/test_e_loop_ledger_p1_s7_context_pack_briefing_realdb.py의 realdb 비-tautological
테스트가 검증한다. 여기서는 begin_nested()가 정상 호출되는 구조와 콘텐츠 분기 로직만 검증한다."""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import loop_briefing


def _loop():
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        title="온보딩 개선 loop", goal_tags=["onboarding"],
        created_by_member_id=uuid.uuid4(),
    )


def _search_result(entity_type, entity_id, text="past text", similarity=0.8):
    return SimpleNamespace(entity_type=entity_type, entity_id=entity_id, embedding_text=text, similarity=similarity)


def _mock_session():
    """begin_nested()가 진짜 async context manager처럼 동작하는 세션 mock(SAVEPOINT 구조 재현).
    __aexit__=False로 예외를 삼키지 않아 assemble_context_pack_briefing의 except가 정상 작동."""
    session = AsyncMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=None)
    cm.__aexit__ = AsyncMock(return_value=False)
    session.begin_nested = MagicMock(return_value=cm)
    return session


class _FakeDoc:
    def __init__(self, doc_id):
        self.id = doc_id


class _FakeDocRepo:
    def __init__(self, session, org_id):
        self.created_kwargs = None

    async def create(self, **kwargs):
        self.created_kwargs = kwargs
        return _FakeDoc(uuid.uuid4())


async def test_embed_unavailable_still_creates_doc_with_skip_notice():
    loop = _loop()
    with patch("app.services.embedding_client.embed_text", return_value=None):
        with patch("app.repositories.doc.DocRepository", _FakeDocRepo):
            with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                doc_id = await loop_briefing.assemble_context_pack_briefing(_mock_session(), loop.org_id, loop)
    assert doc_id is not None


async def test_zero_matches_creates_doc_with_no_history_notice():
    loop = _loop()
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch("app.services.context_pack_search.search_similar_embeddings", new=AsyncMock(return_value=[])):
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    await loop_briefing.assemble_context_pack_briefing(_mock_session(), loop.org_id, loop)
    assert "찾지 못했습니다" in fake_repo.created_kwargs["content"]


async def test_self_result_excluded_from_context_pack():
    loop = _loop()
    other = _search_result("hypothesis", uuid.uuid4())
    self_result = _search_result("loop", loop.id)  # 자기 자신 — 제외돼야.
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(return_value=[self_result, other]),
        ):
            session = _mock_session()
            session.execute = AsyncMock(return_value=SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [])))
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    await loop_briefing.assemble_context_pack_briefing(session, loop.org_id, loop)
    content = fake_repo.created_kwargs["content"]
    assert "과거 유사 항목 1건" in content  # self 제외 후 1건만.


async def test_search_exception_absorbed_as_embed_unavailable():
    """Python 예외 경로(구조 검증용) — 실 DB 트랜잭션 격리는 realdb 테스트가 검증(비-tautological)."""
    loop = _loop()
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ):
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    doc_id = await loop_briefing.assemble_context_pack_briefing(_mock_session(), loop.org_id, loop)
    assert doc_id is not None
    assert "일시 불가" in fake_repo.created_kwargs["content"]


async def test_failure_inside_savepoint_block_calls_begin_nested():
    """SAVEPOINT 구조 자체가 호출되는지 확인 — session.begin_nested()가 실제로 진입점으로 쓰인다."""
    loop = _loop()
    session = _mock_session()
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ):
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    await loop_briefing.assemble_context_pack_briefing(session, loop.org_id, loop)
    session.begin_nested.assert_called_once()
