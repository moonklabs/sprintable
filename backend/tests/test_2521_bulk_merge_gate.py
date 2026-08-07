"""#2521(카디르 QA 적출, PR#2905/#2906 파생): bulk_update_stories가 status 전이 時 merge-gate
(_preflight_merge_gate·enforce_gate)를 아예 안 거치고 setattr로 그대로 쓰던 결함.

근본: PATCH /{id}/status(update_story_status)는 게이트를 거치는데 PATCH /bulk(칸반 드래그·
컬럼메뉴가 실제로 타는 그 경로)는 안 거쳐 사람 승인을 우회할 수 있었다(#2156 advisory→
enforcing flip이 실효를 가지려면 이 우회로부터 먼저 닫혀야 함).

②emit_story_status_changed는 #2131이 이미 닫아서 스코프 밖(#2067 판정 그대로, PO 확認) —
이 테스트는 ①게이트 축만 검증한다. `_preflight_merge_gate`/`enforce_gate` 자신의 내부
정확성은 test_h1_s5_board_gate.py가 이미 고정하므로, 여기선 "bulk가 그 둘을 실제로
부르고 그 판정(차단/park)을 존중하는가"만 스파이로 확認한다(#2131의 emit 테스트와 동형
분리 — 각 계층은 자기 계약만 잰다)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.routers import stories as stories_mod
from app.routers.stories import BulkUpdateRequest, bulk_update_stories


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story(status="in-review", **overrides):
    now = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), epic_id=None,
        sprint_id=None, assignee_id=None, assignee_ids=[], attachments=[], meeting_id=None,
        title="t", status=status, priority="medium", story_points=None, description=None,
        acceptance_criteria=None, position=None, success_hypothesis=None, metric_definition=None,
        measure_after=None, outcome_status="n_a", outcome_result=None, is_excluded=False,
        created_at=now, updated_at=now,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _mock_db(story):
    async def _execute(stmt, *a, **kw):
        m = MagicMock()
        m.scalar_one_or_none = MagicMock(return_value=story)
        return m
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    db.flush = AsyncMock()
    db.refresh = AsyncMock()
    db.commit = AsyncMock()
    db.add = MagicMock()
    return db


def _common_patches():
    """bulk_update_stories 본문이 거치는 project-scope/actor 해소 등 무관 의존성 공용 스텁."""
    return (
        patch.object(stories_mod, "_attach_assignee_ids", AsyncMock()),
        patch.object(stories_mod, "_attach_has_evidence", AsyncMock()),
        patch.object(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None)),
        patch("app.services.project_auth.has_project_access", AsyncMock(return_value=True)),
        patch("app.services.workflow_line_engine.line_merge_gate_active", AsyncMock(return_value=False)),
    )


@pytest.mark.anyio
async def test_bulk_status_done_blocked_by_preflight_merge_gate_item_skipped():
    """⭐본체 — _preflight_merge_gate가 차단(HTTPException)하면 그 item은 조용히 스킵되고
    (setattr 미적용·결과 리스트에 없음) 나머지 요청은 안 죽는다(다건성, #2173과 동형 원칙)."""
    story = _story(status="in-review")
    db = _mock_db(story)
    repo = MagicMock()
    repo.org_id = story.org_id

    patches = _common_patches()
    with (
        patches[0], patches[1], patches[2], patches[3], patches[4],
        patch.object(
            stories_mod, "_preflight_merge_gate",
            AsyncMock(side_effect=HTTPException(status_code=409, detail="blocked")),
        ) as preflight_spy,
        patch("app.services.gate_enforce.enforce_gate", AsyncMock()) as enforce_spy,
    ):
        payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "done"}])
        result = await bulk_update_stories(
            payload, MagicMock(), db, repo, auth=MagicMock(
                user_id=str(uuid.uuid4()), claims={"app_metadata": {}},
            ),
        )

    preflight_spy.assert_awaited_once()
    enforce_spy.assert_not_awaited()  # 차단됐으니 그 뒤 enforce_gate까지 안 감.
    assert result == [], "게이트가 차단했는데 status가 그대로 적용/반환됨 — #2521 미수복"
    assert story.status == "in-review", "차단된 item의 story.status가 setattr로 바뀌면 안 됨"


@pytest.mark.anyio
async def test_bulk_status_done_passes_preflight_then_calls_enforce_gate():
    """⭐본체 — _preflight_merge_gate가 통과(AUTO_MERGE 등, 예외 無)하면 enforce_gate까지
    호출되고, 그것도 통과하면 status가 정상 적용된다."""
    story = _story(status="in-review")
    db = _mock_db(story)
    repo = MagicMock()
    repo.org_id = story.org_id

    patches = _common_patches()
    with (
        patches[0], patches[1], patches[2], patches[3], patches[4],
        patch.object(stories_mod, "_preflight_merge_gate", AsyncMock(return_value=None)) as preflight_spy,
        patch("app.services.gate_enforce.enforce_gate", AsyncMock(return_value=None)) as enforce_spy,
        patch.object(stories_mod, "emit_story_status_changed", AsyncMock()),
    ):
        payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "done"}])
        result = await bulk_update_stories(
            payload, MagicMock(), db, repo, auth=MagicMock(
                user_id=str(uuid.uuid4()), claims={"app_metadata": {}},
            ),
        )

    preflight_spy.assert_awaited_once()
    enforce_spy.assert_awaited_once()
    assert len(result) == 1 and result[0].status == "done"
    assert story.status == "done"


@pytest.mark.anyio
async def test_bulk_status_done_blocked_by_enforce_gate_item_skipped():
    """⭐본체 — _preflight_merge_gate는 통과했는데 enforce_gate(S-GATE-2)가 차단하면 그
    item도 동일하게 스킵된다(둘 다 게이트 축이라 어느 쪽이 막든 같은 결과여야 함)."""
    story = _story(status="in-review")
    db = _mock_db(story)
    repo = MagicMock()
    repo.org_id = story.org_id

    patches = _common_patches()
    with (
        patches[0], patches[1], patches[2], patches[3], patches[4],
        patch.object(stories_mod, "_preflight_merge_gate", AsyncMock(return_value=None)),
        patch(
            "app.services.gate_enforce.enforce_gate",
            AsyncMock(side_effect=HTTPException(status_code=409, detail="parked")),
        ),
    ):
        payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "done"}])
        result = await bulk_update_stories(
            payload, MagicMock(), db, repo, auth=MagicMock(
                user_id=str(uuid.uuid4()), claims={"app_metadata": {}},
            ),
        )

    assert result == []
    assert story.status == "in-review"


@pytest.mark.anyio
async def test_bulk_non_done_status_transition_skips_gate_calls():
    """회귀 0 — done이 아닌 전이(예: todo→in-progress)는 게이트 자체를 안 부른다
    (_preflight_merge_gate 자신도 new_status!="done"이면 즉시 no-op이지만, bulk가 아예
    호출을 스킵하는지까지 — 무해한 호출 낭비 자체는 회귀는 아니나 의도를 명시)."""
    story = _story(status="todo")
    db = _mock_db(story)
    repo = MagicMock()
    repo.org_id = story.org_id

    patches = _common_patches()
    with (
        patches[0], patches[1], patches[2], patches[3], patches[4],
        patch.object(stories_mod, "_preflight_merge_gate", AsyncMock(return_value=None)) as preflight_spy,
        patch("app.services.gate_enforce.enforce_gate", AsyncMock()) as enforce_spy,
        patch.object(stories_mod, "emit_story_status_changed", AsyncMock()),
    ):
        payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "in-progress"}])
        result = await bulk_update_stories(
            payload, MagicMock(), db, repo, auth=MagicMock(
                user_id=str(uuid.uuid4()), claims={"app_metadata": {}},
            ),
        )

    assert len(result) == 1 and result[0].status == "in-progress"
    enforce_spy.assert_not_awaited()  # done 아니므로 enforce_gate 자체는 안 부름.


def test_bulk_calls_shared_preflight_merge_gate_and_enforce_gate_source():
    """소스 검사 — bulk가 _preflight_merge_gate/enforce_gate를 update_story_status와 동일
    이름으로 실제 호출하는지(발행/게이트 지점을 갈라놓지 않았는지) 회귀 고정."""
    import inspect

    source = inspect.getsource(stories_mod.bulk_update_stories)
    assert "await _preflight_merge_gate(" in source
    assert "await enforce_gate(" in source
