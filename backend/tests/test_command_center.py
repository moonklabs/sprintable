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


async def _get(path, *, execute_seq, member=MEMBER, org=ORG_A, resolve_raises=None):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app
    from app.routers import command_center as mod

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=list(execute_seq))

    async def override_db():
        yield session

    fastapi_app.dependency_overrides[get_db] = override_db
    fastapi_app.dependency_overrides[get_verified_org_id] = lambda: org
    # ⭐auth.user_id 를 일부러 member 와 다른 값(=users.id 모사)으로 둬, 엔드포인트가 raw user_id 가 아니라
    # canonical resolve_member 로 member.id 를 쓰는지 증명(HIGH1). resolve_member 는 patch.
    fastapi_app.dependency_overrides[get_current_user] = lambda: MagicMock(user_id=str(uuid.uuid4()))
    if resolve_raises is not None:
        resolver = AsyncMock(side_effect=resolve_raises)
    else:
        resolver = AsyncMock(return_value=MagicMock(id=member))
    try:
        with patch.object(mod, "resolve_member", new=resolver):
            async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
                resp = await c.get(path)
        return resp, session, resolver
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
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
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
async def test_my_actions_uses_canonical_member_resolver():
    """HIGH1: auth.user_id(=users.id 모사·member 와 다름) 직사용 금지 → resolve_member 로 member.id 해소."""
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=[_r_scalars([]), _r_scalars([]), _r_scalars([])])
    assert resp.status_code == 200
    resolver.assert_awaited_once()  # canonical resolver 사용(raw auth.user_id 아님).


@pytest.mark.anyio
async def test_my_actions_agent_stuck_filters_to_agent():
    """HIGH2: agent_stuck 쿼리가 resolved_member_type=='agent' 로 필터(human run 미포함)."""
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=[_r_scalars([]), _r_scalars([]), _r_scalars([])])
    assert resp.status_code == 200
    # 3번째 execute = agent_stuck 쿼리. 컴파일된 SQL 에 agent 필터(resolved_member_type)가 박혀야.
    stuck_stmt = str(session.execute.await_args_list[2].args[0])
    assert "resolved_member_type" in stuck_stmt


@pytest.mark.anyio
async def test_my_actions_clear_state():
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=[_r_scalars([]), _r_scalars([]), _r_scalars([])])
    assert resp.status_code == 200
    assert _data(resp)["is_clear"] is True


@pytest.mark.anyio
async def test_my_actions_resolver_failure_propagates():
    """member resolve 실패(미존재 등) → resolve_member 가 401/403/400 raise → 큐 쿼리 0."""
    from fastapi import HTTPException
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions", execute_seq=[],
        resolve_raises=HTTPException(status_code=400, detail="member not found"))
    assert resp.status_code == 400
    session.execute.assert_not_awaited()  # resolve 실패 → action_queue 쿼리 0.


# ── /overview ─────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_overview_real_and_pending_data():
    epic_id = uuid.uuid4()
    epic = MagicMock(id=epic_id, title="Auth epic", status="active")
    # 순서: total_agents(scalar) → epic story group(all) → epics(scalars) → hypothesis(one) → events(scalars).
    resp, session, resolver = await _get(
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
