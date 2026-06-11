"""E1-S2: Hypothesis service 단위 테스트.

핵심 불변식(블루프린트 §3.1): owner는 human만·agent caller는 proposed만·전이는 모델
상태머신(§2.5) 준수·update는 status/outcome 직접 수정 금지·legacy 매핑(§2.7).

테스트 하네스는 mock 세션 기반이라 repository/member lookup을 patch해 서비스 분기 로직을
검증한다(repository SQL 정합성은 S1 실 DB 행동 테스트에서 입증). pydantic from_attributes
ValidationError 방지를 위해 hypothesis stub은 전 필드를 유효값으로 채운다.
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.hypothesis import is_valid_transition
from app.schemas.hypothesis import (
    HypothesisCreate,
    HypothesisLinkRequest,
    HypothesisResponse,
    HypothesisTransition,
    HypothesisUpdate,
)
from app.services import hypothesis as svc
from app.services.member_resolver import ResolvedMember

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OWNER_ID = uuid.uuid4()
CALLER_HUMAN_ID = uuid.uuid4()
CALLER_AGENT_ID = uuid.uuid4()
HYP_ID = uuid.uuid4()

VALID_METRIC = {"metric": "signups", "source": "manual", "target": 100, "direction": "up"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _caller(member_type: str) -> ResolvedMember:
    cid = CALLER_HUMAN_ID if member_type == "human" else CALLER_AGENT_ID
    return ResolvedMember(
        id=cid, user_id=uuid.uuid4() if member_type == "human" else None,
        name="t", type=member_type, role="member", org_id=ORG_ID,
    )


def _hyp_stub(**overrides) -> SimpleNamespace:
    base = dict(
        id=HYP_ID, org_id=ORG_ID, project_id=PROJECT_ID, owner_member_id=OWNER_ID,
        created_by_member_id=CALLER_HUMAN_ID, confirmed_by_member_id=None,
        statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc), status="proposed",
        outcome_result=None, confidence=None, source_type=None, source_id=None,
        drafted_by_member_id=None, draft_metadata=None,
        human_accounting={}, gate_contract={},
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _repo_mock(hyp: SimpleNamespace | None) -> AsyncMock:
    repo = AsyncMock()
    repo.create = AsyncMock(return_value=hyp)
    repo.get = AsyncMock(return_value=hyp)
    repo.update = AsyncMock(side_effect=lambda _id, **f: _hyp_stub(**f) if hyp is None else _hyp_stub(**{**hyp.__dict__, **f}))
    repo.get_epic_ids = AsyncMock(return_value=[])
    repo.get_story_ids = AsyncMock(return_value=[])
    repo.add_epic_links = AsyncMock()
    repo.add_story_links = AsyncMock()
    repo.remove_epic_links = AsyncMock()
    repo.remove_story_links = AsyncMock()
    return repo


def _patch(repo: AsyncMock, member_type: str | None):
    """HypothesisRepository → repo, lookup_members_by_ids → {OWNER_ID: type}."""
    members = {}
    if member_type is not None:
        members = {OWNER_ID: ResolvedMember(
            id=OWNER_ID, user_id=uuid.uuid4(), name="o", type=member_type,
            role="member", org_id=ORG_ID,
        )}
    return (
        patch.object(svc, "HypothesisRepository", return_value=repo),
        patch.object(svc, "lookup_members_by_ids", AsyncMock(return_value=members)),
    )


# ── 상태머신 (모델 단위) ───────────────────────────────────────────────────────

def test_transition_table_legal():
    assert is_valid_transition("proposed", "active")
    assert is_valid_transition("active", "measuring")
    assert is_valid_transition("measuring", "verified")
    assert is_valid_transition("measuring", "falsified")
    assert is_valid_transition("killed", "archived")


def test_transition_table_illegal():
    assert not is_valid_transition("proposed", "verified")
    assert not is_valid_transition("verified", "active")  # 역전이 금지
    assert not is_valid_transition("archived", "active")


# ── legacy 매핑 (§2.7) ────────────────────────────────────────────────────────

@pytest.mark.parametrize("legacy,expected", [
    ("pending", "active"), ("hit", "verified"), ("miss", "falsified"),
    ("n_a", None), (None, None), ("unknown", None),
])
def test_map_legacy_outcome_status(legacy, expected):
    assert svc.map_legacy_outcome_status(legacy) == expected


# ── metric validator 재사용 ───────────────────────────────────────────────────

def test_create_schema_rejects_bad_metric():
    with pytest.raises(ValueError):
        HypothesisCreate(
            project_id=PROJECT_ID, statement="s",
            metric_definition={"metric": "x"},  # source/target/direction 누락
            measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
        )


def test_create_schema_accepts_valid_metric():
    c = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    assert c.metric_definition["source"] == "manual"


# ── create: owner=human / agent=proposed ─────────────────────────────────────

async def test_create_agent_without_owner_raises():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, None)
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.create_hypothesis(MagicMock(), ORG_ID, _caller("agent"), payload)
    assert ei.value.code == "HUMAN_OWNER_REQUIRED"


async def test_create_agent_forces_proposed():
    repo = _repo_mock(_hyp_stub(status="proposed"))
    p_repo, p_lookup = _patch(repo, "human")  # owner는 human
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
        owner_member_id=OWNER_ID, status="active",  # agent가 active 요청해도 강제 proposed
    )
    with p_repo, p_lookup:
        await svc.create_hypothesis(MagicMock(), ORG_ID, _caller("agent"), payload)
    kwargs = repo.create.call_args.kwargs
    assert kwargs["status"] == "proposed"
    assert kwargs["drafted_by_member_id"] == CALLER_AGENT_ID
    assert kwargs["confirmed_by_member_id"] is None


async def test_create_nonhuman_caller_sets_drafted_by():
    """non-human caller(type이 정확히 'agent'가 아니어도)는 drafted_by 채움 — proposed 강제와 동일
    술어(`!= human`)로 정합. 가설 1호(API-key resolve type≠'agent')에서 drafted_by null 회귀 방지."""
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")  # owner는 human
    odd_caller = ResolvedMember(
        id=CALLER_AGENT_ID, user_id=None, name="k", type="api_key", role="member", org_id=ORG_ID,
    )
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc), owner_member_id=OWNER_ID,
    )
    with p_repo, p_lookup:
        await svc.create_hypothesis(MagicMock(), ORG_ID, odd_caller, payload)
    kwargs = repo.create.call_args.kwargs
    assert kwargs["drafted_by_member_id"] == CALLER_AGENT_ID  # non-human → drafted
    assert kwargs["status"] == "proposed"                     # non-human → proposed


async def test_create_human_defaults_owner_to_self():
    repo = _repo_mock(_hyp_stub())
    # owner=None → caller.id 사용. lookup은 caller.id를 human으로 응답해야 함.
    members = {CALLER_HUMAN_ID: ResolvedMember(
        id=CALLER_HUMAN_ID, user_id=uuid.uuid4(), name="o", type="human",
        role="member", org_id=ORG_ID)}
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    with patch.object(svc, "HypothesisRepository", return_value=repo), \
         patch.object(svc, "lookup_members_by_ids", AsyncMock(return_value=members)):
        await svc.create_hypothesis(MagicMock(), ORG_ID, _caller("human"), payload)
    kwargs = repo.create.call_args.kwargs
    assert kwargs["owner_member_id"] == CALLER_HUMAN_ID
    assert kwargs["created_by_member_id"] == CALLER_HUMAN_ID
    assert kwargs["status"] == "proposed"


async def test_create_owner_agent_raises():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "agent")  # owner가 agent로 해소
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc), owner_member_id=OWNER_ID,
    )
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.create_hypothesis(MagicMock(), ORG_ID, _caller("human"), payload)
    assert ei.value.code == "HUMAN_OWNER_REQUIRED"


async def test_create_invalid_status_raises():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
        owner_member_id=OWNER_ID, status="measuring",  # lifecycle 상태는 생성 불가
    )
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.create_hypothesis(MagicMock(), ORG_ID, _caller("human"), payload)
    assert ei.value.code == "INVALID_CREATE_STATUS"


async def test_create_human_active_sets_confirmed():
    repo = _repo_mock(_hyp_stub(status="active"))
    p_repo, p_lookup = _patch(repo, "human")
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
        owner_member_id=OWNER_ID, status="active",
    )
    with p_repo, p_lookup:
        await svc.create_hypothesis(MagicMock(), ORG_ID, _caller("human"), payload)
    assert repo.create.call_args.kwargs["confirmed_by_member_id"] == CALLER_HUMAN_ID


# ── transition (§2.5) ─────────────────────────────────────────────────────────

async def test_transition_illegal_raises():
    repo = _repo_mock(_hyp_stub(status="proposed"))
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.transition_hypothesis(
            MagicMock(), ORG_ID, _caller("human"), HYP_ID,
            HypothesisTransition(status="verified"),
        )
    assert ei.value.code == "INVALID_HYPOTHESIS_TRANSITION"


async def test_transition_active_requires_human():
    repo = _repo_mock(_hyp_stub(status="proposed"))
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.transition_hypothesis(
            MagicMock(), ORG_ID, _caller("agent"), HYP_ID,
            HypothesisTransition(status="active"),
        )
    assert ei.value.code == "HUMAN_CONFIRM_REQUIRED"


async def test_transition_active_by_human_sets_confirmed():
    repo = _repo_mock(_hyp_stub(status="proposed"))
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup:
        await svc.transition_hypothesis(
            MagicMock(), ORG_ID, _caller("human"), HYP_ID,
            HypothesisTransition(status="active"),
        )
    kwargs = repo.update.call_args.kwargs
    assert kwargs["status"] == "active"
    assert kwargs["confirmed_by_member_id"] == CALLER_HUMAN_ID


async def test_transition_killed_records_note():
    repo = _repo_mock(_hyp_stub(status="active"))
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup:
        await svc.transition_hypothesis(
            MagicMock(), ORG_ID, _caller("human"), HYP_ID,
            HypothesisTransition(status="killed", note="not worth it"),
        )
    assert repo.update.call_args.kwargs["outcome_result"]["reason"] == "not worth it"


# ── update: allowlist / NO_VALID_FIELDS / owner=human ─────────────────────────

async def test_update_empty_raises():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.update_hypothesis(
            MagicMock(), ORG_ID, _caller("human"), HYP_ID, HypothesisUpdate(),
        )
    assert ei.value.code == "NO_VALID_FIELDS"


async def test_update_owner_agent_raises():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "agent")  # 새 owner가 agent
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.update_hypothesis(
            MagicMock(), ORG_ID, _caller("human"), HYP_ID,
            HypothesisUpdate(owner_member_id=OWNER_ID),
        )
    assert ei.value.code == "HUMAN_OWNER_REQUIRED"


async def test_update_statement_ok():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup:
        await svc.update_hypothesis(
            MagicMock(), ORG_ID, _caller("human"), HYP_ID,
            HypothesisUpdate(statement="revised"),
        )
    assert repo.update.call_args.kwargs == {"statement": "revised"}


# ── not found ─────────────────────────────────────────────────────────────────

async def test_get_not_found_raises():
    repo = _repo_mock(None)
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.get_hypothesis(MagicMock(), ORG_ID, HYP_ID)
    assert ei.value.code == "HYPOTHESIS_NOT_FOUND"


# ── link / unlink ─────────────────────────────────────────────────────────────

async def test_link_adds_epic_and_story():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    eid, sid = uuid.uuid4(), uuid.uuid4()
    with p_repo, p_lookup:
        await svc.link_hypothesis(
            MagicMock(), ORG_ID, HYP_ID,
            HypothesisLinkRequest(epic_ids=[eid], story_ids=[sid]),
        )
    repo.add_epic_links.assert_awaited_once_with(HYP_ID, [eid], "primary")
    repo.add_story_links.assert_awaited_once_with(HYP_ID, [sid], "supports")


def test_response_exposes_draft_fields():
    """48dbada0 선행: Response가 drafted_by_member_id·draft_metadata 노출 — FE isDraft 게이팅.

    agent 초안(drafted_by 채워짐) vs 사람 생성 proposed(None) 구분이 [활성화] 버튼 게이트.
    """
    drafted = HypothesisResponse.from_model(
        _hyp_stub(drafted_by_member_id=CALLER_AGENT_ID, draft_metadata={"template": True}), [], []
    )
    assert drafted.drafted_by_member_id == CALLER_AGENT_ID
    assert drafted.draft_metadata == {"template": True}
    human_made = HypothesisResponse.from_model(_hyp_stub(), [], [])
    assert human_made.drafted_by_member_id is None and human_made.draft_metadata is None
