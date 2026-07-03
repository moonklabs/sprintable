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
    HypothesisDraftRequest,
    HypothesisLinkRequest,
    HypothesisResponse,
    HypothesisTransition,
    HypothesisUnlinkRequest,
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


@pytest.fixture(autouse=True)
def _mock_embedding_enqueue():
    """E-LOOP-LEDGER P1-S4: create/update_hypothesis가 해소 직후 enqueue_embedding을 호출
    하므로(추가 session.execute+flush), 전이 로직만 검증하는 기존 mock-session 테스트에서는
    배선 호출을 격리한다(_mock_outcome_verdicts/_mock_loop_attribution과 동일 이유)."""
    with patch("app.services.embedding_enqueue.enqueue_embedding", new=AsyncMock(return_value=None)):
        yield


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
    repo.get_sprint_id = AsyncMock(return_value=None)
    repo.add_epic_links = AsyncMock()
    repo.add_story_links = AsyncMock()
    repo.remove_epic_links = AsyncMock()
    repo.remove_story_links = AsyncMock()
    repo.set_sprint_link = AsyncMock()
    repo.remove_sprint_link = AsyncMock()
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
    # 54a8bd8a: link_hypothesis가 cross-project 가드 쿼리(epic→story)를 탄다 — same-project 반환.
    session = MagicMock()
    epic_res, story_res = MagicMock(), MagicMock()
    epic_res.all = MagicMock(return_value=[(eid, PROJECT_ID)])
    story_res.all = MagicMock(return_value=[(sid, PROJECT_ID)])
    session.execute = AsyncMock(side_effect=[epic_res, story_res])
    with p_repo, p_lookup:
        await svc.link_hypothesis(
            session, ORG_ID, HYP_ID,
            HypothesisLinkRequest(epic_ids=[eid], story_ids=[sid]),
        )
    repo.add_epic_links.assert_awaited_once_with(HYP_ID, [eid], "primary")
    repo.add_story_links.assert_awaited_once_with(HYP_ID, [sid], "supports")


# ── a4acc4d0: HypothesisSprintLink (N:1) ────────────────────────────────────────

def _session_scalar(value):
    """sprint 가드(`session.scalar`)용 mock 세션 — epic/story 가드(`session.execute().all()`)와
    호출 형태가 다르다(Sprint.project_id는 단일 스칼라 조회)."""
    session = MagicMock()
    session.scalar = AsyncMock(return_value=value)
    return session


async def test_link_sets_sprint():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    sprint_id = uuid.uuid4()
    session = _session_scalar(PROJECT_ID)  # 동일 project sprint
    with p_repo, p_lookup:
        await svc.link_hypothesis(
            session, ORG_ID, HYP_ID,
            HypothesisLinkRequest(sprint_id=sprint_id),
        )
    repo.set_sprint_link.assert_awaited_once_with(HYP_ID, sprint_id, "declared")


async def test_link_sprint_cross_project_forbidden():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    sprint_id = uuid.uuid4()
    session = _session_scalar(uuid.uuid4())  # 다른 project sprint
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.link_hypothesis(
            session, ORG_ID, HYP_ID,
            HypothesisLinkRequest(sprint_id=sprint_id),
        )
    assert ei.value.code == "CROSS_PROJECT_LINK_FORBIDDEN"
    repo.set_sprint_link.assert_not_awaited()


async def test_link_sprint_nonexistent_forbidden():
    """존재하지 않는 sprint_id — Sprint.project_id 조회가 None(스칼라 no-row)이라
    project_id와 불일치로 동일하게 거부된다(epic/story의 rowcount 대조와 동형 원칙)."""
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    session = _session_scalar(None)
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.link_hypothesis(
            session, ORG_ID, HYP_ID,
            HypothesisLinkRequest(sprint_id=uuid.uuid4()),
        )
    assert ei.value.code == "CROSS_PROJECT_LINK_FORBIDDEN"


async def test_unlink_sprint_only_when_flagged():
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    with p_repo, p_lookup:
        await svc.unlink_hypothesis(
            MagicMock(), ORG_ID, HYP_ID, HypothesisUnlinkRequest(),
        )
    repo.remove_sprint_link.assert_not_awaited()

    with p_repo, p_lookup:
        await svc.unlink_hypothesis(
            MagicMock(), ORG_ID, HYP_ID, HypothesisUnlinkRequest(unlink_sprint=True),
        )
    repo.remove_sprint_link.assert_awaited_once_with(HYP_ID)


def test_response_exposes_sprint_id():
    resp = HypothesisResponse.from_model(_hyp_stub(), [], [], None)
    assert resp.sprint_id is None
    sprint_id = uuid.uuid4()
    resp2 = HypothesisResponse.from_model(_hyp_stub(), [], [], sprint_id)
    assert resp2.sprint_id == sprint_id


# ── 54a8bd8a: cross-project 가드 service 레벨 — create/draft 경로 패리티 ─────────

def _session_one_result(rows):
    """session.execute → .all()=rows 인 mock 세션(가드 쿼리 1회용)."""
    session = MagicMock()
    res = MagicMock()
    res.all = MagicMock(return_value=rows)
    session.execute = AsyncMock(return_value=res)
    return session


async def test_create_cross_project_epic_forbidden():
    """create 경로도 cross-project epic 링크 거부 — repo.create 전 차단(orphan 0)."""
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    eid = uuid.uuid4()
    session = _session_one_result([(eid, uuid.uuid4())])  # 다른 project epic
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
        owner_member_id=OWNER_ID, epic_ids=[eid],
    )
    with p_repo, p_lookup, pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.create_hypothesis(session, ORG_ID, _caller("human"), payload)
    assert ei.value.code == "CROSS_PROJECT_LINK_FORBIDDEN"
    repo.create.assert_not_awaited()  # 가드가 repo.create 전 → orphan 가설 미생성


async def test_create_same_project_epic_ok():
    """same-project epic 링크는 정상 — 가드 통과 후 링크 생성(회귀 무영향)."""
    repo = _repo_mock(_hyp_stub())
    p_repo, p_lookup = _patch(repo, "human")
    eid = uuid.uuid4()
    session = _session_one_result([(eid, PROJECT_ID)])  # 동일 project epic
    payload = HypothesisCreate(
        project_id=PROJECT_ID, statement="s", metric_definition=VALID_METRIC,
        measure_after=datetime(2026, 7, 1, tzinfo=timezone.utc),
        owner_member_id=OWNER_ID, epic_ids=[eid],
    )
    with p_repo, p_lookup:
        await svc.create_hypothesis(session, ORG_ID, _caller("human"), payload)
    repo.create.assert_awaited_once()
    repo.add_epic_links.assert_awaited_once_with(HYP_ID, [eid], "primary")


async def test_draft_persist_cross_project_source_forbidden():
    """draft(persist) 도 source→story 링크가 cross-project면 거부(create 경유 가드)."""
    repo = _repo_mock(_hyp_stub())
    sid = uuid.uuid4()
    session = _session_one_result([(sid, uuid.uuid4())])  # 다른 project story
    members = {CALLER_HUMAN_ID: ResolvedMember(
        id=CALLER_HUMAN_ID, user_id=uuid.uuid4(), name="o", type="human",
        role="member", org_id=ORG_ID,
    )}
    payload = HypothesisDraftRequest(
        project_id=PROJECT_ID, source_type="story", source_id=sid,
        persist=True, context={"title": "x"},
    )
    with patch.object(svc, "HypothesisRepository", return_value=repo), \
         patch.object(svc, "lookup_members_by_ids", AsyncMock(return_value=members)), \
         pytest.raises(svc.HypothesisServiceError) as ei:
        await svc.draft_hypothesis(session, ORG_ID, _caller("human"), payload)
    assert ei.value.code == "CROSS_PROJECT_LINK_FORBIDDEN"
    repo.create.assert_not_awaited()


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
