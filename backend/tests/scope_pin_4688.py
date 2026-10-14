"""story #4688: tests that are not ABOUT project scope pin «the caller reaches every project» so they can look at what they are about (assigned_to_me,
can_approve, sorting, enrichment, aggregates …). The scope rules themselves are tested in test_4351_* and test_project_delete_realdb.py.

Project-bound routes now filter by `project_scope` / `scoped_project_ids` (the projects that EXIST and the caller reaches) instead of reading
`restricted_accessible_project_ids`' None as «filter nothing» — so the old one-line patch is not enough. This helper patches every entry point:

- default: no query at all (mock-session tests count `execute` calls and SQL statements) — the scope is `None`, the value every service takes to
  mean «no project filter» (the HITL inbox, judgments, posts, Today …), and the gate project rule hides nothing (`~false()`), so rows in made-up or
  real project ids stay visible exactly as they did when these files patched `restricted_accessible_project_ids` to None. (An EMPTY list would mean
  «reaches nothing» to them — it hid every project-bound HITL row in test_2054's real-DB tests.)
- `db=True`: for real-DB tests of aggregates — the scope is the org's live projects read from the database (a real project filter), still «full access».
"""
from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import AsyncMock, patch


async def _live_from_db(session, user_id, org_id):
    from app.services.project_auth import live_project_ids_in_org

    return await live_project_ids_in_org(session, org_id), False


async def _live_ids_from_db(session, user_id, org_id):
    from app.services.project_auth import live_project_ids_in_org

    return await live_project_ids_in_org(session, org_id)


@contextmanager
def full_access_scope(*, db: bool = False):
    from sqlalchemy import false

    scope = AsyncMock(side_effect=_live_from_db) if db else AsyncMock(return_value=(None, False))
    ids = AsyncMock(side_effect=_live_ids_from_db) if db else AsyncMock(return_value=None)
    with patch("app.services.project_auth.restricted_accessible_project_ids", AsyncMock(return_value=None)), \
            patch("app.services.project_auth.project_scope", scope), \
            patch("app.services.project_auth.scoped_project_ids", ids), \
            patch("app.services.gate_service.gate_in_inaccessible_project_clause", lambda accessible: false()):
        yield
