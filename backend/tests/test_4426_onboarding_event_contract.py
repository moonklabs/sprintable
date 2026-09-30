"""story #4426 — the web's onboarding event names and the backend's accepted list are one contract.

Before: three names the web sends (`abandoned_explicit` · `desktop_handoff_selected` · `desktop_key_copied`) were not in
`EVENT_CATALOG`, so every send was a 422 — and the sender is fire-and-forget, so nobody saw it. The test reads the web's
`OnboardingEvent` union from source and pins it to `FE_EMIT_EVENTS` both ways: a name added or removed on one side only turns
this red (the same shape as the mention-entity list guard).
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.onboarding import OnboardingEventBody, post_onboarding_event
from app.services import onboarding_funnel as f

_WEB = Path(__file__).resolve().parents[2] / "apps/web/src/app/onboarding/onboarding-telemetry.ts"


def _web_event_names() -> set[str]:
    source = _WEB.read_text(encoding="utf-8")
    match = re.search(r"export type OnboardingEvent\s*=(.*?);", source, re.S)
    assert match, f"OnboardingEvent union not found in {_WEB}"
    body = re.sub(r"//[^\n]*", "", match.group(1))  # comments inside the union carry quotes too
    return set(re.findall(r"'([a-z_]+)'", body))


def test_the_web_sends_exactly_the_fe_names_the_backend_accepts():
    web = _web_event_names()
    assert web, "no names parsed"
    assert web == f.FE_EMIT_EVENTS, {"web only": sorted(web - f.FE_EMIT_EVENTS), "backend only": sorted(f.FE_EMIT_EVENTS - web)}


def test_the_catalog_is_exactly_the_fe_be_and_desktop_lists():
    assert f.EVENT_CATALOG == f.FE_EMIT_EVENTS | f.BE_EMIT_EVENTS | f.DESKTOP_SHELL_EMIT_EVENTS
    assert not f.FE_EMIT_EVENTS & f.BE_EMIT_EVENTS
    assert not f.FE_EMIT_EVENTS & f.DESKTOP_SHELL_EMIT_EVENTS
    assert not f.BE_EMIT_EVENTS & f.DESKTOP_SHELL_EMIT_EVENTS


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _db():
    db = MagicMock()
    none = MagicMock(); none.first.return_value = None  # no desktop setup behind the session id
    db.execute = AsyncMock(return_value=none)
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.flush = AsyncMock()
    return db


@pytest.mark.anyio
@pytest.mark.parametrize("event", sorted(f.FE_EMIT_EVENTS))
async def test_every_name_the_web_sends_is_accepted(event):
    """The three that were silently dropped (and the rest) are stored: 202, not 422."""
    body = OnboardingEventBody(event=event, session_id=uuid.uuid4(), meta={"flow": "onboarding"})
    db = _db()
    await post_onboarding_event(body, db=db, credentials=None, x_agent_api_key=None)
    assert db.add.called


@pytest.mark.anyio
async def test_the_sweep_counts_an_explicit_leave_as_over():
    """Qadir (4824) — once `abandoned_explicit` is stored, the sweep must not add `abandoned` for the same agent (double count).
    The terminal check the sweep runs includes it."""
    from sqlalchemy.dialects import postgresql

    agent = uuid.uuid4()
    db = MagicMock()
    db.add = MagicMock()
    db.commit = AsyncMock()
    candidates = MagicMock()
    candidates.scalars.return_value.all.return_value = [agent]
    terminal = MagicMock()
    terminal.first.return_value = (uuid.uuid4(),)  # a terminal row exists for this agent
    db.execute = AsyncMock(side_effect=[MagicMock(), candidates, terminal])
    assert await f.sweep_abandoned_onboarding(db) == 0
    db.add.assert_not_called()
    check = db.execute.await_args_list[2].args[0]
    sql = str(check.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    for event in ("verified", "abandoned", "abandoned_explicit"):
        assert f"'{event}'" in sql, sql


def test_the_desktop_setup_writes_only_names_in_the_backend_list():
    """story #4424 (PO 08:42Z) — every name the desktop setup endpoints write is a listed server-written name (the catalog is
    «every name that can be recorded»); the sending side carries this test."""
    from app.services import desktop_setup as d

    written = {d.EVENT_CODE_ISSUED, d.EVENT_CONFIRMED, d.EVENT_EXCHANGED, d.EVENT_TOOLS_CONNECTED, d.EVENT_FIRST_RESULT}
    assert written <= f.BE_EMIT_EVENTS, sorted(written - f.BE_EMIT_EVENTS)


def test_the_setup_reads_only_names_the_desktop_app_may_send():
    """The status read counts names the desktop app sends; a misspelling would count 0 silently. (`desktop_doc_opened`, read by
    the hands line, is the web's — its sending PR (4427) lists it and carries the ⊆ test.)"""
    from app.services import desktop_setup as d

    read = {d.EVENT_FIRST_TASK_HANDED, d.EVENT_WORKDIR_FALLBACK, d.EVENT_BLOCKED}
    assert read <= f.DESKTOP_SHELL_EMIT_EVENTS, sorted(read - f.DESKTOP_SHELL_EMIT_EVENTS)



_DESKTOP_META = {
    "desktop_workdir_fallback": {"hinted": True},
    "desktop_setup_blocked": {"reason": "managed_mcp", "runtime": "claude", "when": "found"},
    "desktop_first_screen_human_input": {"human_hand": True},
    "desktop_first_task_handed": {"via": "start"},
    "desktop_setup_signed_in": {},
    "desktop_agent_ended_early": {"member_id": str(uuid.uuid4()), "runtime": "claude", "exit_code": 1},
    "desktop_agent_restarted": {"member_id": str(uuid.uuid4())},
}

@pytest.mark.anyio
@pytest.mark.parametrize("event", sorted(f.DESKTOP_SHELL_EMIT_EVENTS))
async def test_every_name_the_desktop_app_sends_is_accepted(event):
    # each with the meta the app really sends (the shapes are story 4438's — tests/test_4438_desktop_meta_shapes.py)
    body = OnboardingEventBody(event=event, session_id=uuid.uuid4(), meta=_DESKTOP_META[event])
    db = _db()
    await post_onboarding_event(body, db=db, credentials=None, x_agent_api_key=None)
    assert db.add.called
