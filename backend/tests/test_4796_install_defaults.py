"""story 4796 (P8 of the prod cutover) - what a NEW install of a client is given as the prod address is the VM's API name, not the Cloud Run backend.

Found by the product owner's measurement before the window (2026-10-28, an hour of the prod backend's request log): agent clients still called the Cloud Run address directly. None of the clients in this repository asks the backend for
its address again (only the desktop app does, through /desktop/endpoints, and it lives elsewhere), so the address a client holds is the one it was installed with. These are the places a new install takes its prod address from; an
already installed copy keeps what it was given until its user changes `SPRINTABLE_API_URL` (or updates the plugin): that is the cutover notice's instruction, not something code here can do.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
API = "https://api.sprintable.ai"
OLD = re.compile(r"sprintable-backend-prod-(?:787818285179\.asia-northeast3|57iommnikq-du)\.(?:a\.)?run\.app")


def test_the_cli_the_hermes_prod_plugin_and_the_mcp_examples_give_a_new_install_the_api_name() -> None:
    assert f'export const DEFAULT_API_URL = "{API}";' in (_ROOT / "packages/cli/src/api.ts").read_text()
    assert f'DEFAULT_API_URL = "{API}"' in (_ROOT / "connectors/hermes-sprintable-prod/adapter.py").read_text()
    example = json.loads((_ROOT / "backend/sprintable_mcp/.mcp.json.example").read_text())
    urls = [svc["env"]["SPRINTABLE_API_URL"] for svc in example["mcpServers"].values() if "SPRINTABLE_API_URL" in svc.get("env", {})]
    assert urls == [API], urls
    assert f"export SPRINTABLE_API_URL={API}" in (_ROOT / "backend/sprintable_mcp/README.md").read_text()
    assert f"default: `{API}`" in (_ROOT / "packages/cli/README.md").read_text()


def test_no_install_default_names_the_cloud_run_prod_backend_any_more() -> None:
    for rel in ("packages/cli/src/api.ts", "packages/cli/README.md", "connectors/hermes-sprintable-prod/adapter.py", "backend/sprintable_mcp/.mcp.json.example", "backend/sprintable_mcp/README.md"):
        assert not OLD.search((_ROOT / rel).read_text()), rel


def test_the_hermes_prod_plugin_still_lets_an_environment_value_win() -> None:
    adapter = (_ROOT / "connectors/hermes-sprintable-prod/adapter.py").read_text()
    assert 'os.getenv("SPRINTABLE_PROD_API_URL", DEFAULT_API_URL)' in adapter, "an installed copy that sets the variable keeps what it set"
