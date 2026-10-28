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
    assert "re-creates the services and the scheduler step fails on a deleted backend" in sec and "support gateway living on the VM" in sec and "the dev build without Cloud Run" in sec


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


def test_gate_b_is_the_switch_and_names_the_steps_it_covers_the_scheduler_source_and_the_steps_it_does_not() -> None:
    """Gate B is «the dev build without Cloud Run» (cloudbuild.yaml `_CLOUD_RUN_APP_SKIP`, cloud-build.yml dev `cloud_run_app_skip=true`): the sheet's words are read against the repo."""
    covered = ("build-frontend", "push-frontend", "update-migrate-job", "run-migrate-job", "deploy-frontend", "deploy-backend")
    gate_b = SHEET.split("| **B. Pipeline**")[1].split("\n")[0]
    workflow = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    assert 'echo "cloud_run_app_skip=true" >> "$GITHUB_OUTPUT"' in workflow
    for step in covered:
        assert "_CLOUD_RUN_APP_SKIP" in _step(step), step
        assert f"`{step}`" in gate_b, step
    for token in ("cloud_run_app_skip=true", "`apply-cloud-scheduler` takes its Authorization secret from the VM's declaration", "one dev build ran green", "answer 200 (not 401", "not covered by the switch", "re-creates the services"):
        assert token in gate_b, token
    for step in ("update-support-gateway-migrate-job", "run-support-gateway-migrate-job", "deploy-support-gateway"):
        assert "_CLOUD_RUN_APP_SKIP" not in _step(step), f"{step} is not covered by the switch, as the gate says"


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


def test_redis_has_a_user_the_sheet_names_the_cloud_run_backend_that_the_dev_pipeline_points_at_it() -> None:
    """The dev workflow hands the backend a Redis address and `deploy-backend` passes it on for every non-prod deploy: so R2 follows R1 and gate B, and the undo names that line."""
    workflow = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    m = re.search(r'echo "redis_url=(redis://[\d.]+:\d+)" >> "\$GITHUB_OUTPUT"', workflow)
    assert m, "the dev workflow no longer writes a Redis address: R2's text about it is stale"
    step2 = _rows()["R2"].split("3. Capture")[0]
    assert m.group(1) in step2 and "gate B" in step2 and m.group(1) in _rows()["R2"].split("5. **Undo")[1]
    deploy_backend = _step("deploy-backend")
    assert 'if [ "${_DEPLOY_ENV}" != "prod" ]' in deploy_backend and "REDIS_URL=${_REDIS_URL}" in deploy_backend
    env = (_ROOT / "deploy/vm/env/dev.yaml").read_text()
    assert "REDIS_URL: \"no Redis on the VM" in env
    assert len(re.findall(r'_REDIS_\w*ENABLED: "false"|REDIS_ENABLED: "false"|REDIS_CONSUME_ENABLED: "false"', env)) >= 3


def test_every_delete_line_in_a_code_block_is_guarded_and_never_names_what_must_stay() -> None:
    verb = r"gcloud (?:[a-z-]+ ){1,2}delete\b"  # the command's own verb: «auto-delete=yes» in a create line is not one
    fenced = [ln.strip() for b in _fenced(SHEET) for ln in b.splitlines() if re.search(verb, ln)]
    inline = [c for c in re.findall(r"`([^`\n]*" + verb + r"[^`\n]*)`", SHEET)]
    deletes = fenced + [c for c in inline if c not in fenced]
    assert len(deletes) == 5, deletes  # R1's chained line, R5's chained line, R2, R3 (gated by the snapshot) and the R3 undo note's snapshot delete
    for ln in deletes:
        assert ln.count('"${PROJECT:?}"') == ln.count("gcloud "), f"every gcloud call in the line is guarded: {ln}"
        assert ("${REGION:?}" in ln or "${PGB_ZONE:?}" in ln or "gcloud sql instances delete" in ln or "gcloud compute snapshots delete" in ln), ln
        assert not re.search(r"delete (\S+) (?!--)\S+", re.sub(r'"[^"]*"', '"x"', ln)), f"one resource per delete command: {ln}"
        for stays in ("sprintable-mcp-dev", "office-converter", "support-gateway", "sprintable-vm-dev", "pgbouncer-nat", "sprintable-vm-dev-ip"):
            assert stays not in ln, (stays, ln)
    named = {"gcloud redis instances delete": '"${REDIS:?}"', "gcloud compute instances delete": '"${PGB:?}"', "gcloud sql instances delete": '"${INSTANCE:?}"', "gcloud compute snapshots delete": '"${PGB:?}-removal"'}
    for ln in deletes:
        for cmd, guard in named.items():
            if cmd in ln:
                assert guard in ln.split(cmd)[1].split("--")[0], f"the resource name itself must be guarded: {ln}"
    assert sum(any(c in ln for c in named) for ln in deletes) == 4, "Redis, pgbouncer, snapshot and Cloud SQL deletes are each checked for a guarded name"


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
    assert "gs://${BACKUPS_BUCKET:?}/cloudsql-final/$STAMP/$db.sql.gz" in SHEET


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


def test_the_redis_undo_points_the_restored_service_at_the_new_host() -> None:
    undo = _rows()["R2"].split("5. **Undo")[1]
    cmd = re.search(r"`(gcloud run services update sprintable-backend-dev[^`]*)`", undo)
    assert cmd, "an executable update, not a remark"
    assert '--update-env-vars "REDIS_URL=redis://' in cmd.group(1) and "redis instances describe $REDIS" in cmd.group(1) and "value(host)" in cmd.group(1)


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
    assert len(parts) == 4 and parts[0] == '[ "${EXPORTS_OK:-0}" = 1 ]' and parts[1].startswith("gcloud run jobs delete sprintable-migrate-dev") and parts[2].startswith("gcloud run jobs delete sprintable-verify-oneoff") and parts[3].startswith("gcloud sql instances delete")
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
    for kind in ("firewall-rules", "forwarding-rules", "target-https-proxies", "target-http-proxies", "url-maps", "backend-services", "instance-groups managed", "instance-templates", "health-checks", "addresses"):
        assert f"gcloud compute {kind} list" in r4, kind


# ── the pgbouncer capture and undo, run for real against a fake gcloud and a captured definition ───────────────────────────────────────────────

_PGB_DEFINITION = r"""{"name":"pgb-dev","machineType":"https://www.googleapis.com/compute/v1/projects/p/zones/z/machineTypes/e2-small",
 "disks":[{"boot":true,"source":"https://www.googleapis.com/compute/v1/projects/p/zones/z/disks/pgb-boot-disk"}],
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
    cap = subprocess.run(["bash", "-c", _fence_with("R3", "disks snapshot") + '\necho "SO=${SNAP_OK:-0}"'], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)
    assert cap.returncode == 0 and "SNAPSHOT-OK" in cap.stdout and "SO=1" in cap.stdout, cap.stderr
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


def test_the_first_row_is_one_chain_too_so_the_frontend_is_not_deleted_after_a_failed_backend_delete() -> None:
    line = [ln for b in _fenced(_rows()["R1"]) for ln in b.splitlines() if "gcloud run services delete" in ln]
    assert len(line) == 1
    parts = [p.strip() for p in line[0].split(" && ")]
    assert parts[0] == '[ "${R1_OK:-0}" = 1 ]' and len(parts) == 3
    assert [p.split()[4] for p in parts[1:]] == ["sprintable-backend-dev", "sprintable-frontend-dev"]


def test_no_code_block_of_a_removal_row_is_left_with_an_angle_bracket_placeholder() -> None:
    for key, body in _rows().items():
        for block in _fenced(body):
            assert not re.search(r"<[A-Za-z][^>\n]*>", block), (key, block)
    for c in re.findall(r"`(gcloud [^`]*\bdelete\b[^`]*)`", SHEET):
        assert "<" not in c, c
    for key in ("R2", "R3"):
        assert '= 1 ] && ' in _rows()[key].split("Find it (read only)")[1].split("\n")[0], f"{key}: the name is taken only if exactly one resource matched"
    for key in ("R2", "R3"):
        assert "wc -l" not in _rows()[key], "wc -l pads its count on macOS (` 1`), where the PO runs these lines"
    assert 'INSTANCE=sprintable-dev' in _rows()["R5"] and 'grep -qx "${INSTANCE:?}"' in _rows()["R5"]
    assert '--password "${GW_PASSWORD:?' in _rows()["R5"], "the gateway role's password is a guarded variable the PO fills, never a literal"
    for secret in ("SUPPORT_GATEWAY_DATABASE_URL_dev", "DATABASE_URL_DIRECT_DEV_SPRINTABLE", "DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE"):
        assert secret in _rows()["R5"].split("The services that connected")[1]


_FAKE_GCLOUD_SQL = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "sql instances list") [ "$FAKE_NO_INSTANCE" = 1 ] || echo sprintable-dev ; echo other ;;
  "sql instances describe") if [ "$FAKE_NO_DESCRIBE" = 1 ]; then echo "no definition" >&2; exit 1; fi; echo '{"settings":{"tier":"db-g1-small"}}' ;;
  "run jobs describe") echo "kind: Job" ;;
  "sql backups create") if [ "$FAKE_BACKUP_FAILS" = 1 ]; then echo "backup failed" >&2; exit 1; fi ;;
  "sql export sql") case "$*" in *"--database $FAKE_FAIL_DB"*) echo "export failed" >&2; exit 1 ;; esac ;;
  "storage ls -l") case "$4" in *"$FAKE_EMPTY_DB.sql.gz") echo "     0  $4" ;; *) echo "  1234  $4" ;; esac ;;
  "run jobs delete"|"sql instances delete") : ;;
esac
"""


def _r5_export_block() -> str:
    return _fence_with("R5", "EXPORTS-OK")


def _fake_bin(tmp_path: Path, body: str) -> Path:
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    g = b / "gcloud"
    g.write_text(body)
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    return b


def test_the_cloud_sql_exports_print_their_all_clear_only_when_everything_it_stands_for_happened(tmp_path: Path) -> None:
    b = _fake_bin(tmp_path, _FAKE_GCLOUD_SQL)
    base = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "BACKUPS_BUCKET": "bk", "FAKE_LOG": str(tmp_path / "log"), "FAKE_FAIL_DB": "none", "FAKE_EMPTY_DB": "none",
            "FAKE_NO_INSTANCE": "0", "FAKE_NO_DESCRIBE": "0", "FAKE_BACKUP_FAILS": "0"}

    def run(**over: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "-c", _r5_export_block() + '\necho "EO=${EXPORTS_OK:-0}"'], capture_output=True, text=True, env={**base, **over}, cwd=tmp_path, timeout=30)

    ok = run()
    assert ok.returncode == 0 and "EXPORTS-OK" in ok.stdout and "EO=1" in ok.stdout, ok.stderr
    log = (tmp_path / "log").read_text()
    assert len(set(re.findall(r"cloudsql-final/(\d{8}T\d{6}Z)/", log))) == 1 and log.count("sql export sql") == 3, "one fresh path per attempt, three databases"
    assert all(f"cloudsql-final/" in log and f"/{db}.sql.gz" in log for db in ("postgres", "sprintable", "support_gateway")), "each database has its own object"
    assert (tmp_path / "sql-dev.json").exists() and (tmp_path / "sprintable-migrate-dev.yaml").exists() and (tmp_path / "sprintable-verify-oneoff.yaml").exists(), "the definitions the undo needs are saved by the same block"
    for label, over in (("one export failed", {"FAKE_FAIL_DB": "support_gateway"}), ("an export is empty", {"FAKE_EMPTY_DB": "sprintable"}), ("the backup failed", {"FAKE_BACKUP_FAILS": "1"}),
                        ("the instance is not in the list", {"FAKE_NO_INSTANCE": "1"}), ("the definition can not be saved", {"FAKE_NO_DESCRIBE": "1"})):
        bad = run(**over)
        assert "EXPORTS-OK" not in bad.stdout and "EO=0" in bad.stdout, f"no all clear when {label}"
    assert "NO SUCH INSTANCE: sprintable-dev" in run(FAKE_NO_INSTANCE="1").stdout


def test_the_cloud_sql_delete_line_does_nothing_without_the_all_clear_and_deletes_in_order_with_it(tmp_path: Path) -> None:
    b = _fake_bin(tmp_path, _FAKE_GCLOUD_SQL)
    line = [ln.strip() for blk in _fenced(_rows()["R5"]) for ln in blk.splitlines() if "gcloud sql instances delete" in ln][0]
    env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "INSTANCE": "sprintable-dev", "FAKE_LOG": str(tmp_path / "log"), "FAKE_NO_INSTANCE": "0", "FAKE_NO_DESCRIBE": "0",
           "FAKE_BACKUP_FAILS": "0", "FAKE_FAIL_DB": "none", "FAKE_EMPTY_DB": "none"}
    (tmp_path / "log").write_text("")
    subprocess.run(["bash", "-c", "unset EXPORTS_OK; " + line], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)
    assert (tmp_path / "log").read_text() == "", "nothing is deleted before the exports were verified"
    subprocess.run(["bash", "-c", "EXPORTS_OK=1; " + line], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)
    calls = [c.split()[1:4] for c in (tmp_path / "log").read_text().splitlines()]
    assert calls == [["run", "jobs", "delete"], ["run", "jobs", "delete"], ["sql", "instances", "delete"]]


_FAKE_GCLOUD_FIND = r"""#!/bin/sh
case "$1 $2 $3" in
  "redis instances list") printf '%s' "$FAKE_REDIS" ;;
  "compute instances list") printf '%s' "$FAKE_PGB" ;;
esac
"""


@pytest.mark.parametrize("marker,var,matches,expected", [
    ("unset REDIS;", "FAKE_REDIS", "cache-dev\n", "REDIS=cache-dev"),
    ("unset REDIS;", "FAKE_REDIS", "", None), ("unset REDIS;", "FAKE_REDIS", "cache-dev\nother-dev\n", None),
    ("unset PGB PGB_ZONE;", "FAKE_PGB", "pgb-dev\tzone-a\n", "PGB=pgb-dev PGB_ZONE=zone-a"),
    ("unset PGB PGB_ZONE;", "FAKE_PGB", "", None), ("unset PGB PGB_ZONE;", "FAKE_PGB", "a\tz\nb\tz\n", None),
])
def test_the_name_finders_take_exactly_one_match_and_forget_what_an_earlier_search_left(tmp_path: Path, marker: str, var: str, matches: str, expected) -> None:
    line = re.search(rf"`({re.escape(marker)}[^`]*)`", SHEET)
    assert line, marker
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text(_FAKE_GCLOUD_FIND)
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", var: matches.encode().decode("unicode_escape")}
    # a stale value from an earlier search sits in the shell; the finder must not let it through when the new search found nothing usable
    stale = "REDIS=old-redis; PGB=old-vm; PGB_ZONE=old-zone; "
    r = subprocess.run(["bash", "-c", stale + line.group(1)], capture_output=True, text=True, env=env, timeout=30)
    if expected:
        assert r.returncode == 0 and r.stdout.strip() == expected, (r.stdout, r.stderr)
    else:
        assert r.returncode != 0 and "old-" not in r.stdout, (r.stdout, r.stderr)


def test_the_pgbouncer_capture_refuses_a_second_disk_instead_of_a_half_undo(tmp_path: Path) -> None:
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text(_FAKE_GCLOUD_PGB)
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    extra = _PGB_DEFINITION.replace('"disks":[', '"disks":[{"boot":false,"source":"https://x/disks/other"},')
    (tmp_path / "def.json").write_text(extra)
    env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "PGB": "pgb-dev", "PGB_ZONE": "z", "FAKE_LOG": str(tmp_path / "log"), "FAKE_DEFINITION": str(tmp_path / "def.json")}
    r = subprocess.run(["bash", "-c", _fence_with("R3", "disks snapshot") + '\necho "SO=${SNAP_OK:-0}"'], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)
    assert "SNAPSHOT NOT TAKEN" in r.stdout and "SO=0" in r.stdout and "SNAPSHOT-OK" not in r.stdout
    assert "disks snapshot" not in (tmp_path / "log").read_text(), "no snapshot is taken of a half of the machine"


def test_the_undo_chains_stop_at_the_first_failure_and_restore_both_database_users() -> None:
    r1 = _rows()["R1"].split("5. **Undo:**")[1].split("\n")[0]
    assert r1.count(" && ") == 3 and "for s in" not in r1, "four commands in one chain"
    r5 = _rows()["R5"].split("5. **Undo**")[1]
    block = [b for b in _fenced(r5) if "gcloud sql instances create" in b][0]
    assert block.count(" &&\n") == 7 and block.rstrip().endswith("&& echo RESTORE-OK") and "OK=0" not in block, "eight commands, one chain, one all clear"
    assert block.count("gcloud sql import sql") == 3 and "gcloud sql databases create sprintable " in block and "gcloud sql databases create support_gateway " in block
    assert "gcloud sql users create sprintable " in block and "gcloud sql users create support_gw " in block
    assert '${APP_PASSWORD:?' in block and "ALEMBIC_DATABASE_URL_DEV" in r5 and "--set-cloudsql-instances" in r5
    jobs = [ln for ln in r5.splitlines() if "gcloud run jobs replace sprintable-migrate-dev.yaml" in ln][0]
    assert "&& echo JOBS-OK" in jobs, "the all clear closes the chain"
    assert " && gcloud run jobs replace sprintable-verify-oneoff.yaml" in jobs


def test_the_pgbouncer_delete_runs_only_after_a_verified_snapshot(tmp_path: Path) -> None:
    m = re.search(r'`(\[ "\$\{SNAP_OK:-0\}" = 1 \] && gcloud compute instances delete[^`]*)`', SHEET)
    assert m
    b = _fake_bin(tmp_path, '#!/bin/sh\necho "gcloud $*" >> "$FAKE_LOG"\n')
    env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "PGB": "pgb-dev", "PGB_ZONE": "z", "FAKE_LOG": str(tmp_path / "log")}
    (tmp_path / "log").write_text("")
    subprocess.run(["bash", "-c", "unset SNAP_OK; " + m.group(1)], capture_output=True, text=True, env=env, timeout=30)
    assert (tmp_path / "log").read_text() == ""
    subprocess.run(["bash", "-c", "SNAP_OK=1; " + m.group(1)], capture_output=True, text=True, env=env, timeout=30)
    assert "compute instances delete pgb-dev --zone z --project p" in (tmp_path / "log").read_text()


def test_gate_d_makes_the_realtime_check_come_before_the_redis_and_pooler_rows() -> None:
    gate = SHEET.split("| **D. Realtime leftovers**")[1].split("\n")[0]
    assert "R4" in gate and "nothing in R2 or R3 runs before this" in gate
    for key in ("R2", "R3"):
        assert "**Gate D first**" in _rows()[key], key


_FAKE_GCLOUD_CAPTURE = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "run services describe") if [ "$FAKE_FAIL" = "describe:$4" ]; then echo "kind: Partial"; exit 1; fi; if [ "$FAKE_FAIL" = "empty:$4" ]; then exit 0; fi; case "$*" in *"value("*) echo "region-docker.pkg.dev/p/r/backend@sha256:abc" ;; *) echo "kind: Service $4" ;; esac ;;
  "run services get-iam-policy") if [ "$FAKE_FAIL" = "iam:$4" ]; then echo "{}"; exit 1; fi; echo "{}" ;;
  "run services delete") : ;;
  "redis instances describe") if [ "$FAKE_FAIL" = "redis" ]; then echo '{"tier":"BASIC"}'; exit 1; fi; if [ "$FAKE_FAIL" = "redis-bad" ]; then echo '{"error":"x"}'; exit 0; fi; echo '{"tier":"BASIC","memorySizeGb":1}' ;;
  "redis instances delete") : ;;
esac
"""


def test_the_first_and_second_rows_delete_only_after_their_captures_are_proven(tmp_path: Path) -> None:
    b = _fake_bin(tmp_path, _FAKE_GCLOUD_CAPTURE)
    base = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "REDIS": "cache-dev", "FAKE_LOG": str(tmp_path / "log"), "FAKE_FAIL": ""}

    def run(script: str, **over: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env={**base, **over}, cwd=tmp_path, timeout=30)

    cap1 = _fence_with("R1", "CAPTURE-OK")
    delete1 = [ln.strip() for blk in _fenced(_rows()["R1"]) for ln in blk.splitlines() if "gcloud run services delete" in ln][0]
    ok = run(cap1 + '\necho "R=${R1_OK:-0}"')
    assert "CAPTURE-OK" in ok.stdout and "R=1" in ok.stdout, ok.stderr
    for fail in ("describe:sprintable-frontend-dev", "iam:sprintable-backend-dev", "empty:sprintable-frontend-dev"):
        bad = run(cap1 + '\necho "R=${R1_OK:-0}"', FAKE_FAIL=fail)
        assert "CAPTURE-OK" not in bad.stdout and "R=0" in bad.stdout, fail
    (tmp_path / "log").write_text("")
    run("unset R1_OK; " + delete1)
    assert "services delete" not in (tmp_path / "log").read_text(), "no delete without the proven capture"
    run("R1_OK=1; " + delete1)
    assert (tmp_path / "log").read_text().count("run services delete") == 2

    m1 = re.search(r"`(unset REDIS_OK; gcloud redis instances describe[^`]*)`", SHEET)
    m2 = re.search(r"`(\[ \"\$\{REDIS_OK:-0\}\" = 1 \] && gcloud redis instances delete[^`]*)`", SHEET)
    assert m1 and m2
    good = run(m1.group(1) + '; echo "R=${REDIS_OK:-0}"')
    assert "CAPTURE-OK" in good.stdout and "R=1" in good.stdout, good.stderr
    for fail in ("redis", "redis-bad"):
        bad = run(m1.group(1) + '; echo "R=${REDIS_OK:-0}"', FAKE_FAIL=fail)
        assert "CAPTURE-OK" not in bad.stdout and "R=0" in bad.stdout, fail
    (tmp_path / "log").write_text("")
    run("unset REDIS_OK; " + m2.group(1))
    assert "redis instances delete" not in (tmp_path / "log").read_text()
    run("REDIS_OK=1; " + m2.group(1))
    assert "redis instances delete cache-dev" in (tmp_path / "log").read_text()


def test_the_cloud_sql_dependents_step_says_the_list_is_read_and_not_assumed_and_what_the_first_run_found() -> None:
    """2026-10-28: the first run of R5 stopped at a dependents list longer than the two jobs the sheet expected (the dev admin console's internal API service and seven jobs not run since June-August).
    The blocks of R5 handle the two jobs only, so the paragraph must not promise more than that: the extra lines are retired by hand BEFORE the capture, in an order that cannot delete what is not saved, and the listing is run again."""
    step1 = _rows()["R5"].split("1. Dependents (read only)")[1].split("2. Capture")[0]
    for token in ("**Read the list, do not assume it.**", "on 2026-10-28 the list was longer", "`sprintable-internal-api-dev`", "`sprintable-admin-web-dev`", "seven jobs that had not run since June-August",
                  "**The blocks below handle only those two jobs.**", "retired by hand BEFORE step 2, one resource at a time and in this order", "the product owner states that it is not used",
                  "writes the answer down", "**«I do not know» is a stop, not a yes**", "its definition is saved", "checked to be non-empty", "(c) only then", "**run the listing above again: it must print only the two jobs**",
                  "means gate 0 is not done: stop"):
        assert token in step1, token
    assert step1.index("(a)") < step1.index("(b)") < step1.index("(c) only then") < step1.index("run the listing above again"), "state, save, delete, list again"
    save_step = step1.split("(b)")[1].split("(c) only then")[0]
    delete_step = step1.split("(c) only then")[1].split("Then **run the listing")[0]
    assert "definition is saved" in save_step and "delete" not in save_step, "(b) saves and deletes nothing"
    assert "gcloud run $KIND delete $NAME" in delete_step and "describe" not in delete_step, "(c) is the delete, after the file exists"
    assert "Expected before the delete: only" not in _rows()["R5"], "the old, shorter expectation is gone"
    assert "in the same chain" not in step1, "no promise that the chain below covers the extra lines"
