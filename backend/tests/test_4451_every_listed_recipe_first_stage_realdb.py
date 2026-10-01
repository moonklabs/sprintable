"""story #4451 (critical, 선생님 확인 A) — every recipe the desktop setup lists starts its first work item: whoever holds the first
stage gets one stored first-stage event (`events` row with a recipient_seq) on the new work item.

PO measurement (dev, setup 576b352b): «3단계 칸반» (preset.workflow.kanban_simple) confirmed → the story stayed backlog with no
owner, the project's only events were the three agents' connection tests, and `event_broker shadow: redis-only delivery
event_id=c0991552… (pg 미도착/유실 가능)` ×3 with no such row in `events`. The 09-30 blog recipes were handed and had results; the
09-30 agent_solo run was not handed either. The path: confirm → `_publish_first_stage` → `_publish_registry_event_core`
(stage_origin member).

The guard runs every listed platform preset through the real confirmation on a real database (each agent row on a runtime),
so a recipe whose first stage does not reach its holder is red here — not on a person's first run. The workflow recipes are
also run one step further (PO 04:42Z): their second stage, published on the same work item, reaches the second role's holder —
the hand-off that broke for the same reason (`work_item_stakeholders` read no stage binding).

The cause (AC1): the workflow presets route by `server_derived · work_item_stakeholders`; a work item the setup made a moment ago
has no assignee and no participants, so the publish reached only its sender. The «blog» presets route by `recipe_role_binding`.
"""
from __future__ import annotations

import json
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — world / _addresses are fixtures
    OWNER, OWNER_TM, PROJ, _addresses, _person, _client, _code, _confirm, _dispose_global_engine_after_test, _sql, world,
)
from tests.test_4424_desktop_setup_realdb import pytestmark  # noqa: F401 — the same real-DB skip

# the platform presets the desktop setup lists (list_setup_recipes · org_id IS NULL) — pinned both ways below
PRESETS = [
    "preset.marketing.blog_article", "preset.marketing.newsletter", "preset.marketing.social_card_news",
    "preset.marketing.social_text_post", "preset.marketing.video_production", "preset.workflow.agent_solo",
    "preset.workflow.kanban", "preset.workflow.kanban_simple", "preset.workflow.loop_agency", "preset.workflow.scrum_3step",
    "preset.workflow.solo", "preset.workflow.three_step", "preset.workflow.two_step",
]


async def _preset(key: str):
    rows = await _sql(fetch=(
        "SELECT id, payload_schema->'properties'->'stage'->'enum', routing->'broadcast'->>'target' FROM event_definitions "
        f"WHERE org_id IS NULL AND key='{key}'"
    ))
    assert rows, f"preset {key} not in the database"
    rid, stages, target = rows[0]
    return rid, (stages if isinstance(stages, list) else json.loads(stages)), target


async def _listed_rows(key: str) -> list[dict]:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.services.desktop_setup import list_setup_recipes
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            recipes = await list_setup_recipes(s, org_id=None)
    finally:
        await eng.dispose()
    return recipes if key == "*" else next(r["roles"] for r in recipes if r["key"] == key)


async def _holder(key: str, stage: str) -> str | None:
    rows = await _sql(fetch=(
        "SELECT agent_member_id FROM recipe_role_bindings "
        f"WHERE project_id='{PROJ}' AND event_definition_key='{key}' AND stage='{stage}'"
    ))
    return str(rows[0][0]) if rows and rows[0][0] is not None else None


async def _reached(key: str, holder: str, work_item: str, stage: str) -> tuple:
    """An agent holder: one stored event (with its stream seq) for that stage on that work item. The person who confirmed (the
    publish's own sender — no events row for one's own message): the stage's message is in a conversation they take part in."""
    if holder == str(OWNER_TM):
        rows = await _sql(fetch=(
            "SELECT count(DISTINCT m.id) FROM conversation_messages m JOIN conversation_participants p ON p.conversation_id=m.conversation_id "
            f"WHERE p.member_id='{holder}' AND m.metadata->'event'->'payload'->>'work_item_id'='{work_item}' "
            f"AND m.metadata->'event'->'payload'->>'stage'='{stage}'"
        ))
        return (rows[0][0], rows[0][0])
    rows = await _sql(fetch=(
        "SELECT count(*), count(recipient_seq) FROM events "
        f"WHERE recipient_id='{holder}' AND payload->'event'->'payload'->>'work_item_id'='{work_item}' "
        f"AND payload->'event'->'payload'->>'stage'='{stage}'"
    ))
    return rows[0]


async def _confirm_preset(c, key: str) -> tuple[list, str, str]:
    rid, stages, target = await _preset(key)
    # the setup rows exactly as the web gets them (GET /desktop/recipes → setup_role_rows): each agent / either row on a runtime
    body = {
        "project_id": str(PROJ), "recipe_id": str(rid),
        "roles": [{"role": x["role"], "runtime": "claude"} for x in await _listed_rows(key) if x["kind"] != "human"],
    }
    code, _ = await _code(c, device=f"d4451 {key}")
    r = await _confirm(c, code, body=body)
    assert r.status_code == 200, (key, r.text)
    return stages, target, r.json()["work_item_id"]


@pytest.mark.anyio
async def test_the_guard_covers_exactly_the_listed_presets(world):
    listed = sorted(r["key"] for r in await _listed_rows("*"))
    assert listed == sorted(PRESETS), "a preset was added to or removed from the setup list — add it to PRESETS (this guard)"


@pytest.mark.anyio
@pytest.mark.parametrize("key", PRESETS)
async def test_the_first_stage_reaches_its_holder(world, key):
    async with _client() as c:
        stages, _, work_item = await _confirm_preset(c, key)
    holder = await _holder(key, stages[0])
    assert holder, f"{key}: the setup bound no one to the first stage «{stages[0]}»"
    reached = await _reached(key, holder, work_item, stages[0])
    assert tuple(reached) == (1, 1), f"{key}: the first stage «{stages[0]}» did not reach its holder (rows, with seq) = {reached}"


WORKFLOW_TWO_PLUS = [
    "preset.workflow.agent_solo", "preset.workflow.kanban_simple", "preset.workflow.loop_agency",
    "preset.workflow.scrum_3step", "preset.workflow.three_step", "preset.workflow.two_step",
]


async def _approval_elsewhere_stages(key: str) -> set[str]:
    """Story 4243 (PO ⓑ): a stage that declares `approval.surface` and whose role is not an agent has no holder — its seam is the
    gate's approval card, and the binding resolver drops an old binding row for it. loop_agency's brief_doc_approval (PO · either)."""
    rows = await _sql(fetch=f"SELECT stage_metadata, role_actor_kinds FROM event_definitions WHERE org_id IS NULL AND key='{key}'")
    meta, kinds = (v if isinstance(v, dict) else json.loads(v or "{}") for v in rows[0])
    return {
        st for st, m in meta.items()
        if isinstance(m, dict) and (m.get("approval") or {}).get("surface") and kinds.get(m.get("role"), "agent") != "agent"
    }


async def _publish_stage(c, key: str, work_item: str, stage: str) -> None:
    r = await c.post(
        "/api/v2/events/publish",
        json={"definition_key": key, "payload": {"work_item_type": "story", "work_item_id": work_item, "stage": stage}},
        headers=_person(OWNER),
    )
    assert r.status_code == 201, (key, stage, r.text)


@pytest.mark.anyio
@pytest.mark.parametrize("key", WORKFLOW_TWO_PLUS)
async def test_the_second_stage_of_a_workflow_recipe_reaches_the_second_holder(world, key):
    """kanban_simple: task_created (Any) → in_progress (Dev). The next stage that has a holder is published on the same work item
    by the person (the board's way; workflow recipes have no raw stage-order check) — it reaches whoever the setup bound to it.
    A stage whose approval is elsewhere (4243) is published too and must reach no bound member — the rule holds both ways."""
    elsewhere = await _approval_elsewhere_stages(key)
    async with _client() as c:
        stages, target, work_item = await _confirm_preset(c, key)
        assert target == "work_item_stakeholders" and len(stages) >= 2, (key, target, stages)
        nxt = next(st for st in stages[1:] if st not in elsewhere)
        skipped = [st for st in stages[1:stages.index(nxt)]]
        for st in skipped:
            await _publish_stage(c, key, work_item, st)
        await _publish_stage(c, key, work_item, nxt)
    holder = await _holder(key, nxt)
    assert holder, f"{key}: the setup bound no one to the stage «{nxt}»"
    reached = await _reached(key, holder, work_item, nxt)
    assert tuple(reached) == (1, 1), f"{key}: the stage «{nxt}» did not reach its holder (rows, with seq) = {reached}"
    for st in skipped:  # approval elsewhere: a bound row (the setup makes one for an either role) is not a holder
        bound = await _holder(key, st)
        if bound and bound != str(OWNER_TM):
            assert tuple(await _reached(key, bound, work_item, st)) == (0, 0), f"{key}: «{st}» (approval elsewhere) reached {bound}"


@pytest.mark.anyio
async def test_loop_agency_steps_over_its_approval_stage_both_ways(world):
    """The positive floor for the both-ways check above: loop_agency really has an approval-elsewhere stage right after the start
    and the setup really bound someone to it — otherwise the «reaches no bound member» half would pass on nothing."""
    assert await _approval_elsewhere_stages("preset.workflow.loop_agency") == {"brief_doc_approval"}
    async with _client() as c:
        await _confirm_preset(c, "preset.workflow.loop_agency")
    bound = await _holder("preset.workflow.loop_agency", "brief_doc_approval")
    assert bound and bound != str(OWNER_TM)


def test_the_two_plus_list_is_every_listed_workflow_recipe_with_a_second_stage():
    """Pinned against the seed: a workflow recipe that gains a second stage joins the hand-off check."""
    assert set(WORKFLOW_TWO_PLUS) < set(PRESETS)
    assert {"preset.workflow.kanban", "preset.workflow.solo"} & set(WORKFLOW_TWO_PLUS) == set()  # one stage each
