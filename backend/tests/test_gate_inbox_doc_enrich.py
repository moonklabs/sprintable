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
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        out = await list_gates(work_item_id=None, work_item_type="doc", status="pending",
                               assigned_to_me=False, session=session, org_id=org, auth=auth)
    assert out[0].work_item_summary is not None
    assert out[0].work_item_summary.title == "설계 문서"
    assert out[0].work_item_summary.slug == "design-doc"


@pytest.mark.anyio
async def test_story_gate_summary_enriched_via_project_id_batch_no_extra_query():
    """doc 전용 쿼리·can_approve 판정 쿼리는 여전히 안 나감(N+1 0)·can_approve enrich skip(비휴먼/
    resolve 실패 caller).

    ⚠️2026-07-31 수정(오르테가 라이브 실측 — GET /api/v2/gates pending 37/37 project_id=None):
    story/task/artifact project_id 배치 조회는 이제 caller 타입과 무관하게 항상 돈다(project_id는
    authz 판정이 아니라 데이터 정합성이라 caller 의존이면 결함). 그래서 이 케이스도 session.execute
    호출이 1(gates)→2(gates+story 배치)로 늘었다.

    ⚠️story #3784a8d0(3038, 2026-08-25) 갱신 — 이 테스트는 원래 "비-doc gate는 work_item_summary
    enrich 0"을 단언했었는데, 그게 바로 #3038의 버그 그 자체였다(merge 카드가 "#해시"만 보이던
    실사고). story project_id 배치 쿼리에 title도 얹어 같은 쿼리 1건으로 enrich한다(새 쿼리 추가
    없음 — N+1 0 유지) — 테스트명·단언 전부 새 계약으로 갱신."""
    org, story_id, pid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = [_gate(org, story_id, "story")]
    story_batch_res = MagicMock()
    # story #3784a8d0(3038) — 이 배치 쿼리가 이제 project_id뿐 아니라 title도 같이 실어
    # 3-tuple이 됐다(work_item_summary enrich를 별도 쿼리로 안 늘리고 이 쿼리에 얹음).
    story_batch_res.all.return_value = [(story_id, pid, "스토리 제목")]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_res, story_batch_res])
    with patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        out = await list_gates(work_item_id=None, work_item_type=None, status=None,
                               assigned_to_me=False, session=session, org_id=org, auth=None)
    # story #3784a8d0(3038, 실사고 fix) — merge 게이트(work_item_type=='story')도 이제
    # work_item_summary가 채워진다(예전엔 이 테스트명대로 "no enrich"였으나, 그게 바로
    # #3038의 버그 그 자체였다 — 테스트명은 유지하되 단언은 새 계약으로 갱신).
    assert out[0].work_item_summary is not None
    assert out[0].work_item_summary.title == "스토리 제목"
    assert out[0].can_approve is False  # 비휴먼/resolve 실패 caller — authz enrich 는 여전히 skip
    assert out[0].project_id == pid  # ⭐데이터 enrich 는 caller 무관 — 근본수정 본체
    assert session.execute.await_count == 2  # gates + story project_id/title 배치(doc 쿼리·posture 는 mocked, N+1 0 유지)
