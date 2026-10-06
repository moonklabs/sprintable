"""[SID:4542] The name a person reads for an agent's tool — the web card and the push (PO 2026-10-05 01:59Z · 02:04Z · Yuna 02:05Z ·
Kadir 02:04Z/02:07Z).

The one definition is `app/services/tool-names.json` (table · rule · vectors): the same bytes as sprintable-mobile `contracts/tool-names.json`
(the desktop board and the phone's shell name a tool by it too); both repos pin its sha256, so an edit on one side only is RED. The
name is made here from the row's own `runtime` + `tool` — the daemon sends no name (no new free-text field · an older daemon's row is
named too). The phone's signing sheet never shows this: it names the tool from the value it signs.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

FILE = Path(__file__).resolve().parent / "tool-names.json"
ZWSP = "\u200b"
WJ = "\u2060"
_MCP = re.compile(r"^mcp__(.+?)__(.+)$", re.DOTALL)
_LOWER_DIGIT = re.compile(r"[a-z0-9]")
_UPPER = re.compile(r"[A-Z]")


@lru_cache(maxsize=1)
def _doc() -> dict:
    return json.loads(FILE.read_text(encoding="utf-8"))


def _table() -> dict:
    return _doc()["table"]


def tool_name(runtime: str | None, tool: str, lang: str) -> str:
    """mcp__{server}__{tool} → the file's `mcp` words · Claude's own tools as Claude shows them (but a daemon value in table.claude by
    exact key · story 4580) · others by exact key in the table, else
    «작업\u2060({value})» (the value never hidden) · a runtime not known → the value as it is."""
    lang = "en" if lang == "en" else "ko"
    m = _MCP.match(tool)
    if m:
        return _doc()["mcp"][lang].replace("{server}", m[1]).replace("{tool}", m[2])
    table = _table()
    if runtime == "claude":  # story 4580: its own names as they are — but a value of the daemon's own in the table (SandboxNetwork)
        own = table["claude"]["names"] if "claude" in table else {}
        return own[tool][lang] if tool in own else tool
    if runtime is None:
        return tool
    names = table[runtime]["names"] if runtime in table else {}
    if tool in names:  # a dict from JSON: exact keys, no prototype
        return names[tool][lang]
    return table["codex"]["other"][lang].replace("{value}", tool)


def _hangul(c: str) -> bool:
    return 0xAC00 <= ord(c) <= 0xD7A3


def wrap_tool_name(s: str) -> str:
    """Break points for display only: U+200B after _ - . / : and before a camelCase capital; U+2060 inside a Hangul word and between
    it and what is glued to it. Nothing next to one already there."""
    out: list[str] = []
    for i, b in enumerate(s):
        if i > 0:
            a = s[i - 1]
            if a not in (ZWSP, WJ) and b not in (ZWSP, WJ):
                if (a in "_-./:" and not b.isspace()) or (_LOWER_DIGIT.match(a) and _UPPER.match(b)):
                    out.append(ZWSP)
                elif (_hangul(a) and not b.isspace()) or (_hangul(b) and not a.isspace()):
                    out.append(WJ)  # inside a Hangul word, or glued to it
        out.append(b)
    return "".join(out)


def shown_tool(runtime: str | None, tool: str, lang: str) -> str:
    return wrap_tool_name(tool_name(runtime, tool, lang))


def agent_on_device(agent: str | None, device: str | None) -> str:
    """«{agent} · {computer}» — the computer not again when the agent's name already ends in exactly « · {computer}»."""
    a = (agent or "").strip()
    d = (device or "").strip()
    if not d:
        return a
    if not a:
        return d
    return a if a.endswith(f" · {d}") else f"{a} · {d}"
