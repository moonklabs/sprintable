"""story 4717 — no database needed.

AC4: the plan's agent count lives in one place (app/services/agent_count.py) and every place that compares agents with the limit
calls it — a second hand-written count is how «the page said 1 left» and «the 402 said 0 left» would come apart again.
AC1: both recipe lists carry `agent_room` (the room before [시작]); null stays null.
"""
from __future__ import annotations

import inspect
import pathlib
import re
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

BACKEND = pathlib.Path(__file__).resolve().parents[1]


def test_the_limit_check_the_setup_and_the_room_read_all_call_the_one_count():
    from app.services import desktop_setup
    from ee import plan_limits

    for fn in (plan_limits.check_agent_add_limit, plan_limits.agent_room, desktop_setup._active_agent_count):
        assert "plan_agent_count(" in inspect.getsource(fn), fn.__qualname__


def test_the_one_count_leaves_out_the_system_publisher_only():
    from app.services import agent_count
    from app.services.system_publisher_guard import SYSTEM_PUBLISHER_RUNTIME_TYPE

    sql = str(agent_count._COUNT_SQL)
    assert "runtime_type IS NULL OR runtime_type <> :reserved" in sql  # an agent with no runtime yet is still counted
    assert SYSTEM_PUBLISHER_RUNTIME_TYPE == "system-publisher"
    assert "SYSTEM_PUBLISHER_RUNTIME_TYPE" in inspect.getsource(agent_count.plan_agent_count)


def test_no_other_agent_count_for_the_limit_is_written_by_hand():
    """The limit's count shape (agents · active · not deleted · COUNT) appears in agent_count.py and nowhere else in app/ or ee/."""
    shape = re.compile(r"COUNT\(\*\)[^\"']*FROM members[^;]*type\s*=\s*'agent'[^;]*is_active\s*=\s*true", re.S)
    hits = []
    for root in ("app", "ee"):
        for path in (BACKEND / root).rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            joined = re.sub(r"\"\s*\n\s*\"", "", text)  # adjacent string literals read as one
            if shape.search(joined):
                hits.append(str(path.relative_to(BACKEND)))
    assert hits == ["app/services/agent_count.py"], hits


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.dependencies.auth import get_current_user, get_verified_org_id_no_project_gate
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _db():
        yield AsyncMock()

    org_id = uuid.uuid4()
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = lambda: MagicMock(user_id=str(uuid.uuid4()))
    app.dependency_overrides[get_verified_org_id_no_project_gate] = lambda: org_id
    try:
        with patch("app.routers.desktop_setup._human_only", return_value=uuid.uuid4()), \
             patch("app.routers.desktop_setup.list_setup_recipes", new=AsyncMock(return_value=[])):
            yield TestClient(app), org_id
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("room", [{"limit": 3, "current": 1, "available": 2, "tier": "free"}, None])
def test_the_recipe_list_carries_the_room(client, room):
    c, org_id = client
    with patch("app.routers.desktop_setup.setup_agent_room", new=AsyncMock(return_value=room)) as read:
        r = c.get("/api/v2/desktop/recipes")
    assert r.status_code == 200, r.text
    assert r.json() == {"recipes": [], "agent_room": room}
    assert read.await_args.args[1] == org_id


def test_the_new_org_recipe_list_carries_the_free_room(client):
    c, _ = client
    room = {"limit": 3, "current": 0, "available": 3, "tier": "free"}
    with patch("app.routers.desktop_setup.setup_agent_room", new=AsyncMock(return_value=room)) as read, \
         patch("app.services.org_project_create.has_active_org", new=AsyncMock(return_value=False)), \
         patch("app.routers.desktop_setup.hit_person_limits", return_value=None):
        r = c.get("/api/v2/desktop/recipes/for-new-org")
    assert r.status_code == 200, r.text
    assert r.json() == {"recipes": [], "agent_room": room}
    assert read.await_args.args[1] is None  # no organization yet


# ── Kadir 10-16 · PO ①: no write sets the publisher's runtime_type (the count leaves it out) ──

def test_setting_the_publisher_runtime_type_is_refused_and_any_other_value_passes():
    from fastapi import HTTPException

    from app.services.system_publisher_guard import assert_runtime_type_not_reserved

    with pytest.raises(HTTPException) as exc:
        assert_runtime_type_not_reserved("system-publisher")
    assert (exc.value.status_code, exc.value.detail) == (409, {"code": "SYSTEM_PUBLISHER_RESERVED"})
    for ok in ("claude-code", "codex", None, "System-Publisher "):
        assert_runtime_type_not_reserved(ok)


@pytest.mark.anyio
async def test_the_one_write_path_refuses_it_before_writing():
    """apply_anchor_update is where PATCH · recruit · the desktop setup write runtime_type — it refuses before any SQL runs."""
    from fastapi import HTTPException

    from app.repositories.team_member import TeamMemberRepository

    session = MagicMock()
    session.execute = AsyncMock()
    repo = TeamMemberRepository(session, uuid.uuid4())
    with pytest.raises(HTTPException) as exc:
        await repo.apply_anchor_update(MagicMock(id=uuid.uuid4()), {"runtime_type": "system-publisher", "name": "x"})
    assert exc.value.status_code == 409
    session.execute.assert_not_awaited()


def test_the_patch_route_checks_before_the_run_profile_reset():
    from app.routers import team_members

    src = inspect.getsource(team_members.update_team_member)
    assert src.index("assert_runtime_type_not_reserved(") < src.index("on_runtime_changed(")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_the_guard_and_the_count_compare_the_same_exact_value():
    """Kadir ② — one constant, no normalisation on either side: what the guard refuses is exactly what the count leaves out."""
    from app.services import agent_count, system_publisher_guard

    assert "SYSTEM_PUBLISHER_RUNTIME_TYPE" in inspect.getsource(system_publisher_guard.assert_runtime_type_not_reserved)
    assert "SYSTEM_PUBLISHER_RUNTIME_TYPE" in inspect.getsource(agent_count.plan_agent_count)
    for src in (inspect.getsource(system_publisher_guard.assert_runtime_type_not_reserved), inspect.getsource(agent_count)):
        assert ".lower(" not in src and ".strip(" not in src and "ILIKE" not in src.upper().replace("LIKE ", "")


def test_runtime_type_is_written_only_where_it_is_checked():
    """Kadir ① — every place app/ writes members.runtime_type: the server's publisher insert, the one anchor write path
    (PATCH · recruit · setup — guarded), and the run profile (desktop runtimes only). A new write path makes this red."""
    writers = set()
    for path in (BACKEND / "app").rglob("*.py"):
        src = path.read_text(encoding="utf-8")
        # code statements only (a line that starts with the assignment / the insert keyword / the dict) — not prose in docstrings
        if re.search(r"(?m)^\s+\w+\.runtime_type\s*=(?!=)|^\s+runtime_type\s*=\s*\"system-publisher\"|\{\s*\"runtime_type\"\s*:", src):
            writers.add(str(path.relative_to(BACKEND)))
    assert writers == {
        "app/routers/events.py",  # the server's own «시스템 발행» insert
        "app/services/agent_run_profile.py",  # member.runtime_type = new_runtime — after check(): claude-code · codex only
        "app/services/recruit_service.py",  # → apply_anchor_update (guarded)
        "app/services/desktop_setup.py",  # → apply_anchor_update (guarded) · RUNTIME_TYPES only
    }, writers
