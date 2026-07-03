"""E-LOOP-LEDGER S16 BE 갭(유나 적출, 2026-07-02): hypothesis draft source_type='loop_goal'.

S16(Goal 폼)의 "AI 초안 제안"은 유저가 방금 타이핑한 goal 텍스트에서 초안 — 백킹 엔티티가
없어 source_id가 없다. 기존 source_type(epic/story/conversation/dispatch)은 source_id
필수 그대로(회귀 방지) — loop_goal만 예외.

핵심(비-tautological): source_id 없이 draft 성공(loop_goal)·source_id 없이 draft 거부
(기존 4종, 회귀 없음을 실제로 재확인)·persist 시 source_id=None이 그대로 저장됨(mock 세션).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from app.schemas.hypothesis import HypothesisDraftRequest
from app.services import hypothesis as svc
from app.services.member_resolver import ResolvedMember

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
CALLER_ID = uuid.uuid4()
HYP_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _mock_embedding_enqueue():
    with patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock(return_value=None)):
        yield


# ── 스키마 레벨 — source_id 필수/예외 ────────────────────────────────────────────

def test_loop_goal_source_type_allows_missing_source_id():
    req = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="loop_goal", context={"title": "가입 전환율 개선"},
    )
    assert req.source_id is None


@pytest.mark.parametrize("source_type", ["epic", "story", "conversation", "dispatch"])
def test_existing_source_types_still_require_source_id(source_type):
    """⭐회귀 방지 — 기존 4종은 source_id 없으면 여전히 거부(loop_goal만 예외임을 명시 확인)."""
    with pytest.raises(ValidationError) as ei:
        HypothesisDraftRequest(project_id=PROJECT_ID, source_type=source_type, context={"title": "x"})
    assert "source_id" in str(ei.value)


@pytest.mark.parametrize("source_type", ["epic", "story", "conversation", "dispatch"])
def test_existing_source_types_with_source_id_still_succeed(source_type):
    """회귀 방지 — 기존 4종은 source_id를 주면 여전히 정상 생성(스키마 자체는 안 깨짐)."""
    req = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type=source_type, source_id=uuid.uuid4(), context={"title": "x"},
    )
    assert req.source_id is not None


# ── 서비스 레벨(mock 세션) — loop_goal persist 시 source_id=None 저장 ─────────────

def _hyp_stub(**overrides) -> SimpleNamespace:
    base = dict(
        id=HYP_ID, org_id=ORG_ID, project_id=PROJECT_ID, owner_member_id=CALLER_ID,
        created_by_member_id=CALLER_ID, confirmed_by_member_id=None,
        statement="s", metric_definition={"metric": "outcome", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc), status="proposed",
        outcome_result=None, confidence=None, source_type="loop_goal", source_id=None,
        drafted_by_member_id=None, draft_metadata=None,
        human_accounting={}, gate_contract={},
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _repo_mock(hyp: SimpleNamespace) -> AsyncMock:
    repo = AsyncMock()
    repo.create = AsyncMock(return_value=hyp)
    repo.get_epic_ids = AsyncMock(return_value=[])
    repo.get_story_ids = AsyncMock(return_value=[])
    repo.get_sprint_id = AsyncMock(return_value=None)
    repo.add_epic_links = AsyncMock()
    repo.add_story_links = AsyncMock()
    return repo


def _caller() -> ResolvedMember:
    return ResolvedMember(id=CALLER_ID, user_id=uuid.uuid4(), name="u", type="human", role="member", org_id=ORG_ID)


@pytest.mark.anyio
async def test_draft_persist_loop_goal_creates_row_with_null_source_id_and_empty_links():
    repo = _repo_mock(_hyp_stub())
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="loop_goal",
        persist=True, context={"title": "가입 전환율 개선"},
    )
    with patch.object(svc, "HypothesisRepository", return_value=repo), \
         patch.object(svc, "lookup_members_by_ids", AsyncMock(return_value={CALLER_ID: _caller()})), \
         patch("app.services.llm_client.generate_text", return_value="가입 전환율을 개선하는 실험."):
        out = await svc.draft_hypothesis(None, ORG_ID, _caller(), payload)

    assert out.statement == "가입 전환율을 개선하는 실험."
    create_kwargs = repo.create.call_args.kwargs
    assert create_kwargs["source_type"] == "loop_goal"
    assert create_kwargs["source_id"] is None
    assert create_kwargs["status"] == "proposed"
    repo.add_epic_links.assert_awaited_once_with(HYP_ID, [], "primary")
    repo.add_story_links.assert_awaited_once_with(HYP_ID, [], "supports")
