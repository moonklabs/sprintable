"""[SID:4542] the one naming rule for an agent's tool (web card · push) — app/services/tool-names.json is the same bytes as sprintable-mobile
contracts/tool-names.json (the desktop board and the phone's shell use it too); its sha256 is pinned here and there, so an edit on one
side only is RED, and the same vectors hold every implementation."""

import hashlib
import json

from app.services.tool_names import FILE, agent_on_device, tool_name, wrap_tool_name

RAW = FILE.read_bytes()
ONE = json.loads(RAW.decode("utf-8"))


def _strip(s: str) -> str:
    return s.replace("\u200b", "").replace("\u2060", "")


def test_the_shared_file_is_the_one_pinned_in_both_repos():
    assert hashlib.sha256(RAW).hexdigest() == "e99dd40bacdfde9c897aa35da4afa69b8b006bf56aa69ef0fb1a8310cc742e77"


def test_every_vector_names_and_wraps_as_the_board_and_the_phone_do():
    for v in ONE["vectors"]:
        for lang in ("ko", "en"):
            n = tool_name(v["runtime"], v["tool"], lang)
            assert n == v[lang], (v["runtime"], v["tool"], lang)
            assert wrap_tool_name(n) == v[f"{lang}_wrapped"], (v["runtime"], v["tool"], lang)
            assert _strip(wrap_tool_name(n)) == _strip(n)


def test_exact_keys_only_and_the_value_never_hidden():
    for v in ("__proto__", "constructor", "commandexecution", "commandExecution "):
        assert tool_name("codex", v, "ko") == f"작업\u2060({v})"
    assert tool_name(None, "commandExecution", "ko") == "commandExecution"  # a runtime not known: as it is


def test_the_computer_once_only_on_its_exact_tail():
    assert agent_on_device("Agent · SYJ-MacBook-Pro", "SYJ-MacBook-Pro") == "Agent · SYJ-MacBook-Pro"
    assert agent_on_device("Agent · OtherMac", "SYJ-MacBook-Pro") == "Agent · OtherMac · SYJ-MacBook-Pro"
    assert agent_on_device("Agent · SYJ-MacBook-Pro", "MacBook-Pro") == "Agent · SYJ-MacBook-Pro · MacBook-Pro"
    assert agent_on_device("Agent", "SYJ-MacBook-Pro") == "Agent · SYJ-MacBook-Pro"
    assert agent_on_device("Agent", None) == "Agent"
