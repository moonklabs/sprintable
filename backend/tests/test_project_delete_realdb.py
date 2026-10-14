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
AUTHOR = "d4688000-0000-0000-0000-0000000000b0"  # the standup entries these tests write (wiped after each)


@pytest.fixture(autouse=True)
async def _clean_orphans():
    """a deleted project leaves its rows behind (that is the point of the non-destructive delete) — these tests must not leave theirs in the shared DB."""
    async def wipe():
        await _sql(
            f"DELETE FROM stories WHERE title LIKE '{MARK}%'", f"DELETE FROM sprints WHERE title LIKE '{MARK}%'", f"DELETE FROM goals WHERE title LIKE '{MARK}%'",
            f"DELETE FROM docs WHERE title LIKE '{MARK}%'", f"DELETE FROM standup_entries WHERE author_id='{AUTHOR}'",
            f"DELETE FROM site_post_versions WHERE title LIKE '{MARK}%'", f"DELETE FROM channel_post_versions WHERE text LIKE '{MARK}%'",
            "DELETE FROM site_post_drafts WHERE slug LIKE 't4688-site-%'", "DELETE FROM channel_post_drafts WHERE channel LIKE 't4688-%'",
            "DELETE FROM gate WHERE scope_key LIKE 't4688-%'",
            f"DELETE FROM agent_hitl_requests WHERE title LIKE '{MARK}%'", f"DELETE FROM judgments WHERE statement LIKE '{MARK}%'",
            f"DELETE FROM story_activities WHERE created_by='{AUTHOR}'", f"DELETE FROM site_posts WHERE title LIKE '{MARK}%'",
            "DELETE FROM material_lineage WHERE hook_key='t4688-hook'", "DELETE FROM site_post_drafts WHERE slug LIKE 't4688-camp-%'",
            f"DELETE FROM campaigns WHERE name LIKE '{MARK}%'", "DELETE FROM insight_snapshots WHERE channel='t4688-ins'",
            f"DELETE FROM workflow_line_step_runs WHERE transition_id LIKE '{MARK}%'",
        )
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


# ---- the four paths Kadir found on 5076 (codex, 10-14): docs · standups · the command-center overview · the workflow-line metrics ----

async def _doc(pid: str, slug: str, title: str) -> None:
    await _sql(f"INSERT INTO docs (id,org_id,project_id,title,slug,tags) VALUES (gen_random_uuid(),'{ORG}','{pid}','{title}','{slug}',ARRAY['t4688'])")


async def test_07_docs_of_a_deleted_project_list_nowhere_and_a_live_projects_stay(world):
    """docs have no foreign key to `projects`: every project branch of the list (plain · tree · search · slug · tags · parent) answered the dead id."""
    async with _client() as c:
        live, dead = await _create(c, "walk-docs-live"), await _create(c, "walk-docs-dead")
        await _doc(live, "t4688-live", f"{MARK}-doc-live")
        await _doc(dead, "t4688-dead", f"{MARK}-doc-dead")
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        base = "/api/v2/docs?project_id="
        dead_paths = [f"{base}{dead}", f"{base}{dead}&tree=true", f"{base}{dead}&q={MARK}", f"{base}{dead}&slug=t4688-dead",
                      f"{base}{dead}&tags=t4688", f"{base}{dead}&parent_id={dead}"]
        for path in dead_paths:
            r = await c.get(path, headers=_person(OWNER))
            assert r.status_code == 200 and r.json()["data"] == [], (path, r.status_code, r.text[:200])
            assert MARK not in r.text, path
        tree = (await c.get(f"{base}{dead}&tree=true", headers=_person(OWNER))).json()
        assert tree["meta"]["total"] == 0 and tree["meta"]["has_more"] is False
        for path in ("/api/v2/docs", f"/api/v2/docs?ids={(await _sql(fetch=f'SELECT id::text FROM docs WHERE slug=' + chr(39) + 't4688-dead' + chr(39)))[0][0]}"):
            r = await c.get(path, headers=_person(OWNER))
            assert r.status_code == 200 and "doc-dead" not in r.text, path
        # control: the live project lists its doc on the same branches
        for path in (f"{base}{live}", f"{base}{live}&tree=true", f"{base}{live}&q={MARK}", f"{base}{live}&slug=t4688-live", f"{base}{live}&tags=t4688"):
            r = await c.get(path, headers=_person(OWNER))
            assert r.status_code == 200 and [d["title"] for d in r.json()["data"]] == [f"{MARK}-doc-live"], (path, r.text[:200])


async def test_08_a_standup_written_for_a_deleted_project_is_not_an_org_record(world):
    """deleting the project CASCADE-deletes its links, so the entry kept only its origin `project_id`: with no link it read as «org-level» and showed
    to everybody. An org-level record (no project, no link) and one on a live project are untouched."""
    async with _client() as c:
        live, dead = await _create(c, "walk-su-live"), await _create(c, "walk-su-dead")
        ids = {}
        for key, day, project in (("dead", "2026-09-01", dead), ("live", "2026-09-02", live), ("org", "2026-09-03", None)):
            pj = f"'{project}'" if project else "NULL"
            await _sql(f"INSERT INTO standup_entries (id,org_id,project_id,author_id,date) VALUES (gen_random_uuid(),'{ORG}',{pj},'{AUTHOR}','{day}')")
            ids[key] = (await _sql(fetch=f"SELECT id::text FROM standup_entries WHERE author_id='{AUTHOR}' AND date='{day}'"))[0][0]
            if project:
                await _sql(f"INSERT INTO standup_entry_projects (id,entry_id,project_id,org_id) VALUES (gen_random_uuid(),'{ids[key]}','{project}','{ORG}')")
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get("/api/v2/standups", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        mine = {e["id"] for e in r.json() if e["author_id"] == AUTHOR}
        assert mine == {ids["live"], ids["org"]}, mine  # reverted → the dead one is in the set
        assert (await c.get(f"/api/v2/standups/{ids['dead']}", headers=_person(OWNER))).status_code == 404
        assert (await c.get(f"/api/v2/standups/{ids['live']}", headers=_person(OWNER))).status_code == 200
        assert (await c.get(f"/api/v2/standups/{ids['org']}", headers=_person(OWNER))).status_code == 200


async def test_09_the_command_center_overview_does_not_count_what_a_deleted_project_left(world):
    """the owner reaches every project, so `restricted_accessible_project_ids` answered None («no filter»): the epics and the contribution numbers
    then included rows of a project that is gone. The scope label still says «org»."""
    async with _client() as c:
        before = (await c.get("/api/v2/command-center/overview", headers=_person(OWNER))).json()
        base_unassigned = before["project_status"]["contribution"]["unassigned"]
        live, dead = await _create(c, "walk-cc-live"), await _create(c, "walk-cc-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            await _sql(
                f"INSERT INTO goals (id,org_id,project_id,title,status) VALUES (gen_random_uuid(),'{ORG}','{pid}','{MARK}-epic-{tag}','active')",
                f"INSERT INTO stories (id,org_id,project_id,title,status,priority,epic_id) SELECT gen_random_uuid(),'{ORG}','{pid}','{MARK}-story-{tag}','done','medium',id FROM goals WHERE title='{MARK}-epic-{tag}'",
            )
        both = (await c.get("/api/v2/command-center/overview", headers=_person(OWNER))).json()
        assert both["project_status"]["contribution"]["unassigned"] == base_unassigned + 2  # both projects are live: both count
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        after = (await c.get("/api/v2/command-center/overview", headers=_person(OWNER))).json()
        titles = [e["title"] for e in after["project_status"]["epics"]]
        assert f"{MARK}-epic-live" in titles and f"{MARK}-epic-dead" not in titles, titles
        assert after["project_status"]["contribution"]["unassigned"] == base_unassigned + 1  # reverted → +2
        assert after["scope"] == "org"


async def test_10_the_workflow_line_metrics_do_not_count_a_deleted_projects_step_runs(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-wf-live"), await _create(c, "walk-wf-dead")
        for pid, n in ((live, 1), (dead, 2)):
            for i in range(n):
                await _sql(
                    "INSERT INTO workflow_line_step_runs (id,org_id,project_id,entity_type,entity_id,to_status,mode,correlation_id,transition_id) VALUES "
                    f"(gen_random_uuid(),'{ORG}','{pid}','story',gen_random_uuid(),'done','advisory_only',gen_random_uuid(),'{MARK}-{pid}-{i}')"
                )
        both = (await c.get("/api/v2/stories/workflow-line/metrics", headers=_person(OWNER))).json()
        base = both["total_step_runs"] - 3
        assert base >= 0
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        after = (await c.get("/api/v2/stories/workflow-line/metrics", headers=_person(OWNER))).json()
        assert after["total_step_runs"] == base + 1, after  # reverted → base + 3


# ---- every caller of `restricted_accessible_project_ids` that answered None («reaches every project») — PO 10-14: the same fix in this PR ----

async def _story_in(pid: str, tag: str) -> str:
    await _sql(f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES (gen_random_uuid(),'{ORG}','{pid}','{MARK}-{tag}','backlog','medium')")
    return (await _sql(fetch=f"SELECT id::text FROM stories WHERE project_id='{pid}' AND title='{MARK}-{tag}'"))[0][0]


async def test_11_site_post_drafts_of_a_deleted_project_are_not_listed_for_the_owner(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-site-live"), await _create(c, "walk-site-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"site-{tag}")
            await _sql(f"INSERT INTO site_post_drafts (id,org_id,work_item_id,slug) VALUES (gen_random_uuid(),'{ORG}','{sid}','t4688-site-{tag}')")
            await _sql(  # a draft is listed through its latest version — one row is enough
                "INSERT INTO site_post_versions (id,draft_id,version,title,lang,summary,body_md,body_sha256,author_member_id,author_kind) "
                f"SELECT gen_random_uuid(),id,1,'{MARK}-t','ko','s','b','sha','{EXISTING}','agent' FROM site_post_drafts WHERE slug='t4688-site-{tag}'"
            )
        path = f"/api/v2/organizations/{ORG}/site-posts/drafts"
        both = await c.get(path, headers=_person(OWNER))
        assert both.status_code == 200 and "t4688-site-live" in both.text and "t4688-site-dead" in both.text, both.text[:300]  # both projects live: both listed
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get(path, headers=_person(OWNER))
        assert r.status_code == 200 and "t4688-site-live" in r.text and "t4688-site-dead" not in r.text, r.text[:300]
        assert int(r.headers["X-Total-Count"]) == int(both.headers["X-Total-Count"]) - 1  # the count follows the list (a count that leaks tells it exists)


async def test_12_channel_post_drafts_of_a_deleted_project_are_not_listed_for_the_owner(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-chan-live"), await _create(c, "walk-chan-dead")
        ids = {}
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"chan-{tag}")
            await _sql(f"INSERT INTO channel_post_drafts (id,org_id,work_item_id,channel,connection_id) VALUES (gen_random_uuid(),'{ORG}','{sid}','t4688-{tag}',gen_random_uuid())")
            ids[tag] = (await _sql(fetch=f"SELECT id::text FROM channel_post_drafts WHERE work_item_id='{sid}'"))[0][0]
            await _sql(
                "INSERT INTO channel_post_versions (id,draft_id,version,text,body_sha256,author_member_id,author_kind) "
                f"VALUES (gen_random_uuid(),'{ids[tag]}',1,'{MARK}-t','sha','{EXISTING}','agent')"
            )
        path = f"/api/v2/organizations/{ORG}/channel-posts/drafts"
        both = await c.get(path, headers=_person(OWNER))
        assert both.status_code == 200 and ids["live"] in both.text and ids["dead"] in both.text, both.text[:300]
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get(path, headers=_person(OWNER))
        assert r.status_code == 200 and ids["live"] in r.text and ids["dead"] not in r.text, r.text[:300]
        assert int(r.headers["X-Total-Count"]) == int(both.headers["X-Total-Count"]) - 1
        # a single read by id is a 404 as for a draft that is not there
        assert (await c.get(f"{path}/{ids['dead']}", headers=_person(OWNER))).status_code == 404


async def test_13_gates_of_a_deleted_project_are_not_listed_for_the_owner_and_org_level_ones_stay(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-gate-live"), await _create(c, "walk-gate-dead")
        gate_ids = {}
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"gate-{tag}")
            await _sql(f"INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,scope_key) VALUES (gen_random_uuid(),'{ORG}','{sid}','story','merge','t4688-{tag}')")
            gate_ids[tag] = (await _sql(fetch=f"SELECT id::text FROM gate WHERE scope_key='t4688-{tag}'"))[0][0]
        # an org-level gate (its work item resolves to no project): never hidden by this
        await _sql(f"INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,scope_key) VALUES (gen_random_uuid(),'{ORG}',gen_random_uuid(),'story','merge','t4688-org')")
        gate_ids["org"] = (await _sql(fetch="SELECT id::text FROM gate WHERE scope_key='t4688-org'"))[0][0]
        both = await c.get("/api/v2/gates?limit=200", headers=_person(OWNER))
        assert both.status_code == 200 and all(g in both.text for g in gate_ids.values()), both.text[:300]
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get("/api/v2/gates?limit=200", headers=_person(OWNER))
        assert r.status_code == 200 and gate_ids["live"] in r.text and gate_ids["org"] in r.text and gate_ids["dead"] not in r.text, r.text[:300]


async def test_14_a_deleted_project_gives_its_slot_back_to_the_free_plan(world, monkeypatch):
    """PO 10-14 (walks 5 and 6): the free plan allows one project; on walk 6 the one project still on screen made the create answer 402. The count
    (`ee.plan_limits.check_project_create_limit`) already skips `deleted_at` rows — what made the walk-5 project stay was the delete that answered
    500 (this story): a project that is really gone is not counted. The limit here is set to «the live projects + 1» so the world's own project does
    not matter; the project that is deleted holds a granted member and an epic — exactly what could not be deleted before."""
    import ee.plan_limits as plan_limits
    from app.core.config import settings

    monkeypatch.setattr(settings, "license_consent", "agreed")  # EE on: the plan limit is checked
    live_now = (await _sql(fetch=f"SELECT count(*) FROM projects WHERE org_id='{ORG}' AND deleted_at IS NULL"))[0][0]
    monkeypatch.setitem(plan_limits.FREE_LIMITS, "max_projects", live_now + 1)
    async with _client() as c:
        first = await c.post("/api/v2/projects", headers=_person(OWNER), json={"name": "walk-slot-1", "org_id": str(ORG)})
        assert first.status_code in (200, 201), first.text
        full = await c.post("/api/v2/projects", headers=_person(OWNER), json={"name": "walk-slot-2", "org_id": str(ORG)})
        assert full.status_code == 402, full.text  # the plan's one slot is taken (the control: the limit is really in force here)
        pid = first.json()["id"]
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{pid}','{EXISTING}','granted')")
        await _sql(f"INSERT INTO goals (id,org_id,project_id,title,status) VALUES (gen_random_uuid(),'{ORG}','{pid}','{MARK}-slot-epic','active')")
        assert (await c.delete(f"/api/v2/projects/{pid}", headers=_person(OWNER))).status_code == 200  # was 500
        again = await c.post("/api/v2/projects", headers=_person(OWNER), json={"name": "walk-slot-3", "org_id": str(ORG)})
        assert again.status_code in (200, 201), again.text
        # a soft-deleted project (deleted_at) does not hold a slot either
        await _sql(f"UPDATE projects SET deleted_at=now() WHERE id='{again.json()['id']}'")
        third = await c.post("/api/v2/projects", headers=_person(OWNER), json={"name": "walk-slot-4", "org_id": str(ORG)})
        assert third.status_code in (200, 201), third.text


# ---- Kadir's round 3: the places the table called «tested» (or only mock-shaped) each get their own orphan seed — put the old None path back and the test goes red ----

async def test_15_the_hitl_inbox_does_not_list_a_deleted_projects_approvals(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-hitl-live"), await _create(c, "walk-hitl-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            await _sql(
                "INSERT INTO agent_hitl_requests (id,org_id,project_id,agent_id,request_type,title,prompt,requested_for) VALUES "
                f"(gen_random_uuid(),'{ORG}','{pid}','{EXISTING}','gate_approval','{MARK}-hitl-{tag}','p','{EXISTING}')"
            )
        both = await c.get("/api/v2/gates/inbox", headers=_person(OWNER))
        assert both.status_code == 200 and f"{MARK}-hitl-live" in both.text and f"{MARK}-hitl-dead" in both.text, both.text[:300]  # both live: both listed
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get("/api/v2/gates/inbox", headers=_person(OWNER))
        assert r.status_code == 200 and f"{MARK}-hitl-live" in r.text and f"{MARK}-hitl-dead" not in r.text, r.text[:300]


async def test_16_judgments_about_a_deleted_projects_stories_are_not_listed(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-judg-live"), await _create(c, "walk-judg-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"judg-{tag}")
            await _sql(
                "INSERT INTO judgments (id,org_id,scope,work_item_ids,kind,statement,created_by) VALUES "
                f"(gen_random_uuid(),'{ORG}','items',ARRAY['{sid}']::uuid[],'judgment','{MARK}-judg-{tag}','{EXISTING}')"
            )
        both = await c.get("/api/v2/judgments", headers=_person(OWNER))
        assert both.status_code == 200 and f"{MARK}-judg-live" in both.text and f"{MARK}-judg-dead" in both.text, both.text[:300]
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get("/api/v2/judgments", headers=_person(OWNER))
        assert r.status_code == 200 and f"{MARK}-judg-live" in r.text and f"{MARK}-judg-dead" not in r.text, r.text[:300]


async def test_17_the_today_snapshot_does_not_count_a_deleted_projects_landed_stories(world):
    async with _client() as c:
        base = (await c.get("/api/v2/today", headers=_person(OWNER))).json()["landed_today"]["count"]
        live, dead = await _create(c, "walk-today-live"), await _create(c, "walk-today-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"today-{tag}")
            await _sql(
                "INSERT INTO story_activities (id,story_id,org_id,project_id,activity_type,new_value,created_by) VALUES "
                f"(gen_random_uuid(),'{sid}','{ORG}','{pid}','status_changed','done','{AUTHOR}')"
            )
        both = (await c.get("/api/v2/today", headers=_person(OWNER))).json()
        assert both["landed_today"]["count"] == base + 2  # both projects live: both count
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        after = (await c.get("/api/v2/today", headers=_person(OWNER))).json()
        assert after["landed_today"]["count"] == base + 1  # reverted → +2
        assert after["scope"] == "org"  # the label is about who looks, not about the list the query used


async def test_18_hook_performance_does_not_count_a_deleted_projects_variants(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-hook-live"), await _create(c, "walk-hook-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"hook-{tag}")
            await _sql(
                "INSERT INTO material_lineage (id,org_id,source_evidence_id,derived_kind,derived_id,relation_kind,work_item_id,hook_key) VALUES "
                f"(gen_random_uuid(),'{ORG}',gen_random_uuid(),'channel_post_draft',gen_random_uuid(),'hook_variant','{sid}','t4688-hook')"
            )
        path = "/api/v2/material-lineage/hook-performance?hook_key=t4688-hook"
        both = await c.get(path, headers=_person(OWNER))
        assert both.status_code == 200 and both.json()["variant_count"] == 2, both.text[:300]
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        after = await c.get(path, headers=_person(OWNER))
        assert after.status_code == 200 and after.json()["variant_count"] == 1, after.text[:300]  # reverted → 2
        assert after.json()["scope"] == "org"


async def test_19_the_insights_board_does_not_list_a_deleted_projects_publications(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-ins-live"), await _create(c, "walk-ins-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"ins-{tag}")
            await _sql(
                "INSERT INTO site_posts (id,org_id,lang,slug,title,summary,body_md,published_at,source_story_id,gate_id) VALUES "
                f"(gen_random_uuid(),'{ORG}','ko','t4688-ins-{tag}','{MARK}-ins-{tag}','s','b',now(),'{sid}',gen_random_uuid())"
            )
        path = f"/api/v2/organizations/{ORG}/insights-board?window=30d&limit=200"
        both = await c.get(path, headers=_person(OWNER))
        assert both.status_code == 200 and f"{MARK}-ins-live" in both.text and f"{MARK}-ins-dead" in both.text, both.text[:300]
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get(path, headers=_person(OWNER))
        assert r.status_code == 200 and f"{MARK}-ins-live" in r.text and f"{MARK}-ins-dead" not in r.text, r.text[:300]
        assert r.json()["scope"] == "org"  # the owner still reads «org» (the label follows the caller, 4351 PR B)


async def test_20_a_campaign_detail_does_not_list_a_deleted_projects_content_items(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-camp-live"), await _create(c, "walk-camp-dead")
        cid = (await _sql(fetch=f"INSERT INTO campaigns (id,org_id,name,created_by_member_id) VALUES (gen_random_uuid(),'{ORG}','{MARK}-campaign','{EXISTING}') RETURNING id::text"))[0][0]
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"camp-{tag}")
            await _sql(f"INSERT INTO site_post_drafts (id,org_id,work_item_id,slug,campaign_id) VALUES (gen_random_uuid(),'{ORG}','{sid}','t4688-camp-{tag}','{cid}')")
            await _sql(
                "INSERT INTO site_post_versions (id,draft_id,version,title,lang,summary,body_md,body_sha256,author_member_id,author_kind) "
                f"SELECT gen_random_uuid(),id,1,'{MARK}-camp-{tag}','ko','s','b','sha','{EXISTING}','agent' FROM site_post_drafts WHERE slug='t4688-camp-{tag}'"
            )
        path = f"/api/v2/organizations/{ORG}/campaigns/{cid}"
        both = await c.get(path, headers=_person(OWNER))
        assert both.status_code == 200 and "t4688-camp-live" in both.text and "t4688-camp-dead" in both.text, both.text[:300]
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        r = await c.get(path, headers=_person(OWNER))
        assert r.status_code == 200 and "t4688-camp-live" in r.text and "t4688-camp-dead" not in r.text, r.text[:300]


# ---- Kadir's last two (round 4): the paths that decided «owner/admin = no filter» on their own, not through the shared helper ----

async def test_21_the_designated_pending_badge_does_not_count_a_deleted_projects_gates(world):
    async with _client() as c:
        me = (await _sql(fetch=f"SELECT id::text FROM members WHERE org_id='{ORG}' AND user_id='{OWNER}' LIMIT 1"))[0][0]
        path = "/api/v2/gates/designated-pending-count"
        base = (await c.get(path, headers=_person(OWNER))).json()["count"]
        live, dead = await _create(c, "walk-badge-live"), await _create(c, "walk-badge-dead")
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"badge-{tag}")
            await _sql(
                "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,scope_key,designated_approver_id) VALUES "
                f"(gen_random_uuid(),'{ORG}','{sid}','story','merge','t4688-badge-{tag}','{me}')"
            )
        # an org-level gate (its work item resolves to no project) is counted before and after
        await _sql(f"INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,scope_key,designated_approver_id) VALUES (gen_random_uuid(),'{ORG}',gen_random_uuid(),'story','merge','t4688-badge-org','{me}')")
        assert (await c.get(path, headers=_person(OWNER))).json()["count"] == base + 3  # all three count while both projects live
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        assert (await c.get(path, headers=_person(OWNER))).json()["count"] == base + 2  # the live one and the org-level one — reverted → +3


async def test_22_the_insights_of_a_deleted_projects_publication_are_not_readable(world):
    async with _client() as c:
        live, dead = await _create(c, "walk-insl-live"), await _create(c, "walk-insl-dead")
        pubs = {}
        for pid, tag in ((live, "live"), (dead, "dead")):
            sid = await _story_in(pid, f"insl-{tag}")
            await _sql(
                "INSERT INTO site_posts (id,org_id,lang,slug,title,summary,body_md,published_at,source_story_id,gate_id) VALUES "
                f"(gen_random_uuid(),'{ORG}','ko','t4688-insl-{tag}','{MARK}-insl-{tag}','s','b',now(),'{sid}',gen_random_uuid())"
            )
            pubs[tag] = (await _sql(fetch=f"SELECT id::text FROM site_posts WHERE slug='t4688-insl-{tag}'"))[0][0]
            await _sql(
                "INSERT INTO insight_snapshots (id,org_id,publication_id,publication_kind,work_item_id,channel,due_at) VALUES "
                f"(gen_random_uuid(),'{ORG}','{pubs[tag]}','site_post','{sid}','t4688-ins',now())"
            )
        path = lambda tag: f"/api/v2/organizations/{ORG}/publications/{pubs[tag]}/insights"  # noqa: E731
        assert len((await c.get(path("live"), headers=_person(OWNER))).json()) == 1
        assert len((await c.get(path("dead"), headers=_person(OWNER))).json()) == 1  # both projects live: both readable
        assert (await c.delete(f"/api/v2/projects/{dead}", headers=_person(OWNER))).status_code == 200
        assert len((await c.get(path("live"), headers=_person(OWNER))).json()) == 1  # the live project's stay
        gone = await c.get(path("dead"), headers=_person(OWNER))
        assert gone.status_code == 404, gone.text  # the same 404 as a publication that is not in your org
