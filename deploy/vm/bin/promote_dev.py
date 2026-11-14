#!/usr/bin/env python3
"""Promotes one DEV build to «the version the dev VM runs» — the last step of a dev rollout, run by GitHub Actions instead of a person's laptop (story 4926).

What it does, in order (stops at the first thing that is not right; nothing is written before the last two steps):
  1. refuses to start unless the bucket is the dev deploy bucket and (inside Actions) the ref is develop — before any tool runs
  2. asks the bucket what this service account may do (testIamPermissions — writes nothing); missing permission = stop NOW, with the commands that grant it
  3. waits for candidates/<sha>.json (+ the bundle it names) AND for THIS sha's own develop CI — a green run of the workflow «CI» on a push to develop
     with exactly this head sha. A failed / cancelled CI stops at once, no write. (The gate the PO's laptop script used, unchanged.)
  4. reads the version now wanted (desired.json + its generation); the candidate must be NEWER than it (git: «ahead») — an older or unrelated sha never replaces a newer one
  5. writes desired.json from the candidate's bytes with `--if-generation-match=<generation read in 4>`: if anyone else (the laptop script, a hand copy) wrote in between, nothing is overwritten —
     it reads again and decides again (3 tries)
  6. waits (≤ 12 min) for the dev web and API to answer with this sha — red if they do not

The deploy bucket is a constant of this file. The only object it ever writes is `desired.json` of that bucket; there is no argument that makes it write elsewhere.
Exit 0 = promoted (or already the wanted version) · 1 = stopped, nothing (more) written · 2 = refused to start.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deployer import DeployError, validate_desired  # noqa: E402

DEV_BUCKET = "sprintable-vm-dev-deploy"
REPO = "moonklabs/sprintable"
PROJECT_FALLBACK = "sprintable-494803"
WEB_HEALTH = "https://dev-app.sprintable.ai/api/health"
API_HEALTH = "https://dev-api.sprintable.ai/api/v2/health"
CANDIDATE_WAIT_SEC = 40 * 60
CI_WAIT_SEC = 60 * 60
SERVING_WAIT_SEC = 12 * 60
POLL_SEC = 30
SERVING_POLL_SEC = 10
CAS_TRIES = 3
READ_NEEDED = ("storage.objects.get", "storage.objects.list")
# the write grant is CONDITIONAL on the object name (desired.json only): a bucket-level testIamPermissions says «no» for it by design, so the write is probed by a write that cannot succeed (see Gcs.write_probe)
WRITE_NEEDED = ("storage.objects.create", "storage.objects.delete")
IMPOSSIBLE_GENERATION = 1   # object generations are microsecond timestamps (~1.7e15): nothing ever has generation 1
SERVICE_ACCOUNT = "github-actions@sprintable-494803.iam.gserviceaccount.com"
SHA_RE = re.compile(r"[0-9a-f]{40}")
CI_RUNNING = {"queued", "in_progress", "waiting", "pending", "requested"}

GRANT_HELP = (
    "grant (a person with IAM rights, once; the bucket's policy gets a conditional binding, so its version becomes 3 — the four existing bindings stay as they are):\n"
    f"  gcloud storage buckets add-iam-policy-binding gs://{DEV_BUCKET} --member=serviceAccount:{SERVICE_ACCOUNT} --role=roles/storage.objectViewer\n"
    f"  gcloud storage buckets add-iam-policy-binding gs://{DEV_BUCKET} --member=serviceAccount:{SERVICE_ACCOUNT} --role=roles/storage.objectUser "
    f"--condition='expression=resource.name==\"projects/_/buckets/{DEV_BUCKET}/objects/desired.json\",title=dev-desired-json-only'"
)


class PreconditionFailed(Exception):
    """somebody else wrote desired.json after we read its generation"""


class Stop(Exception):
    def __init__(self, msg: str, code: int = 1):
        super().__init__(msg)
        self.code = code


# ───────────────────────────── the real world (replaced by fakes in the tests) ─────────────────────────────

class Gcs:
    def __init__(self, bucket: str = DEV_BUCKET):
        self.bucket = bucket

    def _run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["gcloud", *args], capture_output=True, text=True, timeout=120)

    def permissions(self, perms: tuple[str, ...]) -> set[str]:
        """what this service account holds on the BUCKET (unconditional grants only). Nothing is written."""
        tok = self._run("auth", "print-access-token")
        if tok.returncode != 0:
            raise Stop("cannot get an access token (is the workflow authenticated?): " + tok.stderr.strip()[-300:])
        q = "&".join("permissions=" + p for p in perms)
        req = urllib.request.Request(f"https://storage.googleapis.com/storage/v1/b/{self.bucket}/iam/testPermissions?{q}", method="GET", headers={"Authorization": "Bearer " + tok.stdout.strip()})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return set(json.load(r).get("permissions", []))
        except urllib.error.HTTPError as e:
            raise Stop(f"testIamPermissions on the dev deploy bucket answered {e.code}: the service account may not even ask") from e

    def write_probe(self) -> bool | None:
        """may this account write desired.json? Asked by a write that CANNOT succeed: `--if-generation-match=1` (no object has generation 1). Authorization is decided before the precondition:
        403 = not allowed (False) · 412 = allowed, and nothing was written (True) · anything else = could not tell (None: the real write will say)."""
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "desired.json"
            p.write_bytes(b"{}\n")
            r = self._run("storage", "cp", str(p), f"gs://{self.bucket}/desired.json", f"--if-generation-match={IMPOSSIBLE_GENERATION}")
        if r.returncode == 0:
            raise Stop("the write probe was accepted although no object has generation 1 — stopping; a person must look at desired.json")
        if re.search(r"\b412\b|conditionNotMet|PreconditionFailed|precondition", r.stderr, re.I):
            return True
        if re.search(r"\b403\b|forbidden|does not have storage|AccessDenied", r.stderr, re.I):
            return False
        return None

    def exists(self, name: str) -> bool:
        return self._run("storage", "objects", "describe", f"gs://{self.bucket}/{name}", "--format=value(name)").returncode == 0

    def read(self, name: str, generation: int | None = None) -> bytes | None:
        """the object's bytes — of exactly one generation when given (`name#generation`), so the bytes and the generation a write is conditioned on always belong together"""
        suffix = f"#{generation}" if generation else ""
        r = subprocess.run(["gcloud", "storage", "cat", f"gs://{self.bucket}/{name}{suffix}"], capture_output=True, timeout=120)
        return r.stdout if r.returncode == 0 else None

    def generation(self, name: str) -> int | None:
        """the current generation; None = the object does not exist (any other failure stops the run: «absent» must not be guessed)"""
        r = self._run("storage", "objects", "describe", f"gs://{self.bucket}/{name}", "--format=value(generation)")
        if r.returncode == 0 and r.stdout.strip().isdigit():
            return int(r.stdout.strip())
        if re.search(r"not found|404|No URLs matched|matched no objects|No such object|does not exist", r.stderr, re.I):
            return None
        raise Stop(f"cannot read the generation of {name}: " + r.stderr.strip()[-300:])

    def write_desired(self, data: bytes, generation: int) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "desired.json"
            p.write_bytes(data)
            r = self._run("storage", "cp", str(p), f"gs://{self.bucket}/desired.json", f"--if-generation-match={generation}", "--content-type=application/json")
        if r.returncode != 0:
            if re.search(r"\b412\b|conditionNotMet|PreconditionFailed|precondition", r.stderr, re.I):
                raise PreconditionFailed(r.stderr.strip()[-300:])
            if re.search(r"\b403\b|forbidden|does not have storage", r.stderr, re.I):
                raise Stop("the service account may not write desired.json — nothing written.\n" + GRANT_HELP)
            raise Stop("writing desired.json failed: " + r.stderr.strip()[-400:])


class Ci:
    def __init__(self, repo: str = REPO):
        self.repo = repo

    def _api(self, path: str):
        r = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise Stop(f"GitHub API {path.split('?')[0]} failed: {r.stderr.strip()[-300:]}")
        return json.loads(r.stdout)

    def develop_ci(self, sha: str) -> tuple[str, str | None] | None:
        """(status, conclusion) of the newest «CI» run for a push to develop with exactly this head sha; None = no such run (yet)"""
        runs = self._api(f"repos/{self.repo}/actions/workflows/ci.yml/runs?head_sha={sha}&event=push&branch=develop&per_page=10")["workflow_runs"]
        runs = [r for r in runs if r.get("head_sha") == sha]
        if not runs:
            return None
        newest = max(runs, key=lambda r: r["created_at"])
        return newest["status"], newest.get("conclusion")

    def relation(self, base: str, head: str) -> str:
        """git relation of head to base: ahead | identical | behind | diverged (anything else, e.g. an unknown sha, is «unknown»)"""
        try:
            return self._api(f"repos/{self.repo}/compare/{base}...{head}")["status"]
        except Stop:
            return "unknown"


def _health_sha(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return str(json.load(r).get("commit_sha", "?"))
    except Exception:  # a down / restarting server is simply «not yet»
        return "?"


# ───────────────────────────── the promotion ─────────────────────────────

def promote(sha: str, gcs, ci, *, health: Callable[[str], str] = _health_sha, sleep: Callable[[float], None] = time.sleep, now: Callable[[], float] = time.monotonic, log: Callable[[str], None] = print) -> int:
    if not SHA_RE.fullmatch(sha):
        raise Stop("--sha must be a full lower-case git sha (40 hex)", 2)
    if getattr(gcs, "bucket", None) != DEV_BUCKET:
        raise Stop(f"refused: the bucket is not {DEV_BUCKET}", 2)
    log(f"promote {sha[:9]} → dev VM (bucket {gcs.bucket})")

    # 2. permissions first: a missing grant must fail in seconds, not after an hour of waiting
    have = gcs.permissions(READ_NEEDED)
    missing = [p for p in READ_NEEDED if p not in have]
    can_write = gcs.write_probe()
    if can_write is False:
        missing += [f"{p} (on desired.json)" for p in WRITE_NEEDED]
    if missing:
        raise Stop("the service account lacks " + ", ".join(missing) + " on the dev deploy bucket — nothing was waited for or written.\n" + GRANT_HELP)
    log("permissions: " + ", ".join(READ_NEEDED) + " on the bucket granted; " + ("write on desired.json granted (probe: precondition failed, nothing written)" if can_write else "write on desired.json could not be probed (the write itself will tell)"))

    # 3. the candidate (and its bundle) and this sha's own develop CI
    t0 = now()
    cand_raw: bytes | None = None
    while True:
        if cand_raw is None and gcs.exists(f"candidates/{sha}.json"):
            cand_raw = gcs.read(f"candidates/{sha}.json")
            if cand_raw is not None:
                log(f"candidate candidates/{sha[:9]}.json present")
        state = ci.develop_ci(sha)
        if state is not None and state[0] == "completed":
            if state[1] != "success":
                raise Stop(f"develop CI of {sha[:9]} is '{state[1]}' — NOT promoting (no write)")
            if cand_raw is not None:
                log(f"develop CI of {sha[:9]}: success")
                break
        elapsed = now() - t0
        if cand_raw is None and elapsed >= CANDIDATE_WAIT_SEC:
            raise Stop(f"NO CANDIDATE for {sha[:9]} after {CANDIDATE_WAIT_SEC // 60} min — check the VM bundle build (tag vm-bundle); nothing written")
        if (state is None or state[0] != "completed") and elapsed >= CI_WAIT_SEC:
            raise Stop(f"develop CI of {sha[:9]} did not finish within {CI_WAIT_SEC // 60} min (state: {state}) — NOT promoting (no write)")
        sleep(POLL_SEC)

    try:
        cand = validate_desired(json.loads(cand_raw))
    except (DeployError, ValueError) as e:
        raise Stop(f"candidates/{sha[:9]}.json is not a valid desired.json: {e}") from e
    if cand["sha"] != sha:
        raise Stop(f"candidates/{sha[:9]}.json names sha {cand['sha'][:9]}, not {sha[:9]} — NOT promoting")
    if not gcs.exists(cand["bundle"]):
        raise Stop(f"the bundle {cand['bundle']} the candidate names is not in the bucket — NOT promoting")

    # 4 + 5. newer than what is wanted now, and written only if nobody wrote in between
    for attempt in range(1, CAS_TRIES + 1):
        gen = gcs.generation("desired.json")
        cur_raw = None
        if gen is None:
            gen = 0   # absent: the write must find no object
        else:
            cur_raw = gcs.read("desired.json", gen)   # the bytes of exactly that generation: a write in between cannot make them disagree
            if cur_raw is None:
                log(f"desired.json changed under us (try {attempt}/{CAS_TRIES}) — reading again")
                continue
        cur_sha = None
        if cur_raw is not None:
            try:
                cur_sha = json.loads(cur_raw)["sha"]
            except (ValueError, KeyError, TypeError) as e:
                raise Stop("the desired.json in the bucket is not readable — a person must look at it; nothing written") from e
        if cur_sha == sha:
            log(f"desired.json already names {sha[:9]} — nothing to write")
            break
        if cur_sha is not None:
            rel = ci.relation(cur_sha, sha)
            if rel != "ahead":
                raise Stop(f"{sha[:9]} is not newer than the wanted {str(cur_sha)[:9]} (git: {rel}) — NOT promoting; a person decides (rollback? different line?)")
        try:
            gcs.write_desired(cand_raw, gen)
            log(f"desired.json ← candidates/{sha[:9]}.json (was {str(cur_sha)[:9] if cur_sha else 'absent'}; undo: copy candidates/{str(cur_sha)[:9]}.json over desired.json)")
            break
        except PreconditionFailed:
            log(f"desired.json changed under us (try {attempt}/{CAS_TRIES}) — reading again")
    else:
        raise Stop(f"desired.json kept changing under us ({CAS_TRIES} tries) — nothing written by this run; a person looks at who else writes it")

    # 6. the VM follows within minutes
    t1 = now()
    web = api = "?"
    while True:
        web, api = health(WEB_HEALTH), health(API_HEALTH)
        if web[:9] == sha[:9] and api[:9] == sha[:9]:
            log(f"PROMOTED OK web {web[:9]} api {api[:9]}")
            return 0
        if now() - t1 >= SERVING_WAIT_SEC:
            raise Stop(f"desired.json names {sha[:9]} but after {SERVING_WAIT_SEC // 60} min the dev web serves {web[:9]} and the API {api[:9]} — look at the VM deployer (journalctl -u sprintable-deploy)")
        sleep(SERVING_POLL_SEC)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sha", required=True)
    a = ap.parse_args(argv[1:])
    # refuse BEFORE any tool runs: inside Actions only a run on develop may promote (the dev builds are dispatched on develop)
    if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REF") != "refs/heads/develop":
        print(f"refused: this run is on {os.environ.get('GITHUB_REF')}, only develop promotes the dev VM", file=sys.stderr)
        return 2
    lines: list[str] = []

    def log(m: str) -> None:
        lines.append(m)
        print(m, flush=True)

    why = ""
    try:
        code = promote(a.sha, Gcs(), Ci(), log=log)
    except Stop as e:
        print(f"STOP: {e}", file=sys.stderr)
        code, why = e.code, str(e)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:  # what a person reads on the run page: the verdict, then why
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### dev promote {a.sha[:9]}: {'OK' if code == 0 else 'STOPPED (exit %d)' % code}\n\n")
            if why:
                f.write(f"**Why:** {why}\n\n")
            f.write("```\n" + "\n".join(lines) + "\n```\n")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
