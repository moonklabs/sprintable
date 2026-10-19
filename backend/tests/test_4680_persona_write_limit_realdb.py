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
