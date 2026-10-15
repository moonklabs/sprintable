"""story 4675 (Kadir 5068) — `TeamMemberResponse` is `from_attributes`: the two desktop fields are injected after validation and
must never be read off the member object. A test double that answers every attribute (MagicMock) used to fail validation with
a mock in `device_name` · `desktop_setup_id`; now anything that is not a str/UUID reads as «not bound» (None), and a real
str/UUID (what the injection writes) stays."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.schemas.team_member import TeamMemberResponse


def _member(**extra) -> SimpleNamespace:
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), user_id=None, type="agent", name="A", role="member",
        avatar_url=None, agent_config=None, is_active=True, color="#000000", agent_role=None, runtime_type="claude-code",
        created_by=None, can_manage_members=False, created_at=now, updated_at=now, last_seen_at=None, active_story_id=None,
        agent_status=None, active_story=None, verified=None, needs_restart=None, **extra,
    )


def test_mock_attributes_read_as_not_bound():
    r = TeamMemberResponse.model_validate(_member(device_name=MagicMock(), desktop_setup_id=MagicMock()))
    assert (r.device_name, r.desktop_setup_id) == (None, None)


def test_real_values_stay_and_a_member_without_the_attributes_reads_none():
    sid = uuid.uuid4()
    r = TeamMemberResponse.model_validate(_member(device_name="yoonjae의 맥", desktop_setup_id=sid))
    assert (r.device_name, r.desktop_setup_id) == ("yoonjae의 맥", sid)
    r = TeamMemberResponse.model_validate(_member())
    assert (r.device_name, r.desktop_setup_id) == (None, None)
    # the injection's own way (model_copy) is untouched
    r = r.model_copy(update={"device_name": "studio mac", "desktop_setup_id": sid})
    assert (r.device_name, r.desktop_setup_id) == ("studio mac", sid)
