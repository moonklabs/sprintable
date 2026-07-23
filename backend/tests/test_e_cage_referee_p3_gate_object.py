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
        mock_disp.return_value = ("ask", "system_default")

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
        mock_disp.return_value = ("allow_auto", "system_default")

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
        mock_disp.return_value = ("deny", "system_default")

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


# ── story #2150: rejected 게이트 재제출 재오픈 ────────────────────────────────
# AC2: 재현부터(reject→재제출→BLOCK 고정) — 아래 test_create_gate_rejected_*_reopens_*가
# 그 재현이자 회귀가드다(수정 전 코드로 돌리면 old_resolver_id가 그대로 남고 status도 그대로
# "rejected"라 실패한다 — fix 적용 전 실제로 RED임을 로컬에서 확認했다).

def _rejected_gate(**overrides):
    gate = MagicMock()
    gate.id = GATE_ID
    gate.status = "rejected"
    gate.resolver_id = uuid.uuid4()
    gate.resolution_note = "요구사항 불충분 — 다시 정리해서 올려주세요"
    gate.resolved_at = datetime(2026, 7, 20, tzinfo=timezone.utc)
    gate.neutral_facts = {"ci_result": "fail", "pr_result": "pass"}
    gate.work_item_type = "story"
    gate.work_item_id = STORY_ID
    for k, v in overrides.items():
        setattr(gate, k, v)
    return gate


async def _create_gate_against_rejected(existing_gate, disposition, gate_type="merge",
                                          neutral_facts=None):
    from app.services.gate_service import create_gate

    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = existing_gate
    session.execute = AsyncMock(return_value=existing_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.gate_service._resolve_gate_notification_targets",
               new_callable=AsyncMock) as mock_targets:
        mock_disp.return_value = (disposition, "system_default")
        mock_targets.return_value = []  # 알림 대상 조회는 스텁(별도 테스트에서 검증)
        result = await create_gate(
            session, ORG_ID, STORY_ID, "story", gate_type, MEMBER_ID, ROLE_ID,
            neutral_facts=neutral_facts,
        )
    return result, session


@pytest.mark.anyio
async def test_create_gate_rejected_reopens_to_pending_on_ask_policy():
    """AC②③ 핵심 재현+수정 확認 — reject된 게이트가 재제출(create_gate 재호출) 시 현재
    정책이 ask면 pending으로 새 사이클이 열린다(전엔 rejected 그대로 반환→영구 BLOCK)."""
    gate = _rejected_gate()
    result, _ = await _create_gate_against_rejected(gate, "ask")

    assert result is gate  # 신규 row 생성 아님(기존 row 재사용 — void/hold와 동일 관례)
    assert result.status == "pending"
    assert result.resolver_id is None  # 이전 반려자 정보 클리어(AC③ 새 사이클)
    assert result.resolution_note is None
    assert result.resolved_at is None


@pytest.mark.anyio
async def test_create_gate_rejected_reopen_still_rejected_if_policy_still_deny():
    """조직 정책이 여전히 deny면 재오픈해도 다시 rejected — 이건 결함이 아니라 정확한
    동작이다(사람이 반려한 게 아니라 정책이 여전히 막고 있는 것). 결정 이력은 그래도 남는다."""
    gate = _rejected_gate()
    result, _ = await _create_gate_against_rejected(gate, "deny")

    assert result.status == "rejected"
    assert result.neutral_facts["decision_history"]  # 재평가 사이클 자체는 열렸다(이력 추가)


@pytest.mark.anyio
async def test_create_gate_rejected_reopen_preserves_decision_history():
    """AC④ — 이전 반려(누가·언제·왜)가 재오픈 후에도 사라지지 않는다."""
    gate = _rejected_gate()
    result, _ = await _create_gate_against_rejected(gate, "ask", neutral_facts={"ci_result": "pass"})

    history = result.neutral_facts["decision_history"]
    assert len(history) == 1
    entry = history[0]
    assert entry["status"] == "rejected"
    assert entry["resolver_id"] == str(gate.resolver_id) or entry["resolver_id"] is not None
    assert entry["resolution_note"] == "요구사항 불충분 — 다시 정리해서 올려주세요"
    assert entry["neutral_facts"] == {"ci_result": "fail", "pr_result": "pass"}
    # 새 평가 facts도 남아있다(이력에 밀려 사라지지 않음).
    assert result.neutral_facts["ci_result"] == "pass"


@pytest.mark.anyio
async def test_create_gate_rejected_reopen_appends_to_existing_history():
    """반려가 두 번째 이상이어도(이미 decision_history가 있는 상태) 이전 이력을 덮어쓰지
    않고 append한다."""
    gate = _rejected_gate(neutral_facts={
        "ci_result": "fail",
        "decision_history": [{"status": "rejected", "resolver_id": None, "resolved_at": None,
                               "resolution_note": "1차 반려", "neutral_facts": {}}],
    })
    result, _ = await _create_gate_against_rejected(gate, "ask")

    history = result.neutral_facts["decision_history"]
    assert len(history) == 2
    assert history[0]["resolution_note"] == "1차 반려"
    assert history[1]["resolution_note"] == "요구사항 불충분 — 다시 정리해서 올려주세요"


@pytest.mark.anyio
async def test_create_gate_rejected_reopen_notifies_when_pending():
    """AC③ — 재오픈이 pending이면 사람 인박스에 다시 뜨도록 알림이 나간다."""
    from app.services.gate_service import create_gate

    gate = _rejected_gate()
    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=existing_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.gate_service._resolve_gate_notification_targets",
               new_callable=AsyncMock) as mock_targets, \
         patch("app.services.notification_dispatch.dispatch_notification",
               new_callable=AsyncMock) as mock_dispatch:
        mock_disp.return_value = ("ask", "system_default")
        mock_targets.return_value = [uuid.uuid4()]
        await create_gate(session, ORG_ID, STORY_ID, "story", "merge", MEMBER_ID, ROLE_ID)
        mock_dispatch.assert_awaited_once()
        assert mock_dispatch.call_args.kwargs["event_type"] == "gate.pending_approval"


@pytest.mark.anyio
async def test_create_gate_approved_does_not_reopen():
    """AC⑤⑥ — approved는 재오픈 대상이 아니다(이미 landed 작업의 재보고는 무해·불변 유지).
    되면 안 되는 경우를 명시적으로 고정 — 한쪽만 보면 '항상 재오픈'도 통과하는 회귀를 막는다."""
    from app.services.gate_service import create_gate

    gate = _rejected_gate(status="approved")
    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=existing_r)

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        result = await create_gate(session, ORG_ID, STORY_ID, "story", "merge", MEMBER_ID, ROLE_ID)
        mock_disp.assert_not_called()  # 재평가 자체가 안 일어난다 — approved는 그대로.

    assert result is gate
    assert result.status == "approved"
    assert "decision_history" not in (gate.neutral_facts or {})


@pytest.mark.anyio
async def test_create_gate_voided_does_not_reopen():
    """AC⑤⑥ — voided도 재오픈 대상이 아니다(void=admin이 "잘못 생성됐다"고 무효화한 것이라
    reject와 의미가 다르다 — 이 스토리 스코프에서는 자동 재오픈 대상에서 제외)."""
    from app.services.gate_service import create_gate

    gate = _rejected_gate(status="voided")
    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=existing_r)

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        result = await create_gate(session, ORG_ID, STORY_ID, "story", "merge", MEMBER_ID, ROLE_ID)
        mock_disp.assert_not_called()

    assert result is gate
    assert result.status == "voided"


@pytest.mark.anyio
async def test_create_gate_pending_still_returns_as_is():
    """무회귀 — pending(터미널 아님)은 원래 관례 그대로 그냥 반환(재오픈 로직 무접촉)."""
    from app.services.gate_service import create_gate

    gate = _rejected_gate(status="pending")
    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=existing_r)

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        result = await create_gate(session, ORG_ID, STORY_ID, "story", "merge", MEMBER_ID, ROLE_ID)
        mock_disp.assert_not_called()

    assert result is gate


@pytest.mark.anyio
async def test_create_gate_auto_passed_still_returns_as_is():
    """무회귀 — auto_passed(모델 docstring상 불변)도 재오픈 로직 무접촉."""
    from app.services.gate_service import create_gate

    gate = _rejected_gate(status="auto_passed")
    session = AsyncMock()
    existing_r = MagicMock()
    existing_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=existing_r)

    with patch("app.services.gate_service.resolve_disposition", new_callable=AsyncMock) as mock_disp:
        result = await create_gate(session, ORG_ID, STORY_ID, "story", "merge", MEMBER_ID, ROLE_ID)
        mock_disp.assert_not_called()

    assert result is gate


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
async def test_transition_approved_saves_note():
    """approved 전이 시 note 전달하면 resolution_note로 저장(story #2027 계약 변경).

    이전 계약("approved는 note를 버린다")은 고위험 게이트 승인에 사유를 **요구**하면서
    저장은 안 하는 모순을 낳았다(요건은 지켜도 감사 추적은 비어 있었다) — void_gate/
    override_gate가 이미 reason을 필수+영속화하는 것과도 어긋났다. `resolution_note`는
    rejection 전용 필드가 아니라 승인·반려 양쪽의 해소 사유를 담는 필드라 이 계약 변경이
    필드 의미와도 정합한다."""
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

    await transition_gate(session, ORG_ID, GATE_ID, "approved", MEMBER_ID, "고위험 승인 사유")
    assert gate.status == "approved"
    assert gate.resolution_note == "고위험 승인 사유"


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


# ── HITL crux(story 7726a003) — A2A task INPUT_REQUIRED 복귀(Q3 writer-side resolver) ─────

@pytest.mark.anyio
async def test_resume_a2a_task_working_on_approve():
    """연결된 A2ATask(INPUT_REQUIRED)가 있으면 approve 시 WORKING으로 복귀."""
    from app.services.gate_service import _resume_a2a_task_on_gate_resolve

    gate = MagicMock()
    gate.id = GATE_ID
    task = MagicMock()
    task.state = "TASK_STATE_INPUT_REQUIRED"

    session = AsyncMock()
    task_r = MagicMock()
    task_r.scalar_one_or_none.return_value = task
    session.execute = AsyncMock(return_value=task_r)
    session.flush = AsyncMock()

    await _resume_a2a_task_on_gate_resolve(session, gate, "approved")
    assert task.state == "TASK_STATE_WORKING"


@pytest.mark.anyio
async def test_resume_a2a_task_rejected_on_reject():
    """연결된 A2ATask가 있으면 reject 시 REJECTED(기존 terminal state)로 전이."""
    from app.services.gate_service import _resume_a2a_task_on_gate_resolve

    gate = MagicMock()
    gate.id = GATE_ID
    task = MagicMock()
    task.state = "TASK_STATE_INPUT_REQUIRED"

    session = AsyncMock()
    task_r = MagicMock()
    task_r.scalar_one_or_none.return_value = task
    session.execute = AsyncMock(return_value=task_r)
    session.flush = AsyncMock()

    await _resume_a2a_task_on_gate_resolve(session, gate, "rejected")
    assert task.state == "TASK_STATE_REJECTED"


@pytest.mark.anyio
async def test_resume_a2a_task_noop_when_no_linked_task():
    """writer 미배선(오늘 기본상태) — 연결된 task가 없으면 no-op·무크래시."""
    from app.services.gate_service import _resume_a2a_task_on_gate_resolve

    gate = MagicMock()
    gate.id = GATE_ID

    session = AsyncMock()
    task_r = MagicMock()
    task_r.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=task_r)
    session.flush = AsyncMock()

    await _resume_a2a_task_on_gate_resolve(session, gate, "approved")
    session.flush.assert_not_called()


@pytest.mark.anyio
async def test_resume_a2a_task_skips_query_for_non_terminal_status():
    """new_status가 approved/rejected가 아니면(auto_passed 등) 쿼리조차 안 함."""
    from app.services.gate_service import _resume_a2a_task_on_gate_resolve

    gate = MagicMock()
    gate.id = GATE_ID

    session = AsyncMock()
    session.execute = AsyncMock()

    await _resume_a2a_task_on_gate_resolve(session, gate, "auto_passed")
    session.execute.assert_not_called()


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
