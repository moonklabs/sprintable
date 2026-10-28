"""story 4796 (P1 of the prod cutover, deploy/vm/CUTOVER-prod.md) - the one address switch of the PROD branch of the pipeline.

Why: the prod pipeline named the Cloud Run backend's `run.app` address as the address that clients and the other services are given (the desktop setup's api_url, the baked `NEXT_PUBLIC_FASTAPI_URL`,
the hosted MCP, the support gateway). After the move that address answers nothing, and the next prod build would write it back. Now the line is the VM's API name, the way dev's line has been since
5300 (RUNBOOK §9); the old value stays in the comment next to it as the one-line undo.
Merging it is safe only while `api.sprintable.ai` already answers with the prod backend (the cutover sheet's step 3, the front door passing it through to Cloud Run); the comment says so.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_WF = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
_MAIN_TEXT = (_ROOT / "cloudbuild.yaml").read_text()
PROD_API = "https://api.sprintable.ai"
PROD_RUN = "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app"
DEV_API = "https://dev-api.sprintable.ai"


def _prod_branch() -> str:
    """the text of the `main` branch of the workflow's first `if`: from `if [[ "$REF_NAME" == "main" ]]` to its `else`"""
    start = _WF.index('if [[ "$REF_NAME" == "main" ]]; then')
    return _WF[start:_WF.index("\n          else\n", start)]


def test_the_prod_branch_has_one_fastapi_url_line_and_it_is_the_api_name() -> None:
    prod = _prod_branch()
    assert re.findall(r'(?m)^\s*echo "fastapi_url=([^"]+)"', prod) == [PROD_API]
    assert PROD_RUN not in re.sub(r"(?m)^\s*#.*$", "", prod).split("mcp_allowed_hosts")[0], "no live line of the address part names the Cloud Run backend any more"
    assert re.findall(r'(?m)^\s*echo "fastapi_url=([^"]+)"', _WF[_WF.index("\n          else\n"):]) == [DEV_API], "dev's line did not move"


def test_the_undo_and_the_condition_are_written_next_to_the_line() -> None:
    prod = _prod_branch()
    comment = prod[:prod.index('echo "fastapi_url=')].rsplit("story 4796 (AC4", 1)[1]
    assert f"Undo = the previous value of this line: {PROD_RUN}" in comment
    assert "Merge this ONLY while the API name already answers with the prod backend" in comment and "step 3" in comment
    for consumer in ("the desktop setup's api_url", "NEXT_PUBLIC_FASTAPI_URL", "the hosted MCP", "the support gateway"):
        assert consumer in comment, consumer


def test_what_the_prod_line_does_not_touch_stays_as_it_was() -> None:
    prod = _prod_branch()
    assert 'echo "backend_url=" >> "$GITHUB_OUTPUT"' in prod, "GA4's callback address stays empty (it has its own registration)"
    assert 'echo "realtime_url=" >> "$GITHUB_OUTPUT"' in prod and 'echo "next_public_app_url=https://app.sprintable.ai"' in prod
    assert "sprintable-mcp-prod-787818285179.asia-northeast3.run.app|mcp.sprintable.ai" in prod, "the hosted MCP's own allowed hosts did not change"


def test_the_prod_declaration_of_the_vm_states_the_same_address_as_the_pipeline() -> None:
    """the Cloud Run build and the VM must give clients the same address, or the two stacks disagree about where the backend is"""
    env = yaml.safe_load((_ROOT / "deploy/vm/env/prod.yaml").read_text())
    flat: dict[str, str] = {}

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str):
                    flat.setdefault(k, v)
                walk(v)

    walk(env)
    assert flat["FASTAPI_URL"] == PROD_API and flat["NEXT_PUBLIC_FASTAPI_URL"] == PROD_API


def test_every_consumer_of_the_substitution_still_reads_it_and_the_scheduler_step_still_skips_prod(tmp_path: Path) -> None:
    for needle in ("FASTAPI_URL=${_FASTAPI_URL},", "NEXT_PUBLIC_FASTAPI_URL=${_FASTAPI_URL}", 'ENV_VARS="MCP_TRANSPORT=http;SPRINTABLE_API_URL=${_FASTAPI_URL}"', "SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL=${_FASTAPI_URL}/api/v2/support/escalation-events"):
        assert needle in _MAIN_TEXT, needle
    steps = {s["id"]: s for s in yaml.safe_load(_MAIN_TEXT)["steps"]}
    body = steps["apply-cloud-scheduler"]["args"][1].replace("${_FASTAPI_URL}", PROD_API).replace("${_DEPLOY_ENV}", "prod").replace("${_CLOUD_RUN_APP_SKIP}", "false").replace("$$", "$")
    fake = tmp_path / "bin"
    fake.mkdir()
    log = tmp_path / "calls.log"
    log.write_text("")
    (fake / "python3").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n')
    (fake / "python3").chmod(0o755)
    p = subprocess.run(["bash", "-c", body], env={"PATH": f"{fake}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp_path)}, capture_output=True, text=True, timeout=30)
    assert p.returncode == 0 and log.read_text() == "", "a prod build with the new address still does not touch the scheduler (the sheet applies it once, from the repository)"


def _deploy_backend_update(tmp_path: Path, env: str, fastapi_url: str | None) -> str:
    steps = {s["id"]: s for s in yaml.safe_load(_MAIN_TEXT)["steps"]}
    body = steps["deploy-backend"]["args"][1]
    subst = {"_DEPLOY_ENV": env}
    if fastapi_url is not None:
        subst["_FASTAPI_URL"] = fastapi_url
    body = re.sub(r"\$\{(_[A-Z_0-9]+)\}", lambda m: subst.get(m.group(1), "v"), body).replace("$$", "$")
    fake = tmp_path / "bin"
    fake.mkdir(exist_ok=True)
    log = tmp_path / "calls.log"
    log.write_text("")
    (fake / "gcloud").write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >> "$FAKE_LOG"; done\n')
    (fake / "gcloud").chmod(0o755)
    p = subprocess.run(["bash", "-c", body], env={"PATH": f"{fake}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp_path), "PROJECT_ID": "p", "COMMIT_SHA": "s"}, capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return next(a for a in log.read_text().splitlines() if a.startswith("--update-env-vars="))


def test_the_prod_backend_deploy_gives_the_backend_the_api_name_and_still_no_public_address(tmp_path: Path) -> None:
    update = _deploy_backend_update(tmp_path, "prod", PROD_API)
    assert f"FASTAPI_URL={PROD_API}" in update.split("=", 1)[1].split(",")
    assert "PUBLIC_API_URL" not in update, "the origin of stored links is a separate step of the sheet (RUNBOOK §12 item 2), not this one"


def test_the_hand_deploy_script_of_prod_defaults_to_the_same_address() -> None:
    script = (_ROOT / "backend/scripts/deploy_backend.sh").read_text()
    prod_case = script[script.index("    prod)"):script.index("    *)")]
    assert 'FASTAPI_URL="${FASTAPI_URL:-https://api.sprintable.ai}"' in prod_case and PROD_RUN not in prod_case
    dev_case = script[script.index("    dev)"):script.index("    prod)")]
    assert 'FASTAPI_URL="${FASTAPI_URL:-https://dev-api.sprintable.ai}"' in dev_case
