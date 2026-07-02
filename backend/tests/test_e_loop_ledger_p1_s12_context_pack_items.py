"""E-LOOP-LEDGER P1-S12: context-pack structured JSON 조립 단위 테스트(mock, doc fbe5923e §3).

crux 확정 3점: ①정렬은 search_similar_embeddings의 기존 순서 보존(similarity-desc) ②decision은
entity_type=='loop'일 때만(chosen+top rejected 1건)·나머지 null ③outcome은 verified/falsified일
때만·loop은 자신의 hypothesis_id로 간접 해소. embed_available 3상태(성공/embed불가/검색실패)도 검증.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import context_pack_items as svc


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _loop_obj(loop_id=None, title="타깃 loop", goal_tags=None):
    return SimpleNamespace(
        id=loop_id or uuid.uuid4(), title=title, goal_tags=goal_tags or [],
        project_id=uuid.uuid4(), org_id=uuid.uuid4(),
    )


def _search_result(entity_type, entity_id, text="past", similarity=0.8):
    return SimpleNamespace(entity_type=entity_type, entity_id=entity_id, embedding_text=text, similarity=similarity)


def _hyp(status="verified", statement="가설", outcome_result=None):
    return SimpleNamespace(
        id=uuid.uuid4(), status=status, statement=statement,
        outcome_result=outcome_result or {"metric": "cvr", "actual": 18.4, "target": 18, "direction": "up"},
    )


def _looprun(hyp_id=None, title="과거 loop"):
    return SimpleNamespace(id=uuid.uuid4(), title=title, hypothesis_id=hyp_id)


def _artifact(loop_id, decision="pending", variant_label="V", choose_reason=None,
              rejection_reason=None, created_at=None):
    from datetime import datetime, timezone
    return SimpleNamespace(
        id=uuid.uuid4(), loop_id=loop_id, decision=decision, variant_label=variant_label,
        choose_reason=choose_reason, rejection_reason=rejection_reason,
        created_at=created_at or datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


async def test_embed_unavailable_returns_empty_items_and_flag_false():
    loop = _loop_obj()
    with patch("app.services.embedding_client.embed_text", return_value=None):
        out = await svc.build_loop_context_pack(AsyncMock(), loop.org_id, loop)
    assert out.items == []
    assert out.embed_available is False


async def test_search_exception_returns_empty_items_and_flag_false():
    loop = _loop_obj()
    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ):
            out = await svc.build_loop_context_pack(AsyncMock(), loop.org_id, loop)
    assert out.items == []
    assert out.embed_available is False


async def test_hypothesis_item_maps_goal_and_outcome_no_decision():
    loop = _loop_obj()
    hyp = _hyp(status="verified")
    result = _search_result("hypothesis", hyp.id)
    session = AsyncMock()
    hyp_result = MagicMock()
    hyp_result.scalars.return_value.all.return_value = [hyp]
    session.execute = AsyncMock(return_value=hyp_result)

    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(return_value=[result]),
        ):
            out = await svc.build_loop_context_pack(session, loop.org_id, loop)

    assert len(out.items) == 1
    item = out.items[0]
    assert item.entity_type == "hypothesis"
    assert item.goal == hyp.statement
    assert item.decision is None
    assert item.outcome is not None
    assert item.outcome.hypothesis_status == "verified"
    assert item.outcome.actual == 18.4
    assert item.href == f"/hypotheses/{hyp.id}"


async def test_hypothesis_not_resolved_status_has_null_outcome():
    loop = _loop_obj()
    hyp = _hyp(status="measuring")
    result = _search_result("hypothesis", hyp.id)
    session = AsyncMock()
    hyp_result = MagicMock()
    hyp_result.scalars.return_value.all.return_value = [hyp]
    session.execute = AsyncMock(return_value=hyp_result)

    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(return_value=[result]),
        ):
            out = await svc.build_loop_context_pack(session, loop.org_id, loop)
    assert out.items[0].outcome is None


async def test_loop_item_gets_decision_and_indirect_outcome():
    loop = _loop_obj()
    hyp = _hyp(status="falsified", outcome_result={"metric": "x", "actual": 5, "target": 10, "direction": "up"})
    past_loop = _looprun(hyp_id=hyp.id)
    result = _search_result("loop", past_loop.id)

    chosen = _artifact(past_loop.id, decision="chosen", variant_label="A안", choose_reason="가설정렬")
    rejected = _artifact(past_loop.id, decision="rejected", variant_label="B안", rejection_reason="miss")

    session = AsyncMock()
    # execute 순서: loop_by_id, linked hyp_by_id, decision artifacts. 명시적으로 side_effect 배열 사용.
    loop_res = MagicMock(); loop_res.scalars.return_value.all.return_value = [past_loop]
    hyp_res = MagicMock(); hyp_res.scalars.return_value.all.return_value = [hyp]
    artifact_res = MagicMock(); artifact_res.scalars.return_value.all.return_value = [chosen, rejected]
    session.execute = AsyncMock(side_effect=[loop_res, hyp_res, artifact_res])

    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(return_value=[result]),
        ):
            out = await svc.build_loop_context_pack(session, loop.org_id, loop)

    assert len(out.items) == 1
    item = out.items[0]
    assert item.entity_type == "loop"
    assert item.goal == past_loop.title
    assert item.decision.chosen.label == "A안" and item.decision.chosen.reason == "가설정렬"
    assert len(item.decision.rejected) == 1 and item.decision.rejected[0].label == "B안"
    assert item.outcome.hypothesis_status == "falsified"
    assert item.href == f"/loops/{past_loop.id}"


async def test_loop_artifact_item_maps_to_decision_entity_type_no_decision_block():
    loop = _loop_obj()
    parent_loop_id = uuid.uuid4()
    artifact = _artifact(parent_loop_id, decision="rejected", variant_label="C안")
    result = _search_result("loop_artifact", artifact.id)

    session = AsyncMock()
    artifact_res = MagicMock(); artifact_res.scalars.return_value.all.return_value = [artifact]
    session.execute = AsyncMock(return_value=artifact_res)

    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(return_value=[result]),
        ):
            out = await svc.build_loop_context_pack(session, loop.org_id, loop)

    item = out.items[0]
    assert item.entity_type == "decision"  # loop_artifact → 'decision' 명명 매핑.
    assert item.goal == "C안"
    assert item.decision is None
    assert item.outcome is None
    assert item.href == f"/loops/{parent_loop_id}"


async def test_input_order_from_search_preserved_similarity_desc():
    """search_similar_embeddings가 이미 similarity-desc로 정렬해 반환 — 조립 단계가 순서를 바꾸지 않음."""
    loop = _loop_obj()
    a1 = _artifact(uuid.uuid4(), decision="chosen", variant_label="high-sim")
    a2 = _artifact(uuid.uuid4(), decision="chosen", variant_label="low-sim")
    r1 = _search_result("loop_artifact", a1.id, similarity=0.95)
    r2 = _search_result("loop_artifact", a2.id, similarity=0.42)

    session = AsyncMock()
    artifact_res = MagicMock(); artifact_res.scalars.return_value.all.return_value = [a1, a2]
    session.execute = AsyncMock(return_value=artifact_res)

    with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
        with patch(
            "app.services.context_pack_search.search_similar_embeddings",
            new=AsyncMock(return_value=[r1, r2]),  # 이미 desc 정렬된 입력.
        ):
            out = await svc.build_loop_context_pack(session, loop.org_id, loop)

    assert [i.similarity for i in out.items] == [0.95, 0.42]
