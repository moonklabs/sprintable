"""story 4796 — one address for the backend in the dev pipeline, and the Cloud Scheduler step follows it.

Every consumer of the backend's own address in cloudbuild.yaml reads `_FASTAPI_URL` (cloud-build.yml `fastapi_url`, dev branch): the backend's `FASTAPI_URL` (which the desktop setup
hands to the Mac app as `api_url`), the baked `NEXT_PUBLIC_FASTAPI_URL`, the hosted MCP's `SPRINTABLE_API_URL`, the support gateway's escalation URL. The Cloud Scheduler step was the one that
did not: it always read the backend's Cloud Run `status.url`, so after the move it would have written the Cloud Run address back into the jobs on every dev deploy (RUNBOOK §9 (4)).

Pinned: the five consumers still read `_FASTAPI_URL`; the dev line of `fastapi_url` is single and (until the move) still the Cloud Run address; the scheduler step — run for real against a
fake python3 after the same substitution Cloud Build does — passes `--base-url` exactly when `_FASTAPI_URL` is the dev API name, passes nothing for either Cloud Run address form, and skips prod.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_MAIN_TEXT = (_ROOT / "cloudbuild.yaml").read_text()
_MAIN = yaml.safe_load(_MAIN_TEXT)
_WF_TEXT = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
_STEPS = {s["id"]: s for s in _MAIN["steps"]}
NEW_FORM = "https://sprintable-backend-dev-787818285179.asia-northeast3.run.app"
OLD_FORM = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
DEV_API = "https://dev-api.sprintable.ai"


def _script(step_id: str) -> str:
    args = _STEPS[step_id]["args"]
    assert args[0] == "-c"
    return args[1]


def _run_step(tmp_path: Path, fastapi_url: str, env: str = "dev") -> tuple[int, list[list[str]]]:
    fake = tmp_path / "bin"
    fake.mkdir(exist_ok=True)
    log = tmp_path / "calls.log"
    log.write_text("")
    (fake / "python3").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n')
    (fake / "python3").chmod(0o755)
    body = _script("apply-cloud-scheduler").replace("${_FASTAPI_URL}", fastapi_url).replace("${_DEPLOY_ENV}", env).replace("$$", "$")
    assert not re.search(r"\$\{_[A-Z_]+\}", body), "an unsubstituted Cloud Build variable is left in the step"
    p = subprocess.run(["bash", "-c", body], env={"PATH": f"{fake}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp_path)}, capture_output=True, text=True, timeout=30)
    return p.returncode, [line.split() for line in log.read_text().splitlines()]


@pytest.mark.parametrize("value", [NEW_FORM, OLD_FORM])
def test_while_the_backend_is_on_cloud_run_the_jobs_are_applied_as_before(tmp_path: Path, value: str) -> None:
    rc, calls = _run_step(tmp_path, value)
    assert rc == 0 and calls == [["infra/apply_cloud_scheduler.py", "--env", "dev", "--apply"]], calls


def test_once_the_backend_address_is_the_dev_api_name_the_jobs_are_pointed_there(tmp_path: Path) -> None:
    rc, calls = _run_step(tmp_path, DEV_API)
    assert rc == 0 and calls == [["infra/apply_cloud_scheduler.py", "--env", "dev", "--base-url", DEV_API, "--apply"]], calls


@pytest.mark.parametrize("value", [DEV_API + "/", "http://dev-api.sprintable.ai", "https://dev-api.sprintable.ai.evil.example", "https://api.sprintable.ai", ""])
def test_any_other_value_passes_no_address_to_the_tool(tmp_path: Path, value: str) -> None:
    """the tool takes exactly one address anyway; the step never forwards anything else"""
    rc, calls = _run_step(tmp_path, value)
    assert rc == 0 and calls == [["infra/apply_cloud_scheduler.py", "--env", "dev", "--apply"]], calls


def test_prod_is_still_skipped(tmp_path: Path) -> None:
    rc, calls = _run_step(tmp_path, DEV_API, env="prod")
    assert rc == 0 and calls == []


def test_every_consumer_of_the_backend_address_still_reads_the_one_substitution() -> None:
    """a consumer that stops reading `_FASTAPI_URL` would keep the Cloud Run address after the move (or the reverse); the switch is one line, so they must all follow it"""
    assert "FASTAPI_URL=${_FASTAPI_URL}," in _MAIN_TEXT, "the backend's own variable (the desktop setup's api_url)"
    assert "NEXT_PUBLIC_FASTAPI_URL=${_FASTAPI_URL}" in _MAIN_TEXT, "the baked browser address"
    assert 'ENV_VARS="MCP_TRANSPORT=http;SPRINTABLE_API_URL=${_FASTAPI_URL}"' in _MAIN_TEXT, "the hosted MCP"
    assert "SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL=${_FASTAPI_URL}/api/v2/support/escalation-events" in _MAIN_TEXT, "the support gateway"
    assert 'if [ "${_FASTAPI_URL}" = "https://dev-api.sprintable.ai" ]' in _script("apply-cloud-scheduler"), "the scheduler jobs"


def test_the_dev_line_of_fastapi_url_is_single_and_until_the_move_the_cloud_run_address() -> None:
    """the switch is this one line; the pull request that flips it (RUNBOOK §9) changes the allowed set here on purpose"""
    dev_lines = re.findall(r'(?m)^\s*echo "fastapi_url=(https://sprintable-backend-dev-[^"]+)"', _WF_TEXT)
    assert dev_lines == [NEW_FORM], dev_lines
    assert not re.search(r'echo "fastapi_url=https://dev-api', _WF_TEXT), "dev has not been switched by this change"


def test_the_runbook_names_the_one_switch_what_follows_it_and_the_order_condition() -> None:
    """the desktop story 4801 AC1 wants the source of the address and the line that changes it in writing; PO: the old address answers until the Macs have heard the new one"""
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec = text[text.index("## 9. "):text.index("## 10. ")]
    switch = sec[sec.index("**The one switch"):sec.index("Order of work:")]
    for needle in ("`.github/workflows/cloud-build.yml`", "`_FASTAPI_URL`", "`exchange_urls()`", "`NEXT_PUBLIC_FASTAPI_URL`", "`SPRINTABLE_API_URL`", "escalation URL", "`--base-url`", "`MCP_PUBLIC_URL`", "story 4801"):
        assert needle in switch, needle
    assert "keeps answering until every lane Mac has heard the new one" in switch
    p3 = text[text.index("**Phase 3"):text.index("## 8. ")]
    pre = p3[:p3.index("\n1. ")]
    assert "request log free of lane traffic at the old `run.app` address" in pre, "Phase 3 starts only when no Mac still uses the old address"
