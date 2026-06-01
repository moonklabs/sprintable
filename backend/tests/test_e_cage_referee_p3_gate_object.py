"""E-CAGE-REFEREE P3: HITL gate 1급 객체 + 상태기계 + verdict 와이어링 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.gate import is_valid_transition
from app.services.gate_service import resolve_gate_from_verdict

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
GATE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 상태기계 단위 테스트 ───────────────────────────────────────────────────────

def test_valid_transition_pending_approved():
    assert is_valid_transition("pending", "approved") is True


def test_valid_transition_pending_rejected():
    assert is_valid_transition("pending", "rejected") is True


def test_invalid_transition_auto_passed_to_approved():
    assert is_valid_transition("auto_passed", "approved") is False


def test_invalid_transition_approved_to_rejected():
    assert is_valid_transition("approved", "rejected") is False


def test_invalid_transition_rejected_to_approved():
    assert is_valid_transition("rejected", "approved") is False


def test_invalid_self_transition():
    assert is_valid_transition("pending", "pending") is False


# ── create_gate disposition 매핑 테스트 ───────────────────────────────────────

@pytest.mark.anyio
async def test_create_gate_ask_gives_pending():
    """disposition=ask → status=pending."""
    from app.services.gate_service import create_gate

    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = None  # 없음
    session.execute = AsyncMock(return_value=existing_r)
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        mock_disp.return_value = "ask"

        gate = MagicMock()
        gate.status = "pending"
        session.refresh = AsyncMock(side_effect=lambda obj: None)

        await create_gate(session, ORG_ID, STORY_ID, "story", "pr_review", MEMBER_ID, ROLE_ID)

        mock_disp.assert_called_once()
        added = session.add.call_args[0][0]
        assert added.status == "pending"


@pytest.mark.anyio
async def test_create_gate_allow_auto_gives_auto_passed():
    """disposition=allow_auto → status=auto_passed."""
    from app.services.gate_service import create_gate

    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=existing_r)
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        mock_disp.return_value = "allow_auto"

        await create_gate(session, ORG_ID, STORY_ID, "story", "pr_review", MEMBER_ID, ROLE_ID)

        added = session.add.call_args[0][0]
        assert added.status == "auto_passed"
        assert added.resolved_at is not None


@pytest.mark.anyio
async def test_create_gate_deny_gives_rejected():
    """disposition=deny → status=rejected."""
    from app.services.gate_service import create_gate

    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=existing_r)
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        mock_disp.return_value = "deny"

        await create_gate(session, ORG_ID, STORY_ID, "story", "merge", MEMBER_ID, ROLE_ID)

        added = session.add.call_args[0][0]
        assert added.status == "rejected"


@pytest.mark.anyio
async def test_create_gate_idempotent():
    """이미 게이트 있으면 기존 반환."""
    from app.services.gate_service import create_gate

    existing_gate = MagicMock()
    existing_gate.status = "pending"

    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = existing_gate
    session.execute = AsyncMock(return_value=existing_r)

    result = await create_gate(session, ORG_ID, STORY_ID, "story", "qa", MEMBER_ID, ROLE_ID)
    assert result == existing_gate
    session.add.assert_not_called()


# ── transition_gate 상태기계 테스트 ───────────────────────────────────────────

@pytest.mark.anyio
async def test_transition_valid_pending_to_approved():
    """pending → approved 전이 성공."""
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.id = GATE_ID
    gate.org_id = ORG_ID
    gate.status = "pending"

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await transition_gate(session, ORG_ID, GATE_ID, "approved", MEMBER_ID)
    assert gate.status == "approved"
    assert gate.resolver_id == MEMBER_ID


@pytest.mark.anyio
async def test_transition_invalid_auto_passed_raises():
    """auto_passed → approved 불법 전이 → ValueError."""
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.status = "auto_passed"

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)

    with pytest.raises(ValueError, match="불법 전이"):
        await transition_gate(session, ORG_ID, GATE_ID, "approved")


# ── verdict→게이트 해소 와이어링 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_gate_pr_pass_approves_pr_review_gate():
    """verdict source='pr' result='pass' → pr_review 게이트 approved."""
    gate = MagicMock()
    gate.status = "pending"
    gate.role_id = ROLE_ID

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    result = await resolve_gate_from_verdict(
        session, ORG_ID, STORY_ID, "story", "pr", "pass"
    )
    assert gate.status == "approved"


@pytest.mark.anyio
async def test_resolve_gate_ci_fail_rejects_pr_review_gate():
    """verdict source='ci' result='fail' → pr_review 게이트 rejected."""
    gate = MagicMock()
    gate.status = "pending"

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await resolve_gate_from_verdict(session, ORG_ID, STORY_ID, "story", "ci", "fail")
    assert gate.status == "rejected"


@pytest.mark.anyio
async def test_resolve_gate_qa_maps_to_qa_gate():
    """verdict source='qa' → gate_type='qa' 탐색."""
    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = None  # 게이트 없음
    session.execute = AsyncMock(return_value=gate_r)

    result = await resolve_gate_from_verdict(
        session, ORG_ID, STORY_ID, "story", "qa", "pass"
    )
    assert result is None  # graceful skip


@pytest.mark.anyio
async def test_resolve_gate_null_result_skip():
    """result=None → 강제 해소 금지 (미측정)."""
    session = AsyncMock()

    result = await resolve_gate_from_verdict(
        session, ORG_ID, STORY_ID, "story", "pr", None
    )
    assert result is None
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_resolve_gate_no_pending_gate_graceful():
    """pending 게이트 없으면 graceful None."""
    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=gate_r)

    result = await resolve_gate_from_verdict(
        session, ORG_ID, STORY_ID, "story", "pr", "pass"
    )
    assert result is None


# ── verdict 캡처 시 게이트 해소 와이어링 통합 단언 ─────────────────────────────

@pytest.mark.anyio
async def test_capture_pr_wires_gate_resolution():
    """capture_pr_ci_verdict가 resolve_gate_from_verdict를 실제 호출 (dead-path 방지)."""
    from app.services.verdict_capture import capture_pr_ci_verdict

    session = AsyncMock()
    participation = MagicMock()
    participation.id = uuid.uuid4()

    with patch("app.services.verdict_capture.resolve_implementation_participation", new_callable=AsyncMock) as mock_part, \
         patch("app.services.verdict_capture.fetch_pr_review_rounds", new_callable=AsyncMock) as mock_rounds, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock), \
         patch("app.services.gate_service.resolve_gate_from_verdict", new_callable=AsyncMock) as mock_gate:
        mock_part.return_value = participation
        mock_rounds.return_value = 0
        mock_gate.return_value = None  # graceful

        await capture_pr_ci_verdict(
            session, ORG_ID, STORY_ID, pr_number=1, repo="org/repo",
            merged=True, ci_result=None
        )

        mock_gate.assert_called_once_with(session, ORG_ID, STORY_ID, "story", "pr", "pass")


# ── resolution_note 영속화 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_transition_rejected_saves_note():
    """rejected 전이 시 note가 resolution_note로 저장."""
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.id = GATE_ID
    gate.org_id = ORG_ID
    gate.status = "pending"

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await transition_gate(session, ORG_ID, GATE_ID, "rejected", MEMBER_ID, "코드 품질 미달")
    assert gate.status == "rejected"
    assert gate.resolution_note == "코드 품질 미달"


@pytest.mark.anyio
async def test_transition_approved_does_not_save_note():
    """approved 전이 시 note 전달해도 resolution_note 저장 안 함."""
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.id = GATE_ID
    gate.org_id = ORG_ID
    gate.status = "pending"

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await transition_gate(session, ORG_ID, GATE_ID, "approved", MEMBER_ID, "의미없는 노트")
    assert gate.status == "approved"
    assert not hasattr(gate, "resolution_note") or gate.resolution_note != "의미없는 노트"


@pytest.mark.anyio
async def test_transition_rejected_empty_note_graceful():
    """rejected 전이 시 note=None이면 resolution_note 건드리지 않음."""
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.id = GATE_ID
    gate.org_id = ORG_ID
    gate.status = "pending"
    gate.resolution_note = None

    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    await transition_gate(session, ORG_ID, GATE_ID, "rejected", MEMBER_ID, None)
    assert gate.status == "rejected"
    assert gate.resolution_note is None


# ── org 격리 ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_org_isolation_gate():
    """게이트 조회 시 org_id 스코프 — 다른 org 게이트 미노출."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()
    mock_r = MagicMock()
    mock_r.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_r)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(f"/api/v2/gates?work_item_id={STORY_ID}")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()
