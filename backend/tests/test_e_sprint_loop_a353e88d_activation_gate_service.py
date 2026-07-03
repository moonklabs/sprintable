"""E-SPRINT-LOOP a353e88d: sprint-open 定 — planning→active 게이트(≥1 생존 가설) 서비스 단위.

핵심 불변식: 게이트는 transition_sprint(SSOT) 안에 있어 to_status=="active"·
from_status=="planning" 조합에서만 발동(다른 전이는 영향 없음). 생존 상태(killed/archived
제외)만 카운트(PO 결 2026-07-03) — mock session이라 SQL WHERE 절 자체는 실측이 아니라
realdb 스위트(test_e_sprint_loop_a353e88d_activation_gate_realdb.py)에서 검증하고, 여기선
게이트의 분기 로직(있음/없음 → 통과/차단)만 빠르게 커버한다."""
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import sprint as svc
from app.services.member_resolver import ResolvedMember

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
SPRINT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _caller(member_type: str = "human") -> ResolvedMember:
    return ResolvedMember(
        id=uuid.uuid4(), user_id=uuid.uuid4() if member_type == "human" else None,
        name="t", type=member_type, role="member", org_id=ORG_ID,
    )


def _mock_sprint(status: str = "planning") -> SimpleNamespace:
    return SimpleNamespace(id=SPRINT_ID, org_id=ORG_ID, project_id=PROJECT_ID, status=status)


def _mock_session(scalar_return) -> MagicMock:
    """게이트 쿼리(session.scalar)만 통제 — 이후 overlay/apply 경로는 별도 patch로 격리."""
    session = MagicMock()
    session.scalar = AsyncMock(return_value=scalar_return)
    session.commit = AsyncMock()
    return session


def _patch_repo(sprint, activated=None):
    repo = MagicMock()
    repo.get = AsyncMock(return_value=sprint)
    repo.activate = AsyncMock(return_value=activated or _mock_sprint("active"))
    return patch.object(svc, "SprintRepository", return_value=repo), repo


async def test_activate_blocked_when_no_hypothesis_linked():
    sprint = _mock_sprint("planning")
    session = _mock_session(scalar_return=None)  # 링크 0건
    p_repo, repo = _patch_repo(sprint)
    with p_repo:
        with pytest.raises(svc.SprintTransitionError) as ei:
            await svc.transition_sprint(session, ORG_ID, _caller(), SPRINT_ID, "active")
    assert ei.value.code == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION"
    repo.activate.assert_not_awaited()  # 게이트가 apply 전에 막음


async def test_activate_succeeds_when_hypothesis_linked():
    sprint = _mock_sprint("planning")
    session = _mock_session(scalar_return=uuid.uuid4())  # 링크 존재(더미 link id)
    p_repo, repo = _patch_repo(sprint)
    with p_repo:
        result = await svc.transition_sprint(session, ORG_ID, _caller(), SPRINT_ID, "active")
    assert result.status == "active"
    repo.activate.assert_awaited_once_with(SPRINT_ID)


async def test_gate_only_applies_to_planning_to_active():
    """다른 전이(예: active→closed)는 게이트 쿼리 자체를 안 탄다(회귀 0 — 범위 최소화)."""
    sprint = _mock_sprint("active")
    session = MagicMock()
    session.scalar = AsyncMock(side_effect=AssertionError("게이트 쿼리가 호출되면 안 됨"))
    session.commit = AsyncMock()
    repo = MagicMock()
    repo.get = AsyncMock(return_value=sprint)
    repo.close = AsyncMock(return_value=_mock_sprint("closed"))
    with patch.object(svc, "SprintRepository", return_value=repo):
        result = await svc.transition_sprint(session, ORG_ID, _caller(), SPRINT_ID, "closed")
    assert result.status == "closed"
    session.scalar.assert_not_called()


async def test_via_gate_true_still_enforces_hypothesis_gate():
    """via_gate=True(overlay 승인 적용 경로)는 human-only inline만 skip하지, ≥1 가설 게이트는
    여전히 통과해야 한다 — 우회 축이 아님을 명시 검증."""
    sprint = _mock_sprint("planning")
    session = _mock_session(scalar_return=None)
    p_repo, repo = _patch_repo(sprint)
    with p_repo:
        with pytest.raises(svc.SprintTransitionError) as ei:
            await svc.transition_sprint(
                session, ORG_ID, _caller(), SPRINT_ID, "active", via_gate=True
            )
    assert ei.value.code == "HYPOTHESIS_REQUIRED_FOR_ACTIVATION"
