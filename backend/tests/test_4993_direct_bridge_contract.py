"""story 4993 (web PR 5a · same-network direct) — the web ↔ shell bridge contract the web repository holds a copy of (`contracts/direct-bridge.json`, the mobile repository's file from PR 4c-1) and the file that says how a press becomes the direct road's ROW
(`contracts/direct-rows.json`). The server runs nothing of the bridge; what it holds to is that the two files are what the other repositories' tests read (the hash of the bridge file) and that the row file names the kinds the server makes commands of. Each check goes red without the line it names.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.models.desktop_relay import COMMAND_KINDS

_DIR = Path(__file__).resolve().parents[2] / "contracts"
# the sha256 of the bytes as the mobile repository committed them (mobile `contracts/direct-bridge.json`, story 4993 · file direct, version 3) — a copy that drifts is RED, and so is a change of the file that did not change this line with it
_BRIDGE_SHA256 = "3ba5217c63df8d7083eafb093b519b3493a10b92b97debf811b9b9c20f2b1a98"


def test_the_bridge_copy_is_the_same_bytes_as_the_mobile_repositorys_file() -> None:
    assert hashlib.sha256((_DIR / "direct-bridge.json").read_bytes()).hexdigest() == _BRIDGE_SHA256, "contracts/direct-bridge.json is not the mobile repository's file (copy it again, byte for byte, and change this hash with it)"


def test_the_kinds_the_direct_road_takes_are_kinds_the_server_makes_commands_of() -> None:
    bridge = json.loads((_DIR / "direct-bridge.json").read_text(encoding="utf-8"))
    rows = json.loads((_DIR / "direct-rows.json").read_text(encoding="utf-8"))
    for kind in bridge["allowed"]["kinds"]:
        assert kind in COMMAND_KINDS, f"{kind} rides the direct road but the server has no command of that kind (the relay's own line would not know it)"
    for case in rows["cases"]:
        assert case["kind"] in COMMAND_KINDS and case["kind"] in bridge["allowed"]["kinds"], case["name"]
    assert rows["row_keys"] == bridge["command_row"]["keys"], "the row the web builds has the keys the bridge's judgement takes"
    assert "direct_open" not in bridge["allowed"]["kinds"] and "file_list" not in bridge["allowed"]["kinds"], "a door ask and a files read stay on the server's road"


def test_a_download_rides_the_direct_road_with_the_payload_the_server_makes_of_it() -> None:
    """story 4993 (file direct): the bridge (version 3) takes `file_download`, and the row file says its payload is exactly what the server's ask for a download stores — {project_id, envelope} (test_4988_desktop_file_download_realdb test_01 asserts the server's side of the same two keys)."""
    bridge = json.loads((_DIR / "direct-bridge.json").read_text(encoding="utf-8"))
    rows = json.loads((_DIR / "direct-rows.json").read_text(encoding="utf-8"))
    assert bridge["version"] == 3 and "file_download" in bridge["allowed"]["kinds"] and "file_download" in COMMAND_KINDS
    [route] = [r for r in rows["other_routes"] if r["verb"] == "download"]
    assert route["kind"] == "file_download" and route["session_key"] is None and route["payload_keys"] == ["project_id", "envelope"]
