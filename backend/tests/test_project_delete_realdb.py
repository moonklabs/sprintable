"""DELETE /api/v2/projects/{id} on a migrated PG (real HTTP · the 4424 world): the settings screen's «프로젝트 삭제» must complete.

dev (10-14): two tries on an empty project both answered 500 INTERNAL_ERROR. The repository hard-deletes through the ORM
(`session.delete(project)`); the `Project.team_members` · `sprints` · `epics` relationships have no delete cascade, so the unit of work first
tries to NULL their foreign keys — `team_members` is a VIEW (0088), which cannot be updated. A comment in the SEC-S1 test (2026-07) had seen it
and left it («사전 존재 버그»). The database's own `ON DELETE` rules already say what happens to every dependent row.
"""
from __future__ import annotations

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


async def _create(c, name: str) -> str:
    r = await c.post("/api/v2/projects", headers=_person(OWNER), json={"name": name, "org_id": str(ORG)})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def test_01_an_empty_project_can_be_deleted_by_the_owner(world):
    async with _client() as c:
        pid = await _create(c, "walk-empty")
        r = await c.delete(f"/api/v2/projects/{pid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert (await _sql(fetch=f"SELECT count(*) FROM projects WHERE id='{pid}'"))[0][0] == 0


async def test_02_a_project_with_a_granted_member_can_be_deleted(world):
    """The walk's project had a member on it: a `project_access` grant makes a row of the `team_members` VIEW for the project."""
    async with _client() as c:
        pid = await _create(c, "walk-with-member")
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{pid}','{EXISTING}','granted')")
        r = await c.delete(f"/api/v2/projects/{pid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert (await _sql(fetch=f"SELECT count(*) FROM projects WHERE id='{pid}'"))[0][0] == 0
        assert (await _sql(fetch=f"SELECT count(*) FROM project_access WHERE project_id='{pid}'"))[0][0] == 0  # the database's own CASCADE


MARK = "ORPHAN-4688"


@pytest.fixture(autouse=True)
async def _clean_orphans():
    """a deleted project leaves its rows behind (that is the point of the non-destructive delete) — these tests must not leave theirs in the shared DB."""
    async def wipe():
        await _sql(f"DELETE FROM stories WHERE title LIKE '{MARK}%'", f"DELETE FROM sprints WHERE title LIKE '{MARK}%'", f"DELETE FROM goals WHERE title LIKE '{MARK}%'")
    await wipe()
    yield
    await wipe()


async def _seed_children(pid: str) -> dict[str, str]:
    """what a used project holds: a sprint, an epic (goals) and a story — none of them has a foreign key to `projects` in the database."""
    await _sql(
        f"INSERT INTO sprints (id,org_id,project_id,title,status,start_date,end_date) VALUES (gen_random_uuid(),'{ORG}','{pid}','{MARK}-sprint','planning',now(),now()+interval '7 days')",
        f"INSERT INTO goals (id,org_id,project_id,title,status) VALUES (gen_random_uuid(),'{ORG}','{pid}','{MARK}-epic','active')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES (gen_random_uuid(),'{ORG}','{pid}','{MARK}-story','backlog','medium')",
    )
    ids = {}
    for kind, table in (("sprint", "sprints"), ("epic", "goals"), ("story", "stories")):
        ids[kind] = (await _sql(fetch=f"SELECT id::text FROM {table} WHERE project_id='{pid}' AND title LIKE '{MARK}%'"))[0][0]
    return ids


async def test_03_a_used_project_can_be_deleted_and_its_data_is_left_untouched(world):
    async with _client() as c:
        pid = await _create(c, "walk-used")
        await _seed_children(pid)
        r = await c.delete(f"/api/v2/projects/{pid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert (await _sql(fetch=f"SELECT count(*) FROM projects WHERE id='{pid}'"))[0][0] == 0
        # the project is gone from every list; what it held is not erased here (no foreign key says so) — the copy promises «비활성화», not erasure
        assert (await _sql(fetch=f"SELECT count(*) FROM stories WHERE project_id='{pid}'"))[0][0] == 1


# story #4688 AC2: «관련 데이터가 비활성화돼요» must be true — what a deleted project left behind shows up nowhere, and no path that could meet it answers 5xx.
ORG_WIDE = (
    "/api/v2/stories", "/api/v2/stories?q=" + MARK, "/api/v2/sprints", "/api/v2/epics", "/api/v2/goals", "/api/v2/tasks", "/api/v2/docs",
    "/api/v2/activity-logs", "/api/v2/activity-stream", "/api/v2/command-center/overview", "/api/v2/retros", "/api/v2/standups",
    "/api/v2/stories/workflow-line/metrics",
)


async def test_04_what_a_deleted_project_left_behind_shows_nowhere_and_nothing_errors(world):
    async with _client() as c:
        pid = await _create(c, "walk-hidden")
        ids = await _seed_children(pid)
        assert (await c.delete(f"/api/v2/projects/{pid}", headers=_person(OWNER))).status_code == 200
        everything = [*ORG_WIDE, f"/api/v2/stories?project_id={pid}", f"/api/v2/stories?project_id={pid}&status=backlog",
                      f"/api/v2/stories?project_id={pid}&no_sprint=true", f"/api/v2/stories?ids={ids['story']}"]
        for path in everything:
            r = await c.get(path, headers=_person(OWNER))
            assert r.status_code < 500, (path, r.status_code, r.text[:200])
            assert MARK not in r.text and not any(i in r.text for i in ids.values()), (path, "an orphan is visible")
        # the same dead project asked for by id on every branch of the stories list: an empty page, a zero count
        for path in (f"/api/v2/stories?project_id={pid}", f"/api/v2/stories?project_id={pid}&status=backlog", f"/api/v2/stories?project_id={pid}&no_sprint=true"):
            r = await c.get(path, headers=_person(OWNER))
            assert (r.status_code, r.json(), r.headers.get("X-Total-Count")) == (200, [], "0"), (path, r.status_code, r.text[:200])
        # a single read of one is a 404, as for a story that is not there
        for path in (f"/api/v2/stories/{ids['story']}", f"/api/v2/sprints/{ids['sprint']}", f"/api/v2/epics/{ids['epic']}"):
            assert (await c.get(path, headers=_person(OWNER))).status_code == 404, path


async def test_05_a_live_project_still_lists_its_stories(world):
    """the guard hides only a project that is gone: a live one lists its stories on every branch, and a deleted neighbour does not matter."""
    async with _client() as c:
        live = await _create(c, "walk-live")
        dead = await _create(c, "walk-dead")
        await _seed_children(live)
        await _seed_children(dead)
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        for suffix in ("", "&status=backlog", "&no_sprint=true"):
            r = await c.get(f"/api/v2/stories?project_id={live}{suffix}", headers=_person(OWNER))
            assert r.status_code == 200 and [x["title"] for x in r.json()] == [f"{MARK}-story"], (suffix, r.text[:200])
        org = await c.get("/api/v2/stories?q=" + MARK, headers=_person(OWNER))
        assert [x["project_id"] for x in org.json()] == [live]  # the dead project's story is not in the org-wide list either


async def test_06_a_soft_deleted_project_lists_no_stories_either(world):
    """`projects.deleted_at` is the other way a project goes away (SoftDeleteMixin): its stories are as hidden as a hard-deleted one's."""
    async with _client() as c:
        pid = await _create(c, "walk-soft")
        await _seed_children(pid)
        await _sql(f"UPDATE projects SET deleted_at=now() WHERE id='{pid}'")
        for suffix in ("", "&status=backlog", "&no_sprint=true"):
            r = await c.get(f"/api/v2/stories?project_id={pid}{suffix}", headers=_person(OWNER))
            # the scope check already refuses a soft-deleted project (403 «not a member» — has_project_access reads `deleted_at`); the list's own guard
            # answers an empty page if it ever got through: either way nothing of the project's shows and nothing is a 5xx
            assert r.status_code == 403 or (r.status_code == 200 and r.json() == []), (suffix, r.status_code, r.text[:200])
            assert MARK not in r.text
