"""story 4714 AC6 — `GET /api/v2/me` for an account with no organization yet (no member row) answers 404 with a machine-readable `reason`.

The web's proxy sends exactly this person to the onboarding (instead of leaving the phone app on a 404) and reads ONLY `error.reason`, never the
message's words. Pinned here: the code is still NOT_FOUND and the message is unchanged (every other reader is untouched), and `reason` is on the envelope.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.dependencies.auth import AuthContext, get_current_user
from app.main import app
from app.routers.me import MEMBERSHIP_ELSEWHERE_REASON, NO_MEMBERSHIP_REASON

USER = uuid.UUID("47140000-0000-0000-0000-0000000000b1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Db:
    """get_db stand-in. `get_me` asks four things, told apart by the SQL it compiles:
      the team member of this person (+ project) → none · the org member of the TOKEN's organization (the fallback, filters org_id) → none ·
      then, to word the 404, «any live org membership anywhere» (org_members, no org filter) and «any team member row» → what the test says."""

    def __init__(self, org_elsewhere: bool = False, team_elsewhere: bool = False):
        self.org_elsewhere, self.team_elsewhere = org_elsewhere, team_elsewhere
        self.sqls: list[str] = []

    async def execute(self, stmt):
        sql = str(stmt)
        self.sqls.append(sql)
        if "org_members" in sql and "org_members.org_id" not in sql:  # the «anywhere» question
            row = uuid.uuid4() if self.org_elsewhere else None
            return SimpleNamespace(scalar_one_or_none=lambda: row)
        if "SELECT team_members.id" in sql and "JOIN" not in sql:  # the «any team member row» question
            row = uuid.uuid4() if self.team_elsewhere else None
            return SimpleNamespace(scalar_one_or_none=lambda: row)
        return SimpleNamespace(scalars=lambda: SimpleNamespace(first=lambda: None, all=lambda: []), scalar_one_or_none=lambda: None)


def _world(db: _Db, claims: dict | None = None):
    from tests.conftest import override_db_and_read  # story #2451: the one way a get_db override is hung

    async def _db():
        yield db

    app.dependency_overrides[get_current_user] = lambda: AuthContext(user_id=str(USER), email="p@example.test", claims=claims or {})
    override_db_and_read(app, _db)


@pytest.fixture
def clean():
    yield
    from app.dependencies.database import get_db, get_read_db

    for k in (get_current_user, get_db, get_read_db):
        app.dependency_overrides.pop(k, None)


async def _me():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        return await c.get("/api/v2/me")


@pytest.mark.anyio
async def test_a_brand_new_account_has_no_membership_anywhere_and_says_so(clean):
    _world(_Db())
    r = await _me()
    assert r.status_code == 404
    body = r.json()
    assert body["data"] is None
    assert body["error"]["code"] == "NOT_FOUND"  # unchanged: every other reader of the envelope still works
    assert body["error"]["message"] == "Member not found"  # unchanged words
    assert body["error"]["reason"] == NO_MEMBERSHIP_REASON == "no_membership"


@pytest.mark.anyio
async def test_a_person_of_another_organization_whose_token_points_at_one_they_are_not_in_is_not_no_membership(clean):
    # Y-only person, the token carries X's id (Kadir's second person): the organization they are NOT in has no row for them, but another one does
    _world(_Db(org_elsewhere=True), claims={"app_metadata": {"org_id": str(uuid.uuid4())}})
    r = await _me()
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "NOT_FOUND" and r.json()["error"]["message"] == "Member not found"
    assert r.json()["error"]["reason"] == MEMBERSHIP_ELSEWHERE_REASON == "membership_elsewhere"


@pytest.mark.anyio
async def test_removed_from_one_organization_but_still_in_another_is_not_no_membership(clean):
    # the third person: out of X (soft-deleted row — the «anywhere» question counts live rows only and finds Y's), still a member of Y
    _world(_Db(org_elsewhere=True), claims={"app_metadata": {"org_id": str(uuid.uuid4()), "project_id": ""}})
    assert (await _me()).json()["error"]["reason"] == "membership_elsewhere"


@pytest.mark.anyio
async def test_a_team_member_row_in_another_organization_also_counts_as_belonging_somewhere(clean):
    _world(_Db(team_elsewhere=True))
    assert (await _me()).json()["error"]["reason"] == "membership_elsewhere"


@pytest.mark.anyio
async def test_the_belongs_somewhere_question_counts_live_rows_only(clean):
    """a removed (soft-deleted) org row must not make someone «belong somewhere»: the question the 404 asks is `deleted_at IS NULL` and has no organization filter"""
    db = _Db()
    _world(db)
    assert (await _me()).json()["error"]["reason"] == "no_membership"
    anywhere = [q for q in db.sqls if "org_members" in q and "org_members.org_id" not in q]
    assert len(anywhere) == 1
    assert "org_members.deleted_at IS NULL" in anywhere[0] and "org_members.user_id" in anywhere[0]


@pytest.mark.anyio
async def test_an_api_key_caller_is_never_asked_the_belongs_somewhere_question(clean):
    """an API key's `user_id` is a team member id, not a person: the «belongs somewhere» lookup (by person) is skipped for it — it keeps the plain
    `no_membership` and the query is never sent, even where a person row would exist (the web proxy never sees an API key; this keeps the branch honest)"""
    db = _Db(org_elsewhere=True, team_elsewhere=True)
    _world(db, claims={"app_metadata": {"api_key_id": "k-1"}})
    r = await _me()
    assert r.status_code == 404
    assert r.json()["error"]["reason"] == "no_membership"
    assert not [q for q in db.sqls if "org_members" in q and "org_members.org_id" not in q]  # the question was not asked


def test_the_two_reasons_are_distinct_words():
    assert NO_MEMBERSHIP_REASON != MEMBERSHIP_ELSEWHERE_REASON


def test_the_reason_word_is_the_one_the_web_proxy_reads():
    import re
    from pathlib import Path

    proxy = (Path(__file__).resolve().parents[2] / "apps" / "web" / "src" / "proxy.ts").read_text(encoding="utf-8")
    assert re.search(r"error\?\.reason\s*===\s*'no_membership'", proxy), "proxy.ts must read the reason field this route writes"
