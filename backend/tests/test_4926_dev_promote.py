"""story 4926 — the dev rollout's last step (desired.json of the dev deploy bucket := the built sha) is done by GitHub Actions, not by a person's gcloud login.

deploy/vm/bin/promote_dev.py is run here against a fake bucket, a fake GitHub (CI runs · git relations) and a fake clock. Pinned:
  gate    — written only when THIS sha's own develop CI is green AND its candidate (and bundle) is there; failed / cancelled / unfinished / absent CI, or no candidate → nothing written
  order   — only a sha that is git-AHEAD of the wanted one replaces it (older · unrelated · unknown → nothing written); the same sha → nothing to do
  writes  — the write is generation-checked: somebody else's write in between is never overwritten (read again, decided again)
  grant   — a missing permission stops in the preflight, before any waiting, and says which commands grant it
  serving — red when the VM does not come up on the sha
  scope   — dev bucket only, by constant, IAM-independent code guards: refuses another ref / bucket before any tool runs; the workflow files point at nothing else (static)
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_BIN = _ROOT / "deploy/vm/bin"
sys.path.insert(0, str(_BIN))
_spec = importlib.util.spec_from_file_location("promote_dev", _BIN / "promote_dev.py")
P = importlib.util.module_from_spec(_spec)
sys.modules["promote_dev"] = P
assert _spec.loader is not None
_spec.loader.exec_module(P)

SHA = "a" * 40
OLD = "b" * 40
NEWER = "c" * 40
DIGEST = "sha256:" + "d" * 64
PREFIX = "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable"


def desired(sha: str) -> bytes:
    return (json.dumps({"sha": sha, "backend_image": f"{PREFIX}/backend@{DIGEST}", "frontend_image": f"{PREFIX}/frontend-vm@{DIGEST}",
                        "bundle": f"bundles/{sha}.tgz", "bundle_sha256": "e" * 64}, indent=2, sort_keys=True) + "\n").encode()


class Clock:
    def __init__(self) -> None:
        self.t = 0.0
        self.naps = 0

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s
        self.naps += 1


class FakeGcs:
    bucket = P.DEV_BUCKET

    def __init__(self, *, candidate=True, bundle=True, current: str | None = OLD, read=("storage.objects.get", "storage.objects.list"),
                 write=("storage.objects.create", "storage.objects.delete")) -> None:
        self.objs: dict[str, bytes] = {}
        self.gens: dict[str, int] = {}
        self.versions: dict[tuple[str, int], bytes] = {}   # every generation ever written stays readable by its number (a real bucket drops old ones: reading one then fails, which the code handles)
        self.after_generation = None   # hooks: somebody else writes right after this call returned (once)
        self.after_read = None
        self.probed = 0
        self.writes: list[tuple[str, int]] = []
        self.read_perms, self.write_perms = set(read), (set(write) if write is not None else None)
        self.asked: list[tuple] = []
        self.before_write = None  # a hook: somebody else writes just before our write
        self.candidate_appears_after = 0.0
        self.clock: Clock | None = None
        if candidate:
            self.put(f"candidates/{SHA}.json", desired(SHA))
        if bundle:
            self.put(f"bundles/{SHA}.tgz", b"x")
        if current:
            self.put("desired.json", desired(current))

    def put(self, name: str, data: bytes) -> None:
        self.objs[name] = data
        self.gens[name] = self.gens.get(name, 0) + 1
        self.versions[(name, self.gens[name])] = data

    def permissions(self, perms):
        self.asked.append(tuple(perms))
        return {p for p in perms if p in self.read_perms}

    def write_probe(self):
        self.probed += 1
        if self.write_perms is None:
            return None
        return set(P.WRITE_NEEDED) <= self.write_perms

    def exists(self, name: str) -> bool:
        if name == f"candidates/{SHA}.json" and self.clock and self.clock.t < self.candidate_appears_after:
            return False
        return name in self.objs

    def read(self, name: str, generation=None):
        data = self.objs.get(name) if generation is None else self.versions.get((name, generation))
        if name == "desired.json" and self.after_read:
            hook, self.after_read = self.after_read, None
            hook(self)
        return data

    def generation(self, name: str):
        g = self.gens.get(name)
        if name == "desired.json" and self.after_generation:
            hook, self.after_generation = self.after_generation, None
            hook(self)
        return g

    def write_desired(self, data: bytes, generation: int) -> None:
        if self.before_write:
            hook, self.before_write = self.before_write, None
            hook(self)
        if generation != self.gens.get("desired.json", 0):
            raise P.PreconditionFailed("412")
        self.writes.append(("desired.json", generation))
        self.put("desired.json", data)


class FakeCi:
    def __init__(self, states=(("completed", "success"),), relations=None) -> None:
        self.states = list(states)
        self.relations = relations if relations is not None else {(OLD, SHA): "ahead"}
        self.calls = 0

    def develop_ci(self, sha: str):
        self.calls += 1
        s = self.states[min(self.calls - 1, len(self.states) - 1)]
        return s

    def relation(self, base: str, head: str) -> str:
        return self.relations.get((base, head), "unknown")


def run(gcs, ci, *, health_sha=SHA, sha=SHA, clock=None):
    clock = clock or Clock()
    gcs.clock = clock
    logs: list[str] = []
    try:
        code = P.promote(sha, gcs, ci, health=lambda url: health_sha, sleep=clock.sleep, now=clock.now, log=logs.append)
    except P.Stop as e:
        code = e.code
        logs.append("STOP: " + str(e))
    return code, logs, clock


def current(gcs) -> str:
    return json.loads(gcs.objs["desired.json"])["sha"]


# ─────────────────────────────── gate ───────────────────────────────

def test_a_green_ci_and_a_candidate_write_desired_json_with_the_candidates_own_bytes_and_wait_for_serving() -> None:
    g = FakeGcs()
    code, logs, _ = run(g, FakeCi())
    assert code == 0, logs
    assert g.objs["desired.json"] == desired(SHA) and len(g.writes) == 1
    assert any("PROMOTED OK" in l for l in logs)


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "timed_out", "skipped", "action_required", None])
def test_a_develop_ci_that_finished_without_success_writes_nothing(conclusion) -> None:
    g = FakeGcs()
    code, logs, _ = run(g, FakeCi([("completed", conclusion)]))
    assert code == 1 and not g.writes and current(g) == OLD, logs
    assert any("NOT promoting" in l for l in logs)


def test_a_failed_ci_stops_at_once_even_while_the_candidate_is_still_missing() -> None:
    g = FakeGcs(candidate=False)
    code, logs, clock = run(g, FakeCi([("completed", "failure")]))
    assert code == 1 and not g.writes and clock.naps == 0, "no point waiting for a candidate of a red sha"


def test_a_ci_that_is_still_running_is_waited_for_and_then_judged() -> None:
    g = FakeGcs()
    code, logs, clock = run(g, FakeCi([("in_progress", None)] * 5 + [("completed", "success")]))
    assert code == 0 and clock.naps >= 5 and len(g.writes) == 1


def test_a_ci_that_is_still_running_after_an_hour_writes_nothing() -> None:
    g = FakeGcs()
    code, logs, clock = run(g, FakeCi([("in_progress", None)]))
    assert code == 1 and not g.writes and clock.t >= P.CI_WAIT_SEC
    assert any("did not finish" in l for l in logs)


def test_a_sha_without_any_develop_ci_run_is_waited_for_then_refused() -> None:
    g = FakeGcs()

    class NoRun(FakeCi):
        def develop_ci(self, sha):
            return None

    code, logs, clock = run(g, NoRun())
    assert code == 1 and not g.writes and clock.t >= P.CI_WAIT_SEC


def test_no_candidate_after_forty_minutes_writes_nothing() -> None:
    g = FakeGcs(candidate=False)
    code, logs, clock = run(g, FakeCi())
    assert code == 1 and not g.writes and clock.t >= P.CANDIDATE_WAIT_SEC
    assert any("NO CANDIDATE" in l for l in logs)


def test_a_candidate_that_appears_later_is_picked_up() -> None:
    g = FakeGcs()
    g.candidate_appears_after = 600
    code, logs, clock = run(g, FakeCi())
    assert code == 0 and clock.t >= 600 and len(g.writes) == 1


def test_a_candidate_that_names_another_sha_is_refused() -> None:
    g = FakeGcs()
    g.put(f"candidates/{SHA}.json", desired(NEWER))
    code, logs, _ = run(g, FakeCi())
    assert code == 1 and not g.writes and any("names sha" in l for l in logs)


def test_a_candidate_whose_bundle_is_missing_is_refused() -> None:
    g = FakeGcs(bundle=False)
    code, logs, _ = run(g, FakeCi())
    assert code == 1 and not g.writes and any("bundle" in l for l in logs)


def test_a_candidate_that_is_not_a_valid_desired_json_is_refused() -> None:
    g = FakeGcs()
    g.put(f"candidates/{SHA}.json", b'{"sha": "' + SHA.encode() + b'"}')
    code, logs, _ = run(g, FakeCi())
    assert code == 1 and not g.writes


# ─────────────────────────────── order ───────────────────────────────

@pytest.mark.parametrize("relation", ["behind", "diverged", "unknown", "identical"])
def test_only_a_sha_that_is_ahead_of_the_wanted_one_replaces_it(relation) -> None:
    g = FakeGcs()
    code, logs, _ = run(g, FakeCi(relations={(OLD, SHA): relation}))
    assert code == 1 and not g.writes and current(g) == OLD, logs
    assert any("not newer" in l for l in logs)


def test_the_sha_that_is_already_wanted_is_nothing_to_write() -> None:
    g = FakeGcs(current=SHA)
    code, logs, _ = run(g, FakeCi())
    assert code == 0 and not g.writes and any("already" in l for l in logs)


def test_a_bucket_without_any_desired_json_gets_one_with_a_must_not_exist_condition() -> None:
    g = FakeGcs(current=None)
    code, logs, _ = run(g, FakeCi())
    assert code == 0 and g.writes == [("desired.json", 0)]


def test_a_desired_json_nobody_can_read_is_left_for_a_person() -> None:
    g = FakeGcs()
    g.put("desired.json", b"not json")
    code, logs, _ = run(g, FakeCi())
    assert code == 1 and not g.writes and any("not readable" in l for l in logs)


# ─────────────────────────────── writes ───────────────────────────────

def test_somebody_elses_write_in_between_is_not_overwritten_and_the_order_is_judged_again() -> None:
    g = FakeGcs()
    g.before_write = lambda gg: gg.put("desired.json", desired(NEWER))  # the laptop script promoted a newer sha meanwhile
    code, logs, _ = run(g, FakeCi(relations={(OLD, SHA): "ahead", (NEWER, SHA): "behind"}))
    assert code == 1 and not g.writes and current(g) == NEWER, "the newer write stays"
    assert any("changed under us" in l for l in logs)


def test_if_the_other_write_is_older_than_ours_it_is_replaced_on_the_second_try() -> None:
    g = FakeGcs()
    mid = "9" * 40
    g.before_write = lambda gg: gg.put("desired.json", desired(mid))
    code, logs, _ = run(g, FakeCi(relations={(OLD, SHA): "ahead", (mid, SHA): "ahead"}))
    assert code == 0 and current(g) == SHA and len(g.writes) == 1


def test_a_newer_write_right_after_the_generation_was_read_is_not_overwritten() -> None:
    g = FakeGcs()
    g.after_generation = lambda gg: gg.put("desired.json", desired(NEWER))
    code, logs, _ = run(g, FakeCi(relations={(OLD, SHA): "ahead", (NEWER, SHA): "behind"}))
    assert code == 1 and not g.writes and current(g) == NEWER, logs


def test_a_newer_write_right_after_the_bytes_were_read_is_not_overwritten() -> None:
    """the flaw codex found: bytes read first, generation read second — the generation of the NEWER write would have been used for the older bytes' decision. The bytes are now those of the generation read first."""
    g = FakeGcs()
    g.after_read = lambda gg: gg.put("desired.json", desired(NEWER))
    code, logs, _ = run(g, FakeCi(relations={(OLD, SHA): "ahead", (NEWER, SHA): "behind"}))
    assert code == 1 and not g.writes and current(g) == NEWER, logs
    assert any("changed under us" in l for l in logs)


def test_a_generation_that_is_gone_when_its_bytes_are_asked_for_is_read_again() -> None:
    g = FakeGcs()
    real_read = g.read

    def gone_once(name, generation=None):
        if name == "desired.json" and generation is not None and not getattr(gone_once, "done", False):
            gone_once.done = True
            g.put("desired.json", desired(OLD))   # somebody replaced it: the old generation no longer exists
            return None
        return real_read(name, generation)

    g.read = gone_once
    code, logs, _ = run(g, FakeCi())
    assert code == 0 and len(g.writes) == 1 and any("changed under us" in l for l in logs)


def test_a_desired_json_that_keeps_changing_stops_after_three_tries() -> None:
    g = FakeGcs()

    def churn(gg):
        gg.put("desired.json", desired(OLD))
        gg.before_write = churn

    g.before_write = churn
    code, logs, _ = run(g, FakeCi())
    assert code == 1 and not g.writes and any("kept changing" in l for l in logs)


# ─────────────────────────────── grant ───────────────────────────────

@pytest.mark.parametrize("read,write,missing", [
    (("storage.objects.list",), ("storage.objects.create", "storage.objects.delete"), "storage.objects.get"),
    (("storage.objects.get", "storage.objects.list"), ("storage.objects.create",), "storage.objects.create (on desired.json)"),
    (("storage.objects.get", "storage.objects.list"), (), "storage.objects.delete (on desired.json)"),
])
def test_a_missing_permission_stops_before_any_waiting_and_names_the_commands_that_grant_it(read, write, missing) -> None:
    g = FakeGcs(read=read, write=write)
    ci = FakeCi([("in_progress", None)])
    code, logs, clock = run(g, ci)
    assert code == 1 and not g.writes and clock.naps == 0 and ci.calls == 0, "the preflight comes before the wait"
    text = "\n".join(logs)
    assert missing in text and "add-iam-policy-binding" in text and "objectUser" in text and "desired.json" in text


def test_the_write_grant_is_probed_by_a_write_that_cannot_succeed_and_the_bucket_is_asked_about_reading_only() -> None:
    g = FakeGcs()
    run(g, FakeCi())
    assert g.probed == 1 and g.asked == [P.READ_NEEDED]


def test_when_the_write_probe_cannot_tell_the_run_goes_on_and_the_write_decides() -> None:
    g = FakeGcs(write=None)
    code, logs, _ = run(g, FakeCi())
    assert code == 0 and len(g.writes) == 1 and any("could not be probed" in l for l in logs)


def _real_gcs_with_fake_gcloud(tmp_path, stderr: str, rc: int = 1):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    t = bin_dir / "gcloud"
    t.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path}/calls.txt"\necho "{stderr}" >&2\nexit {rc}\n')
    t.chmod(0o755)
    return bin_dir


@pytest.mark.parametrize("stderr,expected", [
    ("HTTPError 412: At least one of the pre-conditions you specified did not hold.", True),
    ("ERROR: Gaxios conditionNotMet", True),
    ("HTTPError 403: github-actions@x does not have storage.objects.create access", False),
    ("AccessDenied: 403 Forbidden", False),
    ("ERROR: network unreachable", None),
])
def test_the_real_write_probe_reads_412_as_allowed_403_as_not_allowed_and_anything_else_as_unknown(tmp_path, monkeypatch, stderr, expected) -> None:
    monkeypatch.setenv("PATH", f"{_real_gcs_with_fake_gcloud(tmp_path, stderr)}:/usr/bin:/bin")
    assert P.Gcs().write_probe() is expected
    call = (tmp_path / "calls.txt").read_text()
    assert f"--if-generation-match={P.IMPOSSIBLE_GENERATION}" in call and "gs://sprintable-vm-dev-deploy/desired.json" in call


def test_a_write_probe_that_is_accepted_stops_the_run(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PATH", f"{_real_gcs_with_fake_gcloud(tmp_path, '', rc=0)}:/usr/bin:/bin")
    with pytest.raises(P.Stop):
        P.Gcs().write_probe()


def test_the_real_generation_read_tells_an_absent_object_from_a_failure(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PATH", f"{_real_gcs_with_fake_gcloud(tmp_path, 'ERROR: (gcloud.storage.objects.describe) The following URLs matched no objects: gs://b/desired.json')}:/usr/bin:/bin")
    assert P.Gcs().generation("desired.json") is None
    monkeypatch.setenv("PATH", f"{_real_gcs_with_fake_gcloud(tmp_path, 'ERROR: HTTPError 500 backend error')}:/usr/bin:/bin")
    with pytest.raises(P.Stop):
        P.Gcs().generation("desired.json")


def test_the_real_read_of_a_generation_asks_for_that_generation_only(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PATH", f"{_real_gcs_with_fake_gcloud(tmp_path, '', rc=0)}:/usr/bin:/bin")
    P.Gcs().read("desired.json", 1731542400000000)
    assert "gs://sprintable-vm-dev-deploy/desired.json#1731542400000000" in (tmp_path / "calls.txt").read_text()


def test_the_grant_text_touches_the_dev_bucket_only_and_one_object() -> None:
    text = P.GRANT_HELP
    assert text.count("gs://sprintable-vm-dev-deploy") == 2 and "prod" not in text.lower()
    assert '--condition=\'expression=resource.name=="projects/_/buckets/sprintable-vm-dev-deploy/objects/desired.json",title=dev-desired-json-only\'' in text


# ─────────────────────────────── serving ───────────────────────────────

def test_a_vm_that_does_not_come_up_on_the_sha_is_red_after_twelve_minutes() -> None:
    g = FakeGcs()
    code, logs, clock = run(g, FakeCi(), health_sha=OLD)
    assert code == 1 and len(g.writes) == 1 and clock.t >= P.SERVING_WAIT_SEC
    assert any("look at the VM deployer" in l for l in logs)


# ─────────────────────────────── scope: refused before any tool ───────────────────────────────

def _fake_tools(tmp_path: Path) -> tuple[Path, Path]:
    bin_dir, calls = tmp_path / "bin", tmp_path / "calls.txt"
    bin_dir.mkdir()
    for tool in ("gcloud", "gh", "curl"):
        t = bin_dir / tool
        t.write_text(f'#!/bin/sh\necho "{tool} $@" >> "{calls}"\nexit 1\n')
        t.chmod(0o755)
    return bin_dir, calls


@pytest.mark.parametrize("ref", ["refs/heads/main", "refs/heads/damrong/x", "refs/pull/1/merge", ""])
def test_inside_actions_any_ref_but_develop_is_refused_before_a_tool_runs(tmp_path, ref) -> None:
    bin_dir, calls = _fake_tools(tmp_path)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "GITHUB_ACTIONS": "true", "GITHUB_REF": ref}
    r = subprocess.run([sys.executable, "-I", str(_BIN / "promote_dev.py"), "--sha", SHA], capture_output=True, text=True, env=env, timeout=30)
    assert r.returncode == 2 and "refused" in r.stderr, r.stderr
    assert not calls.exists(), calls.read_text() if calls.exists() else ""


def test_a_sha_that_is_not_a_full_sha_is_refused_before_a_tool_runs(tmp_path) -> None:
    bin_dir, calls = _fake_tools(tmp_path)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/develop"}
    for bad in ("abc1234", "../x", SHA.upper(), SHA + "0"):
        r = subprocess.run([sys.executable, "-I", str(_BIN / "promote_dev.py"), "--sha", bad], capture_output=True, text=True, env=env, timeout=30)
        assert r.returncode == 2, (bad, r.stderr)
    assert not calls.exists()


def test_another_bucket_is_refused_even_if_code_were_changed_to_pass_one() -> None:
    g = FakeGcs()
    g.bucket = "some-other-bucket"
    code, logs, _ = run(g, FakeCi())
    assert code == 2 and not g.writes and not g.asked


# ─────────────────────────────── scope: static (the files) ───────────────────────────────

_WF = _ROOT / ".github/workflows"
_SCRIPT = (_BIN / "promote_dev.py").read_text()
_PROMOTE_WF = (_WF / "dev-promote.yml").read_text()
_CB = yaml.safe_load((_WF / "cloud-build.yml").read_text())


def test_neither_the_script_nor_its_workflow_names_anything_but_the_dev_bucket() -> None:
    for name, text in (("promote_dev.py", _SCRIPT), ("dev-promote.yml", _PROMOTE_WF)):
        assert "prod" not in text.lower(), f"{name} must not mention the production side at all"
    assert len(re.findall(r"sprintable-vm-[a-z]+-deploy", _SCRIPT)) == len(re.findall(r"sprintable-vm-dev-deploy", _SCRIPT)), "the only deploy bucket named is the dev one"
    assert _SCRIPT.count('DEV_BUCKET = "sprintable-vm-dev-deploy"') == 1
    assert "--bucket" not in _SCRIPT and "--bucket" not in _PROMOTE_WF and "gs://" not in _PROMOTE_WF, "no argument or path of a bucket comes from outside"


def test_the_script_writes_exactly_one_object_desired_json_and_only_with_a_generation_condition() -> None:
    writes = re.findall(r'"cp"[^\n]*', _SCRIPT)
    assert len(writes) == 2, writes   # the probe (a generation no object has: it cannot write) and the real write
    for w in writes:
        assert "gs://{self.bucket}/desired.json" in w and "--if-generation-match=" in w, w
    assert "IMPOSSIBLE_GENERATION" in writes[0] and "{generation}" in writes[1]
    assert not re.search(r'"(rm|mv|rsync|compose)"|storage", "(rm|mv|rsync)"', _SCRIPT)


def test_only_a_run_on_develop_reaches_the_promotion_and_main_never_does() -> None:
    job = _CB["jobs"]["promote-dev"]
    assert job["if"] == "github.ref == 'refs/heads/develop'" and job["needs"] == "cloud-build"
    assert job["uses"] == "./.github/workflows/dev-promote.yml" and job["with"] == {"sha": "${{ github.sha }}"}
    wf = yaml.safe_load(_PROMOTE_WF)
    assert wf[True]["workflow_call"]["inputs"]["sha"]["required"] is True and "workflow_dispatch" not in wf[True] and "push" not in wf[True] and "schedule" not in wf[True]
    assert wf["jobs"]["promote"]["if"] == "github.ref == 'refs/heads/develop'"


def test_no_other_workflow_runs_the_script_and_the_build_job_is_untouched() -> None:
    for f in _WF.glob("*.yml"):
        if f.name != "dev-promote.yml":
            assert "promote_dev" not in f.read_text(), f.name
    assert _CB["jobs"]["serving-reality"]["needs"] == "cloud-build"
    assert _CB["jobs"]["cloud-build"]["timeout-minutes"] == 30


def test_the_workflow_has_the_permissions_it_needs_and_no_more_and_one_promotion_runs_at_a_time() -> None:
    wf = yaml.safe_load(_PROMOTE_WF)
    assert wf["permissions"] == {"contents": "read", "actions": "read", "id-token": "write"}
    assert wf["concurrency"] == {"group": "dev-promote", "cancel-in-progress": False}
    assert wf["jobs"]["promote"]["timeout-minutes"] >= 85
    assert _CB["jobs"]["promote-dev"]["permissions"] == {"contents": "read", "actions": "read", "id-token": "write"}
    run = [s for s in wf["jobs"]["promote"]["steps"] if s.get("name") == "Promote"][0]
    assert run["env"]["PROMOTE_SHA"] == "${{ inputs.sha }}" and "${{" not in run["run"], "the input goes through an env var, never into the command text"


def test_the_wait_limits_and_the_job_limit_fit_together() -> None:
    wf = yaml.safe_load(_PROMOTE_WF)
    worst = (P.CI_WAIT_SEC + P.SERVING_WAIT_SEC) / 60  # the candidate wait overlaps the CI wait
    assert worst + 5 <= wf["jobs"]["promote"]["timeout-minutes"]
