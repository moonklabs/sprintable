"""story 4680 AC2 (PO 2026-10-18) — the caps the daemon is handed are checked where the persona is WRITTEN: over → 422 with a readable sentence (how many, how many at most) and nothing written;
the boundary passes. Real HTTP over a migrated PG, the owner-guard test's own scenario (an agent, its owner)."""
from __future__ import annotations

import pytest

from tests.test_4000_agent_owner_guard_realdb import (  # noqa: F401 — fixtures + helpers
    _build_persona_scenario,
    _build_scenario,
    _clear_overrides,
    _client_as,
    _dispose_global_engine_after_test,
    anyio_backend,
)

pytestmark = pytest.mark.anyio


async def _as_owner(scenario):
    return await _client_as(scenario, scenario["owner_user_id"])


async def _count(scenario, name: str) -> int:
    from sqlalchemy import text

    async with scenario["Session"]() as s:
        return (await s.execute(text("SELECT count(*) FROM agent_personas WHERE name = :n"), {"n": name})).scalar_one()


async def test_create_over_the_character_cap_is_a_422_that_says_how_many_and_writes_nothing():
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            ok = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Edge ok", "system_prompt": "x" * 16_000})
            assert ok.status_code == 201, ok.text                                   # the boundary passes
            over = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Edge over", "system_prompt": "x" * 16_001})
            assert over.status_code == 422, over.text
            body = over.json()["error"]
            assert body["code"] == "PERSONA_TOO_LONG"
            assert "16,001 characters" in body["message"] and "16,000 characters" in body["message"] and "32,000 bytes" in body["message"], body["message"]
            assert await _count(scenario, "Edge over") == 0                           # nothing written
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_the_byte_cap_too_korean_is_three_bytes_a_character():
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            ok = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Ko ok", "system_prompt": "가" * 10_666})     # 31,998 bytes
            assert ok.status_code == 201, ok.text
            over = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Ko over", "system_prompt": "가" * 10_667})   # 32,001 bytes
            assert over.status_code == 422 and "32,001 bytes" in over.json()["error"]["message"], over.text
            assert await _count(scenario, "Ko over") == 0
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_the_style_cap_and_the_patch_route_have_the_same_rule():
    scenario = await _build_persona_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            pid = scenario["persona_id"]
            assert (await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "s" * 2_000})).status_code == 200
            style = await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "s" * 2_001})
            assert style.status_code == 422 and "2,001 characters" in style.json()["error"]["message"], style.text
            assert (await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "😀" * 1_500})).status_code == 200            # 6,000 bytes: the byte cap's boundary
            bytes_over = await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "😀" * 1_501})
            assert bytes_over.status_code == 422 and "6,004 bytes" in bytes_over.json()["error"]["message"], bytes_over.text
            text = await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": "y" * 16_001})
            assert text.status_code == 422 and text.json()["error"]["code"] == "PERSONA_TOO_LONG", text.text
            assert (await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": "y" * 16_000})).status_code == 200
            # the persona still holds the last accepted text, not the refused one
            got = await client.get(f"/api/v2/agent-personas/{pid}")
            assert got.json()["data"]["system_prompt"] == "y" * 16_000
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_a_base_persona_counts_toward_the_same_cap():
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            base = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Base", "system_prompt": "b" * 10_000})
            assert base.status_code == 201, base.text
            base_id = base.json()["data"]["id"]
            fits = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Fits", "system_prompt": "o" * 5_000, "base_persona_id": base_id})
            assert fits.status_code == 201, fits.text                                                   # 10,000 + 2 + 5,000 ≤ 16,000
            over = await client.post("/api/v2/agent-personas", json={"agent_id": str(scenario["agent_id"]), "name": "Too much", "system_prompt": "o" * 6_000, "base_persona_id": base_id})
            assert over.status_code == 422 and "with its base persona" in over.json()["error"]["message"], over.text
            assert await _count(scenario, "Too much") == 0
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_the_style_byte_cap_too_and_what_the_write_accepts_always_fits_the_daemons_session_cap():
    """the two caps interlock (PO 2026-10-18): the LONGEST shape the write accepts — instructions at the cap, style at ITS cap, base joined, the longest role name, the daemon's fixed opening sentence — is inside the
    daemon's session cap (40,000 bytes · 20,000 characters, mobile `PERSONA_TEXT_MAX_*`), so a persona that could be written is never cut by the daemon. Pinned in numbers: 32,000 + 6,000 + the role
    and name at four bytes a character + the sentence + the labels ≤ 40,000."""
    from app.services.agent_run_profile import (
        PERSONA_ROLE_MAX, PERSONA_STYLE_MAX, PERSONA_STYLE_MAX_BYTES, PERSONA_TEXT_MAX, PERSONA_TEXT_MAX_BYTES, _clean_persona_text,
    )

    DAEMON_MAX_BYTES, DAEMON_MAX_CHARS = 40_000, 20_000     # mobile desktop-host/src/run-profile.ts PERSONA_TEXT_MAX_BYTES / PERSONA_TEXT_MAX_CHARS — keep equal
    opening = "You are " + "N" * 80 + ", working as " + "R" * PERSONA_ROLE_MAX + " for your organization on Sprintable. Your organization gave this role the instructions below — follow them for this session."
    worst_bytes = (len(opening.encode()) - 80 - PERSONA_ROLE_MAX) + 80 * 4 + PERSONA_ROLE_MAX * 4 + PERSONA_TEXT_MAX_BYTES + PERSONA_STYLE_MAX_BYTES + len("\n\nStyle: ") + len("\n\n")
    assert worst_bytes <= DAEMON_MAX_BYTES, f"{worst_bytes} bytes: lower the write caps, not the daemon's"
    worst_chars = len(opening) + PERSONA_TEXT_MAX + PERSONA_STYLE_MAX + len("\n\nStyle: ") + len("\n\n")
    assert worst_chars <= DAEMON_MAX_CHARS, f"{worst_chars} characters"
    # and the style's own byte cap is enforced where it is written (a 2,000-character style of four-byte characters is 8,000 bytes: refused)
    assert len(_clean_persona_text("가" * 2_000, PERSONA_STYLE_MAX, PERSONA_STYLE_MAX_BYTES).encode()) == 6_000
    assert len(_clean_persona_text("😀" * 2_000, PERSONA_STYLE_MAX, PERSONA_STYLE_MAX_BYTES).encode()) <= PERSONA_STYLE_MAX_BYTES


async def test_a_patch_is_judged_on_what_the_persona_would_be_not_only_the_fields_it_sends():
    """codex 5157: PATCH checked only the fields it carried — a base persona swapped in, or a style added next to a long kept text, could push the effective persona over the cap
    (the daemon would then cut it). Now the kept fields count; a PATCH that touches none of them (a rename) never fails on a long legacy text."""
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            agent = str(scenario["agent_id"])
            big_base = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Big base", "system_prompt": "b" * 12_000})
            assert big_base.status_code == 201, big_base.text
            mine = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Mine", "system_prompt": "m" * 6_000})
            assert mine.status_code == 201, mine.text
            pid = mine.json()["data"]["id"]
            swap = await client.patch(f"/api/v2/agent-personas/{pid}", json={"base_persona_id": big_base.json()["data"]["id"]})   # 12,000 + 6,000 kept > 16,000
            assert swap.status_code == 422 and "with its base persona" in swap.json()["error"]["message"], swap.text
            got = (await client.get(f"/api/v2/agent-personas/{pid}")).json()["data"]
            assert not got.get("base_persona_id")                                                                                 # nothing was written
            # a rename touches none of the three: it passes even for a text that is over the cap today
            from sqlalchemy import text as sql

            async with scenario["Session"]() as s:
                await s.execute(sql("UPDATE agent_personas SET system_prompt = :t WHERE id = :i"), {"t": "z" * 20_000, "i": pid})
                await s.commit()
            assert (await client.patch(f"/api/v2/agent-personas/{pid}", json={"name": "Renamed"})).status_code == 200
            # but touching the style with that kept 20,000-character text is judged on it
            assert (await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "ok"})).status_code == 422
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_the_kept_base_persona_and_the_base_style_count_on_a_patch_and_on_create():
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            agent = str(scenario["agent_id"])
            base = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Base", "system_prompt": "b" * 12_000, "style_prompt": "s" * 1_500})
            assert base.status_code == 201, base.text
            bid = base.json()["data"]["id"]
            mine = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Mine", "system_prompt": "m" * 1_000, "base_persona_id": bid})
            assert mine.status_code == 201, mine.text
            pid = mine.json()["data"]["id"]
            # the base is KEPT (the patch sends no base id): 12,000 + 2 + 5,000 > 16,000
            kept = await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": "m" * 5_000})
            assert kept.status_code == 422 and "with its base persona" in kept.json()["error"]["message"], kept.text
            # the base's style counts with the own style: 1,500 + 2 + 600 > 2,000
            style = await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "t" * 600})
            assert style.status_code == 422 and "with its base persona" in style.json()["error"]["message"], style.text
            assert (await client.patch(f"/api/v2/agent-personas/{pid}", json={"style_prompt": "t" * 400})).status_code == 200      # 1,500 + 2 + 400 fits
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()
