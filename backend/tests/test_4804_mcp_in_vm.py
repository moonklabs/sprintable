"""story 4804 - deploy/vm/MCP-IN-VM.md: the measurements and the design for moving the hosted MCP server into the VM, pinned.

The file is AC1 and a design paragraph; it changes nothing. What can go wrong is (a) a premise about the repository that is no longer true when somebody reads it, (b) a measuring line that does not run (a gcloud
flag the real parser refuses, a jq filter that reads the wrong field), (c) a rule of decision that is not in the text. Each is pinned here, and the premises are read from the files themselves.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

from tests import _real_gcloud as _gcloud

_ROOT = Path(__file__).resolve().parents[2]
DOC = (_ROOT / "deploy/vm/MCP-IN-VM.md").read_text()
SAMPLE = {"PROJECT": "sprintable-494803", "REGION": "asia-northeast3", "SVC": "sprintable-mcp-prod", "TOKEN": "t", "START": "s", "END": "e"}


def _blocks() -> list[str]:
    return re.findall(r"```\n(.*?)```", DOC, flags=re.S)


def _block_with(marker: str) -> str:
    found = [b for b in _blocks() if marker in b]
    assert len(found) == 1, (marker, len(found))
    return found[0]


# ── the premises, read from the files ────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_file_records_what_the_long_requests_are_and_what_is_still_to_be_shown() -> None:
    five = DOC.split("## 5. What the long requests are")[1].split("## Questions")[0]
    for token in ("888 requests over 30 s add up to 267,288 s (0.442 concurrent)", "all of them `GET /mcp` of one client", "no byte for 6 seconds", "the transport handler still serves a client's GET", "no `send_*` of a notification", "answer the GET with **405**", "`MCP_HTTP_GET_STREAM=true`",
                  "**Still to be shown (dev round, the product owner's hands):**", "per client per hour"):
        assert token in five, token
    # and the change it describes is in the source
    auth = (_ROOT / "backend/sprintable_mcp/http_auth.py").read_text()
    assert "_send_405_no_stream" in auth and 'b"allow", b"POST"' in auth and (_ROOT / "backend/tests/test_4804_mcp_get_405.py").exists()


def test_the_file_states_the_premises_it_checks() -> None:
    table = DOC.split("## 1.")[1].split("## 2.")[0]
    for token in ("A fallback key can be configured (`AGENT_API_KEY`; the prod script of Cloud Run injects one from Secret Manager)", "**stateless Streamable HTTP** (`stateless_http=True`)", "**the event bridge is not started**", "**the backend's own image**", "`MCP_ALLOWED_HOSTS`", "**CPU throttling off**", "`mcp.sprintable.ai`", "16 MiB"):
        assert token in table, token


def test_the_premises_about_the_server_hold_in_the_source() -> None:
    main = (_ROOT / "backend/sprintable_mcp/__main__.py").read_text()
    http = main.split("def _run_http()")[1].split('if __name__ == "__main__"')[0]
    assert "stateless_http=True" in http and "bearer_auth_asgi" in http, "stateless, every request brings its own bearer key"
    assert "start_sse_bridge" not in http, "the event bridge is the stdio mode's; the HTTP server is tools only"
    assert 'os.environ.get("PORT") or settings.mcp_http_port' in http and "/mcp" in http
    cfg = (_ROOT / "backend/sprintable_mcp/config.py").read_text()
    assert "mcp_http_port: int = 8080" in cfg and "mcp_allowed_hosts" in cfg and "mcp_scope_cache_max_size: int = 1000" in cfg
    server = (_ROOT / "backend/sprintable_mcp/server.py").read_text()
    assert "MAX_MCP_REQUEST_BODY_SIZE = 16 * 1024 * 1024" in server and "enable_dns_rebinding_protection=bool(_allowed_hosts)" in server


def test_the_premises_about_the_deploy_and_the_stack_hold() -> None:
    prod = (_ROOT / "backend/scripts/deploy_mcp_prod.sh").read_text()
    assert '--command="python"' in prod and '--args="-m,sprintable_mcp"' in prod and "backend" in prod, "the backend's image with another command"
    assert "--min-instances=0" in prod and "--max-instances=2" in prod
    assert "mcp.sprintable.ai" in prod and "MCP_ALLOWED_HOSTS" in prod
    compose = yaml.safe_load((_ROOT / "deploy/vm/compose.yml").read_text())
    assert "mcp" not in compose["services"], "the story's premise: the VM's stack has no MCP in it (when this changes, this file and this test are the first to be rewritten)"
    assert sorted(compose["services"]) == ["backend", "caddy", "db", "frontend", "gateway-db", "migrate"]
    caddy = (_ROOT / "deploy/vm/Caddyfile").read_text()
    assert "{$API_HOST}" in caddy and "{$APP_HOST}" in caddy and "MCP_HOST" not in caddy
    for env in ("dev", "prod"):
        hosts = yaml.safe_load((_ROOT / f"deploy/vm/env/{env}.yaml").read_text())["hosts"]
        assert sorted(hosts) == ["api", "app", "realtime"], (env, "no MCP name yet")
    runbook = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    assert "--machine-type e2-medium" in runbook and "| `dev-mcp` |" in runbook
    assert "## 8. Lane wheel on the VM, then DNS" in runbook and "## 4. Address, firewall, disk, VM" in runbook, "the section numbers the file cites"


# ── the measuring lines run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _expand(token: str) -> str:
    def repl(m: re.Match) -> str:
        name = m.group(1) or m.group(2)
        assert name in SAMPLE, f"the file uses ${name} and nowhere defines it"
        return SAMPLE[name]
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", repl, token)


def _gcloud_commands() -> list[list[str]]:
    found = []
    inline = [m for m in re.findall(r"`([^`\n]*)`", DOC) if "gcloud" in m and re.search(r" -{1,2}\w", m)]
    for block in [*_blocks(), *inline]:
        for line in block.splitlines():
            if "gcloud" not in line:
                continue
            lex = shlex.shlex(line, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""
            toks = list(lex)
            toks = [t for k, t in enumerate(toks) if not (t.isdigit() and k + 1 < len(toks) and toks[k + 1].startswith(">"))]
            cur: list[str] = []
            for t in [*toks, "|"]:
                if t in {"|", ";", "&&", "||", "(", ")", "$"} or (t != "" and set(t) <= set("|;&()<>$")):
                    if "gcloud" in cur:
                        found.append(cur[cur.index("gcloud"):])
                    cur = []
                else:
                    cur.append(t)
    return found


def test_the_file_has_its_gcloud_commands() -> None:
    verbs = {" ".join(c[1:3]) for c in _gcloud_commands()}
    for must in ("logging read", "run services", "compute ssh", "auth print-access-token"):
        assert must in verbs, (must, sorted(verbs))


@pytest.mark.skipif(shutil.which("gcloud") is None, reason="no gcloud on this machine")
@pytest.mark.timeout(120)
def test_every_gcloud_command_of_the_file_parses_in_the_real_gcloud(tmp_path: Path) -> None:
    unique: dict[tuple, int] = {}
    for cmd in _gcloud_commands():
        argv = tuple(_expand(t) for t in cmd[1:])
        unique.setdefault(argv, len(unique))
    bad = []
    for argv, n in unique.items():
        home = tmp_path / f"home-{n}"
        home.mkdir()
        out = _gcloud.text(_gcloud.run(list(argv), home))
        if "(unset)" in out and argv[0:2] == ("config", "get-value"):
            continue
        if "do not currently have an active account" in out:
            continue
        bad.append((" ".join(argv)[:140], out[:200]))
    assert len(unique) >= 6 and not bad, bad


@pytest.mark.parametrize("shell", ["bash", pytest.param("zsh", marks=pytest.mark.skipif(shutil.which("zsh") is None, reason="no zsh"))])
def test_every_block_is_valid_shell(shell: str, tmp_path: Path) -> None:
    for i, block in enumerate(_blocks()):
        f = tmp_path / f"block-{i}.sh"   # as a file: nothing of it is run, and the guard of the tests sees no «gcloud» on a command line
        f.write_text(block)
        p = subprocess.run([shell, "-n", str(f)], capture_output=True, text=True, timeout=30)
        assert p.returncode == 0, (i, shell, p.stderr)


def _fake_world(tmp_path: Path, series: dict[str, list[float]]) -> dict[str, str]:
    b = tmp_path / "bin"
    b.mkdir()
    calls = tmp_path / "calls"
    calls.write_text("")
    (tmp_path / "series.json").write_text(json.dumps(series))
    for name, text in (
        ("gcloud", '#!/bin/sh\necho "gcloud $*" >> "$CALLS"\ncase "$*" in *print-access-token*) echo tok ;; esac\n'),
        ("curl", '#!/bin/sh\necho "curl $*" >> "$CALLS"\n# the list call of the Monitoring API needs a filter, an interval, an aggregation and view=FULL: without any of them it answers an error, as the real one does\n'
                 'for need in "filter=" "interval.startTime=" "interval.endTime=" "aggregation.alignmentPeriod=" "aggregation.perSeriesAligner=" "view=FULL"; do case "$*" in *"$need"*) ;; *) echo \'{"error":{"code":400,"message":"missing parameter"}}\'; exit 0 ;; esac; done\n'
                 'metric=$(printf "%s\\n" "$*" | sed -n \'s/.*metric.type="\\([^"]*\\)".*/\\1/p\')\n'
                 'python3 -c \'import json,sys; s=json.load(open(sys.argv[1])); v=s.get(sys.argv[2], []); print(json.dumps({"timeSeries":[{"points":[{"value":{"doubleValue":x}} for x in v]}]}))\' "$SERIES" "$metric"\n'),
    ):
        f = b / name
        f.write_text(text)
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return {"PATH": f"{b}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": str(tmp_path), "CALLS": str(calls), "SERIES": str(tmp_path / "series.json"), **{k: v for k, v in SAMPLE.items() if k not in ("TOKEN", "START", "END")}}


def test_the_monitoring_lines_read_the_fields_the_api_returns_and_summarise_them(tmp_path: Path) -> None:
    block = _block_with("TOKEN=$(gcloud auth print-access-token)")
    series = {"run.googleapis.com/container/billable_instance_time": [0.99, 1.0, 0.98], "run.googleapis.com/container/memory/utilizations": [0.31, 0.44],
              "run.googleapis.com/container/max_request_concurrencies": [2.0, 5.0], "run.googleapis.com/request_count": [1.5, 3.5]}
    env = _fake_world(tmp_path, series)
    p = subprocess.run(["bash", "-c", block], capture_output=True, text=True, timeout=60, env=env)
    assert p.returncode == 0, p.stderr
    docs = []
    buf = ""
    for line in p.stdout.splitlines():
        buf += line
        if line.strip() == "}":
            docs.append(json.loads(buf))
            buf = ""
    assert len(docs) == 4, p.stdout
    assert docs[0]["hours"] == 3 and abs(docs[0]["mean"] - 0.99) < 1e-9 and docs[0]["max"] == 1.0
    assert docs[1]["hourly_p99_max"] == 0.44 and docs[2]["hourly_p99_max_concurrent"] == 5.0 and docs[3]["max_per_s"] == 3.5
    calls = Path(env["CALLS"]).read_text().splitlines()
    metrics = [re.search(r'metric.type="([^"]+)"', c).group(1) for c in calls if c.startswith("curl")]
    assert metrics == list(series), "the four metrics, in this order, for this service"
    assert all("sprintable-mcp-prod" in c for c in calls if c.startswith("curl"))
    reducers = {re.search(r'metric.type="([^"]+)"', c).group(1): re.search(r"aggregation.crossSeriesReducer=(\w+)", c).group(1) for c in calls if c.startswith("curl")}
    assert reducers == {"run.googleapis.com/container/billable_instance_time": "REDUCE_SUM", "run.googleapis.com/container/memory/utilizations": "REDUCE_MAX",
                        "run.googleapis.com/container/max_request_concurrencies": "REDUCE_MAX", "run.googleapis.com/request_count": "REDUCE_SUM"}, "totals are summed over instances, the memory and the concurrency are the worst instance"
    assert not [c for c in calls if any(w in c.split() for w in ("update", "deploy", "delete", "create"))], "read-only"


def test_the_monitoring_filter_names_real_cloud_run_metrics() -> None:
    for metric in ("billable_instance_time", "container/memory/utilizations", "container/max_request_concurrencies", "request_count"):
        assert f"run.googleapis.com/{metric}" in DOC or metric in DOC, metric
    assert "-v-7d" in DOC and "ALIGN_RATE" in DOC
    assert "mon run.googleapis.com/container/memory/utilizations ALIGN_PERCENTILE_99 REDUCE_MAX" in DOC and "mon run.googleapis.com/container/max_request_concurrencies ALIGN_PERCENTILE_99 REDUCE_MAX" in DOC, "the 99th percentile, not the mean, is what the memory is judged by"


def test_the_held_time_line_adds_up_the_latencies_the_log_prints(tmp_path: Path) -> None:
    block = _block_with("SVC=sprintable-mcp-prod")
    b = tmp_path / "bin"
    b.mkdir()
    calls = tmp_path / "calls"
    calls.write_text("")
    f = b / "gcloud"
    f.write_text('#!/bin/sh\necho "gcloud $*" >> "$CALLS"\ncase "$*" in\n  *"value(httpRequest.latency)"*) printf "42s\\n100s\\n302400s\\n" ;;\n  *"value(timestamp)"*) printf "2026-10-28T01:00:00Z\\n2026-10-28T02:00:00Z\\n2026-10-29T01:00:00Z\\n" ;;\n  *"value(httpRequest.requestMethod"*) printf "POST 200\\nPOST 200\\nGET 405\\n" ;;\n  *"value(httpRequest.userAgent)"*) printf "ua-a\\nua-a\\nua-b\\n" ;;\nesac\n')
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{b}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": str(tmp_path), "CALLS": str(calls), "PROJECT": "p", "REGION": "r"}
    p = subprocess.run(["bash", "-c", block], capture_output=True, text=True, timeout=60, env=env)
    assert p.returncode == 0, p.stderr
    assert "3 requests over 30 s, 302542 s, 0.500 concurrent on average (7 days)" in p.stdout, p.stdout
    assert "3 requests, 302542 s, 3.502 concurrent on average (24 hours)" in p.stdout, "the same latencies over one day: the busiest figure, an upper bound"
    assert "2 2026-10-28" in p.stdout and "1 2026-10-29" in p.stdout, "requests per day"


def test_the_request_log_lines_only_read_and_never_print_a_key() -> None:
    block = _block_with('SVC=sprintable-mcp-prod')
    for line in block.splitlines():
        if "logging read" in line:
            assert "--format='value(" in line and "authorization" not in line.lower() and "requestUrl" not in line, line
    last = [l for l in block.splitlines() if "value(httpRequest.latency)" in l]
    assert "--freshness=1d --limit=1000000" in last[1] and "httpRequest.latency>" not in last[1], "the second line is ALL requests of the last day (up to a million), not the long ones"
    assert "--freshness=7d" in last[0] and 'httpRequest.latency>\\"30s\\"' in last[0]
    assert "604800" in block and "86400" in block and block.count("value(httpRequest.latency)") == 2, "the time is added up from the log's own latency, over 7 days for the long ones and over 24 hours for all"
    assert 'httpRequest.requestMethod=\\"GET\\" AND httpRequest.latency>\\"30s\\"' in block and 'httpRequest.requestMethod=\\"POST\\" AND httpRequest.latency>\\"30s\\"' in block, "a held connection is a GET that lasts; a slow POST is counted apart so that it is not taken for one"


# ── the decision ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_text_says_how_the_numbers_decide_and_what_the_design_is() -> None:
    for token in ("the average number of requests being served at the same moment", "an upper bound of the share of one instance that is busy", "**both count as held time**", "**A. Billing, not a connection**", "**A′. In between**", "the **request time alone** is at most a tenth of today's busy time", "**no bound on the bill is claimed**", "**read after a day**", "the cost is in the short requests themselves and not in a held connection", "In case A′ with the bill still above the target", "| **All** requests together keep less than 0.1 of an instance busy", "below 0.1 concurrent on average over 24 hours", "keep less than 0.1 of an instance busy", "keep 0.1 or more concurrent on average over 7 days", "1.5 × the measured `hourly_p99_max` + 256 MiB", "--cpu-throttling", "--no-cpu-throttling", "**B. A held connection**", "a forwarder that holds the same streams is active all day", "which are not lower per second than the instance-based ones", "**unmeasured**",
                  "**Fit**", "lowest** `available` memory", "1.5 × the server's `hourly_p99_max`", "not a maximum", "256 MiB of margin", "48 MiB", "idle percentage", "above 30", "Nothing goes to `main` until the prod move and one day after it are over"):
        assert token in DOC, token
    design = DOC.split("## 4. Design")[1].split("## Questions")[0]
    for token in ("`${BACKEND_IMAGE}`", "python -m sprintable_mcp", "http://backend:8000", "`MCP_ALLOWED_HOSTS`", "no secret (every request brings its own bearer key; the service sets **no** `AGENT_API_KEY`", "mem_limit", "`{$MCP_HOST}`", "flush_interval -1", "`hosts.mcp`", "DNS-only A record", "deploy/vm/forwarder/", "`FORWARD_TO`", "the security domain reads the key and path exposure"):
        assert token in design, token
    assert "58 USD" in DOC and "59 USD" in DOC, "the product owner's figure and the forwarder's"
