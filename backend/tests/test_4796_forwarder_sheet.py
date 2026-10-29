"""story 4796 - the forwarder blocks of deploy/vm/CUTOVER-prod.md (steps 4c, 8c, 9, 10-11 and the first block of 12), run as written against a fake gcloud that keeps a state.

The fake models what matters: the traffic of the service, who may call it, what a new revision inherits from the old one unless the command clears it, and what a request to each address
would answer. So a command that forgets a flag (the revision inherits the environment, the traffic moves to it, the public binding stays on) shows up as a block that does not reach its pass.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tests.test_4796_cutover_prod_sheet import SHEET, WP, _block_with, _fresh, _section, _verbs, _w, _world  # noqa: F401

_ROOT = Path(__file__).resolve().parents[2]
REAL = "sprintable-backend-prod-00042-abc"
FWDREV = "sprintable-backend-prod-fwd-20261102"
SA = "sprintable-forwarder-prod@sprintable-494803.iam.gserviceaccount.com"
DIGEST = "sha256:" + "a" * 64
IMAGE = f"asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable/sprintable-forwarder@{DIGEST}"
RECORD = f"real\t{REAL}\nreal-image\tasia-northeast3-docker.pkg.dev/x/backend@sha256:{'b' * 64}\nforwarder\t{FWDREV}\n"
VM_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"

_GCLOUD = r'''#!__PY__
import json, os, sys
state = os.environ["STATE"] + "/world.json"
w = json.load(open(state))
a = sys.argv[1:]
open(os.environ["CALLS"], "a").write("gcloud " + " ".join(a) + "\n")
fail = os.environ.get("FAIL", "")
if fail and fail in " ".join(a):
    sys.exit(1)
def save(): json.dump(w, open(state, "w"))
def flag(name, default=None):
    for i, x in enumerate(a):
        if x == name and i + 1 < len(a): return a[i + 1]
        if x.startswith(name + "="): return x.split("=", 1)[1]
    return default
def has(name): return name in a
j = " ".join(a)
REH_NAME = "sprintable-rehearsal-forwarder"
if a[:3] == ["run", "services", "describe"] and a[3] == REH_NAME:
    if os.environ.get("REH_ERR"): sys.stderr.write("ERROR: (gcloud.run.services.describe) HTTPError 503: backend unavailable\n"); sys.exit(1)
    if not w.get("reh_exists"): sys.stderr.write("ERROR: (gcloud.run.services.describe) Cannot find service [sprintable-rehearsal-forwarder]\n"); sys.exit(1)
    if "labels.rehearsal" in flag("--format", ""): sys.stdout.write(w.get("reh_label", ""))
    sys.exit(0)
if a[:3] == ["run", "services", "describe"] and a[3] != "sprintable-backend-prod":
    sys.stderr.write("the fake knows one service besides the rehearsal one: " + a[3] + "\n"); sys.exit(1)
if a[:3] == ["run", "services", "describe"]:
    fmt = flag("--format", "")
    if fmt == "json":
        real = w["revisions"][w["template_from"]]
        print(json.dumps({"status": {"url": w["url"], "traffic": w["traffic"]}, "spec": {"template": {"metadata": {"annotations": real["metadata"]["annotations"]}}}}))
    elif "status.url" in fmt: sys.stdout.write(w["url"])
    elif "containers[0].image" in fmt: sys.stdout.write(w["service_image"])
    sys.exit(0)
if a[:3] == ["run", "revisions", "describe"]:
    name = a[3]; fmt = flag("--format", "")
    if fmt == "json": print(json.dumps(w["revisions"][name]))
    else: sys.stdout.write(w["revisions"][name]["spec"]["containers"][0]["image"])
    sys.exit(0)
if a[:3] == ["run", "services", "delete"]:
    w["reh_exists"] = False; save(); sys.exit(0)
if a[:3] == ["run", "services", "update-traffic"]:
    spec = flag("--to-revisions")
    rev = spec.split("=")[0]
    tagged = [t for t in w["traffic"] if t.get("tag")]
    w["traffic"] = [{"revisionName": rev, "percent": 100}] + [dict(t, percent=0) for t in tagged]
    save(); sys.exit(0)
if a[:2] == ["run", "deploy"] and not flag("--revision-suffix"):
    w["reh_exists"] = True; w["reh_label"] = (flag("--labels") or "").replace("rehearsal=", ""); save()   # the throwaway service of the rehearsal: made with its label
    sys.exit(0)
if a[:2] == ["run", "deploy"]:
    suffix = flag("--revision-suffix"); name = a[2] + "-" + suffix
    base = w["revisions"][w["template_from"]]
    clear = lambda f: has(f)
    rev = json.loads(json.dumps(base))
    rev["spec"]["containers"][0]["image"] = flag("--image")
    rev["spec"]["serviceAccountName"] = flag("--service-account", base["spec"]["serviceAccountName"])
    c0 = rev["spec"]["containers"][0]
    if clear("--clear-env-vars"): c0["env"] = [e for e in c0["env"] if "valueFrom" in e]
    if clear("--clear-secrets"):
        c0["env"] = [e for e in c0["env"] if "valueFrom" not in e]
        gone = {v["name"] for v in rev["spec"]["volumes"] if "secret" in v}
        rev["spec"]["volumes"] = [v for v in rev["spec"]["volumes"] if v["name"] not in gone]
        c0["volumeMounts"] = [m for m in c0["volumeMounts"] if m["name"] not in gone]
    if clear("--clear-volumes"): rev["spec"]["volumes"] = []
    if clear("--clear-volume-mounts"): c0["volumeMounts"] = []
    ni = rev["metadata"]["annotations"].get("run.googleapis.com/network-interfaces")
    if ni:
        att = json.loads(ni)[0]
        if clear("--clear-network"): att = {}   # disconnects from the VPC network: the whole attachment goes
        if att: rev["metadata"]["annotations"]["run.googleapis.com/network-interfaces"] = json.dumps([att])
        else: rev["metadata"]["annotations"].pop("run.googleapis.com/network-interfaces")
    if clear("--clear-cloudsql-instances"): rev["metadata"]["annotations"].pop("run.googleapis.com/cloudsql-instances", None)
    if clear("--clear-vpc-connector"): rev["metadata"]["annotations"].pop("run.googleapis.com/vpc-access-connector", None)
    rev["status"] = {"imageDigest": flag("--image")}
    w["revisions"][name] = rev
    tag = flag("--tag")
    if has("--no-traffic"):
        pass
    else:
        w["traffic"] = [{"revisionName": name, "percent": 100}]
    if tag:
        w["traffic"] = [t for t in w["traffic"] if t.get("tag") != tag] + [{"revisionName": name, "percent": 0, "tag": tag, "url": "https://" + tag + "---x.run.app"}]
    save(); sys.exit(0)
if a[:3] == ["run", "services", "get-iam-policy"]:
    if os.environ.get("EMPTY_POLICY"): sys.exit(0)
    print(json.dumps({"bindings": [{"role": "roles/run.invoker", "members": w["invokers"]}]})); sys.exit(0)
if a[:3] == ["run", "services", "add-iam-policy-binding"]:
    m = flag("--member")
    if m not in w["invokers"]: w["invokers"].append(m)
    save(); sys.exit(0)
if a[:3] == ["run", "services", "remove-iam-policy-binding"]:
    m = flag("--member")
    if m not in w["invokers"]: sys.exit(1)
    if m in os.environ.get("STICKY", "").split(): sys.exit(0)   # gcloud says yes, the policy keeps the member
    w["invokers"].remove(m); save(); sys.exit(0)
if a[:2] == ["builds", "submit"]:
    sys.exit(0)
if a[:4] == ["artifacts", "docker", "images", "describe"]:
    sys.stdout.write(w["built_digest"]); sys.exit(0)
if a[:3] == ["iam", "service-accounts", "describe"]:
    sys.exit(0 if w["sa_exists"] else 1)
if a[:3] == ["iam", "service-accounts", "create"]:
    w["sa_exists"] = True; save(); sys.exit(0)
if a[:2] == ["projects", "get-iam-policy"]:
    sys.stdout.write(w.get("sa_roles", "")); sys.exit(0)
if a[:2] == ["auth", "print-identity-token"]:
    sys.stdout.write("id-token"); sys.exit(0)
sys.stderr.write("the fake gcloud does not know: " + j + "\n"); sys.exit(2)
'''

_CURL = r'''#!__PY__
import json, os, sys
w = json.load(open(os.environ["STATE"] + "/world.json"))
a = sys.argv[1:]
open(os.environ["CALLS"], "a").write("curl " + " ".join(a) + "\n")
url = [x for x in a if x.startswith("http")][0]
authed = any(x == "X-Serverless-Authorization: Bearer id-token" for x in a)
code_only = "-w" in a
host, _, path = url.split("://", 1)[1].partition("/")
path = "/" + path
traffic_rev = [t for t in w["traffic"] if t.get("percent") == 100][0]["revisionName"]
def vm():  return {"status": w.get("vm_status", "ok"), "db": w.get("vm_db", "ok"), "commit_sha": w["vm_sha"], "revision": w.get("vm_revision", "unknown")}
def cr():  return {"status": "ok", "db": "ok", "commit_sha": w["real_sha"], "revision": traffic_rev}
if host == "api.sprintable.ai":
    out, code = (dict(vm(), commit_sha=w.get("api_sha", w["vm_sha"]), status=w.get("api_status", w.get("vm_status", "ok"))), 200)
else:
    public = "allUsers" in w["invokers"] or authed or (traffic_rev == w["forwarder"] and w.get("open_on_switch", False))
    served = dict(vm(), status=w.get("fwd_authed_status" if authed else "fwd_public_status", w.get("vm_status", "ok"))) if traffic_rev == w["forwarder"] else cr()
    if traffic_rev == w["forwarder"] and not authed:
        served = dict(served, db=w.get("fwd_public_db", served["db"]), commit_sha=w.get("fwd_public_sha", served["commit_sha"]))
    if host.startswith("fwd---"):
        # the tag reaches the forwarder, which hands the request to api.sprintable.ai (the pass-through of step 3), which hands it to the main address
        tagged = [t for t in w["traffic"] if t.get("tag")][0]["revisionName"]
        runs_forwarder = w["revisions"][tagged]["spec"]["containers"][0]["image"] == w["built_digest"]
        served = {"status": "ok", "db": "ok", "commit_sha": w["real_sha"], "revision": w.get("tag_revision", w["real"])} if (runs_forwarder and not w.get("loop")) else None
        public = True
    if not public: out, code = None, 403
    else: out, code = served, (200 if served is not None else 504)
if code_only: sys.stdout.write(str(code))
elif out is not None: print(json.dumps(out))
sys.exit(0)
'''


def _rev(sa: str, env: list, secrets: bool, cloudsql: bool, vpc: bool, kind: str = "direct", tags: bool = True) -> dict:
    """a revision like the backend's: plain and secret environment, a secret volume and a plain one, Cloud SQL, a VPC connector, a network"""
    ann: dict = {}
    if cloudsql:
        ann["run.googleapis.com/cloudsql-instances"] = "sprintable-494803:asia-northeast3:sprintable-prod"
    if vpc and kind == "connector":
        ann["run.googleapis.com/vpc-access-connector"] = "conn"
    if vpc and kind == "direct":   # prod's backend: a Direct VPC attachment, no connector
        ann["run.googleapis.com/network-interfaces"] = json.dumps([{"network": "default", "subnetwork": "default", **({"tags": ["egress-tag"]} if tags else {})}])
    return {"metadata": {"annotations": ann}, "spec": {"serviceAccountName": sa, "containers": [{"image": "asia-northeast3-docker.pkg.dev/x/backend@sha256:" + "b" * 64, "env": env + ([{"name": "JWT_SECRET", "valueFrom": {"secretKeyRef": {"name": "j", "key": "latest"}}}] if secrets else []),
                                                                                                        "volumeMounts": ([{"name": "s", "mountPath": "/secrets"}, {"name": "tmp", "mountPath": "/tmp"}] if secrets else [])}],
                                                      "volumes": ([{"name": "s", "secret": {"secretName": "x"}}, {"name": "tmp", "emptyDir": {}}] if secrets else [])}, "status": {"imageDigest": "sha256:" + "b" * 64}}


def _world_state(root: Path, **over) -> None:
    w = {"url": "https://x.run.app", "service_image": "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable/backend@sha256:" + "b" * 64,
         "traffic": [{"revisionName": REAL, "percent": 100, "latestRevision": True}], "invokers": ["user:operator@example.com"],
         "revisions": {REAL: _rev("cloudrun-runtime-prod@sprintable-494803.iam.gserviceaccount.com", [{"name": "DATABASE_URL", "value": "x"}], True, True, True)},
         "template_from": REAL, "built_digest": IMAGE, "sa_exists": False, "sa_roles": "", "vm_sha": VM_SHA, "real_sha": "1111111111111111111111111111111111111111",
         "forwarder": FWDREV, "real": REAL}
    w.update(over)
    (root / "state").mkdir(exist_ok=True)
    (root / "state" / "world.json").write_text(json.dumps(w))


def _world_of(root: Path, **over) -> dict:
    env = _world(root)
    b = Path(env["PATH"].split(":")[0])
    for name, text in (("gcloud", _GCLOUD), ("curl", _CURL)):
        f = b / name
        f.write_text(text.replace("__PY__", sys.executable))
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    _world_state(root, **over)
    return env


def _go(block: str, root: Path, shell: str = "bash", files: dict[str, str] | None = None, extra: dict[str, str] | None = None, state: dict | None = None):
    env = _world_of(root, **(state or {}))
    env.update(extra or {})
    work = _w(root)
    work.mkdir(exist_ok=True)
    for name, text in (files or {}).items():
        (work / name).write_text(text)
    p = subprocess.run([shell, "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=work)
    calls = Path(env["CALLS"]).read_text().splitlines()
    world = json.loads((root / "state" / "world.json").read_text())
    return p, calls, world, work


SHELLS = ["bash", pytest.param("zsh", marks=pytest.mark.skipif(shutil.which("zsh") is None, reason="no zsh on this machine"))]
A = lambda: _block_with("FWDOK=no")      # noqa: E731
B = lambda: _block_with("FWD=no\n[ -n \"$WINDOW\" ] && [ \"${PWD##*/}\" = \"window-${WINDOW}\" ] && [ -s forwarder-image.txt ]")      # noqa: E731
C = lambda: _block_with("FWDP=no")      # noqa: E731
E8 = lambda: _block_with("FWD=no\n[ -n \"$WINDOW\" ] && [ \"${PWD##*/}\" = \"window-${WINDOW}\" ] && [ -s \"real-revision-${WINDOW}.txt\" ] && [ -s \"was-invoker")      # noqa: E731
M12 = lambda: _block_with("BACK=no\n[ \"$VMBACK\" = passing ]")      # noqa: E731


def _last(p: subprocess.CompletedProcess, word: str) -> str:
    return [l for l in p.stdout.splitlines() if l.startswith(word)][-1]


# ── 4c-A: the image and the account ─────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("shell", SHELLS)
def test_4c_a_builds_next_to_the_backends_image_pins_the_digest_and_makes_an_account_with_no_role(tmp_path: Path, shell: str) -> None:
    p, calls, world, work = _go(A(), tmp_path, shell, extra={"REPO": str(_ROOT)})
    assert _last(p, "forwarder image") == "forwarder image: account", p.stdout + p.stderr
    sub = _verbs(calls, "builds submit")[0]
    assert "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable/sprintable-forwarder:20261102" in sub and f"{_ROOT}/deploy/vm/forwarder" in sub, "built from the repository's folder, tagged next to the backend's image"
    assert (work / "forwarder-image.txt").read_text().strip() == IMAGE, "the digest is what is kept"
    assert _verbs(calls, "service-accounts create") and not _verbs(calls, "add-iam-policy-binding") and not _verbs(calls, "projects add-iam"), "an account with no role: nothing is granted to it"
    assert world["sa_exists"] is True


def test_4c_a_takes_the_registry_from_the_environment_when_it_is_set_for_the_rehearsal(tmp_path: Path) -> None:
    p, calls, _, _ = _go(A(), tmp_path, extra={"REPO": str(_ROOT), "FWD_AR": "asia-northeast3-docker.pkg.dev/other/registry"})
    assert "asia-northeast3-docker.pkg.dev/other/registry/sprintable-forwarder:20261102" in _verbs(calls, "builds submit")[0], "the throwaway runs a public image: its registry is not the backend's"


def test_4c_a_stops_where_a_line_fails_and_keeps_an_existing_account(tmp_path: Path) -> None:
    for name, fail, last in (("img", "run services describe", "start"), ("build", "builds submit", "named"), ("digest", "images describe", "built")):
        p, calls, _, work = _go(A(), _fresh(tmp_path, name), extra={"REPO": str(_ROOT), "FAIL": fail})
        assert _last(p, "forwarder image") == f"forwarder image: {last}", (name, p.stdout)
        assert not _verbs(calls, "service-accounts create") and not (work / "forwarder-image.txt").exists(), name
    p, calls, _, _ = _go(A(), _fresh(tmp_path, "exists"), extra={"REPO": str(_ROOT)}, state={"sa_exists": True})
    assert _last(p, "forwarder image") == "forwarder image: account" and not _verbs(calls, "service-accounts create"), "an account that is there is kept"
    p, calls, _, _ = _go(A(), _fresh(tmp_path, "nofolder"), extra={"REPO": "/nowhere"})
    assert _last(p, "forwarder image") == "forwarder image: no" and not calls, "outside the repository's checkout nothing is called"


# ── 4c-B: the record and the revision ───────────────────────────────────────────────────────────────────────────────────────────────────────

def _b(root: Path, files: dict | None = None, state: dict | None = None, extra: dict | None = None, shell: str = "bash"):
    return _go(B(), root, shell, files={"forwarder-image.txt": IMAGE + "\n", **(files or {})}, state=state, extra=extra)


@pytest.mark.parametrize("shell", SHELLS)
def test_4c_b_writes_the_record_before_it_deploys_and_the_deploy_clears_everything_the_forwarder_must_not_inherit(tmp_path: Path, shell: str) -> None:
    p, calls, world, work = _b(tmp_path, shell=shell)
    assert _last(p, "forwarder revision") == "forwarder revision: deployed", p.stdout + p.stderr
    rec = dict(l.split("\t") for l in (work / "real-revision-20261102.txt").read_text().splitlines())
    assert rec["real"] == REAL and rec["forwarder"] == FWDREV and rec["real-image"].endswith("b" * 64)
    deploy = _verbs(calls, "run deploy")[0].split()
    for flag in ("--no-traffic", "--clear-env-vars", "--clear-secrets", "--clear-volumes", "--clear-volume-mounts", "--clear-cloudsql-instances", "--clear-vpc-connector", "--clear-network", "--tag", "--revision-suffix", "--service-account", "--min-instances", "--max-instances"):
        assert flag in deploy, flag
    assert deploy[deploy.index("--image") + 1] == IMAGE, "the digest, never a tag"
    assert "--allow-unauthenticated" not in deploy and "--set-env-vars" not in deploy and "--update-env-vars" not in deploy and "--set-secrets" not in deploy, "the public binding is the product owner's line in 8c, and nothing is set"
    assert calls.index(next(c for c in calls if "run deploy" in c)) > calls.index(next(c for c in calls if "revisions describe" in c)), "the real revision is read before anything is made"
    # the revision it made holds nothing of the backend's and the real revision still has the traffic
    rev = world["revisions"][FWDREV]
    assert rev["spec"]["containers"][0]["env"] == [] and rev["spec"]["volumes"] == [] and rev["spec"]["containers"][0]["volumeMounts"] == [] and rev["metadata"]["annotations"] == {}, "nothing of the backend's is left"
    assert [(t["revisionName"], t["percent"]) for t in world["traffic"] if t["percent"] > 0] == [(REAL, 100)]


def test_4c_b_stops_when_the_traffic_is_not_one_revision_with_all_of_it_or_the_record_names_another_real_revision(tmp_path: Path) -> None:
    split = [{"revisionName": REAL, "percent": 60}, {"revisionName": "other", "percent": 40}]
    p, calls, _, work = _b(_fresh(tmp_path, "split"), state={"traffic": split})
    assert _last(p, "forwarder revision") == "forwarder revision: start" and not _verbs(calls, "run deploy") and not (work / "real-revision-20261102.txt").exists()
    p, calls, _, work = _b(_fresh(tmp_path, "other"), files={"real-revision-20261102.txt": RECORD.replace(REAL, "somebody-else")})
    assert _last(p, "forwarder revision") == "forwarder revision: read" and not _verbs(calls, "run deploy"), "a record of another real revision is never overwritten"
    assert "somebody-else" in (work / "real-revision-20261102.txt").read_text()
    p, calls, _, _ = _b(_fresh(tmp_path, "again"), files={"real-revision-20261102.txt": RECORD})
    assert _last(p, "forwarder revision") == "forwarder revision: deployed", "a second run on the same real revision goes on"
    p, calls, _, _ = _b(_fresh(tmp_path, "noimage"), files={"forwarder-image.txt": ""})
    assert _last(p, "forwarder revision") == "forwarder revision: no" and not calls


# ── 4c-C: the proof ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _after_b(root: Path, **over):
    """the state 4c-B leaves: run it, then return the folder, the files and the world for the proof"""
    p, _, world, work = _b(root)
    assert _last(p, "forwarder revision") == "forwarder revision: deployed", p.stdout
    return work, world


def _c(root: Path, mutate=None, extra: dict | None = None, shell: str = "bash"):
    work, world = _after_b(root)
    if mutate:
        mutate(world)
    env = _world_of(root)
    (root / "state" / "world.json").write_text(json.dumps(world))
    env.update(extra or {})
    p = subprocess.run([shell, "-c", C()], capture_output=True, text=True, timeout=60, env=env, cwd=work)
    return p, Path(env["CALLS"]).read_text().splitlines()


@pytest.mark.parametrize("shell", SHELLS)
def test_4c_c_passes_only_for_a_revision_that_holds_nothing_has_no_traffic_and_reaches_the_real_revision_through_its_tag(tmp_path: Path, shell: str) -> None:
    p, calls = _c(_fresh(tmp_path, "ok"), shell=shell)
    assert _last(p, "forwarder:") == "forwarder: ready", p.stdout + p.stderr
    assert not [c for c in calls if any(w in c.split() for w in ("deploy", "update-traffic", "add-iam-policy-binding", "remove-iam-policy-binding", "create", "delete"))], "the proof only reads"


def test_a_deploy_line_that_forgets_a_clear_flag_makes_a_revision_that_the_proof_stops_on(tmp_path: Path) -> None:
    """the sheet as it was before the review of the security domain: the connector cleared, the Direct VPC attachment inherited"""
    for name, drop in (("network", " --clear-network "), ("env", " --clear-env-vars "), ("volumes", " --clear-volumes "), ("mounts", " --clear-volume-mounts "), ("cloudsql", " --clear-cloudsql-instances ")):
        block = B().replace(drop, " ", 1)
        assert block != B(), name
        p, _, world, work = _go(block, _fresh(tmp_path, f"b-{name}"), files={"forwarder-image.txt": IMAGE + "\n"})
        assert _last(p, "forwarder revision") == "forwarder revision: deployed", name
        root = tmp_path / f"b-{name}"
        env = _world_of(root)
        (root / "state" / "world.json").write_text(json.dumps(world))
        q = subprocess.run(["bash", "-c", C()], capture_output=True, text=True, timeout=60, env=env, cwd=work)
        assert _last(q, "forwarder:") == "forwarder: untouched", (name, "the proof does not let a revision that kept it through")
    # the same with the connector kind of attachment: the connector flag is what clears it
    p, _, world, work = _go(B(), _fresh(tmp_path, "connector"), files={"forwarder-image.txt": IMAGE + "\n"}, state={"revisions": {REAL: _rev("cloudrun-runtime-prod@sprintable-494803.iam.gserviceaccount.com", [{"name": "A", "value": "x"}], True, True, True, "connector")}})
    assert world["revisions"][FWDREV]["metadata"]["annotations"] == {}, "the connector kind of attachment is cleared by its own flag"


def test_4c_c_every_thing_the_forwarder_must_not_hold_is_a_stop(tmp_path: Path) -> None:
    def rev(w): return w["revisions"][FWDREV]
    cases = {
        "env": (lambda w: rev(w)["spec"]["containers"][0].update(env=[{"name": "DATABASE_URL", "value": "x"}]), "untouched"),
        "secret-volume": (lambda w: rev(w)["spec"].update(volumes=[{"name": "s", "secret": {"secretName": "x"}}]), "untouched"),
        "volume-mount": (lambda w: rev(w)["spec"]["containers"][0].update(volumeMounts=[{"name": "s", "mountPath": "/x"}]), "untouched"),
        "cloudsql": (lambda w: rev(w)["metadata"]["annotations"].update({"run.googleapis.com/cloudsql-instances": "p:r:i"}), "untouched"),
        "vpc": (lambda w: rev(w)["metadata"]["annotations"].update({"run.googleapis.com/vpc-access-connector": "c"}), "untouched"),
        "network-interfaces": (lambda w: rev(w)["metadata"]["annotations"].update({"run.googleapis.com/network-interfaces": "[{}]"}), "untouched"),
        "network-tags-only": (lambda w: rev(w)["metadata"]["annotations"].update({"run.googleapis.com/network-interfaces": "[{\"tags\": [\"t\"]}]"}), "untouched"),
        "wrong-account": (lambda w: rev(w)["spec"].update(serviceAccountName="cloudrun-runtime-prod@sprintable-494803.iam.gserviceaccount.com"), "untouched"),
        "wrong-image": (lambda w: (rev(w)["spec"]["containers"][0].update(image="x/backend@sha256:" + "b" * 64), rev(w).update(status={"imageDigest": "sha256:" + "b" * 64})), "untouched"),
        "has-a-role": (lambda w: w.update(sa_roles="roles/editor\n"), "empty"),
        "digest-resolved-is-another": (lambda w: rev(w).update(status={"imageDigest": "x/forwarder@sha256:" + "c" * 64}), "untouched"),
        "digest-not-resolved": (lambda w: rev(w).update(status={}), "untouched"),
        "spec-image-is-another": (lambda w: rev(w)["spec"]["containers"][0].update(image="x/forwarder@sha256:" + "c" * 64), "untouched"),
    }
    for name, (mutate, reached) in cases.items():
        p, _ = _c(_fresh(tmp_path, name), mutate)
        assert _last(p, "forwarder:") == f"forwarder: {reached}", (name, p.stdout)


def test_4c_c_traffic_that_moved_or_a_loop_through_the_tag_is_a_stop(tmp_path: Path) -> None:
    p, _ = _c(_fresh(tmp_path, "moved"), lambda w: w.update(traffic=[{"revisionName": FWDREV, "percent": 100}, {"revisionName": FWDREV, "percent": 0, "tag": "fwd", "url": "https://fwd---x.run.app"}]))
    assert _last(p, "forwarder:") == "forwarder: read", "the forwarder has the traffic already: that is not what 4c is"
    p, _ = _c(_fresh(tmp_path, "loop"), lambda w: w.update(loop=True))
    assert _last(p, "forwarder:") == "forwarder: noroles", "the tag does not answer (the two addresses hand the request to each other): not ready"
    def tag_on_real(w):
        for t in w["traffic"]:
            if t.get("tag"): t["revisionName"] = REAL
    p, _ = _c(_fresh(tmp_path, "tag-on-the-real-revision"), tag_on_real)
    assert _last(p, "forwarder:") == "forwarder: noroles", "a tag that points at the real revision answers well and proves nothing about the forwarder"
    p, _ = _c(_fresh(tmp_path, "tag-with-traffic"), lambda w: [t.update(percent=5) for t in w["traffic"] if t.get("tag")])
    assert _last(p, "forwarder:") == "forwarder: read", "a tag that carries traffic is traffic on the forwarder"
    p, _ = _c(_fresh(tmp_path, "own-name"), lambda w: w.update(tag_revision=FWDREV))
    assert _last(p, "forwarder:") == "forwarder: noroles", "an answer with the forwarder's own name through its own tag is a loop or a wrong address, not the real revision"
    p, _ = _c(_fresh(tmp_path, "notag"), lambda w: w.update(traffic=[t for t in w["traffic"] if not t.get("tag")]))
    assert _last(p, "forwarder:") == "forwarder: noroles"


# ── 8c ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _frozen(root: Path, **over):
    """the state when step 8 begins: the forwarder is made (4c), the freeze took `allUsers` off the backend, the operator is the only invoker"""
    work, world = _after_b(root)
    world.update(over)
    return work, world


def _e8(root: Path, files: dict | None = None, mutate=None, shell: str = "bash", extra: dict | None = None):
    work, world = _frozen(root)
    if mutate:
        mutate(world)
    env = _world_of(root)
    (root / "state" / "world.json").write_text(json.dumps(world))
    env.update(extra or {})
    for name, text in {WP: f"{'sprintable-backend-prod'}\tallUsers\nsprintable-mcp-prod\tallUsers\n", **(files or {})}.items():
        (work / name).write_text(text)
    p = subprocess.run([shell, "-c", E8()], capture_output=True, text=True, timeout=60, env=env, cwd=work)
    return p, Path(env["CALLS"]).read_text().splitlines(), json.loads((root / "state" / "world.json").read_text())


@pytest.mark.parametrize("shell", SHELLS)
def test_8c_moves_the_traffic_while_closed_proves_it_as_the_vm_and_only_then_opens(tmp_path: Path, shell: str) -> None:
    p, calls, world = _e8(_fresh(tmp_path, "ok"), shell=shell)
    assert _last(p, "forwarder:") == "forwarder: proven", p.stdout + p.stderr
    assert world["invokers"] == ["user:operator@example.com", "allUsers"] and [t["revisionName"] for t in world["traffic"] if t["percent"] > 0] == [FWDREV]
    order = [i for i, c in enumerate(calls) if "update-traffic" in c or "add-iam-policy-binding" in c or "print-identity-token" in c]
    assert [("update-traffic" in calls[i], "print-identity-token" in calls[i], "add-iam-policy-binding" in calls[i]) for i in order] == [(True, False, False), (False, True, False), (False, False, True)], "traffic, then the proof with the operator's identity, then the public binding"
    assert any("403" in l or "still closed: 403" in l for l in p.stdout.splitlines()), "it shows it is closed before it opens"
    add = _verbs(calls, "add-iam-policy-binding")
    assert len(add) == 1 and "--member=allUsers" in add[0] and "sprintable-backend-prod" in add[0], "only the public binding, only on the backend"
    assert not [c for c in calls if "sprintable-frontend-prod" in c], "the frontend is not touched"
    assert p.stdout.splitlines()[-2].endswith("Z"), "T2 is printed"


def test_8c_can_be_run_again_when_it_stopped_after_the_traffic_moved_and_before_the_binding(tmp_path: Path) -> None:
    p, calls, world = _e8(_fresh(tmp_path, "again"), mutate=lambda w: w.update(traffic=[{"revisionName": FWDREV, "percent": 100}, {"revisionName": FWDREV, "percent": 0, "tag": "fwd", "url": "https://fwd---x.run.app"}]))
    assert _last(p, "forwarder:") == "forwarder: proven" and world["invokers"][-1] == "allUsers", "the traffic is already on the forwarder and the service is closed: the block goes on"


def test_8c_refuses_what_it_was_not_asked_to_do(tmp_path: Path) -> None:
    # the freeze did not record a public binding for the backend: nothing is opened that was not open
    p, calls, _ = _e8(_fresh(tmp_path, "private"), files={WP: "sprintable-backend-prod\tuser:someone@example.com\nsprintable-mcp-prod\tallUsers\n"})
    assert _last(p, "forwarder:") == "forwarder: listed" and not _verbs(calls, "update-traffic") and not _verbs(calls, "add-iam-policy-binding")
    # somebody moved the traffic
    p, calls, _ = _e8(_fresh(tmp_path, "moved"), mutate=lambda w: w.update(traffic=[{"revisionName": "other", "percent": 100}]))
    assert _last(p, "forwarder:") == "forwarder: named" and not _verbs(calls, "update-traffic") and not _verbs(calls, "add-iam-policy-binding")
    # no record of the real revision, no record of the freeze, outside the window's folder
    p, calls, _ = _e8(_fresh(tmp_path, "norecord"), files={"real-revision-20261102.txt": ""})
    assert _last(p, "forwarder:") == "forwarder: no" and not _verbs(calls, "update-traffic")
    p, calls, _ = _e8(_fresh(tmp_path, "nowindow"), extra={"WINDOW": ""})
    assert _last(p, "forwarder:") == "forwarder: no" and not calls


def test_8c_does_not_open_when_the_service_is_not_closed_or_the_forwarder_does_not_answer_as_the_vm(tmp_path: Path) -> None:
    p, calls, _ = _e8(_fresh(tmp_path, "open"), mutate=lambda w: w["invokers"].append("allUsers"))
    assert _last(p, "forwarder:") == "forwarder: named" and not _verbs(calls, "update-traffic") and not _verbs(calls, "print-identity-token"), "a service that is public before 8c is a stop BEFORE the traffic moves (the freeze did not hold)"
    p, calls, world = _e8(_fresh(tmp_path, "other-build"), mutate=lambda w: w.update(api_sha="2" * 40))
    assert _last(p, "forwarder:") == "forwarder: closed" and "allUsers" not in world["invokers"], "the forwarder and the API name answer with different builds: not the same VM"
    p, calls, world = _e8(_fresh(tmp_path, "unknown2"), mutate=lambda w: w.update(vm_sha="unknown"))
    assert _last(p, "forwarder:") == "forwarder: closed" and "allUsers" not in world["invokers"] and not _verbs(calls, "add-iam-policy-binding"), "a VM that cannot say what it runs proves nothing"
    for name, mutate in (("vm-error", lambda w: w.update(vm_status="error")), ("vm-db-error", lambda w: w.update(vm_db="error: OperationalError")),
                         ("only-the-forwarder-answer-is-unhealthy", lambda w: w.update(fwd_authed_status="error")), ("only-the-api-answer-is-unhealthy", lambda w: w.update(api_status="error"))):
        p, calls, world = _e8(_fresh(tmp_path, name), mutate=mutate)
        assert _last(p, "forwarder:") == "forwarder: closed" and "allUsers" not in world["invokers"] and not _verbs(calls, "add-iam-policy-binding"), (name, "a VM that cannot work is not opened to the old address")
    for name, mutate in (("status", lambda w: w.update(fwd_public_status="error")), ("db", lambda w: w.update(fwd_public_db="error: OperationalError")), ("build", lambda w: w.update(fwd_public_sha="3" * 40))):
        p, calls, world = _e8(_fresh(tmp_path, "public-" + name), mutate=mutate)
        assert _last(p, "forwarder:") == "forwarder: opened", (name, "once opened, an answer that is not healthy and of the same build is not a proof (the undo is block 1 of step 12)")
    # the 403 that is read AFTER the traffic moved: a move that opens the service is a stop before the binding is added
    p, calls, world = _e8(_fresh(tmp_path, "opens-by-itself"), mutate=lambda w: w.update(open_on_switch=True))
    assert _last(p, "forwarder:") == "forwarder: switched" and not _verbs(calls, "print-identity-token") and not _verbs(calls, "add-iam-policy-binding"), "the traffic move must not have opened the service"
    p, calls, world = _e8(_fresh(tmp_path, "samerevision"), mutate=lambda w: w.update(vm_revision=REAL))
    assert _last(p, "forwarder:") == "forwarder: closed" and "allUsers" not in world["invokers"], "an answer with the real revision's name is the real backend, not the VM"
    p, calls, world = _e8(_fresh(tmp_path, "fail-add"), extra={"FAIL": "add-iam-policy-binding"})
    assert _last(p, "forwarder:") == "forwarder: answers" and "allUsers" not in world["invokers"]


# ── step 12, block 1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _b12(root: Path, opened: bool, shell: str = "bash", extra: dict | None = None, files: dict | None = None):
    work, world = _after_b(root)
    if opened:
        world["traffic"] = [{"revisionName": FWDREV, "percent": 100}, {"revisionName": FWDREV, "percent": 0, "tag": "fwd", "url": "https://fwd---x.run.app"}]
        world["invokers"].append("allUsers")
    env = _world_of(root)
    (root / "state" / "world.json").write_text(json.dumps(world))
    env.update(extra or {})
    for name, text in (files or {}).items():
        (work / name).write_text(text)
    open(env["CALLS"], "w").write("")
    block = _block_with('BACK=no\n[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s "real-revision-${WINDOW}.txt" ]')
    q = subprocess.run([shell, "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=work)
    return q, Path(env["CALLS"]).read_text().splitlines(), json.loads((root / "state" / "world.json").read_text())


@pytest.mark.parametrize("shell", SHELLS)
def test_the_way_back_closes_the_forwarder_before_it_gives_the_traffic_back_and_proves_the_real_revision_is_closed(tmp_path: Path, shell: str) -> None:
    p, calls, world = _b12(_fresh(tmp_path, "open"), True, shell)
    assert _last(p, "forwarder way back") == "forwarder way back: proven", p.stdout + p.stderr
    kinds = [("remove" if "remove-iam" in c else "traffic") for c in calls if "remove-iam" in c or "update-traffic" in c]
    assert kinds == ["remove", "traffic"], "the door is closed first, then the traffic goes back"
    assert "allUsers" not in world["invokers"] and [t["revisionName"] for t in world["traffic"] if t["percent"] > 0] == [REAL]


def test_the_way_back_from_a_move_that_never_opened_the_forwarder_removes_nothing(tmp_path: Path) -> None:
    p, calls, world = _b12(_fresh(tmp_path, "closed"), False)
    assert _last(p, "forwarder way back") == "forwarder way back: proven"
    assert not _verbs(calls, "remove-iam-policy-binding"), "removing a binding that is not there is an error in gcloud: it is not tried"


def test_the_way_back_stops_when_a_line_fails_and_the_machine_block_will_not_run_without_the_proof(tmp_path: Path) -> None:
    p, calls, world = _b12(_fresh(tmp_path, "rm-fails"), True, extra={"FAIL": "remove-iam-policy-binding"})
    assert _last(p, "forwarder way back") == "forwarder way back: read" and not _verbs(calls, "update-traffic"), "the traffic does not go back while the door is open"
    p, calls, world = _b12(_fresh(tmp_path, "traffic-fails"), True, extra={"FAIL": "update-traffic"})
    assert _last(p, "forwarder way back") == "forwarder way back: closed"
    p, calls, world = _b12(_fresh(tmp_path, "still-public"), True, extra={"STICKY": "allUsers"})
    assert _last(p, "forwarder way back") == "forwarder way back: real" and "proven" not in p.stdout, "a service that still answers from outside is not a way back that is proven"
    p, calls, world = _b12(_fresh(tmp_path, "empty-policy"), True, extra={"EMPTY_POLICY": "1"})
    assert _last(p, "forwarder way back") == "forwarder way back: listed" and not _verbs(calls, "update-traffic") and not _verbs(calls, "remove-iam-policy-binding"), "an unreadable policy is never read as «no allUsers»: the traffic does not move while the door may be open"
    assert "allUsers" in world["invokers"]
    p, calls, world = _b12(_fresh(tmp_path, "norecord"), True, files={"real-revision-20261102.txt": ""})
    assert _last(p, "forwarder way back") == "forwarder way back: no" and not calls
    # the last block of the way back asks for REALBACK as it asks for VMBACK
    vm_chain = _block_with("[ \"$REALBACK\" = proven ] && sudo docker ps -a")
    root = _fresh(tmp_path, "vm")
    env = _world(root)
    env["REALBACK"] = ""
    q = subprocess.run(["bash", "-c", vm_chain], capture_output=True, text=True, timeout=60, env=env, cwd=root)
    assert "vm way back: no" in q.stdout and not [c for c in Path(env["CALLS"]).read_text().splitlines() if c.startswith("sudo")], "without the proof of block 1 the pass-through to the old address is not started"
    machine = M12()
    assert '[ "$VMBACK" = passing ] && [ "$REALBACK" = proven ]' in machine
    root = _fresh(tmp_path, "m")
    env = _world_of(root)
    env.update({"VMBACK": "passing", "REALBACK": ""})
    work = _w(root)
    work.mkdir(exist_ok=True)
    (work / WP).write_text("sprintable-backend-prod\tallUsers\n")
    q = subprocess.run(["bash", "-c", machine], capture_output=True, text=True, timeout=60, env=env, cwd=work)
    assert "way back: no" in q.stdout and not _verbs(Path(env["CALLS"]).read_text().splitlines(), "add-iam-policy-binding"), "without the proof of block 1 nothing is reopened"


# ── Appendix A: the rehearsal ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_rehearsal_reads_prods_network_shape_makes_a_closed_service_and_stops_without_a_tag(tmp_path: Path) -> None:
    a1 = _block_with("REH=sprintable-rehearsal-forwarder\nNI=")
    p, calls, _, _ = _go(a1, _fresh(tmp_path, "a1"))
    deploy = _verbs(calls, "run deploy")[0].split()
    assert "network: default · subnet: default · tags: egress-tag" in p.stdout and deploy[3] == "sprintable-rehearsal-forwarder", p.stdout + p.stderr
    for flag, value in (("--network", "default"), ("--subnet", "default"), ("--network-tags", "egress-tag"), ("--image", "us-docker.pkg.dev/cloudrun/container/hello")):
        assert deploy[deploy.index(flag) + 1] == value, flag
    assert "--no-allow-unauthenticated" in deploy and "--allow-unauthenticated" not in deploy, "the throwaway is closed to everyone but the operator"
    assert not [c for c in calls if "sprintable-backend-prod" in c and any(w in c.split() for w in ("deploy", "update", "update-traffic", "delete"))], "prod is only read"
    # prod's attachment has no tags (what prod really has): the service is made without the tag flag
    notags = {"revisions": {REAL: _rev("x@y.iam.gserviceaccount.com", [], True, True, True, "direct", False)}}
    p, calls, world, _ = _go(a1, _fresh(tmp_path, "a1-notags"), state=notags)
    deploy = _verbs(calls, "run deploy")[0].split()
    assert "--network-tags" not in deploy and deploy[deploy.index("--network") + 1] == "default" and "--no-allow-unauthenticated" in deploy and world["reh_exists"] is True, p.stdout
    # no network shape at all: nothing is made, and it says why
    noting = {"revisions": {REAL: _rev("x@y.iam.gserviceaccount.com", [], True, True, False)}}
    p, calls, _, work = _go(a1, _fresh(tmp_path, "a1-none"), state=noting)
    assert not _verbs(calls, "run deploy") and "no network shape" in p.stdout and not (work / "rehearsal-id.txt").exists(), "no network shape, no throwaway, no id"
    # a service of that name exists already (an old rehearsal, or another service): it is left alone
    p, calls, world, _ = _go(a1, _fresh(tmp_path, "a1-exists"), state={"reh_exists": True, "reh_label": "something-else"})
    assert not _verbs(calls, "run deploy") and "exists already" in p.stdout and world["reh_label"] == "something-else"
    # any answer but «Cannot find service» (a transient error, a permission) is «could not tell»: nothing is made
    p, calls, world, _ = _go(a1, _fresh(tmp_path, "a1-error"), extra={"REH_ERR": "1"})
    assert not _verbs(calls, "run deploy") and "could not tell" in p.stdout and not world.get("reh_exists")
    # the throwaway carries a new id that is also written in the folder, and A4 asks for that id
    root = _fresh(tmp_path, "a1-label")
    _, _, world, work = _go(a1, root)
    rid = (work / "rehearsal-id.txt").read_text().strip()
    assert world["reh_exists"] is True and world["reh_label"] == rid and re.fullmatch(r"r\d{14}", rid), rid
    # the read of the network shape is of prod's backend (the fake answers for no other service: a read of $REH would print an empty shape)
    assert "network: · subnet: · tags:" not in p.stdout


def test_the_rehearsal_deletes_only_a_service_with_its_name(tmp_path: Path) -> None:
    a4 = _block_with("case \"$REH\" in sprintable-rehearsal-forwarder)")
    mine = {"rehearsal-id.txt": "r20261029120000\n"}
    p, calls, world, _ = _go(a4, _fresh(tmp_path, "ok"), extra={"REH": "sprintable-rehearsal-forwarder"}, state={"reh_exists": True, "reh_label": "r20261029120000"}, files=mine)
    assert _verbs(calls, "services delete") and "sprintable-rehearsal-forwarder" in _verbs(calls, "services delete")[0] and world["reh_exists"] is False
    cases = (("unlabelled", {"reh_exists": True, "reh_label": ""}, mine), ("other-label", {"reh_exists": True, "reh_label": "keep-me"}, mine), ("missing", {"reh_exists": False}, mine),
             ("same-static-label-another-service", {"reh_exists": True, "reh_label": "forwarder-4c"}, mine),
             ("no-id-file", {"reh_exists": True, "reh_label": "r20261029120000"}, {}), ("empty-id-file", {"reh_exists": True, "reh_label": ""}, {"rehearsal-id.txt": "\n"}))
    for name, state, files in cases:
        p, calls, world, _ = _go(a4, _fresh(tmp_path, "no-" + name), extra={"REH": "sprintable-rehearsal-forwarder"}, state=state, files=files)
        assert not _verbs(calls, "services delete") and "refused" in p.stdout, name
    for name in ("sprintable-backend-prod", "", "sprintable-rehearsal-forwarder-x"):
        p, calls, _, _ = _go(a4, _fresh(tmp_path, "no-" + (name or "empty")), extra={"REH": name})
        assert not _verbs(calls, "services delete") and "refused" in p.stdout, name


def test_the_rehearsal_measures_the_header_and_lists_what_the_revision_keeps() -> None:
    app = SHEET.split("## Appendix A.")[1]
    for token in ("**A1.", "**A2.", "**A3.", "**A4.", "`forwarder: noroles`", "X-Serverless-Authorization", "`run.googleapis.com/network-interfaces`", "(`WINDOW=rehearsal`)", "`FWD_AR` set by hand"):
        assert token in app, token
    assert "does not clear it" in SHEET and "Direct VPC attachment" in SHEET
    assert "run.googleapis.com/cloudsql-instances` is absent **or has an empty value**" in SHEET and "(without tags the deploy has no `--network-tags`" in SHEET
    assert "**From 4c to step 8 nothing may be pushed to `main`.**" in SHEET
    assert "gcloud has no «create only if absent»" in SHEET, "the check-then-act of the rehearsal is a written limit"
    assert "there is no fallback to `Authorization`" in SHEET and "is a **stop**: 8c is not run with the token in `Authorization`" in SHEET, "a token that is not meant for the VM must not be sent to it"
    assert "the header is `Authorization`" not in SHEET


# ── the text, and the pipeline premise ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_text_says_the_order_the_loop_and_what_the_forwarder_holds() -> None:
    four = _section("## 4c. The forwarder of the old address", "## 5. Freeze")
    for token in ("A client that still names the old address", "holds nothing", "runs as an account with **no role**", "**minimum 0 instances**", "`--no-traffic` pins the traffic", "`forwarder: ready` is the pass, and **step 5 does not start without it**", "tag → forwarder → `api.sprintable.ai`",
                  "arm image that Cloud Run cannot start", "**Undo of the whole step:**", "**The mark against a loop.**", "`X-Sprintable-Forwarded`"):
        assert token in four, token
    twelve = _section("## 12. The way back", "## Known limits")
    for token in ("**The order is the point:**", "the two would hand the request to each other for ever", "close the forwarder, give the traffic back to the real revision", "`REALBACK` to `proven`", "type `REALBACK=proven` in the ssh shell"):
        assert token in twelve, token
    assert twelve.index("**1. From the product owner's machine") < twelve.index("**2. On the VM**") < twelve.index("**3. From the product owner's machine again**")
    eight = _section("## 8. Unfreeze", "## 9. The lap")
    for token in ("**The serving-reality guard knows about this (declared, not forgotten).**", "there is no schedule since story 4659", "**the line is not removed after 8c**", "until 2026-11-27", "a day to judge again, not a day to delete", "`update-traffic --to-latest`, is an accident here", "answer 508", "traffic to the real revision **by name**",
                  "**8c. The forwarder takes the old address", "T0 to **T2**", "the public binding the freeze recorded for the backend, and no other member", "The Cloud Run **frontend** is not touched"):
        assert token in eight, token
    g = _section("## G. Gates", "## 0. Read-only")
    assert "**the old address is not a gate**" in g and "no unexplained caller" not in g
    ten = _section("## 10–11. The day after", "## 12. The way back")
    for token in ("**The old address, counted — the criterion for removing it.**", "**not** a 401", "**7 days in a row**", "**The registry:**", "`real-image`"):
        assert token in ten, token
    assert "5. **How many days**" in SHEET and "6. Callers of the old address count as one address" in SHEET
    assert "**P3 is also what keeps the forwarder in place:**" in SHEET


def test_the_lap_and_the_day_after_blocks_only_read(tmp_path: Path) -> None:
    for i, marker in enumerate(("AND httpRequest.status>=500\" --project", "AND NOT httpRequest.status=401")):
        root = _fresh(tmp_path, f"ro{i}")
        env = _world_of(root)
        work = _w(root)
        work.mkdir(exist_ok=True)
        (work / "real-revision-20261102.txt").write_text(RECORD)
        block = _block_with(marker)
        p = subprocess.run(["bash", "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=work)
        calls = Path(env["CALLS"]).read_text().splitlines()
        assert p.returncode == 0 and len([c for c in calls if "logging read" in c]) == 2, (marker, p.stderr)
        assert all(FWDREV in c for c in calls if "logging read" in c), "the forwarder revision of the record, not the whole service"
        assert not [c for c in calls if any(w in c.split() for w in ("deploy", "update-traffic", "add-iam-policy-binding", "remove-iam-policy-binding"))]


def test_with_the_skip_on_the_deploy_backend_step_never_calls_gcloud_so_a_prod_build_cannot_put_the_real_backend_over_the_forwarder(tmp_path: Path) -> None:
    build = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
    steps = {s["id"]: s for s in build["steps"] if "id" in s}
    script = steps["deploy-backend"]["args"][-1]
    first = [l for l in script.splitlines() if l.strip() and not l.strip().startswith("#")][:2]
    assert first[0].strip() == "set -euo pipefail" and first[1].strip().startswith('[ "${_CLOUD_RUN_APP_SKIP}" = "true" ] && {') and "exit 0" in first[1], "the skip is the first thing the step does"
    # the only place that makes a revision of the prod backend service is this step
    text = (_ROOT / "cloudbuild.yaml").read_text()
    import re
    assert len(re.findall(r"gcloud run deploy sprintable-backend-\$\{_DEPLOY_ENV\}", text)) == 1 and "update-traffic" not in text and "run services update-traffic" not in text
    # and run as it is, with the skip on, it calls nothing
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    calls = tmp_path / "calls"
    calls.write_text("")
    for tool in ("gcloud", "docker", "curl", "git"):
        f = bin_ / tool
        f.write_text(f'#!/bin/sh\necho "{tool} $*" >> "{calls}"\n')
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "_CLOUD_RUN_APP_SKIP": "true", "HOME": str(tmp_path)}
    p = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30, env=env)
    assert p.returncode == 0 and "skip deploy-backend" in p.stdout and calls.read_text() == "", (p.stdout, p.stderr)


def test_the_workflow_premise_prod_states_no_skip_today_so_p3_is_what_turns_it_on() -> None:
    wf = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    assert wf.count('echo "cloud_run_app_skip=true"') == 1, "only the dev branch writes it today; the prod line is P3, merged right after step 8"
