"""story 4796 (D2) — deploy/vm/bin/subnet-residents.py: who sits on the gateway's own subnet? (written by the security domain; read only, names only).

The subnet's rule is that only the gateway service, its migrate job and the probe jobs may sit on it: anything else deployed there reaches the gateway database's port. The tool is run from the PO's machine
(RUNBOOK §13, the cutover sheet's steps 1, 8 and 11). Run here against a FAKE gcloud that serves JSON fixtures and records every call, in nine situations (the security domain's own set) plus the usage errors; the
recorded calls prove it reads and never writes.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = _ROOT / "deploy/vm/bin/subnet-residents.py"
SUB = "support-gateway-dev"
ALLOW = ["--allow-service", "support-gateway-dev", "--allow-job", "sprintable-support-gateway-migrate-dev", "--allow-job", "gwdb-probe-"]


def ann(subnet: str) -> dict:
    return {"run.googleapis.com/network-interfaces": json.dumps([{"network": "default", "subnetwork": subnet}])}


def svc(name: str, subnet: str, traffic=None) -> dict:
    return {"metadata": {"name": name}, "spec": {"template": {"metadata": {"annotations": ann(subnet)}}}, "status": {"traffic": traffic or []}}


def job(name: str, subnet: str) -> dict:
    return {"metadata": {"name": name}, "spec": {"template": {"metadata": {"annotations": ann(subnet)}}}}


def fixture(**kw) -> dict:
    base = {"subnet": {"ipCidrRange": "10.1.2.0/25", "purpose": "PRIVATE"}, "services": [], "jobs": [], "instances": [], "templates": [], "revisions": {}}
    base.update(kw)
    return base


FAKE = '''#!{python}
import json, os, sys
fx = json.load(open(os.environ["K_FIX"]))
a = " ".join(sys.argv[1:])
open(os.environ["K_CALLS"], "a").write(a + "\\n")
if fx.get("fail"):
    sys.stderr.write("ERROR: forced\\n"); sys.exit(1)
def out(x): print(json.dumps(x))
if "compute networks subnets describe" in a: out(fx["subnet"])
elif "run services list" in a: out(fx["services"])
elif "run revisions describe" in a: out(fx["revisions"].get(sys.argv[4], {{"metadata": {{"annotations": {{}}}}}}))
elif "run jobs list" in a: out(fx["jobs"])
elif "compute instances list" in a: out(fx["instances"])
elif "compute instance-templates list" in a: out(fx["templates"])
else: out([])
'''


def run(tmp: Path, fx: dict, args: list[str] | None = None) -> tuple[int, str, list[str]]:
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    g = b / "gcloud"
    g.write_text(FAKE.format(python=sys.executable))
    g.chmod(0o755)
    fxp, calls = tmp / "fx.json", tmp / "calls.log"
    fxp.write_text(json.dumps(fx))
    calls.write_text("")
    r = subprocess.run([sys.executable, "-I", str(SCRIPT), *(args if args is not None else ["p", "r", SUB, *ALLOW])], capture_output=True, text=True, timeout=60,
                       env={"PATH": f"{b}:{os.environ.get('PATH', '/usr/bin:/bin')}", "K_FIX": str(fxp), "K_CALLS": str(calls), "HOME": str(tmp)})
    return r.returncode, r.stdout, calls.read_text().splitlines()


def test_nobody_on_the_subnet_is_fine(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(services=[svc("other-svc", "default")], jobs=[job("other-job", "default")]))
    assert rc == 0 and "services on it: none" in out and "VERDICT: OK" in out


def test_only_the_gateway_service_its_migrate_job_and_a_probe_job_is_fine(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(services=[svc("support-gateway-dev", SUB), svc("sprintable-backend-prod", "default")],
                                       jobs=[job("sprintable-support-gateway-migrate-dev", SUB), job("gwdb-probe-gwsubnet-1028051234", SUB), job("sprintable-migrate-prod", "default")]))
    assert rc == 0 and "NOT ALLOWED" not in out and "VERDICT: OK" in out
    assert "support-gateway-dev (allowed)" in out and "sprintable-support-gateway-migrate-dev (allowed)" in out and "gwdb-probe-gwsubnet-1028051234 (allowed)" in out


def test_another_service_on_the_subnet_is_named(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(services=[svc("support-gateway-dev", SUB), svc("somebody-else", SUB)]))
    assert rc == 1 and "somebody-else (NOT ALLOWED)" in out and "VERDICT: NOT OK" in out


def test_a_service_whose_template_moved_but_whose_serving_revision_is_still_there_is_named(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(services=[svc("hidden", "default", traffic=[{"revisionName": "hidden-00007", "percent": 100}])], revisions={"hidden-00007": {"metadata": {"annotations": ann(SUB)}}}))
    assert rc == 1 and "hidden (NOT ALLOWED)" in out


def test_a_revision_without_traffic_that_a_tag_reaches_is_named(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(services=[svc("tagged", "default", traffic=[{"revisionName": "tagged-00002", "percent": 0, "tag": "canary"}])], revisions={"tagged-00002": {"metadata": {"annotations": ann(SUB)}}}))
    assert rc == 1 and "tagged (NOT ALLOWED)" in out


def test_another_job_is_named(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(jobs=[job("sprintable-backfill-dev", SUB)]))
    assert rc == 1 and "sprintable-backfill-dev (NOT ALLOWED)" in out


def test_a_vm_and_an_instance_template_on_the_subnet_are_named(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(instances=[{"name": "a-vm", "networkInterfaces": [{"subnetwork": f"projects/p/regions/r/subnetworks/{SUB}"}]}],
                                       templates=[{"name": "a-tmpl", "properties": {"networkInterfaces": [{"subnetwork": SUB}]}}]))
    assert rc == 1 and "a-vm" in out and "a-tmpl" in out


def test_a_gcloud_that_fails_or_a_missing_subnet_is_exit_2_never_fine(tmp_path: Path) -> None:
    rc, out, _ = run(tmp_path, fixture(fail=True))
    assert rc == 2 and "could not look" in out and "VERDICT" not in out


def test_an_annotation_that_is_not_json_is_exit_2(tmp_path: Path) -> None:
    bad = svc("weird", SUB)
    bad["spec"]["template"]["metadata"]["annotations"]["run.googleapis.com/network-interfaces"] = "{not json"
    rc, out, _ = run(tmp_path, fixture(services=[bad]))
    assert rc == 2 and "could not look" in out and "VERDICT" not in out


@pytest.mark.parametrize("args", [[], ["p", "r"], ["p", "r", SUB, "--allow-service"], ["p", "r", SUB, "--bogus", "x"]])
def test_wrong_usage_is_exit_2_and_asks_nothing(tmp_path: Path, args: list[str]) -> None:
    rc, out, calls = run(tmp_path, fixture(), args)
    assert rc == 2 and calls == [] and "usage" in out


def test_it_only_reads_and_never_prints_an_address(tmp_path: Path) -> None:
    fx = fixture(services=[svc("support-gateway-dev", SUB, traffic=[{"revisionName": "r1", "percent": 100}])], revisions={"r1": {"metadata": {"annotations": ann(SUB)}}},
                 jobs=[job("sprintable-support-gateway-migrate-dev", SUB)], instances=[{"name": "a-vm", "networkInterfaces": [{"subnetwork": SUB, "networkIP": "10.9.9.9"}]}])
    rc, out, calls = run(tmp_path, fx)
    verbs = {c.split()[c.split().index("describe") if "describe" in c.split() else c.split().index("list")] for c in calls}
    assert verbs <= {"describe", "list"}, calls
    assert not any(w in " ".join(calls) for w in ("create", "update", "delete", "deploy", "add-", "remove-", "set-", "execute")), calls
    assert "10.9.9.9" not in out and "10.1.2" not in out, "names only: no address of anything on the subnet (the range's size is shown, not the range)"
    assert "/25" in out


def test_the_script_is_the_one_the_sheet_and_the_runbook_name() -> None:
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    assert "deploy/vm/bin/subnet-residents.py" in sheet and "--allow-service $GW --allow-job $GWJOB --allow-job gwdb-probe-" in sheet
    assert SCRIPT.read_text().startswith("#!/usr/bin/env python3\n# Written by the security domain") and os.access(SCRIPT, os.X_OK)


def test_it_says_it_does_not_look_at_worker_pools_and_the_sheet_says_what_to_do() -> None:
    rc, out, _ = run(Path(__import__("tempfile").mkdtemp()), fixture())
    assert rc == 0 and "Cloud Run worker pools : NOT LOOKED AT by this tool" in out and out.index("worker pools") < out.index("VERDICT")
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    assert "**The tool does not look at Cloud Run worker pools**" in sheet and "Cloud Run → Worker pools in the console" in sheet
