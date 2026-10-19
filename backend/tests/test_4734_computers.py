"""story 4734 — the computer's derived id: pure grouping of setups (no database)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.services.desktop_computers import SetupFacts, assign_computers

ORG = uuid.UUID("d4734000-0000-0000-0000-000000000010")
ME = uuid.UUID("d4734000-0000-0000-0000-000000000011")
OTHER = uuid.UUID("d4734000-0000-0000-0000-000000000012")
T0 = datetime(2026, 10, 20, tzinfo=timezone.utc)


def _row(n: int, *, key: str | None, by: uuid.UUID | None = ME, name: str = "SYJ-MacBook-Pro") -> SetupFacts:
    return SetupFacts(id=uuid.UUID(int=n), machine_key=key, confirmed_by=by, device_name=name, confirmed_at=T0 - timedelta(minutes=n))


def _ids(rows):
    return assign_computers(ORG, rows)


def test_setups_of_one_machine_key_and_one_person_are_one_computer():
    ids = _ids([_row(i, key="k1") for i in range(1, 101)])
    assert len(set(ids.values())) == 1  # a hundred lines of one Mac are one computer


def test_the_same_machine_of_two_people_is_two_computers_and_two_machines_are_two():
    ids = _ids([_row(1, key="k1", by=ME), _row(2, key="k1", by=OTHER), _row(3, key="k2", by=ME)])
    assert len({ids[uuid.UUID(int=1)], ids[uuid.UUID(int=2)], ids[uuid.UUID(int=3)]}) == 3


def test_a_line_with_no_machine_key_joins_the_one_machine_key_that_has_its_name_and_person():
    ids = _ids([_row(1, key="k1"), _row(2, key=None), _row(3, key=None, name="  syj-macbook-pro ")])  # name compared trimmed · case-folded
    assert ids[uuid.UUID(int=1)] == ids[uuid.UUID(int=2)] == ids[uuid.UUID(int=3)]


def test_lines_with_no_machine_key_group_by_name_and_person_when_no_key_carries_them():
    ids = _ids([_row(1, key=None), _row(2, key=None), _row(3, key=None, name="Other Mac"), _row(4, key=None, by=OTHER)])
    assert ids[uuid.UUID(int=1)] == ids[uuid.UUID(int=2)]
    assert len({ids[uuid.UUID(int=1)], ids[uuid.UUID(int=3)], ids[uuid.UUID(int=4)]}) == 3


def test_two_machine_keys_with_the_same_name_and_person_leave_a_keyless_line_on_its_own():
    # ambiguous: it cannot be told which Mac it was — it is not glued to either (a wrong glue would let one Mac's phone list cover another's)
    ids = _ids([_row(1, key="k1"), _row(2, key="k2"), _row(3, key=None)])
    assert ids[uuid.UUID(int=3)] not in {ids[uuid.UUID(int=1)], ids[uuid.UUID(int=2)]}
    assert ids[uuid.UUID(int=1)] != ids[uuid.UUID(int=2)]


def test_a_line_with_no_known_person_is_its_own_computer_never_joined_to_a_person_or_to_another_unknown():
    ids = _ids([_row(1, key="k1", by=ME), _row(2, key="k1", by=None), _row(3, key="k1", by=None)])
    assert len({ids[uuid.UUID(int=1)], ids[uuid.UUID(int=2)], ids[uuid.UUID(int=3)]}) == 3  # unknown ≠ the person · unknown ≠ another unknown (4618: «not the same»)
    keyless = _ids([_row(4, key=None, by=None), _row(5, key=None, by=None)])
    assert keyless[uuid.UUID(int=4)] != keyless[uuid.UUID(int=5)]


def test_the_id_is_stable_across_calls_and_depends_on_the_org():
    rows = [_row(1, key="k1")]
    assert _ids(rows) == _ids(list(rows))
    other_org = assign_computers(uuid.UUID(int=99), rows)
    assert other_org[uuid.UUID(int=1)] != _ids(rows)[uuid.UUID(int=1)]
