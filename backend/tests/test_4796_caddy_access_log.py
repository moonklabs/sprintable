"""story 4796 (P5 of the prod cutover) - the VM's front writes an access log, so that the request rate can be measured on the VM.

Why: the prod move's one lap asks whether the machine traffic (agent streams and polling, about 3,000-3,300 requests an hour in every Korean hour on Cloud Run) comes back by itself. That figure came from Cloud Run's Monitoring, which stops with the move,
and the Caddyfile wrote no log. Now it does, to standard output (docker logs, under the compose logging limit), JSON, **without** the request or response headers and **without** the URI at all (path and query string: one-time codes of OAuth callbacks travel there).
The Caddyfile has no local validator here (no caddy binary, no Docker daemon): the pins below are of its text; Caddy verifies the file when it loads it, a bad one makes `caddy reload` fail and the deploy rolls back.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
CADDY = (_ROOT / "deploy/vm/Caddyfile").read_text()
COMPOSE = yaml.safe_load((_ROOT / "deploy/vm/compose.yml").read_text())
RUNBOOK = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()


def _sites() -> dict[str, str]:
    """the body of each site block of the Caddyfile (top-level `{...}` blocks that have an address)"""
    out, depth, head, body = {}, 0, "", []
    for line in CADDY.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if depth == 0 and stripped.endswith("{") and stripped != "{":
            head, body = stripped[:-1].strip(), []
            depth = 1
            continue
        if depth == 0 and stripped == "{":
            depth = 1
            head, body = "<global>", []
            continue
        if depth >= 1:
            depth += stripped.count("{") - stripped.count("}")
            if depth == 0:
                out[head] = "\n".join(body)
                continue
            body.append(line)
    return out


def test_the_braces_of_the_caddyfile_balance_and_the_three_blocks_are_still_there() -> None:
    code = "\n".join(line for line in CADDY.splitlines() if not line.strip().startswith("#"))
    assert code.count("{") - code.count("{$") * 0 >= 0
    opens = len(re.findall(r"\{(?!\$)", code))
    closes = code.count("}") - len(re.findall(r"\{\$\w+\}", code))
    assert opens == closes, (opens, closes)
    assert set(_sites()) == {"<global>", "{$API_HOST}, {$REALTIME_HOST}", "{$APP_HOST}"}


def test_both_sites_log_to_stdout_as_json_without_headers_without_the_query_and_without_credentials_switched_on() -> None:
    sites = _sites()
    for host in ("{$API_HOST}, {$REALTIME_HOST}", "{$APP_HOST}"):
        body = sites[host]
        assert re.search(r"^\s*log \{$", body, flags=re.M), host
        log = body.split("log {", 1)[1].split("\n\t}\n", 1)[0]
        assert "output stdout" in log and "format filter {" in log and "wrap json" in log, host
        for removed in ("request>headers delete", "request>tls delete", "resp_headers delete"):
            assert removed in log, (host, removed)
        assert re.search(r"^\s*request>uri delete$", log, flags=re.M), (host, "the whole URI is removed: credentials travel in the path as well as in the query")
        assert "regexp" not in log, host
        assert "log_credentials" not in log and "include " not in log and "output file" not in log and "output stderr" not in log, host


def test_the_uri_is_removed_whole_because_credentials_travel_in_the_path_too() -> None:
    """codex (P5): cutting only the query string left `/api/v2/invites/{token}` and `/api/v2/public/docs/{token}` in the log. Those routes really exist, so removing the path is not a precaution against nothing"""
    invites = (_ROOT / "backend/app/routers/invite_accept.py").read_text()
    docs = (_ROOT / "backend/app/routers/public_docs.py").read_text()
    assert '@router.get("/{token}"' in invites and '@router.get("/{token}"' in docs
    assert 'prefix="/invites"' in invites.replace("'", '"') or "/invites" in invites
    assert "public" in docs and "docs" in docs
    for host in ("{$API_HOST}, {$REALTIME_HOST}", "{$APP_HOST}"):
        log = _sites()[host].split("log {", 1)[1].split("\n\t}\n", 1)[0]
        kept = [line.strip() for line in log.splitlines() if "delete" in line]
        assert "request>uri delete" in kept, host


def test_the_global_options_and_the_proxy_settings_were_not_touched() -> None:
    sites = _sites()
    assert "protocols h1 h2" in sites["<global>"] and "email {$ACME_EMAIL}" in sites["<global>"] and "log" not in sites["<global>"]
    assert "reverse_proxy backend:8000 {" in sites["{$API_HOST}, {$REALTIME_HOST}"] and "flush_interval -1" in sites["{$API_HOST}, {$REALTIME_HOST}"]
    assert "encode" not in sites["{$API_HOST}, {$REALTIME_HOST}"].replace("# no `encode`", ""), "still no compression on the stream hosts"
    assert "encode zstd gzip" in sites["{$APP_HOST}"] and "reverse_proxy frontend:3000 {" in sites["{$APP_HOST}"]


def test_the_container_keeps_the_logs_under_the_limit_of_every_other_container() -> None:
    caddy = COMPOSE["services"]["caddy"]
    assert caddy["logging"] == COMPOSE["x-logging"] == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "5"}}


def test_the_runbook_says_how_to_count_the_requests_and_what_the_log_keeps() -> None:
    day = RUNBOOK.split("## 11. Day-to-day on the VM")[1]
    line = next(item for item in day.split("\n- ") if item.startswith("**Requests per minute on the VM"))
    for token in ("sudo docker logs --since 5m sprintable-caddy-1", '"msg":"handled request"', '"host":"api.sprintable.ai"', "times 12", "**the whole URI (path and query string)**", "the request headers, the response headers and **the whole URI (path and query string)** are removed", "it does not say which route",
                  "`remote_ip` and `client_ip`", "a bad one makes `caddy reload` fail and the deploy rolls back"):
        assert token in line, token
    # the two greps count what the log really says: a sample line in Caddy's JSON shape
    sample = '{"level":"info","ts":1.0,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","host":"api.sprintable.ai","uri":"/api/v2/health"},"status":200}\n' * 3 + \
             '{"level":"info","msg":"handled request","request":{"host":"app.sprintable.ai","uri":"/"},"status":200}\n{"level":"info","msg":"other"}\n'
    counted = [row for row in sample.splitlines() if '"msg":"handled request"' in row and '"host":"api.sprintable.ai"' in row]
    assert len(counted) == 3


def test_the_caddyfile_comment_does_not_claim_more_than_the_log_does() -> None:
    """codex (P5, round 2): the comment said nothing personal is kept, but the client address is. The comment and the runbook say the same: no credential, and the address stays"""
    comment = "\n".join(line for line in CADDY.splitlines() if line.strip().startswith("#"))
    assert "Nothing that identifies a person" not in comment
    assert comment.count("No credential is kept") == 2 and comment.count("remote_ip / client_ip") == 2 and comment.count("an address is personal data") == 2
