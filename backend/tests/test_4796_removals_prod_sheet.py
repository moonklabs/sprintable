"""story 4796 — the prod removals sheet (deploy/vm/REMOVALS-prod.md) cannot go stale or unsafe.

Pinned: every resource name the sheet deletes is the one the repository's scripts and pipeline create; what stays (the hosted MCP, the scheduler, the NAT) is never in a delete line;
every delete line is guarded and one resource per command; the Cloud SQL line does nothing without the verified exports and the exports print their all clear only when everything it stands for
happened (run for real against a fake gcloud); the final dump of the move is copied out of the 7-day prefix before anything is deleted; and the one decision the cutover sheet had made for «a day
later» (the old address, gate F) is a gate, not a silent drop.
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
SHEET = (_ROOT / "deploy/vm/REMOVALS-prod.md").read_text()
CUTOVER = (_ROOT / "deploy/vm/CUTOVER-prod.md").read_text()
RUNBOOK = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
POOLER = (_ROOT / "infra/pgbouncer/deploy_prod.sh").read_text()
WORKFLOW = (_ROOT / ".github/workflows/cloud-build.yml").read_text()


def _rows() -> dict[str, str]:
    parts = re.split(r"^## (R\d)\. ", SHEET, flags=re.M)
    return {parts[i]: parts[i + 1] for i in range(1, len(parts), 2)}


def _fenced(text: str) -> list[str]:
    return re.findall(r"```\n(.*?)```", text, flags=re.S)


def _block(row: str, marker: str) -> str:
    found = [b for b in _fenced(_rows()[row]) if marker in b]
    assert len(found) == 1, (row, marker)
    return found[0]


def _delete_lines() -> list[str]:
    verb = r"gcloud (?:[a-z-]+ ){1,3}delete\b"
    fenced = [ln.strip() for b in _fenced(SHEET) for ln in b.splitlines() if re.search(verb, ln)]
    inline = [c for c in re.findall(r"`([^`\n]*" + verb + r"[^`\n]*)`", SHEET) if c not in fenced]
    return fenced + inline


def test_the_rows_are_six_in_the_run_order_and_the_old_address_has_its_own_gate() -> None:
    assert list(_rows()) == ["R1", "R2", "R3", "R4", "R5", "R6"]
    heads = re.findall(r"^## R\d\. (.*)$", SHEET, flags=re.M)
    assert [h.split(" —")[0].split(" (")[0] for h in heads] == [
        "Cloud Run prod frontend", "Redis prod", "pgbouncer prod", "realtime prod", "Cloud SQL `sprintable-prod`", "`sprintable-backend-prod`"]
    gate_f = SHEET.split("| **F. The old address**")[1].split("\n")[0]
    assert "7 days in a row" in gate_f and "remove now" not in SHEET.lower(), "the old address goes after the seven empty days of the cutover sheet, not on a note"
    # the cutover sheet really says 7 days and that the removals sheet of prod does the removal
    assert "empty for **7 days in a row**" in CUTOVER and "removed as a whole" in CUTOVER
    assert "R1–R5 do **not** touch `sprintable-backend-prod`" in gate_f
    why = _rows()["R6"].split("**Why it is not removed today")[1].split("\n")[0]
    for token in ("0.08 vCPU", "128 Mi", "concurrency 1", "maximum 10", "first generation", "CPU boost off", "minimum instances 0", "fwd-20261030=100", "unmeasured here"):
        assert token in why, token


def test_the_names_are_the_ones_the_repository_creates() -> None:
    assert "`sprintable-redis-prod`" in WORKFLOW or "sprintable-redis-prod" in WORKFLOW
    assert "REDIS_URL_PROD" in WORKFLOW and "REDIS_URL_PROD" in SHEET
    for name in ("pgbouncer-prod-tmpl", "pgbouncer-prod-mig", "pgbouncer-prod-hc", "pgbouncer-prod-bes", "pgbouncer-prod-fr", "pgbouncer-nat-router", "pgbouncer-nat", "pgbouncer-prod-sa"):
        assert name in SHEET and name in POOLER, name
    for m in ("MIG", "BES", "FR"):
        assert re.search(rf"^{m}=pgbouncer-prod-", POOLER, flags=re.M)
    assert "gcloud compute health-checks create tcp \"$HC\" --region=" in POOLER, "the prod health check is regional: the sheet's lines carry --region"
    assert 'sprintable-readonly-prod' in (_ROOT / "backend/scripts/provision_readonly_prod_job.sh").read_text() and "sprintable-readonly-prod" in SHEET
    assert "sprintable-migrate-${_DEPLOY_ENV}" in (_ROOT / "cloudbuild.yaml").read_text() and "sprintable-migrate-prod" in SHEET
    assert 'INSTANCE_PROD="sprintable-prod"' in (_ROOT / "backend/scripts/provision_cloud_sql.sh").read_text() and "SQL=sprintable-prod" in SHEET
    assert "BACKEND=sprintable-backend-prod" in CUTOVER and "FRONTEND=sprintable-frontend-prod" in CUTOVER and "MCP=sprintable-mcp-prod" in CUTOVER
    for verb in ("list", "describe", "delete"):
        cmds = re.findall(rf"gcloud compute health-checks {verb}\b[^&\n`]*pgbouncer-prod-hc[^&\n`]*", SHEET)
        assert cmds and all("--region" in c for c in cmds), (verb, cmds)


def test_the_pooler_is_in_use_by_the_old_backend_so_the_sheet_says_so_and_orders_it_behind_gate_g() -> None:
    assert 'echo "backend_db_pgbouncer=true"' in WORKFLOW and "10.178.0.111:6432" in WORKFLOW
    assert "DATABASE_URL=DATABASE_URL_PROD_PGBOUNCER:latest" in (_ROOT / "cloudbuild.yaml").read_text()
    r3 = _rows()["R3"]
    assert "10.178.0.111:6432" in r3 and "DATABASE_URL_PROD_PGBOUNCER" in r3 and "which is why gate G comes first" in r3
    assert "idle" not in r3.split("1. Find it")[0], "the pooler is no longer called idle"


def test_the_final_dump_gate_copies_by_prefix_because_the_helper_adds_a_pid() -> None:
    helper = (_ROOT / "deploy/vm/bin/dump-source.sh").read_text()
    assert 'base="$dir/$env_name-$label-$stamp-$$"' in helper
    assert 'gs://$BACKUPS_BUCKET/import/$P-*' in SHEET and "COPY-OK" in SHEET


def test_the_vm_declares_no_redis_and_no_pooler_so_nothing_alive_needs_what_the_sheet_removes() -> None:
    env = (_ROOT / "deploy/vm/env/prod.yaml").read_text()
    assert "REDIS_URL: no Redis on the VM" in env and "DB_PGBOUNCER: 'false'" in env
    assert len(re.findall(r"REDIS\w*ENABLED: 'false'", env)) >= 5


def test_every_delete_line_is_guarded_one_resource_per_command_and_never_names_what_stays() -> None:
    deletes = _delete_lines()
    assert len(deletes) == 5, deletes  # R1, R2, R3's chain (five pieces, one chain), R5's chain, R6
    assert sum(ln.count(" delete ") for ln in deletes) == 11, "R1 1, R2 1, R3 5, R5 3, R6 1"
    for ln in deletes:
        assert ln.count('"${PROJECT:?}"') == ln.count("gcloud "), f"every gcloud call in the line is guarded: {ln}"
        assert re.sub(r'"[^"]*"', '"x"', ln).count(" delete ") == ln.count("gcloud "), ln
        for stays in ("sprintable-mcp-prod", "$MCP", "scheduler", "pgbouncer-nat", "pgbouncer-prod-sa", "cloudsql-final", "import/", "storage rm"):
            assert stays not in ln, (stays, ln)
    assert "gcloud storage rm" not in SHEET.replace("`gcloud storage rm` of exactly the two paths", ""), "no bucket object is deleted by a line of this sheet"
    for key in ("R1", "R2", "R5", "R6"):
        body = _rows()[key]
        d = max(body.find(c) for c in ("gcloud run services delete", "gcloud redis instances delete", "gcloud sql instances delete"))
        assert 0 < body.find("Capture") < d and "**Undo" in body and body.index("**Undo") > d, key


def test_the_final_dump_is_copied_out_of_the_seven_day_prefix_before_anything_is_deleted() -> None:
    assert '"matchesPrefix":["db/"]' in RUNBOOK and "`import/`" in RUNBOOK and "7 days" in RUNBOOK
    gate_c = SHEET.split("| **C. The final dump outlives its 7 days**")[1].split("\n")[0]
    assert "prod-final-20261029T111058Z" in gate_c and "`COPY-OK` is a condition of R5's delete line" in gate_c
    copy = [b for b in _fenced(SHEET) if "COPY-OK" in b][0]
    assert "gcloud storage cp" in copy and "cloudsql-final/$P/" in copy and "P=prod-final-20261029T111058Z" in copy
    lifecycle = RUNBOOK.split("lifecycle.json <<'EOF'")[1].split("EOF")[0]
    assert "cloudsql-final" not in lifecycle, "the prefix the exports and the copy go to has no expiry rule"
    assert "gs://${BACKUPS_BUCKET:?}/cloudsql-final/$STAMP/$db.sql.gz" in _block("R5", "EXPORTS-OK")


def test_the_cloud_sql_undo_names_the_loss_window_and_no_secret_value_is_in_the_sheet() -> None:
    r5 = _rows()["R5"]
    assert "Anything written on the VM after the unfreeze" in r5 and "accepted in writing in gate G" in r5
    gate_g = SHEET.split("| **G. The way back through Cloud Run ends here")[1].split("\n")[0]
    assert "REDIS_URL_PROD" in gate_g and "DATABASE_URL_PROD_PGBOUNCER" in gate_g and "way-back-accepted.txt" in gate_g
    for key in ("R2", "R3", "R5"):
        assert re.search(r"[Gg]ates? [^\n]*\bG\b", _rows()[key].split("\n")[0] + "\n".join(l for l in _rows()[key].splitlines() if "first" in l or "only after" in l)), key
    assert "secrets versions access" not in SHEET
    assert '--password "${APP_PASSWORD:?' in r5
    assert not re.search(r"postgres(?:ql)?://\S+:\S+@", SHEET)
    for block in (b for body in _rows().values() for b in _fenced(body)):
        assert not re.search(r"<[A-Za-z][^>\n]*>", block), block


# ── the Cloud SQL blocks, run for real against a fake gcloud ─────────────────────────────────────────────────────────────────────────────

_FAKE_GCLOUD_SQL = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "sql instances list") [ "$FAKE_NO_INSTANCE" = 1 ] || echo sprintable-prod ; echo other ;;
  "sql instances describe") if [ "$FAKE_NO_DESCRIBE" = 1 ]; then echo "no definition" >&2; exit 1; fi; echo '{"settings":{"tier":"db-g1-small"}}' ;;
  "sql databases list") printf '%s' "$FAKE_DBS" ;;
  "run jobs describe") echo "kind: Job" ;;
  "sql backups create") if [ "$FAKE_BACKUP_FAILS" = 1 ]; then echo "backup failed" >&2; exit 1; fi ;;
  "sql export sql") case "$*" in *"--database $FAKE_FAIL_DB"*) echo "export failed" >&2; exit 1 ;; esac ;;
  "storage ls -l") case "$4" in *"$FAKE_EMPTY_DB.sql.gz") echo "     0  $4" ;; *) echo "  1234  $4" ;; esac ;;
  "run jobs delete"|"sql instances delete") : ;;
esac
"""


def _fake_bin(tmp_path: Path) -> Path:
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    g = b / "gcloud"
    g.write_text(_FAKE_GCLOUD_SQL)
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    return b


def _env(tmp_path: Path, **over: str) -> dict[str, str]:
    return {**os.environ, "PATH": f"{_fake_bin(tmp_path)}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "SQL": "sprintable-prod", "BACKUPS_BUCKET": "bk", "FAKE_LOG": str(tmp_path / "log"),
            "FAKE_DBS": "postgres\nsprintable\n", "FAKE_FAIL_DB": "none", "FAKE_EMPTY_DB": "none", "FAKE_NO_INSTANCE": "0", "FAKE_NO_DESCRIBE": "0", "FAKE_BACKUP_FAILS": "0", **over}


def test_the_exports_print_their_all_clear_only_when_everything_it_stands_for_happened(tmp_path: Path) -> None:
    block = _block("R5", "EXPORTS-OK") + '\necho "EO=${EXPORTS_OK:-0}"'

    def run(**over: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "-c", block], capture_output=True, text=True, env=_env(tmp_path, **over), cwd=tmp_path, timeout=30)

    ok = run()
    assert ok.returncode == 0 and "EXPORTS-OK" in ok.stdout and "EO=1" in ok.stdout, ok.stderr
    log = (tmp_path / "log").read_text()
    assert len(set(re.findall(r"cloudsql-final/(\d{8}T\d{6}Z)/", log))) == 1 and log.count("sql export sql") == 2, "one fresh path per attempt, one object per database the instance holds"
    assert (tmp_path / "sql-prod.json").exists() and (tmp_path / "sprintable-migrate-prod.yaml").exists() and (tmp_path / "sprintable-readonly-prod.yaml").exists()
    assert run(FAKE_DBS="postgres\nsprintable\nextra\n").stdout.count("EXPORTS-OK") == 1 and (tmp_path / "log").read_text().count("--database extra") >= 1, "the databases are read from the instance, not assumed"
    for label, over in (("one export failed", {"FAKE_FAIL_DB": "sprintable"}), ("an export is empty", {"FAKE_EMPTY_DB": "postgres"}), ("the backup failed", {"FAKE_BACKUP_FAILS": "1"}),
                        ("the instance is not in the list", {"FAKE_NO_INSTANCE": "1"}), ("the definition can not be saved", {"FAKE_NO_DESCRIBE": "1"}), ("the database list is empty", {"FAKE_DBS": ""})):
        bad = run(**over)
        assert "EXPORTS-OK" not in bad.stdout and "EO=0" in bad.stdout, f"no all clear when {label}"


def test_the_cloud_sql_delete_line_does_nothing_without_all_three_proofs_and_deletes_in_order_with_them(tmp_path: Path) -> None:
    line = [ln.strip() for b in _fenced(_rows()["R5"]) for ln in b.splitlines() if "gcloud sql instances delete" in ln][0]
    proofs = ("EXPORTS_OK", "DEP_OK", "COPY_OK")
    for missing in proofs:
        (tmp_path / "log").write_text("")
        sets = "; ".join(f"{p}=1" for p in proofs if p != missing)
        subprocess.run(["bash", "-c", f"unset {' '.join(proofs)}; {sets}; " + line], capture_output=True, text=True, env=_env(tmp_path), cwd=tmp_path, timeout=30)
        assert (tmp_path / "log").read_text() == "", f"nothing is deleted without {missing}"
    (tmp_path / "log").write_text("")
    subprocess.run(["bash", "-c", "set -u; EXPORTS_OK=1; DEP_OK=1; COPY_OK=1; SQL=''; " + line], capture_output=True, text=True, env={**_env(tmp_path), "SQL": ""}, cwd=tmp_path, timeout=30)
    assert (tmp_path / "log").read_text() == "", "an empty instance name stops the line before the first job is deleted"
    subprocess.run(["bash", "-c", "EXPORTS_OK=1; DEP_OK=1; COPY_OK=1; " + line], capture_output=True, text=True, env=_env(tmp_path), cwd=tmp_path, timeout=30)
    calls = [c.split()[1:4] for c in (tmp_path / "log").read_text().splitlines()]
    assert calls == [["run", "jobs", "delete"], ["run", "jobs", "delete"], ["sql", "instances", "delete"]]


_FAKE_GCLOUD_DEP = r"""#!/bin/sh
case "$1 $2 $3" in
  "sql instances describe") echo '{"ipAddresses":[{"type":"PRIMARY","ipAddress":"34.64.0.9"},{"type":"PRIVATE","ipAddress":"10.110.0.5"}]}' ;;
  "run services list") printf 'sprintable-backend-prod\nsprintable-mcp-prod\n' ;;
  "run jobs list") printf 'sprintable-migrate-prod\nsprintable-readonly-prod\n%s' "$FAKE_EXTRA_JOB" ;;
  "run services describe") if [ "$4" = "$FAKE_UNREADABLE" ]; then exit 1; fi; echo "{\"name\":\"$4\"}"; [ "$4" = "$FAKE_SVC_USES" ] && echo "$FAKE_USES"; exit 0 ;;
  "run jobs describe") echo "{\"name\":\"$4\"} proj:r:sprintable-prod DATABASE_URL_PROD" ;;
  "run revisions list") echo "real-revision mounts it" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
"""


def test_the_dependents_block_is_a_gate_only_the_two_jobs_pass_and_an_unreadable_definition_is_not_clear(tmp_path: Path) -> None:
    b = tmp_path / "bin"
    b.mkdir()
    (b / "gcloud").write_text(_FAKE_GCLOUD_DEP)
    (b / "gcloud").chmod(0o755)
    block = _block("R5", "DEPENDENTS-CLEAR") + '\necho "DEP=${DEP_OK:-0}"'

    def run(**over: str) -> subprocess.CompletedProcess:
        env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "SQL": "sprintable-prod", "BACKEND": "sprintable-backend-prod",
               "FAKE_EXTRA_JOB": "", "FAKE_UNREADABLE": "none", "FAKE_SVC_USES": "none", "FAKE_USES": "", **over}
        return subprocess.run(["bash", "-c", block], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)

    ok = run()
    assert "DEPENDENTS-CLEAR" in ok.stdout and "DEP=1" in ok.stdout, ok.stderr
    for label, over, needle in (
        ("an old admin job uses the secret", {"FAKE_EXTRA_JOB": "old-admin-job\n"}, "USES CLOUD SQL PROD: jobs old-admin-job"),
        ("a service carries the secret", {"FAKE_SVC_USES": "sprintable-mcp-prod", "FAKE_USES": "DATABASE_URL_PROD"}, "USES CLOUD SQL PROD: services sprintable-mcp-prod"),
        ("a service carries the private address", {"FAKE_SVC_USES": "sprintable-mcp-prod", "FAKE_USES": "host 10.110.0.5"}, "USES CLOUD SQL PROD: services sprintable-mcp-prod"),
        ("a definition can not be read", {"FAKE_UNREADABLE": "sprintable-mcp-prod"}, "UNREADABLE: services sprintable-mcp-prod"),
    ):
        bad = run(**over)
        assert "DEPENDENTS-CLEAR" not in bad.stdout and "DEP=0" in bad.stdout and needle in bad.stdout, label


_FAKE_GCLOUD_COPY = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "storage ls -l") case "$4" in
      */import/*) [ "$FAKE_NO_SRC" = 1 ] || { [ "$FAKE_NO_DUMP" = 1 ] || printf '  100  2026-10-29T11:11:00Z  gs://bk/import/prod-final-20261029T111058Z-4242.dump\n'; printf '   64  2026-10-29T11:11:00Z  gs://bk/import/prod-final-20261029T111058Z-4242.dump.sha256\nTOTAL: 2 objects\n'; } ;;
      */cloudsql-final/*) [ "$FAKE_NO_COPY" = 1 ] || { [ "$FAKE_NO_DUMP" = 1 ] || printf '  %s  2026-10-29T12:00:00Z  gs://bk/cloudsql-final/prod-final-20261029T111058Z/prod-final-20261029T111058Z-4242.dump\n' "$FAKE_DST_SIZE"; printf '   64  x  gs://bk/cloudsql-final/prod-final-20261029T111058Z/prod-final-20261029T111058Z-4242.dump.sha256\nTOTAL: 2 objects\n'; } ;;
    esac ;;
esac
"""


def test_the_final_dump_copy_prints_its_all_clear_only_when_every_object_is_there_with_its_size(tmp_path: Path) -> None:
    b = tmp_path / "bin"
    b.mkdir()
    (b / "gcloud").write_text(_FAKE_GCLOUD_COPY)
    (b / "gcloud").chmod(0o755)
    block = [x for x in _fenced(SHEET) if "COPY-OK" in x][0] + '\necho "COPY=${COPY_OK:-0}"'

    def run(**over: str) -> subprocess.CompletedProcess:
        env = {**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "BACKUPS_BUCKET": "bk", "FAKE_LOG": str(tmp_path / "log"), "FAKE_NO_SRC": "0", "FAKE_NO_DUMP": "0", "FAKE_NO_COPY": "0", "FAKE_DST_SIZE": "100", **over}
        (tmp_path / "log").write_text("")
        return subprocess.run(["bash", "-c", block], capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30)

    ok = run()
    assert "COPY-OK" in ok.stdout and "COPY=1" in ok.stdout, ok.stderr
    assert "storage cp" in (tmp_path / "log").read_text() and "import/prod-final-20261029T111058Z-*" in (tmp_path / "log").read_text(), "the copy is by prefix: the helper adds a pid"
    for label, over in (("the copy has another size", {"FAKE_DST_SIZE": "99"}), ("nothing was copied", {"FAKE_NO_COPY": "1"}), ("the source is empty", {"FAKE_NO_SRC": "1"}), ("the source holds only the checksum, not the dump", {"FAKE_NO_DUMP": "1"})):
        bad = run(**over)
        assert "COPY-OK" not in bad.stdout and "COPY=0" in bad.stdout, label
        if over.get("FAKE_NO_SRC") == "1":
            assert "storage cp" not in (tmp_path / "log").read_text(), "an empty source copies nothing"


def test_the_service_rows_delete_only_after_their_capture_is_proven(tmp_path: Path) -> None:
    g = tmp_path / "bin"
    g.mkdir()
    (g / "gcloud").write_text('#!/bin/sh\necho "gcloud $*" >> "$FAKE_LOG"\ncase "$1 $2 $3" in\n  "run services describe") [ "$FAKE_FAIL" = 1 ] && exit 1; echo "kind: Service" ;;\n'
                              '  "run services get-iam-policy") echo \'{"bindings":[]}\' ;;\n  "run revisions list") echo \'[{"name":"r1"}]\' ;;\nesac\n')
    (g / "gcloud").chmod(0o755)
    for row, svc, var, marker in (("R1", "sprintable-frontend-prod", "FRONTEND", "CAPTURE-OK"), ("R6", "sprintable-backend-prod", "BACKEND", "CAPTURE-OK")):
        cap = _block(row, "CAPTURE-OK")
        line = [c for c in re.findall(r"`([^`\n]*gcloud run services delete[^`\n]*)`", _rows()[row])][0]
        for fail in ("0", "1"):
            d = tmp_path / f"{row}{fail}"
            d.mkdir()
            (d / "log").write_text("")
            env = {**os.environ, "PATH": f"{g}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", var: svc, "FAKE_LOG": str(d / "log"), "FAKE_FAIL": fail}
            out = subprocess.run(["bash", "-c", cap + "\n" + line], capture_output=True, text=True, env=env, cwd=d, timeout=30)
            deleted = "services delete" in (d / "log").read_text()
            assert (marker in out.stdout) == (fail == "0") and deleted == (fail == "0"), (row, fail, out.stdout, out.stderr)


def test_the_sheet_keeps_what_the_first_run_taught() -> None:
    """2026-10-29: the dependents list printed four more than the two jobs, and the export failed with 412 until the instance's service account had a role on the bucket"""
    r5 = _rows()["R5"]
    for token in ("`sprintable-internal-api`", "`seed-loadtest-prod`", "`sprintable-audit-apikey-prod`", "`sprintable-backfill-prod`", "DEPENDENTS-CLEAR", "failed with 412"):
        assert token in r5, token
    grant = [b for b in _fenced(r5) if "add-iam-policy-binding" in b][0]
    assert grant.index("add-iam-policy-binding") < grant.index("remove-iam-policy-binding")
    assert "roles/storage.objectAdmin" in grant and grant.count("serviceAccount:$SQL_SA") == 2, "granted before, taken away after, to the instance's own account only"
    assert "R6 has not run" in SHEET.split("## Run record")[1].split("##")[0]


def test_the_pooler_template_is_read_from_the_group_not_assumed_and_the_revoke_is_guarded(tmp_path: Path) -> None:
    """2026-10-29: the live group used `tmpl-r3`, not the script's `pgbouncer-prod-tmpl`; and the temporary bucket role must come off even through a typo (an empty bucket name aborts, it does not skip)"""
    r3 = _rows()["R3"]
    capture = _block("R3", "CAPTURE-OK")
    assert "$(jq -r '.versions[0].instanceTemplate" in capture and "NO TEMPLATE IN THE GROUP'S DEFINITION" in capture
    chain = [ln for ln in _fenced(r3)[2].splitlines() if "instance-templates delete" in ln][0]
    assert 'instance-templates delete "${TMPL:?}"' in chain and "pgbouncer-prod-tmpl" not in chain
    revoke = [ln for ln in SHEET.splitlines() if "remove-iam-policy-binding" in ln][0]
    assert 'gs://${BACKUPS_BUCKET:?}' in revoke
    # run for real: a definition without a template stops the capture; with one, the template's own name is described
    b = tmp_path / "bin"
    b.mkdir()
    (b / "gcloud").write_text('#!/bin/sh\necho "gcloud $*" >> "$FAKE_LOG"\ncase "$1 $2 $3" in\n  "compute instance-groups managed") echo "$FAKE_MIG" ;;\n  *) echo \'{"name":"x"}\' ;;\nesac\n')
    (b / "gcloud").chmod(0o755)
    (tmp_path / "log").write_text("")
    for mig, ok in (('{"name":"m","versions":[{"instanceTemplate":"https://x/global/instanceTemplates/tmpl-r3"}]}', True), ('{"name":"m","versions":[]}', False)):
        script = capture.replace("--format=json > pgbouncer-prod-mig.json || OK=0", "--format=json > pgbouncer-prod-mig.json || OK=0; echo \"$FAKE_MIG\" > pgbouncer-prod-mig.json")
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, cwd=tmp_path, timeout=30,
                             env={**os.environ, "PATH": f"{b}:{os.environ['PATH']}", "PROJECT": "p", "REGION": "r", "FAKE_LOG": str(tmp_path / "log"), "FAKE_MIG": mig})
        assert ("CAPTURE-OK" in out.stdout) == ok, (mig, out.stdout, out.stderr)
        assert ("the group's template: tmpl-r3" in out.stdout) == ok


def test_the_forwarder_is_deployed_with_the_values_that_are_live_and_the_real_gcloud_accepts_them(tmp_path: Path) -> None:
    """2026-10-29 14:04Z: the PO moved the old address to 0.08 vCPU / 128 Mi / concurrency 1 / maximum 10 by hand; the written line (cutover 4c-B) says the same, and the real gcloud parses it"""
    line = [ln for ln in CUTOVER.splitlines() if ln.startswith('[ "$FWD" = recorded ]') and "gcloud run deploy" in ln][0]
    for flag in ("--cpu 0.08", "--memory 128Mi", "--concurrency 1", "--max-instances 10", "--execution-environment gen1", "--cpu-throttling", "--no-cpu-boost", "--min-instances 0"):
        assert flag in line, flag
    for old in ("--cpu 1 ", "256Mi", "--concurrency 250", "--max-instances 2 "):
        assert old not in line, old
    assert "128 MiB, 0.08 CPU, first generation, concurrency 1" in CUTOVER
    r6 = _rows()["R6"]
    assert "0.08 vCPU, 128 Mi, concurrency 1, maximum 10" in r6 and "CUTOVER-prod.md" in r6.split("**Why it is not removed today")[1].split("\n")[0]
