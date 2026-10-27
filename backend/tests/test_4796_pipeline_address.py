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


def test_the_dev_line_of_fastapi_url_is_single_and_names_the_vm_api_address() -> None:
    """the switch is this one line (RUNBOOK §9); the pull request that flipped it (story 4796, PO signal 2026-10-27) moved it from the Cloud Run address to the dev API name and keeps the old value in the comment above it as the undo"""
    dev_lines = re.findall(r'(?m)^\s*echo "fastapi_url=(https://(?:dev-api\.sprintable\.ai|sprintable-backend-dev-[^"]+))"', _WF_TEXT)
    assert dev_lines == [DEV_API], dev_lines
    assert f"Undo = the previous value of this line: {NEW_FORM}" in _WF_TEXT, "the one-line undo is written next to the line"
    assert re.findall(r'(?m)^\s*echo "backend_url=(https://sprintable-backend-dev-[^"]+)"', _WF_TEXT) == [NEW_FORM], "GA4's own line did not move"
    prod = re.findall(r'(?m)^\s*echo "fastapi_url=(https://sprintable-backend-prod-[^"]+)"', _WF_TEXT)
    assert prod == ["https://sprintable-backend-prod-787818285179.asia-northeast3.run.app"], "prod is not part of this change"
    assert len(re.findall(r'echo "fastapi_url=', _WF_TEXT)) == 2, "exactly the prod line and the dev line"


def test_the_runbook_names_the_one_switch_what_follows_it_and_the_order_condition() -> None:
    """the desktop story 4801 AC1 wants the source of the address and the line that changes it in writing; PO: the old address answers until the Macs have heard the new one"""
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec = text[text.index("## 9. "):text.index("## 10. ")]
    switch = sec[sec.index("**The one switch"):sec.index("Order of work:")]
    for needle in ("`.github/workflows/cloud-build.yml`", "`_FASTAPI_URL`", "`exchange_urls()`", "`NEXT_PUBLIC_FASTAPI_URL`", "`SPRINTABLE_API_URL`", "escalation URL", "`--base-url`", "`MCP_PUBLIC_URL`", "story 4801"):
        assert needle in switch, needle
    assert "keeps answering until every lane Mac has heard the new one" in switch
    assert "`httpRequest.remoteIp` is **not** the VM's static address" in _runbook_section("**Phase 3", "## 8. "), "the front door's own requests are in the same log: the check must read it by caller"
    assert "the front door's own requests carry the VM's address as `httpRequest.remoteIp`" in switch
    p3 = text[text.index("**Phase 3"):text.index("## 8. ")]
    pre = p3[:p3.index("\n1. ")]
    assert "request log free of lane traffic at the old `run.app` address" in pre, "Phase 3 starts only when no Mac still uses the old address"


def _runbook_section(start: str, end: str) -> str:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    return text[text.index(start):text.index(end)]


def test_the_claims_the_runbook_makes_about_the_address_sources_are_true_in_the_code() -> None:
    """codex (pipeline PR): api_url is FASTAPI_URL but mcp_url is MCP_PUBLIC_URL; the manual deploy scripts and the static guides still hold the Cloud Run address"""
    ds = (_ROOT / "backend/app/services/desktop_setup.py").read_text()
    ex = ds[ds.index("def exchange_urls"):]
    assert 'os.environ.get("FASTAPI_URL"' in ex and "resolve_mcp_public_url()" in ex, "api_url from FASTAPI_URL, mcp_url from MCP_PUBLIC_URL"
    assert 'FASTAPI_URL="${FASTAPI_URL:-https://dev-api.sprintable.ai}"' in (_ROOT / "backend/scripts/deploy_backend.sh").read_text()
    assert re.search(r'(?m)^DEV_BACKEND_URL="https://dev-api\.sprintable\.ai"', (_ROOT / "backend/scripts/deploy_mcp_dev.sh").read_text()), "the hosted-MCP script carries the same value"
    assert re.search(r"(?m)^  _FASTAPI_URL: https://dev-api\.sprintable\.ai$", _MAIN_TEXT), "the build's own default is the switch's value"
    for guide in ("connect-guide.ko.txt", "connect-guide.en.txt", "onboarding-guide.txt"):
        assert "run.app" in (_ROOT / "apps/web/public" / guide).read_text(), guide
    usage = (_ROOT / "backend/app/services/agent_api_key_usage.py").read_text()
    assert "remote_ip = client_ip(request)" in usage, "the ledger records client_ip(): the VM's address behind the pass-through"


def test_no_route_the_three_flipped_callers_use_is_limited_per_client_ip() -> None:
    """the PR text says the scheduler, the hosted MCP and the support gateway reach no `client_ip`-keyed limit; this pins which files hold such limits"""
    holders = {
        str(p.relative_to(_ROOT / "backend/app"))
        for p in (_ROOT / "backend/app").rglob("*.py")
        if re.search(r"\b(open_setup_limiter|resend_verification_limiter)\.limit\(", p.read_text())
    }
    assert holders == {"routers/auth.py", "routers/onboarding.py", "routers/desktop_setup.py"}, holders
    auth = (_ROOT / "backend/app/routers/auth.py").read_text()
    assert auth.count("@resend_verification_limiter.limit(") == 2 and '@router.post("/set-password/request")\n@resend_verification_limiter' in auth, "the two mail-sending routes the runbook names"
    assert len(re.findall(r"@open_setup_limiter\.limit\(", (_ROOT / "backend/app/routers/desktop_setup.py").read_text())) == 4, "the four public desktop-setup routes"
    for name in ("cron.py", "support_gateway_token.py"):
        files = list((_ROOT / "backend/app/routers").glob(name))
        assert files, name
        assert "limiter.limit(" not in files[0].read_text(), f"{name} has a limit now: recheck the PR text"


def test_the_runbook_measurement_example_is_the_harmless_endpoint_with_more_requests_than_instances_times_the_limit() -> None:
    sec = _runbook_section("**First-VM measurement", "Caddy needs the real hostnames")
    assert "POST /api/v2/desktop/setup-codes/exchange" in sec and "the limit times the number of instances that can answer" in sec
    assert "Do not use the verification-resend limiter: it sends real mail" in sec
    assert "480 passed = 2 × 240" in sec, "the Phase 1 measurement that fixed the reading"
    wf = _WF_TEXT
    assert 'echo "backend_min_instances=2"' in wf and 'echo "backend_max_instances=8"' in wf, "the dev instance range the runbook quotes"
    assert "`backend_min_instances=2`, `backend_max_instances=8`" in sec and "240 × 8 = 1,920, round to 2400" in sec and "seq 1 2400" in sec
    assert "1000 would not have been enough from 5 instances up" in sec


def test_the_runbook_states_the_flip_order_the_accepted_cost_and_the_places_the_pipeline_does_not_cover() -> None:
    sec = _runbook_section("## 9. ", "## 10. ")
    assert "**before** the 4801 app version is installed" in sec
    assert "Accepted cost (PO)" in sec and "agent_api_key_usage.remote_ip" in sec and "`client_ip()` is not changed for this" in sec
    assert "3,613 a day" in sec and "1,404 a day" in sec
    for name in ("backend/scripts/deploy_backend.sh", "backend/scripts/deploy_mcp_dev.sh", "connect-guide.ko.txt", "connect-guide.en.txt", "onboarding-guide.txt"):
        assert name in sec, name
    assert "`resend-verification` and `set-password/request` — both 3 an hour, both send mail" in sec and "`sk_live_` key is counted per key" in sec
    assert "also name `run.app` addresses and are copied into the VM frontend image as they are" in sec
    assert "change them before `dev-app` is served from the VM" in sec, "the guides are a cutover precondition, not a note"
    p2 = _runbook_section("**Phase 2", "**Phase 3")
    assert "`mcp_url` from `MCP_PUBLIC_URL`" in p2


def test_the_stream_lifetimes_the_runbook_states_are_the_ones_in_the_code() -> None:
    """codex (pipeline PR, round 2): the browser stream is cut at 55 s by the frontend BFF and capped at 90 s + 15 s jitter by the backend; 120 s was the agent stream the PO measured"""
    assert "const UPSTREAM_HARD_TIMEOUT_MS = 55_000;" in (_ROOT / "apps/web/src/app/api/event-stream/route.ts").read_text()
    events = (_ROOT / "backend/app/routers/events.py").read_text()
    assert "_SSE_LIFESPAN_SEC: float = 90.0" in events and "_SSE_LIFESPAN_JITTER_SEC: float = 15.0" in events
    sec = _runbook_section("## 9. ", "## 10. ")
    assert "cuts its upstream at 55 s" in sec and "90 s plus up to 15 s jitter" in sec and "the agent stream" in sec
    assert "the server closes a stream after 120 s by design" not in sec
    agent = (_ROOT / "backend/app/routers/agent_gateway.py").read_text()
    assert "_AGENT_SSE_LIFESPAN_SEC: float = 300.0" in agent and "_AGENT_SSE_LIFESPAN_JITTER_SEC: float = 30.0" in agent
    assert "the 120 s is the length of the observation" in sec and "300 s plus up to 30 s jitter" in sec, "120 s is what the PO observed, not a server design limit"
    assert "closed by the server at 120 s" not in sec


def test_the_runbook_does_not_call_the_switch_the_only_backend_address_line() -> None:
    """codex (pipeline PR, round 4): `backend_url=` is a second, separate dev line (`_BACKEND_URL`, the GA4 redirect); the switch is the one line for `_FASTAPI_URL`"""
    assert re.findall(r'(?m)^\s*echo "backend_url=(https://sprintable-backend-dev-[^"]+)"', _WF_TEXT) == [NEW_FORM], "the separate dev line the runbook points at"
    sec = _runbook_section("## 9. ", "## 10. ")
    assert "exactly one line for `_FASTAPI_URL`" in sec and "exactly one line for the backend's address" not in sec
    assert "`backend_url=…` just below it is a different value, `_BACKEND_URL`" in sec and "moves with the GA4 registration in Phase 2" in sec


def test_the_documented_measurement_command_really_sends_what_the_exchange_route_reads(tmp_path: Path) -> None:
    """codex (pipeline PR, round 7): without the JSON content type the body is not read and the route answers 422 before the limiter counts; run the documented command for real against a fake curl"""
    import json

    sec = _runbook_section("**First-VM measurement", "Caddy needs the real hostnames")
    commands = [c for c in re.findall(r"`([^`]+)`", sec) if c.startswith("V=$(printf")]
    assert len(commands) == 1, commands
    cmd = commands[0].replace("xargs -P 16", "xargs -P 1")
    fake = tmp_path / "bin"
    fake.mkdir()
    log = tmp_path / "curl.log"
    (fake / "curl").write_text('#!/bin/sh\nprintf "%s\\0" "$@" >> "$FAKE_LOG"; printf "\\n--END--\\0" >> "$FAKE_LOG"\necho 404\n')
    (fake / "curl").chmod(0o755)
    p = subprocess.run(["bash", "-c", cmd], env={"PATH": f"{fake}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp_path)}, capture_output=True, text=True, timeout=30)
    assert p.returncode == 0 and p.stdout.split() == ["2400", "404"], (p.stdout, p.stderr)
    calls = [c for c in log.read_bytes().decode().split("\n--END--\0") if c]
    assert len(calls) == 2400
    forged = set()
    for call in calls:
        args = call.split("\0")
        assert args[args.index("-X") + 1] == "POST"
        assert "https://dev-api.sprintable.ai/api/v2/desktop/setup-codes/exchange" in args
        headers = [args[i + 1] for i, a in enumerate(args) if a == "-H"]
        assert "content-type: application/json" in headers
        forged.add(next(h for h in headers if h.startswith("X-Forwarded-For: ")))
        body = json.loads(args[args.index("-d") + 1])
        assert set(body) == {"code", "verifier"} and len(body["code"]) >= 20 and re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", body["verifier"])
    import ipaddress

    assert len(forged) == 2400, "a different forged address in every request"
    for h in forged:
        ipaddress.IPv4Address(h.removeprefix("X-Forwarded-For: "))  # a malformed address would be thrown away by client_ip() and the socket address counted
    addresses = sorted(ipaddress.IPv4Address(h.removeprefix("X-Forwarded-For: ")) for h in forged)
    assert (str(addresses[0]), str(addresses[-1])) == ("9.9.0.1", "9.9.9.150") and "(`9.9.0.1` … `9.9.9.150`;" in sec, "the range the runbook states is the range the command produces"


def test_the_runbook_does_not_ask_for_a_stream_that_cannot_stay_open_and_names_the_admin_audience_as_not_moved() -> None:
    """codex (pipeline PR, round 9): a browser event stream is closed by the server after 90 s + 15 s; `_ADMIN_OPERATOR_AUDIENCE` is its own value, not a consumer of the switch"""
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    p1 = text[text.index("**Phase 1"):text.index("**Phase 2")]
    assert "an event stream held open for 10 minutes" not in p1 and "in a loop and record each stream's lifetime" in p1
    sec = _runbook_section("## 9. ", "## 10. ")
    assert "ten-minute continuous stream" not in sec and "ten minutes of reconnect cycles through the front door are **not measured**" in sec
    assert re.search(r"(?m)^  _ADMIN_OPERATOR_AUDIENCE: https://sprintable-backend-dev-57iommnikq-du\.a\.run\.app$", _MAIN_TEXT), "its own value, in the old describe form"
    assert "ADMIN_OPERATOR_AUDIENCE=${_ADMIN_OPERATOR_AUDIENCE}" in _MAIN_TEXT and "ADMIN_OPERATOR_AUDIENCE=${_FASTAPI_URL}" not in _MAIN_TEXT
    assert "`_ADMIN_OPERATOR_AUDIENCE` (the audience the admin tool's ID token is checked against" in sec and "never `_FASTAPI_URL`" in sec


def test_the_runbook_says_the_switch_is_flipped_and_where_the_undo_is() -> None:
    sec = _runbook_section("## 9. ", "## 10. ")
    assert "**State: flipped** (story 4796, PO signal 2026-10-27)" in sec and "the previous value, kept in the comment above the line" in sec


def test_the_three_defaults_that_carry_the_switch_value_are_named_in_the_runbook() -> None:
    sec = _runbook_section("## 9. ", "## 10. ")
    assert "Three places that are **not** the pipeline's `fastapi_url` line carry the same value" in sec
    for needle in ("the `_FASTAPI_URL` default in `cloudbuild.yaml`", "`backend/scripts/deploy_backend.sh` (`FASTAPI_URL` default)", "`backend/scripts/deploy_mcp_dev.sh` (`DEV_BACKEND_URL`)", "must be put back with it"):
        assert needle in sec, needle
    assert "still hold the Cloud Run address" not in sec
