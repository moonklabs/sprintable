"""story 4796 — the old Cloud Run address of the dev backend (`…-57iommnikq-du.a.run.app`) is no longer written as a default or an example in the connectors and the static guides.

Phase 2 of the dev move (RUNBOOK §7c) moves every guest to `https://dev-api.sprintable.ai`. These files are guests that are not servers: the connectors' `DEFAULT_API_URL` (a connector started without a stored
address dials it) and the dev example lines of the guides under `apps/web/public/` (copied as they are into the VM frontend image). Prod is not part of this move: `hermes-sprintable-prod` and the guides' prod lines keep the
prod addresses.

Pinned: no file of the connectors (prod plugin excepted) or the guides names the old dev form; every `DEFAULT_API_URL` / `apiUrl` default there is the dev API name; the prod plugin and the prod lines of the guides are unchanged.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
OLD_DEV = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
DEV_API = "https://dev-api.sprintable.ai"
PROD_PLUGIN = "connectors/hermes-sprintable-prod"
_TEXT_SUFFIXES = {".py", ".ts", ".md", ".txt"}


def _files(base: str) -> list[Path]:
    return [p for p in (_ROOT / base).rglob("*") if p.is_file() and p.suffix in _TEXT_SUFFIXES and "node_modules" not in p.parts]


def test_no_connector_or_guide_file_names_the_old_dev_form() -> None:
    offenders = [
        str(p.relative_to(_ROOT))
        for p in _files("connectors") + _files("apps/web/public")
        if OLD_DEV in p.read_text(errors="ignore") and not str(p.relative_to(_ROOT)).startswith(PROD_PLUGIN)
    ]
    assert offenders == [], offenders


def test_every_default_api_url_of_the_dev_connectors_is_the_dev_api_name() -> None:
    found = []
    for p in _files("connectors"):
        rel = str(p.relative_to(_ROOT))
        if rel.startswith(PROD_PLUGIN):
            continue
        for m in re.finditer(r"(?m)^\s*(?:export\s+)?(?:const\s+)?DEFAULT_API_URL\s*(?::\s*\w+\s*)?=\s*[\"'](https?://[^\"']+)[\"']", p.read_text(errors="ignore")):
            found.append((rel, m.group(1)))
    assert len(found) >= 15, f"the connectors' defaults were found: {len(found)}"
    # the one default that is not a dev backend address is the OpenClaw channel's PROD app domain (`https://app.sprintable.ai`): prod is not part of this move
    others = [f for f in found if f[1] != DEV_API]
    assert others == [("connectors/openclaw-sprintable/src/channel.ts", "https://app.sprintable.ai")], others


def test_the_prod_plugin_and_the_prod_lines_of_the_guides_did_not_move() -> None:
    assert 'DEFAULT_API_URL = "https://sprintable-backend-prod-57iommnikq-du.a.run.app"' in (_ROOT / PROD_PLUGIN / "adapter.py").read_text()
    prod = "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app"
    for guide in ("connect-guide.ko.txt", "connect-guide.en.txt", "onboarding-guide.txt"):
        assert prod in (_ROOT / "apps/web/public" / guide).read_text(), guide


@pytest.mark.parametrize("guide,needle", [
    ("connect-guide.ko.txt", "/sprintable:configure <0단계에서 발급한 키> " + DEV_API),
    ("connect-guide.en.txt", "/sprintable:configure <the key issued in step 0> " + DEV_API),
    ("onboarding-guide.txt", "# export SPRINTABLE_API_URL=" + DEV_API),
])
def test_the_dev_example_line_of_each_guide_names_the_dev_api_name(guide: str, needle: str) -> None:
    assert needle in (_ROOT / "apps/web/public" / guide).read_text()
