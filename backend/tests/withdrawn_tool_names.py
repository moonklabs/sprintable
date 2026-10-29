"""Tool names that have been withdrawn from the agent surface but still sit in the SEED TEXT of migrations that have already run (role-template prompts: 0156, 0157, 0160, 0166).

A migration that has run is never edited, so the tests that check «the seed text names only real tools» would fail for every withdrawal. They import this one set instead.
The stored role prompts of already-recruited roles are rewritten by a follow-up data migration after all the withdrawal lanes (OPEN-ZERO ④–⑧) have landed — until then these names are the
only ones allowed in the seed text without being a registered tool. Add a name here only together with the story that withdrew it; `test_4811_sprint_analysis_withdrawn.py` checks that no name
on this list is a registered tool (the allowance can never hide a live one)."""
from __future__ import annotations

WITHDRAWN_BUT_STILL_IN_SEED_TEXT: frozenset[str] = frozenset({
    # story 4811 PR-S — sprint tools
    "sprintable_sprint_summary", "sprintable_activate_sprint", "sprintable_close_sprint", "sprintable_get_velocity",
    "sprintable_create_sprint", "sprintable_update_sprint", "sprintable_get_sprint_velocity_history", "sprintable_checkin_sprint",
})
