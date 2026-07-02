"""E-LOOP-LEDGER P1-S7: Context Pack 조립 서비스 단위 테스트(mock, 블루프린트 §P1).

핵심 불변식: embed 불가/검색 예외/0건 매칭 모두 예외를 밖으로 흘리지 않고 Doc 콘텐츠 3갈래로
흡수 — assemble_context_pack_briefing은 어떤 경우에도 Doc id를 반환한다(never raise 상단 보장은
transition_loop 쪽 통합테스트 스코프, 여기선 함수 자체의 3갈래 콘텐츠 분기만 검증).
"""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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
                doc_id = await loop_briefing.assemble_context_pack_briefing(AsyncMock(), loop.org_id, loop)
    assert doc_id is not None


async def test_zero_matches_creates_doc_with_no_history_notice():
    loop = _loop()
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch("app.services.context_pack_search.search_similar_embeddings", new=AsyncMock(return_value=[])):
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    await loop_briefing.assemble_context_pack_briefing(AsyncMock(), loop.org_id, loop)
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
            session = AsyncMock()
            session.execute = AsyncMock(return_value=SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [])))
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    await loop_briefing.assemble_context_pack_briefing(session, loop.org_id, loop)
    content = fake_repo.created_kwargs["content"]
    assert "과거 유사 항목 1건" in content  # self 제외 후 1건만.


async def test_search_exception_absorbed_as_embed_unavailable():
    loop = _loop()
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ):
            fake_repo = _FakeDocRepo(None, None)
            with patch("app.repositories.doc.DocRepository", return_value=fake_repo):
                with patch("app.services.doc_slug.resolve_unique_slug", new=AsyncMock(return_value="slug")):
                    doc_id = await loop_briefing.assemble_context_pack_briefing(AsyncMock(), loop.org_id, loop)
    assert doc_id is not None
    assert "일시 불가" in fake_repo.created_kwargs["content"]
