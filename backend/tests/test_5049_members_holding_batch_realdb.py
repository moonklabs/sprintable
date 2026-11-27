"""story 5049 (PR 3 · «one question for the whole channel») — `members_holding_channel_project` answers «which of these members hold the channel's project NOW» in a CONSTANT number of statements, and the answer is the
SAME set the per-member loop of `has_project_access` gives, for every kind of member and project. Real Postgres.

The loop (the oracle kept below, verbatim from before) asked `has_project_access` once per member. A single set-based statement is the dangerous version of this question: `_project_access_predicate` nests its EXISTS branches
two levels deep and SQLAlchemy auto-correlates only to the immediately enclosing SELECT, so a naive «correlate on the member rows» makes the inner branches cross-join `members` and EVERY candidate passes (measured on the
first attempt, 5032). So this matrix is the first thing: every kind of candidate × every kind of project, alone and together (a result must not depend on who else is in the set), against the loop.

  01 the matrix: each candidate kind × each project kind — the whole set, each member alone, and mixed subsets — equals the loop; some are certain to pass and some certain to fail (a «nobody» or an «everybody» answer cannot satisfy it)
  02 a room that is not a channel passes all · a channel with no project passes none · an empty set is empty
  03 the statement count is constant: the same for 1 · 5 · 20 · 50 candidates
  05 chunks: the matrix is the same with a tiny chunk size, and the statements are ceil(N/chunk) × 2
  06 a very large set (40,000 ids — past the 32,767 bind-parameter limit of one statement) answers exactly, without error
  07 the holders that fall in DIFFERENT chunks are both found
  08 the bind-parameter limit: 32,757 · 32,766 · 32,767 · 32,768 candidates (real Postgres, as members and as access ids) answer exactly, no error — and one UNCHUNKED statement of 32,768 does fail (the limit is real)
  09 chunk edges: 0 · 1 · chunk−1 · chunk · chunk+1 · 2×chunk±1 candidates answer exactly with ceil(N/chunk)×2 statements (no empty last chunk)
  10 holders on either side of a chunk edge (last cell of one chunk / first of the next) are both found, in both steps
  04 the compiled statement correlates (no member table joined into the inner branches): compiled text + EXPLAIN
"""
from __future__ import annotations

import itertools
import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import event, func, select, text

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _oracle(db, *, project_id, org_id, member_ids) -> set:
    """the per-member loop `members_holding_channel_project` was, kept here verbatim as the reference answer."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.services.project_auth import has_project_access

    if not member_ids:
        return set()
    rows = (await db.execute(
        select(Member.id, func.coalesce(Member.user_id, Member.id)).where(Member.id.in_(member_ids), Member.org_id == org_id)
    )).all()
    ids = {mid: access_id for mid, access_id in rows}
    for mid, uid in (await db.execute(
        select(OrgMember.id, OrgMember.user_id).where(
            OrgMember.id.in_(member_ids - set(ids)), OrgMember.org_id == org_id, OrgMember.deleted_at.is_(None),
        )
    )).all():
        ids[mid] = uid
    return {mid for mid, access_id in ids.items() if await has_project_access(db, access_id, project_id, org_id)}


class _World:
    pass


async def _world():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.member import AgentProjectProfile, Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    w = _World()
    w.engine, w.Session, w.m = engine, Session, {}
    now = datetime.now(timezone.utc)
    async with Session() as s:
        def org(tag):
            o = Organization(id=uuid.uuid4(), name=f"O-{tag}", slug=f"o5049-{tag}-{uuid.uuid4().hex[:8]}")
            s.add(o)
            return o

        o1, o2 = org("a"), org("b")
        await s.flush()
        w.org, w.org2 = o1.id, o2.id
        projects = {}
        for key, o in (("P", o1), ("Q", o1), ("PD", o1), ("P2", o2)):
            p = Project(id=uuid.uuid4(), org_id=o.id, name=key)
            s.add(p)
            projects[key] = p
        await s.flush()
        w.p = {k: v.id for k, v in projects.items()}

        def user():
            u = User(id=uuid.uuid4(), email=f"u5049-{uuid.uuid4().hex[:10]}@test.com", hashed_password="x")
            s.add(u)
            return u

        async def human(name, *, org_id, role="member", grants=(), perm="granted", active=True, om_deleted=False, anchor=True):
            u = user()
            await s.flush()
            om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=u.id, role=role, deleted_at=now if om_deleted else None)
            s.add(om)
            await s.flush()
            if anchor:
                s.add(Member(id=om.id, org_id=org_id, type="human", user_id=u.id, name=name, is_active=active))
                await s.flush()
            for pr in grants:
                s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p[pr], org_member_id=om.id, member_id=om.id if anchor else None, permission=perm, role="member"))
            await s.flush()
            w.m[name] = om.id

        async def agent(name, *, org_id, grants=(), perm="granted", active=True, deleted=False, profile=()):
            m = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name, is_active=active, deleted_at=now if deleted else None)
            s.add(m)
            await s.flush()
            for pr in grants:
                s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p[pr], org_member_id=None, member_id=m.id, permission=perm, role="member"))
            for pr in profile:
                s.add(AgentProjectProfile(id=uuid.uuid4(), member_id=m.id, project_id=w.p[pr]))
            await s.flush()
            w.m[name] = m.id

        # people with a `members` anchor (a team member by the grant) …
        await human("h_grant", org_id=o1.id, grants=("P", "PD"))
        await human("h_denied", org_id=o1.id, grants=("P",), perm="denied")
        await human("h_other_project", org_id=o1.id, grants=("Q",))
        await human("h_inactive", org_id=o1.id, grants=("P",), active=False)
        await human("h_org_member_deleted", org_id=o1.id, grants=("P",), om_deleted=True)
        await human("h_owner", org_id=o1.id, role="owner")
        await human("h_admin", org_id=o1.id, role="admin")
        await human("h_plain_member", org_id=o1.id)
        # … people whose `members` row has NO user (access is asked with the member's own id: `coalesce(user_id, id)`) — one holds the project, one does not
        for name, grants in (("h_no_user_id_grant", ("P",)), ("h_no_user_id_none", ())):
            m = Member(id=uuid.uuid4(), org_id=o1.id, type="human", user_id=None, name=name)
            s.add(m)
            await s.flush()
            for pr in grants:
                s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p[pr], org_member_id=None, member_id=m.id, permission="granted", role="member"))
            await s.flush()
            w.m[name] = m.id
        # … a grant-only person (the org seat is their member id; access is asked with the seat's user) …
        await human("go_grant", org_id=o1.id, grants=("P",), anchor=False)
        await human("go_none", org_id=o1.id, anchor=False)
        await human("go_admin", org_id=o1.id, role="admin", anchor=False)
        await human("go_seat_deleted", org_id=o1.id, grants=("P",), om_deleted=True, anchor=False)
        # … agents …
        await agent("a_grant", org_id=o1.id, grants=("P", "PD"))
        await agent("a_inactive", org_id=o1.id, grants=("P",), active=False)
        await agent("a_deleted", org_id=o1.id, grants=("P",), deleted=True)
        await agent("a_profile_only", org_id=o1.id, profile=("P",))
        await agent("a_denied", org_id=o1.id, grants=("P",), perm="denied")
        await agent("a_other_project", org_id=o1.id, grants=("Q",))
        # … and people of another organization (one with a grant row on THIS organization's project)
        await human("x_other_org", org_id=o2.id, grants=("P2",))
        await agent("x_other_org_agent_on_P", org_id=o2.id, grants=("P",))
        await human("x_other_org_human_on_P", org_id=o2.id, grants=("P",))  # a person of another organization with a grant row on THIS organization's project (the team-member branch has no member-org guard — the set's own org filter is what keeps them out)
        await s.execute(text("UPDATE projects SET deleted_at = now() WHERE id = :p"), {"p": w.p["PD"]})
        await s.commit()
    w.unknown = uuid.uuid4()
    w.m["unknown"] = w.unknown
    w.p["nonexistent"] = uuid.uuid4()
    return w


MUST_PASS_P = {"h_grant", "a_grant", "go_grant", "h_owner", "h_admin", "go_admin", "h_no_user_id_grant"}
MUST_FAIL_P = {"h_no_user_id_none", "h_other_project", "h_plain_member", "a_inactive", "a_deleted", "a_profile_only", "a_other_project", "go_none", "go_seat_deleted", "x_other_org", "x_other_org_agent_on_P", "x_other_org_human_on_P", "unknown"}  # (a person whose org seat is deleted but who still has a members anchor + a grant row passes — the team-member branch does not ask the seat; the loop says so and so does the set)


async def _both(w, project, ids):
    from app.services.conversation_auth import members_holding_channel_project

    async with w.Session() as s:
        want = await _oracle(s, project_id=project, org_id=w.org, member_ids=set(ids))
    async with w.Session() as s:
        got = await members_holding_channel_project(s, is_project_channel=True, project_id=project, org_id=w.org, member_ids=set(ids))
    return want, got


async def _run_matrix(w) -> int:
    everyone = set(w.m.values())
    names = {v: k for k, v in w.m.items()}
    rows = 0
    for pkey, project in w.p.items():
        want, got = await _both(w, project, everyone)
        assert got == want, (pkey, {names[i] for i in got ^ want})
        rows += len(everyone)
        # each member alone: the answer must not depend on who else is asked about
        for name, mid in w.m.items():
            one_want, one_got = await _both(w, project, {mid})
            assert one_got == one_want, (pkey, name)
            rows += 1
        # mixed subsets: pairs of one who passes and one who does not (a cross-join leaks the passer's verdict to the other)
        if pkey == "P":
            passers = [w.m[n] for n in MUST_PASS_P]
            failers = [w.m[n] for n in MUST_FAIL_P]
            for a, b in itertools.product(passers[:3], failers):
                pw, pg = await _both(w, project, {a, b})
                assert pg == pw and b not in pg, (names[a], names[b])
                rows += 2
    # the reference itself is not trivial: some certainly pass, some certainly fail (so «everybody» and «nobody» are both wrong)
    want_p, got_p = await _both(w, w.p["P"], everyone)
    assert MUST_PASS_P <= {names[i] for i in want_p}, {names[i] for i in want_p}
    assert not (MUST_FAIL_P & {names[i] for i in want_p}), {names[i] for i in want_p}
    assert got_p == want_p
    assert rows >= 150, rows
    return rows


async def test_01_the_set_answer_equals_the_per_member_loop_for_every_kind_of_member_and_project():
    w = await _world()
    try:
        await _run_matrix(w)
    finally:
        await w.engine.dispose()


async def test_02_not_a_channel_passes_all_a_channel_with_no_project_none_and_an_empty_set_is_empty():
    from app.services.conversation_auth import members_holding_channel_project

    w = await _world()
    try:
        ids = set(w.m.values())
        async with w.Session() as s:
            assert await members_holding_channel_project(s, is_project_channel=False, project_id=w.p["P"], org_id=w.org, member_ids=ids) == ids
            assert await members_holding_channel_project(s, is_project_channel=True, project_id=None, org_id=w.org, member_ids=ids) == set()
            assert await members_holding_channel_project(s, is_project_channel=True, project_id=w.p["P"], org_id=w.org, member_ids=set()) == set()
    finally:
        await w.engine.dispose()


async def test_03_the_number_of_statements_does_not_grow_with_the_number_of_candidates():
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.services.conversation_auth import members_holding_channel_project

    w = await _world()
    try:
        # 50 more agents that hold P
        extra = []
        async with w.Session() as s:
            for i in range(50):
                m = Member(id=uuid.uuid4(), org_id=w.org, type="agent", name=f"bulk-{i}")
                s.add(m)
                await s.flush()
                s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p["P"], org_member_id=None, member_id=m.id, permission="granted", role="member"))
                extra.append(m.id)
            await s.commit()
        counts = {}
        for n in (1, 5, 20, 50):
            ids = set(extra[:n])
            seen = []

            def hook(conn, cursor, statement, params, context, executemany, _seen=seen):
                _seen.append(statement)

            async with w.Session() as s:
                event.listen(w.engine.sync_engine, "before_cursor_execute", hook)
                try:
                    got = await members_holding_channel_project(s, is_project_channel=True, project_id=w.p["P"], org_id=w.org, member_ids=ids)
                finally:
                    event.remove(w.engine.sync_engine, "before_cursor_execute", hook)
            assert got == ids
            counts[n] = len(seen)
        assert len(set(counts.values())) == 1 and counts[50] <= 3, counts
    finally:
        await w.engine.dispose()


async def test_04_the_candidates_are_named_once_in_the_statement_and_in_its_plan_no_cross_join():
    from sqlalchemy.dialects import postgresql

    from app.services.conversation_auth import members_holding_channel_project
    from app.services.project_auth import project_access_holders_statement

    w = await _world()
    try:
        ids = set(list(w.m.values())[:8])
        sql = str(project_access_holders_statement(w.p["P"], w.org, ids).compile(dialect=postgresql.dialect()))
        assert sql.count("VALUES") == 1, sql  # the candidate table is rendered ONCE; a cross-join would repeat it in the inner branches
        assert sql.count("FROM") >= 5 and "SELECT cand.uid" in sql
        seen = []

        def hook(conn, cursor, statement, params, context, executemany):
            if "VALUES" in statement and "project_access" in statement:
                seen.append((statement, params))

        event.listen(w.engine.sync_engine, "before_cursor_execute", hook)
        try:
            async with w.Session() as s:
                await members_holding_channel_project(s, is_project_channel=True, project_id=w.p["P"], org_id=w.org, member_ids=ids)
        finally:
            event.remove(w.engine.sync_engine, "before_cursor_execute", hook)
        assert len(seen) == 1, len(seen)  # the access question is ONE statement
        statement, params = seen[0]
        async with w.engine.connect() as conn:
            plan = "\n".join(r[0] for r in (await conn.exec_driver_sql("EXPLAIN (COSTS OFF) " + statement, params)).all())
        # the plan: the candidates are scanned ONCE (the VALUES list is `*VALUES*` in a plan) and every access branch is a (hashed) sub-plan keyed on it — no table of members or seats is joined at the top level
        assert plan.count("Values Scan") == 1, plan
        top = plan.split("SubPlan 1\n")[0]
        assert "on members" not in top and "on org_members" not in top and "on team_members" not in top, plan
    finally:
        await w.engine.dispose()


async def _statements_of(w, project, ids) -> tuple[set, int]:
    from app.services.conversation_auth import members_holding_channel_project

    seen = []

    def hook(conn, cursor, statement, params, context, executemany):
        seen.append(statement)

    event.listen(w.engine.sync_engine, "before_cursor_execute", hook)
    try:
        async with w.Session() as s:
            got = await members_holding_channel_project(s, is_project_channel=True, project_id=project, org_id=w.org, member_ids=set(ids))
    finally:
        event.remove(w.engine.sync_engine, "before_cursor_execute", hook)
    return got, len(seen)


async def _bulk_holders(w, n) -> list:
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    out = []
    async with w.Session() as s:
        for i in range(n):
            m = Member(id=uuid.uuid4(), org_id=w.org, type="agent", name=f"chunk-{i}")
            s.add(m)
            await s.flush()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p["P"], org_member_id=None, member_id=m.id, permission="granted", role="member"))
            out.append(m.id)
        await s.commit()
    return out


async def test_05_with_a_tiny_chunk_the_matrix_is_the_same_and_the_statements_are_ceil_n_over_chunk_times_two(monkeypatch):
    import math

    from app.services import project_auth

    w = await _world()
    try:
        monkeypatch.setattr(project_auth, "ACCESS_CHUNK_SIZE", 7)
        await _run_matrix(w)  # the whole matrix: loop == set, now through chunks of 7
        extra = await _bulk_holders(w, 50)
        got, n_statements = await _statements_of(w, w.p["P"], extra)
        assert got == set(extra)
        assert n_statements == math.ceil(50 / 7) * 2, n_statements
        monkeypatch.setattr(project_auth, "ACCESS_CHUNK_SIZE", 5000)
        got, n_statements = await _statements_of(w, w.p["P"], extra)
        assert got == set(extra) and n_statements == 2, n_statements  # a real channel: two statements
    finally:
        await w.engine.dispose()


async def test_06_a_set_larger_than_the_bind_parameter_limit_answers_exactly_without_error():
    """40,000 ids (one bind parameter each — past PostgreSQL's 32,767 per statement), none of them a member, plus a few real ones: no error and exactly the real holders. The ids are asked both ways: as MEMBERS
    (`members_holding_channel_project`, the mapping step) and as ACCESS IDS (`project_access_holders`, the holders step)."""
    from app.services.project_auth import project_access_holders

    w = await _world()
    try:
        noise = {uuid.uuid4() for _ in range(40_000)}
        holders = {w.m["h_grant"], w.m["a_grant"], w.m["h_owner"]}
        not_holders = {w.m["h_other_project"], w.m["a_inactive"]}
        got, _n = await _statements_of(w, w.p["P"], noise | holders | not_holders)
        assert got == holders, {k for k, v in w.m.items() if v in (got ^ holders)}
        # the access ids themselves (a person's user id · an agent's member id): the holders step alone gets 40,000 too
        async with w.Session() as s:
            from sqlalchemy import select as _select

            from app.models.member import Member

            access = {mid: uid for mid, uid in (await s.execute(_select(Member.id, func.coalesce(Member.user_id, Member.id)).where(Member.id.in_(holders | not_holders)))).all()}
            held = await project_access_holders(s, w.p["P"], w.org, set(access.values()) | noise)
        assert held == {access[m] for m in holders}, held
    finally:
        await w.engine.dispose()


async def test_07_holders_that_fall_in_different_chunks_are_both_found(monkeypatch):
    from app.services import project_auth

    w = await _world()
    try:
        monkeypatch.setattr(project_auth, "ACCESS_CHUNK_SIZE", 1)  # every id is a chunk of its own: any two holders are in different chunks
        a, b = w.m["a_grant"], w.m["h_grant"]
        ids = {a, b, w.m["h_other_project"], w.m["a_inactive"], w.m["unknown"]}
        got, n_statements = await _statements_of(w, w.p["P"], ids)
        assert got == {a, b}, got
        assert n_statements == 5 + 4, n_statements  # 5 mapping chunks (the unknown id maps to nothing) + one holders chunk for each of the 4 mapped ids
    finally:
        await w.engine.dispose()


@pytest.mark.parametrize("n", [32757, 32766, 32767, 32768])
async def test_08_around_the_bind_parameter_limit_the_answer_is_exact_and_one_unchunked_statement_really_fails(n, monkeypatch):
    from sqlalchemy.exc import DBAPIError

    from app.models.member import Member
    from app.services import project_auth
    from app.services.project_auth import project_access_holders, project_access_holders_statement

    w = await _world()
    try:
        holders = {w.m["h_grant"], w.m["a_grant"], w.m["h_owner"]}
        not_holders = {w.m["h_other_project"], w.m["a_inactive"]}
        real = holders | not_holders
        noise = {uuid.uuid4() for _ in range(n - len(real))}
        everyone = noise | real
        assert len(everyone) == n
        # as MEMBERS (the mapping step and the holders step)
        got, _stmts = await _statements_of(w, w.p["P"], everyone)
        assert got == holders, n
        # as ACCESS IDS (the holders step alone)
        async with w.Session() as s:
            access = {mid: uid for mid, uid in (await s.execute(select(Member.id, func.coalesce(Member.user_id, Member.id)).where(Member.id.in_(real)))).all()}
            held = await project_access_holders(s, w.p["P"], w.org, {access[m] for m in real} | noise)
        assert held == {access[m] for m in holders}, n
        # the limit is real: the same ids in ONE statement (no chunking) fail at 32,768 (and the statement carries two more parameters, so at 32,766 and up)
        if n >= 32766:
            monkeypatch.setattr(project_auth, "ACCESS_CHUNK_SIZE", 10**9)
            with pytest.raises(DBAPIError):
                async with w.Session() as s:
                    await project_access_holders(s, w.p["P"], w.org, everyone)
            monkeypatch.undo()
    finally:
        await w.engine.dispose()


@pytest.mark.parametrize("n", [0, 1, 6, 7, 8, 13, 14, 15, 21])
async def test_09_at_the_edges_of_a_chunk_the_answer_is_exact_and_the_statements_are_ceil_n_over_chunk_times_two(n, monkeypatch):
    import math

    from app.services import project_auth

    w = await _world()
    try:
        monkeypatch.setattr(project_auth, "ACCESS_CHUNK_SIZE", 7)
        extra = await _bulk_holders(w, 21)
        ids = extra[:n]
        got, n_statements = await _statements_of(w, w.p["P"], ids)
        assert got == set(ids), n
        assert n_statements == math.ceil(n / 7) * 2, (n, n_statements)  # a multiple of the chunk makes no empty last chunk; 0 candidates ask nothing
    finally:
        await w.engine.dispose()


async def test_10_holders_on_either_side_of_a_chunk_edge_are_both_found_in_both_steps(monkeypatch):
    from app.models.member import Member
    from app.services import project_auth
    from app.services.conversation_auth import members_holding_channel_project
    from app.services.project_auth import chunks_of_access_ids, project_access_holders

    w = await _world()
    try:
        monkeypatch.setattr(project_auth, "ACCESS_CHUNK_SIZE", 7)
        # the partition itself, on an ORDERED list: 14 ids → two chunks of 7, no third; 15 → 7 · 7 · 1
        assert [len(c) for c in chunks_of_access_ids(range(14))] == [7, 7]
        assert [len(c) for c in chunks_of_access_ids(range(15))] == [7, 7, 1]
        assert [len(c) for c in chunks_of_access_ids([])] == []
        a, b, c = w.m["h_grant"], w.m["a_grant"], w.m["h_owner"]
        for positions in ((6, 7), (0, 13), (6, 7, 0)):  # last cell of chunk 1 · first of chunk 2 · the two outer ends · all three at once
            real = [a, b, c][: len(positions)]
            order = [uuid.uuid4() for _ in range(14)]  # ids nobody holds (they map to nothing)
            for pos, mid in zip(positions, real):
                order[pos] = mid
            # step 1 + 2 as members: a LIST, so the chunks are exactly these cells
            async with w.Session() as s:
                got = await members_holding_channel_project(s, is_project_channel=True, project_id=w.p["P"], org_id=w.org, member_ids=order)
            assert got == set(real), positions
            # step 2 alone as access ids, the holders again on either side of an edge
            async with w.Session() as s:
                access = {mid: uid for mid, uid in (await s.execute(select(Member.id, func.coalesce(Member.user_id, Member.id)).where(Member.id.in_(real)))).all()}
            access_order = [uuid.uuid4() for _ in range(14)]
            for pos, mid in zip(positions, real):
                access_order[pos] = access[mid]
            async with w.Session() as s:
                held = await project_access_holders(s, w.p["P"], w.org, access_order)
            assert held == {access[m] for m in real}, positions
    finally:
        await w.engine.dispose()
