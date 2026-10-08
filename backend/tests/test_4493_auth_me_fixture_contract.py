"""story 4493 — the web's Firebase session branch (apps/web/src/lib/db/server.ts) reads `GET /api/v2/auth/me`, and its test answers with
apps/web/src/lib/db/__fixtures__/auth-me.firebase-session.json. These pin that body to the backend schema, so the web test can never again
pass on a shape the server does not send (its old hand-written mock read `member_id` from `/api/v2/me`, which has no such field).

  01 · the fixture is exactly an AuthMeResponse — every field, nothing else — and validates as one
  02 · it is a Firebase PERSON session's body: no project claim (project_id null) · the agent-only project fields at their defaults
  03 · `/api/v2/me` (MeResponse) has no `member_id` — the field the web reads exists only on `/api/v2/auth/me`
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from app.routers.auth import AuthMeResponse
from app.schemas.me import MeResponse

FIXTURE = Path(__file__).resolve().parents[2] / "apps" / "web" / "src" / "lib" / "db" / "__fixtures__" / "auth-me.firebase-session.json"


def _body() -> dict:
    return json.loads(FIXTURE.read_text())


def test_01_the_fixture_is_exactly_an_auth_me_response():
    body = _body()
    assert set(body) == set(AuthMeResponse.model_fields), "the web fixture drifted from AuthMeResponse — update it with the schema"
    assert AuthMeResponse.model_validate(body).model_dump() == body


def test_02_it_is_a_firebase_person_sessions_body():
    body = _body()
    uuid.UUID(body["member_id"])  # users.id
    uuid.UUID(body["org_id"])  # the user's last org (dependencies/auth.py _resolve_firebase_session)
    uuid.UUID(body["org_member_id"])
    assert body["project_id"] is None  # a Firebase session carries no project claim
    assert (body["resolved_default_project_id"], body["is_project_ambiguous"], body["accessible_project_ids"]) == (None, False, [])
    assert isinstance(body["email_verified"], bool) and isinstance(body["email_verification_required"], bool)


def test_03_the_other_me_has_no_member_id():
    assert "member_id" in AuthMeResponse.model_fields
    assert "member_id" not in MeResponse.model_fields
