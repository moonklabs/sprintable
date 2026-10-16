"""story 4686 (AC3 · Yuna run-info-1014 (4)) — the org agent list says which DESKTOP agents name no model: `run_model_unset` on
/team-members (real HTTP · migrated PG · the 4424 world). True = the runtime's own default runs (no profile row, or a row whose model
is empty) · False = a model is named · None = not a desktop agent (a person · another runtime). Each claim has a test that goes red
without it (mutants in the PR)."""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    EXISTING,
    ORG,
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio


async def _flags() -> dict[str, bool | None]:
    """{member id: run_model_unset} for every member the owner's list shows."""
    async with _client() as c:
        r = await c.get("/api/v2/team-members", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        return {m["id"]: m["run_model_unset"] for m in r.json()}


async def test_01_no_profile_row_means_the_runtime_default_runs(world):
    await _sql(f"UPDATE members SET runtime_type='claude-code' WHERE id='{EXISTING}'", f"DELETE FROM agent_run_profiles WHERE member_id='{EXISTING}'")
    assert (await _flags())[str(EXISTING)] is True


async def test_02_a_named_model_is_not_unset_and_an_empty_one_is(world):
    await _sql(f"UPDATE members SET runtime_type='claude-code' WHERE id='{EXISTING}'", f"DELETE FROM agent_run_profiles WHERE member_id='{EXISTING}'")
    await _sql(f"INSERT INTO agent_run_profiles (member_id, model, effort) VALUES ('{EXISTING}', 'claude-opus-5-5', NULL)")
    assert (await _flags())[str(EXISTING)] is False
    # the row exists but names no model (an effort only) — the runtime's default still runs
    await _sql(f"UPDATE agent_run_profiles SET model=NULL, effort='high' WHERE member_id='{EXISTING}'")
    assert (await _flags())[str(EXISTING)] is True
    # an empty string is not a model either
    await _sql(f"UPDATE agent_run_profiles SET model='' WHERE member_id='{EXISTING}'")
    assert (await _flags())[str(EXISTING)] is True


async def test_03_codex_is_a_desktop_agent_too(world):
    await _sql(f"UPDATE members SET runtime_type='codex' WHERE id='{EXISTING}'", f"DELETE FROM agent_run_profiles WHERE member_id='{EXISTING}'")
    assert (await _flags())[str(EXISTING)] is True
    await _sql(f"INSERT INTO agent_run_profiles (member_id, model) VALUES ('{EXISTING}', 'gpt-5-codex')")
    assert (await _flags())[str(EXISTING)] is False


async def test_04_a_person_and_another_runtime_say_nothing(world):
    """Not a desktop agent → no verdict (None): a person has no run profile, and an agent of another runtime is not started by the app."""
    await _sql(f"UPDATE members SET runtime_type='hermes' WHERE id='{EXISTING}'", f"DELETE FROM agent_run_profiles WHERE member_id='{EXISTING}'")
    flags = await _flags()
    assert flags[str(EXISTING)] is None
    humans = (await _sql(fetch=f"SELECT id::text FROM members WHERE org_id='{ORG}' AND type='human'"))
    assert humans, "the world has a person to check"
    assert all(flags[h[0]] is None for h in humans if h[0] in flags)
    await _sql(f"UPDATE members SET runtime_type=NULL WHERE id='{EXISTING}'")
    assert (await _flags())[str(EXISTING)] is None


def test_05_a_test_double_that_answers_every_attribute_reads_none():
    """Kadir 5068's lesson (device_name): the field is set by the injection only — a MagicMock member must not fail validation."""
    from tests.test_4675_team_member_schema import _member
    from app.schemas.team_member import TeamMemberResponse

    assert TeamMemberResponse.model_validate(_member(run_model_unset=MagicMock())).run_model_unset is None
    assert TeamMemberResponse.model_validate(_member()).run_model_unset is None
    r = TeamMemberResponse.model_validate(_member()).model_copy(update={"run_model_unset": True})
    assert r.run_model_unset is True
