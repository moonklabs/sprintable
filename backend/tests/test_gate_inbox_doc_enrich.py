"""24f5ae18: Gate inbox 가 doc gate 를 doc title/slug 로 enrich(인박스 렌더+링크)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers import gates as gates_mod
from app.routers.gates import list_gates
from app.services.member_resolver import ResolvedMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _gate(org, work_item_id, wtype):
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=org, work_item_id=work_item_id, work_item_type=wtype,
        gate_type="doc_approval" if wtype == "doc" else "merge", status="pending",
        resolver_id=None, resolved_at=None, resolution_note=None, held_until=None,
        neutral_facts=None, requires_human=False, evidence_status=None,
        decision_basis=None, auto_decision_reason=None, work_item_summary=None,
        created_at=datetime(2026, 6, 26, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 26, tzinfo=timezone.utc),
    )


@pytest.mark.anyio
async def test_doc_gate_enriched_with_title_slug():
    org, doc_id, pid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = [_gate(org, doc_id, "doc")]
    # 89484c8c: 배치가 project_id 도 조회(4-tuple) — can_approve enrich 재사용.
    docs_res = MagicMock()
    docs_res.all.return_value = [(doc_id, "설계 문서", "design-doc", pid)]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_res, docs_res])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    resolved = ResolvedMember(
        id=uuid.uuid4(), user_id=uuid.uuid4(), name="h", type="human", role="member", org_id=org
    )
    # doc_approval gate → can_approve enrich 가 resolve_member 호출(여기선 summary 만 검증·patch 로 무crash).
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=resolved)), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)):
        out = await list_gates(work_item_id=None, work_item_type="doc", status="pending",
                               session=session, org_id=org, auth=auth)
    assert out[0].work_item_summary is not None
    assert out[0].work_item_summary.title == "설계 문서"
    assert out[0].work_item_summary.slug == "design-doc"


@pytest.mark.anyio
async def test_non_doc_gate_no_enrich_no_extra_query():
    """비-doc gate 는 enrich 0(work_item_summary None)·doc 쿼리 미발생(N+1 0)·can_approve enrich skip."""
    org = uuid.uuid4()
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = [_gate(org, uuid.uuid4(), "story")]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_res])
    out = await list_gates(work_item_id=None, work_item_type=None, status=None,
                           session=session, org_id=org, auth=None)
    assert out[0].work_item_summary is None
    assert session.execute.await_count == 1  # gates 쿼리만(doc/can_approve enrich 쿼리 0)
