"""E-MODERN Track C: 커맨드 센터 CC-BE.1 단위(산티아고 혼합-scope checklist).

커버: /my-actions action_queue(member-private·gate_approval+review_merge·caller member_id) / attention(org
agent_stuck·enum/summary·raw 비노출) scope label 분리 · /overview org(fleet total 실·breakdown pending_data·
epics/outcome/recent 실·risk/cycle/contribution/cost pending_data) · invalid member 400 · mock 0.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_A = uuid.uuid4()
MEMBER = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _r_scalars(rows):
    r = MagicMock()
    r.scalars.return_value.all.return_value = list(rows)
    return r


def _r_scalar(val):
    r = MagicMock()
    r.scalar_one.return_value = val
    return r


def _r_all(rows):
    r = MagicMock()
    r.all.return_value = list(rows)
    return r


def _r_one(tup):
    r = MagicMock()
    r.one.return_value = tup
    return r


async def _get(path, *, execute_seq, member=MEMBER, org=ORG_A):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=list(execute_seq))

    async def override_db():
        yield session

    fastapi_app.dependency_overrides[get_db] = override_db
    fastapi_app.dependency_overrides[get_verified_org_id] = lambda: org
    fastapi_app.dependency_overrides[get_current_user] = lambda: MagicMock(
        user_id=str(member) if member else "not-a-uuid"
    )
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            resp = await c.get(path)
        return resp, session
    finally:
        fastapi_app.dependency_overrides.clear()


def _data(resp):
    body = resp.json()
    return body.get("data", body) if isinstance(body, dict) else {}


# ── /my-actions ─────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_my_actions_scope_separation_and_items():
    approval = MagicMock(gate_id=uuid.uuid4(), approval_group_id=uuid.uuid4(), kind="approver",
                         created_at=datetime(2026, 6, 23, tzinfo=timezone.utc))
    review = MagicMock(id=uuid.uuid4(), title="Ship login", status="in-review",
                       updated_at=datetime(2026, 6, 23, tzinfo=timezone.utc))
    stuck = MagicMock(entity_type="story", entity_id=uuid.uuid4(), effective_gate_type="merge",
                      started_at=datetime(2026, 6, 23, tzinfo=timezone.utc), failure_message="SECRET raw error")
    # 쿼리 순서: approvals → reviews → stuck.
    resp, _ = await _get("/api/v2/command-center/my-actions",
                         execute_seq=[_r_scalars([approval]), _r_scalars([review]), _r_scalars([stuck])])
    assert resp.status_code == 200
    d = _data(resp)
    assert d["action_queue"]["scope"] == "member"      # ⭐member-private.
    assert d["attention"]["scope"] == "org"            # ⭐org.
    types = {i["type"] for i in d["action_queue"]["items"]}
    assert types == {"gate_approval", "review_merge"}
    assert d["attention"]["items"][0]["type"] == "agent_stuck" and d["attention"]["items"][0]["auto_detected"]
    # ⭐민감 텍스트 비노출: failure_message 가 응답 어디에도 없어야.
    assert "SECRET raw error" not in resp.text
    assert "my_blockers" in d["attention"]["pending"]  # CC-BE.2 명시.


@pytest.mark.anyio
async def test_my_actions_clear_state():
    resp, _ = await _get("/api/v2/command-center/my-actions",
                         execute_seq=[_r_scalars([]), _r_scalars([]), _r_scalars([])])
    assert resp.status_code == 200
    assert _data(resp)["is_clear"] is True


@pytest.mark.anyio
async def test_my_actions_invalid_member_400():
    resp, session = await _get("/api/v2/command-center/my-actions", execute_seq=[], member=None)
    assert resp.status_code == 400
    session.execute.assert_not_awaited()  # member resolve 실패 → 쿼리 0.


# ── /overview ─────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_overview_real_and_pending_data():
    epic_id = uuid.uuid4()
    epic = MagicMock(id=epic_id, title="Auth epic", status="active")
    # 순서: total_agents(scalar) → epic story group(all) → epics(scalars) → hypothesis(one) → events(scalars).
    resp, _ = await _get(
        "/api/v2/command-center/overview",
        execute_seq=[
            _r_scalar(4),                       # total_agents
            _r_all([(epic_id, 5, 2)]),          # epic group: total 5, done 2
            _r_scalars([epic]),                 # epics
            _r_one((10, 3)),                    # hypothesis total 10, hit 3
            _r_scalars([MagicMock(verb="story.status_changed", object_type="story",
                                  object_id=uuid.uuid4(),
                                  occurred_at=datetime(2026, 6, 23, tzinfo=timezone.utc))]),
        ],
    )
    assert resp.status_code == 200
    d = _data(resp)
    assert d["scope"] == "org"
    assert d["fleet"]["total_agents"] == 4
    assert d["fleet"]["status_breakdown"] == {"status": "pending_data"}   # 신규=pending.
    assert d["project_status"]["epics"][0]["completion_pct"] == 40        # 2/5.
    assert d["project_status"]["outcome"] == {"hit": 3, "total": 10}      # 실데이터.
    assert len(d["project_status"]["recent_changes"]) == 1
    # mock-0: 신규 집계는 전부 pending_data(가짜 수치 0).
    for k in ("risk", "cycle_time", "contribution", "cost_trend"):
        assert d["project_status"][k] == {"status": "pending_data"}
