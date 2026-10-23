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


async def test_a_control_character_is_a_readable_422_not_a_500_and_nothing_is_written():
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            agent = str(scenario["agent_id"])
            for field, body in (
                ("system_prompt", {"name": "Nul text", "system_prompt": "a\x00b"}),
                ("style_prompt", {"name": "Nul style", "system_prompt": "ok", "style_prompt": "s\x00"}),
                ("name", {"name": "Nul\x00name", "system_prompt": "ok"}),
                ("system_prompt", {"name": "Esc text", "system_prompt": "a\x1bb"}),
            ):
                r = await client.post("/api/v2/agent-personas", json={"agent_id": agent, **body})
                assert r.status_code == 422 and r.json()["error"]["code"] == "PERSONA_TEXT_INVALID", (field, r.status_code, r.text)
                assert field.replace("_", " ") in r.json()["error"]["message"] or field in r.json()["error"]["message"], r.text
            assert await _count(scenario, "Nul text") == 0 and await _count(scenario, "Esc text") == 0
            ok = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Tabs ok", "system_prompt": "line1\n\tindented\r\nline3"})
            assert ok.status_code == 201, ok.text                                                       # tab, newline and carriage return are text
            pid = ok.json()["data"]["id"]
            bad = await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": "x\x00"})
            assert bad.status_code == 422 and bad.json()["error"]["code"] == "PERSONA_TEXT_INVALID", bad.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_saved_equals_run_invisible_characters_and_odd_line_breaks_are_normalized_at_the_write():
    from app.services.agent_run_profile import _clean_persona_text

    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            agent = str(scenario["agent_id"])
            typed = "a‮b​c d\r\ne f﻿g­h\U000e0041i"
            r = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Normalized", "system_prompt": typed, "style_prompt": "x‏y z"})
            assert r.status_code == 201, r.text
            saved = r.json()["data"]
            assert saved["system_prompt"] == "abc\nd\ne\nfghi" and saved["style_prompt"] == "xy\nz", saved                     # the line breaks stay line breaks; nothing visible changed
            assert _clean_persona_text(saved["system_prompt"], 16_000, 32_000) == saved["system_prompt"]                       # the session's text IS the saved text
            pid = saved["id"]
            p = await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": "p‮q r"})
            assert p.status_code == 200 and p.json()["data"]["system_prompt"] == "pq\nr", p.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_a_base_patched_longer_is_judged_against_every_persona_that_uses_it():
    scenario = await _build_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            agent = str(scenario["agent_id"])
            base = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Shared base", "system_prompt": "b" * 3_000, "style_prompt": "s" * 100})
            bid = base.json()["data"]["id"]
            for name, size in (("Child big", 12_000), ("Child small", 1_000)):
                c = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": name, "system_prompt": "c" * size, "base_persona_id": bid})
                assert c.status_code == 201, c.text
            lone = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Not a child", "system_prompt": "n" * 15_000})
            assert lone.status_code == 201
            over = await client.patch(f"/api/v2/agent-personas/{bid}", json={"system_prompt": "b" * 5_000})                  # 5,000 + 2 + 12,000 > 16,000 for "Child big"
            assert over.status_code == 422 and over.json()["error"]["code"] == "PERSONA_TOO_LONG", over.text
            msg = over.json()["error"]["message"]
            assert '"Child big"' in msg and "Child small" not in msg and "Not a child" not in msg and "17,002 characters" in msg, msg
            assert (await client.get(f"/api/v2/agent-personas/{bid}")).json()["data"]["system_prompt"] == "b" * 3_000        # nothing was written
            style = await client.patch(f"/api/v2/agent-personas/{bid}", json={"style_prompt": "s" * 1_950})                 # the base style joins the child styles too (own style none → 1,950 fits)
            assert style.status_code == 200, style.text
            fits = await client.patch(f"/api/v2/agent-personas/{bid}", json={"system_prompt": "b" * 3_500})                  # 3,500 + 2 + 12,000 fits
            assert fits.status_code == 200, fits.text
            rename = await client.patch(f"/api/v2/agent-personas/{bid}", json={"name": "Renamed base"})
            assert rename.status_code == 200
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_a_long_kept_style_is_judged_when_only_the_instructions_are_patched():
    scenario = await _build_persona_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            from sqlalchemy import text as sql

            pid = scenario["persona_id"]
            async with scenario["Session"]() as s:
                await s.execute(sql("UPDATE agent_personas SET style_prompt = :t WHERE id = :i"), {"t": "s" * 2_500, "i": pid})
                await s.commit()
            r = await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": "short"})
            assert r.status_code == 422 and "The style is too long: 2,500 characters" in r.json()["error"]["message"], r.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_codex_5157_blank_after_normalization_and_a_nul_in_a_list_are_readable_422s_not_500s():
    scenario = await _build_persona_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            pid = scenario["persona_id"]
            agent = str(scenario["agent_id"])
            for blank in ("​", "‮﻿", "   ", ""):
                r = await client.patch(f"/api/v2/agent-personas/{pid}", json={"system_prompt": blank})
                assert r.status_code == 422 and r.json()["error"]["code"] == "PERSONA_TEXT_INVALID", (blank, r.status_code, r.text)
            assert (await client.get(f"/api/v2/agent-personas/{pid}")).json()["data"]["system_prompt"] == "hi"                    # unchanged
            lst = await client.patch(f"/api/v2/agent-personas/{pid}", json={"tool_allowlist": ["stories", "ta\x00sks"]})
            assert lst.status_code == 422 and lst.json()["error"]["code"] == "PERSONA_TEXT_INVALID", lst.text
            created = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "List nul", "system_prompt": "ok", "tool_allowlist": ["x\x00"]})
            assert created.status_code == 422 and created.json()["error"]["code"] == "PERSONA_TEXT_INVALID", created.text
            invisible_only = await client.post("/api/v2/agent-personas", json={"agent_id": agent, "name": "Invisible only", "system_prompt": "​"})
            assert invisible_only.status_code != 500, invisible_only.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def test_codex_5157_a_persona_cannot_be_its_own_base_and_the_read_ignores_such_a_row():
    scenario = await _build_persona_scenario()
    try:
        client = await _as_owner(scenario)
        try:
            pid = scenario["persona_id"]
            r = await client.patch(f"/api/v2/agent-personas/{pid}", json={"base_persona_id": str(pid)})
            assert r.status_code == 422 and r.json()["error"]["code"] == "PERSONA_BASE_INVALID", r.text
            assert not (await client.get(f"/api/v2/agent-personas/{pid}")).json()["data"].get("base_persona_id")
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()
