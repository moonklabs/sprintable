"""E1-S6: dispatch hypothesis anchor 단위 테스트 (블루프린트 §5).

anchor dict 평탄화·content 한 줄 포맷(truncate/절 생략/날짜)·resolve_dispatch_anchor 위임.
resolve_primary_anchor의 link 해소(story primary→epic fallback·active 우선·최신순) SQL은
실 DB 스모크에서 검증.
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import hypothesis as svc

HID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _hyp(**ov):
    base = dict(
        id=HID, statement="가입 전환율을 높인다", status="active",
        metric_definition={"metric": "signups", "source": "manual", "target": 100, "direction": "up"},
        measure_after=datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc),
    )
    base.update(ov)
    return SimpleNamespace(**base)


def test_build_anchor_dict_flattens_metric():
    a = svc.build_anchor_dict(_hyp())
    assert a == {
        "id": str(HID), "statement": "가입 전환율을 높인다", "status": "active",
        "metric": "signups", "target": 100, "direction": "up",
        "measure_after": "2026-07-01T12:00:00+00:00",
    }


def test_build_anchor_dict_handles_empty_metric():
    a = svc.build_anchor_dict(_hyp(metric_definition=None, measure_after=None))
    assert a["metric"] is None and a["target"] is None and a["measure_after"] is None


def test_format_anchor_line_full():
    a = svc.build_anchor_dict(_hyp())
    assert svc.format_anchor_line(a) == "[hypothesis] 가입 전환율을 높인다 — signups up 100 by 2026-07-01"


def test_format_anchor_line_truncates_statement_160():
    long = "x" * 200
    line = svc.format_anchor_line(svc.build_anchor_dict(_hyp(statement=long)))
    # [hypothesis] + 160 x's + metric part
    assert ("x" * 160) in line and ("x" * 161) not in line


def test_format_anchor_line_omits_missing_metric_and_date():
    a = {"statement": "s", "metric": None, "direction": None, "target": None, "measure_after": None}
    assert svc.format_anchor_line(a) == "[hypothesis] s"


def test_format_anchor_line_partial_metric_no_date():
    a = {"statement": "s", "metric": "signups", "direction": "up", "target": 50, "measure_after": None}
    assert svc.format_anchor_line(a) == "[hypothesis] s — signups up 50"


async def test_resolve_dispatch_anchor_returns_dict():
    repo = MagicMock()
    repo.resolve_primary_anchor = AsyncMock(return_value=_hyp())
    with patch.object(svc, "HypothesisRepository", return_value=repo):
        a = await svc.resolve_dispatch_anchor(MagicMock(), uuid.uuid4(), "story", uuid.uuid4())
    assert a["id"] == str(HID) and a["metric"] == "signups"


async def test_resolve_dispatch_anchor_none_when_no_primary():
    repo = MagicMock()
    repo.resolve_primary_anchor = AsyncMock(return_value=None)
    with patch.object(svc, "HypothesisRepository", return_value=repo):
        a = await svc.resolve_dispatch_anchor(MagicMock(), uuid.uuid4(), "epic", uuid.uuid4())
    assert a is None
