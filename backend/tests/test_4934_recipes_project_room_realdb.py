"""story 4934 — GET /desktop/recipes tells the solo card BEFORE the first press whether a new project can still be made (real HTTP · migrated PG).

The card used to learn «무료 플랜은 프로젝트가 하나예요» only from the 402 of its first [만들기] press. The read now carries `project_room` — the
SAME rule (`check_project_create_allowed`) and the SAME name lookup as that 402, so nothing more is shown than the 402 already hands the same person:
 ㉠ same rule · same gate as the POST: an owner/admin of a free organization with its one project reads {limit, existing_project}, and it equals what
   confirm-solo's 402 names; room left (the plan's check passes) or no limit enforced (OSS) → null
 ㉡ only the block and that one project's id · name — never a second project's data (two projects → no name; a project the person cannot open → no name)
 ㉢ a member who cannot confirm (not owner/admin) → null; a person from another organization is refused exactly as the read refuses them today."""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    ORG,
    OWNER,
    PLAIN,
    PROJ,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4711_solo_setup_realdb import _confirm_solo, _solo_code  # noqa: F401
from tests.test_4565_attach_existing_agent_realdb import _live_keys, _plain_key, attachable  # noqa: F401

OUTSIDER = None  # filled from the 4424 world below (an admin of the OTHER organization)


async def _read(c, who=OWNER, org=ORG):
    return await c.get("/api/v2/desktop/recipes", headers=_person(who, org))


@pytest.fixture
async def free_ee(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    yield


@pytest.mark.anyio
async def test_a_free_org_admin_reads_the_block_and_the_one_project_the_402_would_name(world, free_ee):
    async with _client() as c:
        r = await _read(c)
        assert r.status_code == 200, r.text
        room = r.json()["project_room"]
        assert room == {"limit": 1, "existing_project": {"id": str(PROJ), "name": "P"}}, r.text  # ㉠ ㉡ the one project, nothing else of it
        # ㉠ the same person's confirm-solo 402 for a new folder names exactly that
        code, _, _ = await _solo_code(c, "d4934 same as 402")
        r402 = await _confirm_solo(c, code, {"runtime": "claude", "project_name": "second-folder"})
        assert r402.status_code == 402, r402.text
        assert r402.json()["error"]["existing_project"] == room["existing_project"]


@pytest.mark.anyio
async def test_room_left_or_no_limit_enforced_is_null(world, free_ee, monkeypatch):
    async def allowed(_db, _org):
        return None

    async with _client() as c:
        monkeypatch.setattr("ee.plan_limits.check_project_create_limit", allowed)  # the plan has room: the same check passes
        r = await _read(c)
        assert r.status_code == 200 and r.json()["project_room"] is None, r.text
    from app.core.config import settings

    monkeypatch.undo()
    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: False))  # OSS: nothing is enforced
    async with _client() as c:
        r = await _read(c)
        assert r.status_code == 200 and r.json()["project_room"] is None, r.text


@pytest.mark.anyio
async def test_two_projects_name_none_and_a_member_who_cannot_confirm_reads_nothing(world, free_ee):
    await _sql(f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES (gen_random_uuid(),'{ORG}','P2','d4934-p2','warn')")
    try:
        async with _client() as c:
            r = await _read(c)
            assert r.status_code == 200, r.text
            assert r.json()["project_room"] == {"limit": 1, "existing_project": None}, r.text  # ㉡ blocked, but no single project to name
            plain = await _read(c, who=PLAIN)
            assert plain.status_code == 200, plain.text
            assert plain.json()["project_room"] is None, plain.text  # ㉢ not owner/admin: the same gate as confirm-solo — told nothing
    finally:
        await _sql(f"DELETE FROM projects WHERE org_id='{ORG}' AND slug='d4934-p2'")


@pytest.mark.anyio
async def test_a_project_the_person_cannot_open_is_not_named(world, free_ee):
    await _sql(f"DELETE FROM project_access WHERE project_id='{PROJ}'")  # the owner has no access row here (and an owner reads through the org role — so check the name rule directly)
    from app.services import desktop_setup as svc

    async def no_access(_db, _user, _project, _org):
        return False

    import app.services.project_auth as pa

    orig = pa.has_project_access
    pa.has_project_access = no_access
    try:
        async with _client() as c:
            r = await _read(c)
            assert r.status_code == 200, r.text
            assert r.json()["project_room"] == {"limit": 1, "existing_project": None}, r.text  # ㉡ the block is said · the project is not
    finally:
        pa.has_project_access = orig
        assert svc  # the module the rule lives in


@pytest.mark.anyio
async def test_a_person_from_another_organization_is_refused_as_the_read_refuses_them_today(world, free_ee):
    outsider = (await _sql(fetch="SELECT id FROM users WHERE email='out@d4424.test'"))[0][0]
    async with _client() as c:
        r = await _read(c, who=outsider, org=ORG)  # an admin of the OTHER organization, naming this one
        assert r.status_code in (401, 403, 404), r.text
        assert "project_room" not in r.text and "\"P\"" not in r.text  # ㉢ nothing of the project in the refusal
