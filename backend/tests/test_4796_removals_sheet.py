"""story 4796 (AC3) — the dev removals sheet (deploy/vm/REMOVALS-dev.md) cannot go stale or unsafe.

Pinned: the names the sheet deletes are the names the pipeline creates; the resources that must stay are never in a delete line; every delete line in a code block is guarded against an empty variable; every row
that deletes carries an undo; the two dependency facts that decide the order are still true in the repo (the dev pipeline still deploys the Cloud Run services and runs the Cloud SQL migrate job → gate B;
the support gateway's database lives inside the Cloud SQL instance → gate 0) — and the dependents loops printed in the sheet are run for real against a fake gcloud.
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
SHEET = (_ROOT / "deploy/vm/REMOVALS-dev.md").read_text()
RUNBOOK = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()


def _rows() -> dict[str, str]:
    parts = re.split(r"^## (R\d)\. ", SHEET, flags=re.M)
    return {parts[i]: parts[i + 1] for i in range(1, len(parts), 2)}


def _fenced(text: str) -> list[str]:
    return re.findall(r"```\n(.*?)```", text, flags=re.S)


def _step(step_id: str) -> str:
    m = re.search(rf"^  - id: {re.escape(step_id)}\n(.*?)(?=^  - id: |\Z)", CLOUDBUILD, flags=re.S | re.M)
    assert m, step_id
    return m.group(1)


def test_the_runbook_points_at_the_sheet_and_no_longer_carries_the_old_table() -> None:
    sec = RUNBOOK.split("## 10. After the soak")[1].split("## 11.")[0]
    assert "[`REMOVALS-dev.md`](REMOVALS-dev.md)" in sec
    assert "| Remove | Command | Undo |" not in sec, "one list of removals, not two that drift apart"
    assert "re-creates them" in sec and "support gateway living on the VM" in sec


def test_the_rows_are_the_five_the_story_names_in_the_run_order() -> None:
    assert list(_rows()) == ["R1", "R2", "R3", "R4", "R5"]
    heads = re.findall(r"^## (R\d\. .*)$", SHEET, flags=re.M)
    assert [h.split(".")[1].strip().split(" —")[0] for h in heads] == [
        "Cloud Run dev backend and frontend", "Redis dev", "pgbouncer dev VM", "realtime-gateway dev", "Cloud SQL `sprintable-dev`"]


@pytest.mark.parametrize("service,step", [("sprintable-backend-dev", "deploy-backend"), ("sprintable-frontend-dev", "deploy-frontend"),
                                           ("sprintable-migrate-dev", "update-migrate-job"), ("support-gateway-dev", "deploy-support-gateway")])
def test_every_name_the_sheet_uses_is_what_the_pipeline_creates(service: str, step: str) -> None:
    assert service in SHEET
    stem = service.replace("-dev", "-${_DEPLOY_ENV}")
    body = _step(step)
    assert stem in body or service.replace("-dev", "") in body or "provision_migrate_job.sh ${_DEPLOY_ENV}" in body, (service, step)


def test_the_migrate_job_name_comes_from_the_provision_script() -> None:
    assert 'sprintable-migrate-${_DEPLOY_ENV}' in _step("run-migrate-job")
    assert "sprintable-verify-oneoff" in RUNBOOK and "sprintable-verify-oneoff" in SHEET


def test_the_dev_pipeline_still_deploys_what_gate_b_says_it_does_so_the_gate_is_still_needed() -> None:
    """If this fails the pipeline PR landed: drop gate B and its mentions from the sheet and this test together (a gate nobody can read off the repo is a story, not a gate)."""
    for step, needle in (("deploy-backend", "gcloud run deploy sprintable-backend-${_DEPLOY_ENV}"), ("deploy-frontend", "gcloud run deploy sprintable-frontend-${_DEPLOY_ENV}"),
                         ("run-migrate-job", "sprintable-migrate-${_DEPLOY_ENV}")):
        body = _step(step)
        assert needle in body
        assert 'skip' not in body.split(needle)[0].split("args:")[-1], f"{step} already has a skip before it deploys"
    gate_b = SHEET.split("| **B. Pipeline**")[1].split("\n")[0]
    for token in ("deploy-backend", "deploy-frontend", "run-migrate-job", "re-creates"):
        assert token in gate_b


def test_the_support_gateway_database_is_inside_the_cloud_sql_instance_so_gate_zero_guards_row_five() -> None:
    assert "--add-cloudsql-instances=${PROJECT_ID}:${_AR_REGION}:sprintable-${_DEPLOY_ENV}" in _step("deploy-support-gateway")
    gate0 = SHEET.split("| **0. support-gateway on the VM**")[1].split("\n")[0]
    assert "deleting the instance deletes the `support_gateway` database" in gate0
    r5 = _rows()["R5"]
    assert r5.index("support_gateway") < r5.index("gcloud sql instances delete")
    assert "only after gate 0" in SHEET.split("## R5.")[1].split("\n")[0]


def test_realtime_is_only_checked_because_the_pipeline_says_it_was_retired_by_hand_first() -> None:
    assert "retired (story 4786)" in _step("deploy-realtime") and "retired (story 4786)" in _step("deploy-realtime-gce")
    r4 = _rows()["R4"]
    assert "read only" in SHEET.split("## R4.")[1].split("\n")[0]
    assert not [b for b in _fenced(r4) if re.search(r"\bdelete\b", b)], "R4 deletes nothing"
    assert "Never delete `sprintable-vm-dev-ip`" in r4 and "`dev-realtime`" in r4


def test_redis_is_unused_on_the_dev_side_as_the_row_says() -> None:
    assert "_REDIS_URL: ''" in CLOUDBUILD
    env = (_ROOT / "deploy/vm/env/dev.yaml").read_text()
    assert "REDIS_URL: \"no Redis on the VM" in env
    assert len(re.findall(r'_REDIS_\w*ENABLED: "false"|REDIS_ENABLED: "false"|REDIS_CONSUME_ENABLED: "false"', env)) >= 3


def test_every_delete_line_in_a_code_block_is_guarded_and_never_names_what_must_stay() -> None:
    fenced = [ln.strip() for b in _fenced(SHEET) for ln in b.splitlines() if re.search(r"gcloud .* delete\b", ln)]
    inline = re.findall(r"`(gcloud [^`]*\bdelete\b[^`]*)`", SHEET)
    deletes = fenced + [c for c in inline if "snapshots delete" not in c and c not in fenced]
    assert len(deletes) == 4, deletes  # R1 (a loop: the command takes one service), R2, R3, and R5's one chained line (jobs, then the instance); the snapshot's delete is part of an undo note
    for ln in deletes:
        assert ln.count('"${PROJECT:?}"') == ln.count("gcloud "), f"every gcloud call in the line is guarded: {ln}"
        assert ("${REGION:?}" in ln or "${PGB_ZONE:?}" in ln or "gcloud sql instances delete" in ln), ln
        assert not re.search(r"delete (\S+) (?!--)\S+", re.sub(r'"[^"]*"', '"x"', ln)) or "for s in" in ln, f"one resource per delete command: {ln}"
        for stays in ("sprintable-mcp-dev", "office-converter", "support-gateway", "sprintable-vm-dev", "pgbouncer-nat", "sprintable-vm-dev-ip"):
            assert stays not in ln, (stays, ln)
    named = {"gcloud redis instances delete": '"${REDIS:?}"', "gcloud compute instances delete": '"${PGB:?}"', "gcloud sql instances delete": '"${INSTANCE:?}"'}
    for ln in deletes:
        for cmd, guard in named.items():
            if cmd in ln:
                assert guard in ln.split(cmd)[1].split("--")[0], f"the resource name itself must be guarded: {ln}"
    assert sum(any(c in ln for c in named) for ln in deletes) == 3, "Redis, pgbouncer and Cloud SQL deletes are each checked for a guarded name"


def test_every_row_that_deletes_has_a_capture_before_the_delete_and_an_undo_after_it() -> None:
    rows = _rows()
    for key in ("R1", "R2", "R3", "R5"):
        body = rows[key]
        d = max(body.find("gcloud run services delete"), body.find("gcloud redis instances delete"), body.find("gcloud compute instances delete"), body.find("gcloud sql instances delete"))
        assert d > 0, key
        assert body.find("Capture") != -1 and body.find("Capture") < d, key
        assert "**Undo" in body and body.index("**Undo") > d, key


def test_the_sheet_reads_no_secret_value_and_invents_no_resource_name() -> None:
    assert "secrets versions access" not in SHEET
    assert re.search(r"<dev-instance>|<dev-redis>|<pgbouncer-dev>", SHEET) is None, "names are discovered by the list commands, not left as the old placeholders"
    for r in ("R2", "R3"):
        assert "Find it (read only)" in _rows()[r]


def test_the_cloud_sql_exports_are_kept_beyond_the_backup_lifecycle() -> None:
    lifecycle = RUNBOOK.split("lifecycle.json <<'EOF'")[1].split("EOF")[0]
    assert '"matchesPrefix":["db/"]' in lifecycle and '"matchesPrefix":["status/"]' in lifecycle and "cloudsql-final" not in lifecycle
    assert "gs://${BACKUPS_BUCKET:?}/cloudsql-final/$db.sql.gz" in SHEET


# ── the dependents loops of the sheet, run for real against a fake gcloud ───────────────────────────────────────────────────────────────────────

_FAKE_GCLOUD = r"""#!/bin/sh
# usage seen by the sheet: gcloud run (services|jobs) (list|describe) [NAME] ... ; gcloud redis instances describe NAME ...
case "$1 $2 $3" in
  "run services list") printf 'sprintable-mcp-dev\nsupport-gateway-dev\n' ;;
  "run jobs list") printf 'sprintable-migrate-dev\nsprintable-verify-oneoff\nother-job\n' ;;
  "run services describe") echo "{\"name\":\"$4\"}"; case "$4" in support-gateway-dev) echo "proj:asia-northeast3:sprintable-dev 10.0.0.9" ;; sprintable-mcp-dev) echo "$FAKE_MCP_EXTRA" ;; esac ;;
  "run jobs describe") echo "{\"name\":\"$4\"}"; case "$4" in sprintable-migrate-dev|sprintable-verify-oneoff) echo "proj:asia-northeast3:sprintable-dev" ;; esac ;;
  "redis instances describe") echo "10.0.0.9" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
"""


@pytest.fixture
def fakebin(tmp_path: Path) -> Path:
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text(_FAKE_GCLOUD)
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    return b


def _run(script: str, fakebin: Path, **env: str) -> subprocess.CompletedProcess:
    e = {**os.environ, "PATH": f"{fakebin}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "FAKE_MCP_EXTRA": "", **env}
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=e, timeout=30)


def _loop(marker: str) -> str:
    blocks = [b for b in _fenced(SHEET) if marker in b]
    assert len(blocks) == 1, marker
    return blocks[0]


def test_the_cloud_sql_dependents_loop_lists_exactly_the_things_that_hold_the_instance(fakebin: Path) -> None:
    r = _run(_loop("USES CLOUD SQL"), fakebin)
    assert r.returncode == 0, r.stderr
    lines = sorted(r.stdout.strip().splitlines())
    assert lines == ["USES CLOUD SQL: jobs sprintable-migrate-dev", "USES CLOUD SQL: jobs sprintable-verify-oneoff", "USES CLOUD SQL: services support-gateway-dev"]


def test_the_redis_still_used_loop_prints_the_user_and_nothing_else(fakebin: Path) -> None:
    line = re.search(r"`(H=\$\(gcloud redis instances describe .*?done; done)`", SHEET)
    assert line, "the loop of R2 step 2"
    quiet = _run('REDIS=cache-dev; ' + line.group(1), fakebin, FAKE_MCP_EXTRA="")
    assert quiet.returncode == 0, quiet.stderr
    assert quiet.stdout.strip() == "STILL USED: services support-gateway-dev", "the fake gives the gateway the host; the mcp service does not have it"
    holder = _run('REDIS=cache-dev; ' + line.group(1), fakebin, FAKE_MCP_EXTRA="connects to 10.0.0.9")
    assert "STILL USED: services sprintable-mcp-dev" in holder.stdout
    assert "${REDIS:?}" in line.group(1), "an empty name aborts before anything is asked"
    empty = _run(line.group(1), fakebin)
    assert "STILL USED" not in empty.stdout, "an empty name must not turn into «everything uses it»"


def test_the_cloud_sql_line_is_one_chain_jobs_first_so_a_failed_job_delete_never_reaches_the_instance() -> None:
    chain = [ln for b in _fenced(_rows()["R5"]) for ln in b.splitlines() if "gcloud sql instances delete" in ln]
    assert len(chain) == 1
    parts = [p.strip() for p in chain[0].split(" && ")]
    assert len(parts) == 3 and parts[0].startswith("gcloud run jobs delete sprintable-migrate-dev") and parts[1].startswith("gcloud run jobs delete sprintable-verify-oneoff") and parts[2].startswith("gcloud sql instances delete")
    r5 = _rows()["R5"]
    assert "gcloud sql instances create" in r5 and r5.index("gcloud sql instances create") < r5.index("gcloud sql import sql") and 'jq -r .settings.tier sql-dev.json' in r5


def test_gate_b_names_the_support_gateway_steps_that_still_reach_cloud_sql() -> None:
    gate_b = SHEET.split("| **B. Pipeline**")[1].split("\n")[0]
    for step in ("update-support-gateway-migrate-job", "run-support-gateway-migrate-job", "deploy-support-gateway"):
        assert step in gate_b
        assert f"- id: {step}\n" in CLOUDBUILD
    assert "_SUPPORT_GATEWAY_DEPLOY_ENABLED" in gate_b


def test_realtime_check_lists_the_load_balancer_front_not_only_the_back() -> None:
    r4 = _rows()["R4"]
    for kind in ("forwarding-rules", "target-https-proxies", "target-http-proxies", "url-maps", "backend-services", "instance-groups managed", "instance-templates", "health-checks", "addresses"):
        assert f"gcloud compute {kind} list" in r4, kind


# ── the pgbouncer capture and undo, run for real against a fake gcloud and a captured definition ───────────────────────────────────────────────

_PGB_DEFINITION = r"""{"name":"pgb-dev","machineType":"https://www.googleapis.com/compute/v1/projects/p/zones/z/machineTypes/e2-small",
 "disks":[{"boot":false,"source":"https://x/disks/other"},{"boot":true,"source":"https://www.googleapis.com/compute/v1/projects/p/zones/z/disks/pgb-boot-disk"}],
 "networkInterfaces":[{"subnetwork":"https://x/regions/r/subnetworks/default","networkIP":"10.178.0.63"}],
 "serviceAccounts":[{"email":"pgb-sa@p.iam.gserviceaccount.com"}],"tags":{"items":["pgbouncer-dev","ssh"]},
 "metadata":{"items":[{"key":"startup-script","value":"#!/bin/bash\necho boot, with, commas"},{"key":"enable-oslogin","value":"TRUE"}]}}"""

_FAKE_GCLOUD_PGB = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "compute instances describe") cat "$FAKE_DEFINITION" ;;
esac
"""


def _fence_with(row: str, marker: str) -> str:
    blocks = [b for b in _fenced(_rows()[row]) if marker in b]
    assert len(blocks) == 1, marker
    return blocks[0]


def test_the_pgbouncer_capture_snapshots_the_boot_disk_of_the_definition_and_the_undo_is_built_from_the_captured_values(tmp_path: Path) -> None:
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text(_FAKE_GCLOUD_PGB)
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    (tmp_path / "def.json").write_text(_PGB_DEFINITION)
    env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "PGB": "pgb-dev", "PGB_ZONE": "z", "FAKE_LOG": str(tmp_path / "log"), "FAKE_DEFINITION": str(tmp_path / "def.json")}
    cap = subprocess.run(["bash", "-c", _fence_with("R3", "disks snapshot")], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)
    assert cap.returncode == 0, cap.stderr
    log = (tmp_path / "log").read_text()
    assert "gcloud compute disks snapshot pgb-boot-disk --zone z" in log and "--snapshot-names pgb-dev-removal" in log, "the boot disk of the definition, not the instance name"
    assert (tmp_path / "md-startup-script").read_text() == "#!/bin/bash\necho boot, with, commas\n" and (tmp_path / "md-enable-oslogin").exists()
    (tmp_path / "log").write_text("")
    undo = subprocess.run(["bash", "-c", _fence_with("R3", "disks create")], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)
    assert undo.returncode == 0, undo.stderr
    calls = (tmp_path / "log").read_text().splitlines()
    assert calls[0].startswith("gcloud compute disks create pgb-dev --source-snapshot pgb-dev-removal")
    create = calls[1]
    for want in ("--machine-type e2-small", "--subnet https://x/regions/r/subnetworks/default", "--private-network-ip 10.178.0.63", "--service-account pgb-sa@p.iam.gserviceaccount.com",
                 "--tags pgbouncer-dev,ssh", "--metadata-from-file ", "startup-script=md-startup-script", "enable-oslogin=md-enable-oslogin", "--no-address"):
        assert want in create, (want, create)
    assert "<" not in _fence_with("R3", "disks create"), "no placeholder is left in the undo"
