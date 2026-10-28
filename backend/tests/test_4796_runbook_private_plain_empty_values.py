"""story 4796 - the private plain file keeps the names whose live value is EMPTY.

The rehearsal of the prod move (2026-10-28) stopped at `deployer --db-only`: «the private plain file lacks 3 variables». The RUNBOOK §6 line that makes the file filtered on `.value != null`, but Cloud Run's JSON
leaves out the `value` key of a variable whose value is empty (`{"name": "X"}`), so five names that the live prod services really hold (empty) were dropped, and the deployer - rightly - refused to start without them.
The line now keeps every entry that is not a secret reference and gives it "" when it has no value. This runs the line as the RUNBOOK writes it.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
RUNBOOK = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
needs_jq = pytest.mark.skipif(shutil.which("jq") is None, reason="no jq on this machine")

# the shape gcloud prints for a service: an empty variable has no `value`, a secret reference has `valueFrom`
SERVICE = {"spec": {"template": {"spec": {"containers": [{"env": [
    {"name": "APP_URL", "value": "https://app.sprintable.ai"},
    {"name": "BACKEND_URL"},                                            # empty on the live service: no value key at all
    {"name": "OPS_ALERT_CONVERSATION_ID"},                              # the same
    {"name": "SPRINTABLE_FLAG", "value": ""},                           # an explicit empty string
    {"name": "JWT_SECRET", "valueFrom": {"secretKeyRef": {"name": "JWT_SECRET_PROD", "key": "latest"}}},
]}]}}}}


def _jq_expression() -> str:
    block = RUNBOOK.split("**Private plain file**")[1].split("```")[1]
    m = re.search(r"\| jq --arg s \$SVC '(.*)'\n", block)
    assert m, block
    return m.group(1)


def _run(expression: str) -> dict:
    p = subprocess.run(["jq", "--arg", "s", "backend", expression], input=json.dumps(SERVICE), capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


@needs_jq
def test_the_runbook_line_keeps_empty_names_and_leaves_secret_references_out() -> None:
    plain = _run(_jq_expression())["backend"]
    assert plain == {"APP_URL": "https://app.sprintable.ai", "BACKEND_URL": "", "OPS_ALERT_CONVERSATION_ID": "", "SPRINTABLE_FLAG": ""}, plain
    assert "JWT_SECRET" not in plain, "a secret reference is Secret Manager's, not the file's"


@needs_jq
def test_the_old_filter_dropped_the_empty_names_which_is_what_the_rehearsal_hit() -> None:
    old = '{($s): ([.spec.template.spec.containers[0].env[] | select(.value != null) | {(.name): .value}] | add)}'
    plain = _run(old)["backend"]
    assert "BACKEND_URL" not in plain and "OPS_ALERT_CONVERSATION_ID" not in plain, "the defect"
    assert "SPRINTABLE_FLAG" in plain, "only the entries without a value key were lost"


@needs_jq
def test_a_service_with_no_secret_reference_and_one_variable_still_makes_a_file() -> None:
    one = {"spec": {"template": {"spec": {"containers": [{"env": [{"name": "ONLY"}]}]}}}}
    p = subprocess.run(["jq", "--arg", "s", "frontend", _jq_expression()], input=json.dumps(one), capture_output=True, text=True, timeout=30)
    assert json.loads(p.stdout) == {"frontend": {"ONLY": ""}}


def test_the_runbook_says_why_an_empty_name_is_in_the_file() -> None:
    sec = RUNBOOK.split("**Private plain file**")[1].split("**Before any cutover")[0]
    for token in ("**A name whose live value is empty is in the file with an empty value:**", "leaves out the `value` key of an empty variable", "dropped them and the deployer stopped on «the private plain file lacks N variables»", "(`valueFrom`)"):
        assert token in sec, token
    assert "select(.value != null)" not in sec and 'select(has("valueFrom") | not)' in sec and '(.value // "")' in sec


def test_the_renderer_accepts_an_empty_string_for_a_name_of_the_file_and_still_refuses_a_missing_one(tmp_path: Path) -> None:
    """the other end: the empty value travels on (the rehearsal passed with the five empty names in the file), and a name that is really absent is still refused"""
    import sys
    sys.path.insert(0, str(_ROOT / "deploy/vm/bin"))
    import render_env as R

    decl = {"services": {"backend": {"live_plain": ["APP_URL", "BACKEND_URL"], "overrides": {}, "computed": {}, "secrets": {}, "added": {}, "dropped": {}}}, "database": {"user": "u", "name": "n", "password_secret": "P"}}
    env = R.build_service_env(decl, "backend", {"APP_URL": "https://a", "BACKEND_URL": ""}, "pw0123456789abcdef", lambda sid: "v")
    assert env["BACKEND_URL"] == "" and env["APP_URL"] == "https://a"
    with pytest.raises(R.EnvError, match="lacks 1 variable"):
        R.build_service_env(decl, "backend", {"APP_URL": "https://a"}, "pw0123456789abcdef", lambda sid: "v")
