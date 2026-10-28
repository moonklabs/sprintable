"""story 4796 — the old Cloud Run address of the dev backend (`…-57iommnikq-du.a.run.app`) is no longer written as a default or an example in the connectors and the static guides.

Phase 2 of the dev move (RUNBOOK §7c) moves every guest to `https://dev-api.sprintable.ai`. These files are guests that are not servers: the connectors' `DEFAULT_API_URL` (a connector started without a stored
address dials it) and the dev example lines of the guides under `apps/web/public/` (copied as they are into the VM frontend image). Prod is not part of this move: `hermes-sprintable-prod` and the guides' prod lines keep the
prod addresses.

Pinned: no file of the connectors (prod plugin excepted) or the guides names the old dev form; every `DEFAULT_API_URL` of the Python and host connectors and the shared SSE client is the dev API name — the one `DEFAULT_API_URL` that is not (the OpenClaw channel's) and the inline fallbacks of the Pi and OpenCode entry points name the prod app domain on purpose and are pinned as such; the prod plugin and the prod lines of the guides are unchanged.
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
        for p in _files("connectors") + _files("apps/web/public") + _files("packages/fakechat")
        if OLD_DEV in p.read_text(errors="ignore") and not str(p.relative_to(_ROOT)).startswith(PROD_PLUGIN)
    ]
    assert offenders == [], offenders
    for rel in ("backend/scripts/jobs/verify_grant_only_story_assign.py", "backend/sprintable_mcp/README.md"):
        assert OLD_DEV not in (_ROOT / rel).read_text(), rel


def test_fakechat_dials_the_dev_api_name_when_no_address_is_given() -> None:
    assert "process.env.SPRINTABLE_API_URL ?? 'https://dev-api.sprintable.ai'" in (_ROOT / "packages/fakechat/server.ts").read_text()


def test_the_texts_that_explain_why_the_address_is_direct_no_longer_say_only_run_app_is_direct() -> None:
    """codex (tokens PR): the reason is «no Cloudflare proxy in front» (SSE buffering); for dev that is the DNS-only dev API name now"""
    guide = (_ROOT / "apps/web/public/onboarding-guide.txt").read_text()
    assert "dev: `https://dev-api.sprintable.ai`, DNS only — no Cloudflare proxy" in guide and "Dev: `https://dev-api.sprintable.ai`" in guide
    assert "use the backend-direct run.app host" not in guide
    readme = (_ROOT / "backend/sprintable_mcp/README.md").read_text()
    assert "dev=https://dev-api.sprintable.ai" in readme and "prod는 run.app, dev는 DNS 전용 dev-api.sprintable.ai" in readme
    onboarding = (_ROOT / "backend/app/services/agent_onboarding_config.py").read_text()
    assert "prod=run.app, dev=DNS 전용 dev-api.sprintable.ai" in onboarding and "직통 run.app 이어야 한다" not in onboarding


def test_the_runbook_says_the_load_test_tools_stay_on_raw_cloud_run_on_purpose() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec = text[text.index("## 10. "):text.index("## 11. ")]
    assert "default to the raw Cloud Run backend **on purpose**" in sec and "They go with the Cloud Run backend in the first row above" in sec
    for name in ("run_loadtest.sh", "endpoint_mix_test.js", "dev_db_capacity_test.js", "generator_selfcheck.js"):
        assert name in sec and (_ROOT / "backend/scripts/loadtest" / name).exists(), name


def test_every_default_api_url_of_the_python_and_host_connectors_is_the_dev_api_name_and_the_three_entry_points_keep_the_prod_app_domain() -> None:
    found = []
    for p in _files("connectors"):
        rel = str(p.relative_to(_ROOT))
        if rel.startswith(PROD_PLUGIN):
            continue
        for m in re.finditer(r"(?m)^\s*(?:export\s+)?(?:const\s+)?DEFAULT_API_URL\s*(?::\s*\w+\s*)?=\s*[\"'](https?://[^\"']+)[\"']", p.read_text(errors="ignore")):
            found.append((rel, m.group(1)))
    assert len(found) >= 15, f"the connectors' defaults were found: {len(found)}"
    # the one `DEFAULT_API_URL` that is not a dev backend address is the OpenClaw channel's PROD app domain (`https://app.sprintable.ai`); the Pi and OpenCode entry points have an inline fallback to the same domain
    # (checked in the Phase 2 test below): prod is not part of this move
    others = [f for f in found if f[1] != DEV_API]
    assert others == [("connectors/openclaw-sprintable/src/channel.ts", "https://app.sprintable.ai")], others
    for rel, needle in (("connectors/pi-sprintable/index.ts", "process.env.SPRINTABLE_API_URL ?? 'https://app.sprintable.ai'"), ("connectors/opencode-sprintable/index.ts", 'process.env.SPRINTABLE_API_URL ?? "https://app.sprintable.ai"')):
        assert needle in (_ROOT / rel).read_text(), rel


def test_the_prod_plugin_and_the_prod_lines_of_the_guides_did_not_move() -> None:
    assert 'DEFAULT_API_URL = "https://api.sprintable.ai"' in (_ROOT / PROD_PLUGIN / "adapter.py").read_text(), "P8: the prod plugin's default is the API name"
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


def test_phase_2_of_the_runbook_says_what_the_connector_change_does_and_does_not_reach() -> None:
    """codex (tokens PR, round 2): new starts use the dev API name; an already installed connector keeps the old default and shows up as a non-VM caller in the request-log table"""
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    p2 = text[text.index("**Phase 2"):text.index("**Phase 3")]
    assert "a new start of the Python and host connectors (`DEFAULT_API_URL`) uses `https://dev-api.sprintable.ai`" in p2
    assert "the Pi and OpenCode extensions and the OpenClaw channel resolve their address at load time and use `https://app.sprintable.ai`" in p2, "their entry points name the prod app domain when no address is set"
    for rel, needle in (("connectors/pi-sprintable/index.ts", "process.env.SPRINTABLE_API_URL ?? 'https://app.sprintable.ai'"), ("connectors/opencode-sprintable/index.ts", 'process.env.SPRINTABLE_API_URL ?? "https://app.sprintable.ai"'), ("connectors/openclaw-sprintable/src/channel.ts", "const DEFAULT_API_URL = 'https://app.sprintable.ai'")):
        assert needle in (_ROOT / rel).read_text(), rel
    assert "(**deferred by the PO**, see «Phase 2 status» in §9" in p2 and "the Polar webhook (**deferred**, same place)" in p2
    assert "an already installed" not in p2 and "a connector already installed with the old `…-57iommnikq-du.a.run.app` default keeps dialing it" in p2
    assert "those show up in the request-log table as non-VM callers" in p2
