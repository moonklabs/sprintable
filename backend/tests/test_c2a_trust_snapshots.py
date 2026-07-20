"""story 91404248(C2a): compute_and_snapshot() lazy write-through 단위 테스트
(org-c2-trust-persistence-design §2/§3). compute_member_trust_scores()는 완전 불변 —
이 파일은 wrapper의 부수효과(session.add 호출 여부·dedup skip)만 검증한다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import trust_score as ts

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _fake_compute_result(scores):
    return {
        "member_id": str(MEMBER_ID), "scores": scores, "window_days": 90,
        "primary_source": "hypothesis_outcome", "hypothesis_hit_rate": None,
        "resolved": 0, "hit": 0, "pending": 0, "source_breakdown": {},
    }


@pytest.mark.anyio
async def test_no_scores_no_snapshot_write():
    """scores=[] (cold-start) → session.add 호출 없음."""
    session = AsyncMock()
    with patch.object(ts, "compute_member_trust_scores", new=AsyncMock(return_value=_fake_compute_result([]))):
        result = await ts.compute_and_snapshot(session, ORG_ID, MEMBER_ID)
    session.add.assert_not_called()
    assert result["scores"] == []


@pytest.mark.anyio
async def test_snapshot_written_when_no_recent_row():
    """최근 24h 내 스냅샷 없음 → session.add로 신규 행 적재."""
    session = AsyncMock()
    no_recent = MagicMock()
    no_recent.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=no_recent)
    score = {"role_key": "dev", "role_label": "개발", "hit_rate": 0.8, "resolved": 5}
    with patch.object(ts, "compute_member_trust_scores", new=AsyncMock(return_value=_fake_compute_result([score]))):
        await ts.compute_and_snapshot(session, ORG_ID, MEMBER_ID)
    session.add.assert_called_once()
    added = session.add.call_args.args[0]
    assert added.org_id == ORG_ID and added.member_id == MEMBER_ID
    assert added.role_key == "dev" and added.metrics == score


@pytest.mark.anyio
async def test_dedup_skips_write_within_24h():
    """24h 내 동일 (org,member,role) 스냅샷 존재 → session.add 호출 없음(dedup)."""
    session = AsyncMock()
    recent = MagicMock()
    recent.scalar_one_or_none.return_value = uuid.uuid4()  # 최근 행 존재
    session.execute = AsyncMock(return_value=recent)
    score = {"role_key": "dev", "role_label": "개발", "hit_rate": 0.8, "resolved": 5}
    with patch.object(ts, "compute_member_trust_scores", new=AsyncMock(return_value=_fake_compute_result([score]))):
        await ts.compute_and_snapshot(session, ORG_ID, MEMBER_ID)
    session.add.assert_not_called()


@pytest.mark.anyio
async def test_compute_member_trust_scores_formula_untouched():
    """산식 불변 회귀 — compute_and_snapshot이 compute_member_trust_scores에 정확한 인자를 그대로 전달."""
    session = AsyncMock()
    no_recent = MagicMock()
    no_recent.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=no_recent)
    inner = AsyncMock(return_value=_fake_compute_result([]))
    with patch.object(ts, "compute_member_trust_scores", new=inner):
        await ts.compute_and_snapshot(session, ORG_ID, MEMBER_ID, role_key="dev", window_days=30, include_legacy=True)
    inner.assert_awaited_once_with(session, ORG_ID, MEMBER_ID, "dev", 30, include_legacy=True)
