#!/usr/bin/env python3
"""Pull-based deployer of one VM (story 4796). Runs from a systemd timer every minute; one run = at most one deploy.

  gs://<deploy bucket>/desired.json   written by Cloud Build as its LAST step (images are pushed and the bundle is uploaded before it):
      {"sha": "<git sha>", "backend_image": "<ref>", "frontend_image": "<ref>", ["support_gateway_image": "<ref>",] "bundle": "bundles/<sha>.tgz", "bundle_sha256": "<hex>"}
      (the support gateway image is optional, pinned by digest like the others; without it the gateway is not part of the release)
  state dir (default /var/lib/sprintable-deploy): current.json (what runs, with what it replaced) · failed.json · status.json · docker/ (registry login, root only)

A deploy is: fetch bundle → render environment (Secret Manager through the VM's own identity) → pull images → migrate (new backend image, BEFORE the swap) →
swap (`compose up -d`) → /api/v2/health AND /api/v2/ready from inside the backend container → on failure put the previous release back and say so.
Database migrations are not rolled back (the same as the Cloud Run job flow today): a migration must work with the previous image too.

The VM can only READ the deploy bucket; it writes its status to the backups bucket, so a taken VM cannot change what the other environments or itself will run.
Names only in logs and status — never a value.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_env as renv  # noqa: E402

DECLARATION_FORMAT = 1
PRE_SWAP_RETRY_SECONDS = 300
T_PULL, T_DB, T_MIGRATE, T_UP = 900, 300, 1800, 300  # seconds per step; the systemd unit must outlive all of them (a test pins it)
HEALTH_SNIPPET = (
    "import sys,urllib.request\n"
    "for p in ('/api/v2/health','/api/v2/ready'):\n"
    "    try:\n"
    "        r=urllib.request.urlopen('http://127.0.0.1:8000'+p,timeout=5)\n"
    "        ok=200<=r.status<300\n"
    "    except Exception:\n"
    "        ok=False\n"
    "    if not ok:\n"
    "        sys.exit(1)\n"
)
GATEWAY_SNIPPET = "import sys,urllib.request\ntry:\n    ok=200<=urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=5).status<300\nexcept Exception:\n    ok=False\nsys.exit(0 if ok else 1)\n"
# idempotent: the gateway's role and database inside the VM's Postgres (the image only creates the first database, and only on an empty data folder). An EXISTING role keeps its password — like the main
# database's (RUNBOOK §3): the secret is read when the role is first made, and rotating means `ALTER ROLE` first, then the secret (a deploy that changed the role's password before its swap would cut
# off the gateway that is still running on the old one if the deploy then failed). Run through psql's STANDARD INPUT: the password never
# appears in an argument list. Every value is a plain identifier or a letters/digits/«_»/«-» password (render_env checks both), so the quoting below cannot be broken out of.
GATEWAY_DB_SQL = (
    "\\set ON_ERROR_STOP on\n"
    "\\set gw_user '{user}'\n\\set gw_pw '{password}'\n\\set gw_db '{database}'\n\\set main_db '{main}'\n"
    "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'gw_user', :'gw_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'gw_user') \\gexec\n"
    "SELECT format('CREATE DATABASE %I OWNER %I', :'gw_db', :'gw_user') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'gw_db') \\gexec\n"
    "SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'main_db') \\gexec\n"
    "SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'gw_db') \\gexec\n"
    "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'gw_db', :'gw_user') \\gexec\n"
)
FRONTEND_SNIPPET = "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"


class DeployError(Exception):
    def __init__(self, message: str, phase: str) -> None:
        super().__init__(message)
        self.phase = phase  # "pre-swap" | "post-swap"


@dataclass
class Config:
    environment: str
    project: str
    deploy_bucket: str
    backups_bucket: str
    install_dir: Path = Path("/opt/sprintable")
    state_dir: Path = Path("/var/lib/sprintable-deploy")
    data_dir: Path = Path("/srv/sprintable")
    private_plain: Path = Path("/etc/sprintable/private-plain.json")
    acme_email: str = ""
    registry: str = "asia-northeast3-docker.pkg.dev"
    trusted_compose: Path = Path("/opt/sprintable/bin/compose.yml")
    health_timeout: float = 240.0
    health_interval: float = 5.0
    keep_releases: int = 3

    @staticmethod
    def load(path: str | Path) -> "Config":
        raw = json.loads(Path(path).read_text())
        cfg = Config(**{k: (Path(v) if k in ("install_dir", "state_dir", "data_dir", "private_plain", "trusted_compose") else v) for k, v in raw.items()})
        return cfg


# ───────────────────────── the outside world, injectable ─────────────────────────

class Runner:
    def run(self, args: Sequence[str], env: Mapping[str, str], cwd: Path | None = None, timeout: float = 900, stdin: str | None = None) -> tuple[int, str]:
        try:
            p = subprocess.run(list(args), env=dict(env), cwd=cwd, input=stdin, capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return 124, f"timed out after {int(timeout)} s"
        return p.returncode, (p.stdout + p.stderr)[-4000:]


class GcsStore:
    """Cloud Storage JSON API with the VM service account's token (no gcloud)."""

    def __init__(self, reader: renv.MetadataSecretReader, urlopen: Callable = urllib.request.urlopen) -> None:
        self._reader = reader
        self._urlopen = urlopen

    def _req(self, req: urllib.request.Request) -> bytes | None:
        req.add_header("Authorization", f"Bearer {self._reader.token()}")
        try:
            with self._urlopen(req, timeout=60) as resp:  # noqa: S310 — fixed https URL
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def get(self, bucket: str, name: str) -> bytes | None:
        url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(name, safe='')}?alt=media"
        return self._req(urllib.request.Request(url))

    def put_json(self, bucket: str, name: str, obj: object) -> None:
        url = f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=media&name={urllib.parse.quote(name, safe='')}"
        req = urllib.request.Request(url, data=json.dumps(obj).encode(), method="POST", headers={"Content-Type": "application/json"})
        self._req(req)


# ───────────────────────── helpers ─────────────────────────

COMPOSE_STAMP = ".compose-sha256"  # in a release folder: the checksum of the compose.yml that was found equal to the trusted copy of its time
STATE_KEYS = ("sha", "backend_image", "frontend_image", "bundle", "bundle_sha256")
OPTIONAL_STATE_KEYS = ("support_gateway_image",)  # part of a release when present; a record written before the gateway existed lacks it and is still a valid record
GATEWAY_PROFILE, GATEWAY_MIGRATE_PROFILE = "support-gateway", "support-gateway-migrate"


def release_state(d: Mapping) -> dict:
    """what a recorded release is made of: the required keys, plus the optional ones that are there"""
    return {**{k: d[k] for k in STATE_KEYS}, **{k: d[k] for k in OPTIONAL_STATE_KEYS if isinstance(d.get(k), str) and d[k]}}


def _read_json(path: Path) -> dict | None:
    try:
        doc = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except ValueError:  # JSONDecodeError and UnicodeDecodeError
        return None  # a damaged state file counts as «unknown»: the deploy is idempotent, so doing it again is safe
    return doc if isinstance(doc, dict) else None


def read_current(path: Path) -> dict | None:
    doc = _read_json(path)
    return doc if doc and all(isinstance(doc.get(k), str) and doc[k] for k in STATE_KEYS) else None


def current_is_unknown(path: Path) -> bool:
    """the file is there but cannot be trusted: we do not know what runs, which is different from «nothing has been deployed yet»"""
    return path.exists() and read_current(path) is None


def read_failed(path: Path) -> dict | None:
    doc = _read_json(path)
    ok = doc and isinstance(doc.get("signature"), str) and isinstance(doc.get("phase"), str) and isinstance(doc.get("at"), (int, float))
    return doc if ok else None


def _write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as fh:
        fh.write(json.dumps(obj, indent=2, sort_keys=True))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


MAX_BUNDLE_BYTES = 10 * 1024 * 1024       # compressed
MAX_UNPACKED_BYTES = 20 * 1024 * 1024     # all members together
MAX_MEMBERS = 500


def safe_extract(blob: bytes, dest: Path) -> None:
    """a bundle is plain files and folders only — no links, no device files, no «..» or absolute names, nothing outside `dest`, bounded in size and count"""
    if len(blob) > MAX_BUNDLE_BYTES:
        raise DeployError(f"bundle is larger than {MAX_BUNDLE_BYTES // (1024 * 1024)} MB", "pre-swap")
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            members = tar.getmembers()
            if len(members) > MAX_MEMBERS or sum(m.size for m in members) > MAX_UNPACKED_BYTES:
                raise DeployError("bundle holds too many or too large files", "pre-swap")
            for m in members:
                if not (m.isfile() or m.isdir()):
                    raise DeployError(f"bundle member {m.name!r} is not a plain file or folder", "pre-swap")
                parts = m.name.replace("\\", "/").split("/")
                if m.name.startswith("/") or ".." in parts:
                    raise DeployError(f"bundle member {m.name!r} has an absolute name or «..» in it", "pre-swap")
            for m in members:
                m.mode &= 0o755  # no setuid/setgid/sticky, no group/other write
                tar.extract(m, root)
    except (tarfile.TarError, OSError, EOFError) as e:
        raise DeployError(f"bundle cannot be unpacked: {type(e).__name__}", "pre-swap") from e


def _stamp_matches(stamp: Path, want: str) -> bool:
    """does the release folder carry the checksum of THIS bundle? A missing, unreadable, non-text or wrong stamp all mean «no» (the folder is then extracted again)"""
    try:
        return stamp.read_text(encoding="utf-8").strip() == want
    except (OSError, UnicodeError):
        return False


_DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")


def validate_desired(d: object, image_prefix: str | None = None) -> dict:
    if not isinstance(d, dict):
        raise DeployError("desired.json is not an object", "pre-swap")
    for key in ("sha", "backend_image", "frontend_image", "bundle", "bundle_sha256"):
        if not isinstance(d.get(key), str) or not d[key]:
            raise DeployError(f"desired.json lacks «{key}»", "pre-swap")
    if not all(c in "0123456789abcdef" for c in d["sha"]) or len(d["sha"]) < 7:
        raise DeployError("desired.json: «sha» is not a git sha", "pre-swap")
    if "support_gateway_image" in d and (not isinstance(d["support_gateway_image"], str) or not d["support_gateway_image"]):
        raise DeployError("desired.json: «support_gateway_image» must be an image reference when it is present", "pre-swap")
    for key in ("backend_image", "frontend_image", *(["support_gateway_image"] if "support_gateway_image" in d else [])):
        if " " in d[key] or d[key].startswith("-"):
            raise DeployError(f"desired.json: «{key}» is not an image reference", "pre-swap")
        if not _DIGEST.search(d[key]):
            # a tag can be moved to another image later; a rollback must run exactly what ran before
            raise DeployError(f"desired.json: «{key}» must be pinned by digest (…@sha256:<64 hex>)", "pre-swap")
        if image_prefix is not None and not d[key].startswith(image_prefix):
            # the VM's registry login token goes only to our own Artifact Registry, never to a host named in desired.json
            raise DeployError(f"desired.json: «{key}» is not in {image_prefix}", "pre-swap")
    if d["bundle"].startswith("/") or ".." in d["bundle"]:
        raise DeployError("desired.json: «bundle» is not an object name", "pre-swap")
    return d


def signature(d: Mapping) -> str:
    """a release's identity; the gateway image joins it only when there is one, so the signature of a release recorded before the gateway existed does not change"""
    parts = [str(d[k]) for k in ("sha", "backend_image", "frontend_image", "bundle_sha256")]
    if isinstance(d.get("support_gateway_image"), str) and d["support_gateway_image"]:
        parts.append(str(d["support_gateway_image"]))
    return "|".join(parts)


def _differing(got: object, want: object) -> list[str]:
    """names of the places where two compose documents differ (never values)"""
    if not isinstance(got, dict) or not isinstance(want, dict):
        return ["(document)"]
    out = []
    for key in sorted(set(got) | set(want), key=str):
        if got.get(key) == want.get(key):
            continue
        if key == "services" and isinstance(got.get(key), dict) and isinstance(want.get(key), dict):
            for name in sorted(set(got[key]) | set(want[key]), key=str):
                g, w = got[key].get(name), want[key].get(name)
                if g == w:
                    continue
                if isinstance(g, dict) and isinstance(w, dict):
                    out += [f"services.{name}.{k}" for k in sorted(set(g) | set(w), key=str) if g.get(k) != w.get(k)]
                else:
                    out.append(f"services.{name}")
        else:
            out.append(str(key))
    return out


def check_compose(compose_file: Path, trusted_file: Path) -> None:
    """a bundle's compose.yml runs as root on the VM, so it must be EXACTLY the one installed on this VM by bootstrap.sh (compared as parsed documents:
    every key and value of every service). A compose change is therefore an infrastructure change — it takes a bootstrap run, a human step — while a normal release only changes image digests."""
    try:
        got = yaml.safe_load(compose_file.read_text())
        want = yaml.safe_load(trusted_file.read_text())
    except (OSError, ValueError, yaml.YAMLError) as e:
        raise DeployError(f"compose.yml cannot be read or compared: {type(e).__name__}", "pre-swap") from e
    if got != want:
        raise DeployError(f"compose.yml differs from the one installed on this VM at: {', '.join(_differing(got, want))} (a compose change takes a bootstrap run, RUNBOOK §6)", "pre-swap")


# ───────────────────────── the deployer ─────────────────────────

@dataclass
class Prepared:
    release: Path
    decl: dict
    env: dict
    services: dict
    caddyfile: str
    gateway_password: str = ""

    @property
    def gateway(self) -> bool:
        """is the support gateway part of this release? (an image is in the release and the environment was built for it)"""
        return "SUPPORT_GATEWAY_IMAGE" in self.env


@dataclass
class Deployer:
    cfg: Config
    store: GcsStore
    runner: Runner
    secrets: Callable[[str], str]
    token: Callable[[], str]
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.time
    log: Callable[[str], None] = field(default=lambda m: print(m, flush=True))
    _scrub_values: set = field(default_factory=set)
    _phase: str = "pre-swap"
    _status_seq: int = 0
    _secret_cache: dict = field(default_factory=dict)
    _current_unknown: bool = False
    _prev: "Prepared | None" = None
    _cand: "Prepared | None" = None

    @property
    def _image_prefix(self) -> str:
        return f"{self.cfg.registry}/{self.cfg.project}/"

    def _seq(self) -> int:
        self._status_seq += 1
        return self._status_seq

    def _scrub(self, text: str) -> str:
        for v in sorted(self._scrub_values, key=len, reverse=True):
            text = text.replace(v, "***")
        return text

    # --- state ---
    @property
    def _current_path(self) -> Path:
        return self.cfg.state_dir / "current.json"

    @property
    def _pending_path(self) -> Path:
        return self.cfg.state_dir / "pending.json"

    def _status(self, state: str, **extra: object) -> None:
        doc = {"state": state, "environment": self.cfg.environment, "at": int(self.now()), **extra}
        _write_json(self.cfg.state_dir / "status.json", doc)
        try:
            self.store.put_json(self.cfg.backups_bucket, f"status/{self.cfg.environment}/{int(self.now() * 1000)}-{self._seq()}.json", doc)  # create-only: the VM may add objects, not replace or delete them
        except Exception as e:  # noqa: BLE001 — the status upload must never decide whether a deploy happens
            self.log(f"status upload failed: {type(e).__name__}")

    # --- one tick ---
    def run_once(self, force: bool = False) -> str:
        self._secret_cache.clear()
        self._prev = self._cand = None
        current = read_current(self._current_path)
        # first of all: a previous run may have died between «a swap started» and «the state is recorded» — settle that, whatever desired.json says or fails to say
        unresolved = self._settle_unresolved(current)
        if unresolved:
            self._status(unresolved, serving=(current or {}).get("sha"))
            return unresolved
        try:
            raw = self.store.get(self.cfg.deploy_bucket, "desired.json")
        except Exception as e:  # noqa: BLE001 — a network blip must not look like a crash; the next tick tries again
            self._status("desired-unreadable", detail=type(e).__name__)
            return "desired-unreadable"
        if raw is None:
            self._status("no-desired")
            return "no-desired"
        try:
            desired = validate_desired(json.loads(raw), self._image_prefix)
        except (ValueError, DeployError) as e:  # ValueError covers bad JSON and bytes that are not UTF-8
            self._status("bad-desired", detail=str(e)[:300])
            return "bad-desired"

        # a damaged current.json, or a swap that started and never got to record itself (pending.json), means we do not know what is running
        self._current_unknown = current_is_unknown(self._current_path) or (current is None and self._pending_path.exists())
        if current and signature(current) == signature(desired) and not force:
            self._status("up-to-date", sha=desired["sha"])
            return "up-to-date"

        failed = read_failed(self.cfg.state_dir / "failed.json")
        if failed and failed["signature"] == signature(desired) and not force:
            if failed["phase"] == "post-swap" or self.now() - failed["at"] < PRE_SWAP_RETRY_SECONDS:
                self._status("skipping-failed", sha=desired["sha"], detail=str(failed.get("detail", ""))[:300], serving=(current or {}).get("sha"))
                return "skipping-failed"

        self._status("deploying", sha=desired["sha"], serving=(current or {}).get("sha"))
        self._phase = "pre-swap"
        try:
            self._deploy(desired, current)
        except Exception as e:  # noqa: BLE001 — whatever went wrong, record it and (after the swap) put the previous release back
            err = e if isinstance(e, DeployError) else DeployError(f"unexpected {type(e).__name__}", self._phase)
            _write_json(self.cfg.state_dir / "failed.json", {"signature": signature(desired), "phase": err.phase, "detail": self._scrub(str(err))[:500], "at": int(self.now())})
            if err.phase == "post-swap":
                outcome = self._rollback(current)
                self._status(outcome, sha=desired["sha"], detail=self._scrub(str(err))[:300], serving=(current or {}).get("sha") if outcome == "rolled-back" else None)
                return outcome
            self._status("failed", sha=desired["sha"], detail=self._scrub(str(err))[:300], serving=(current or {}).get("sha"))
            return "failed"
        (self.cfg.state_dir / "failed.json").unlink(missing_ok=True)
        self._status("deployed", sha=desired["sha"], serving=desired["sha"])
        return "deployed"

    def _settle_unresolved(self, current: Mapping | None) -> str | None:
        """None = nothing is left over; otherwise the status to report (and nothing new is started)"""
        if not self._pending_path.exists():
            return None
        pending = _read_json(self._pending_path) or {}
        if current:
            return self._reconcile(current, pending)
        if self._current_path.exists():
            return None  # current.json is damaged: something may be serving and we cannot tell which release — leave it, report «unknown» when a deploy fails
        return self._stop_first_release(pending)

    def _reconcile(self, current: Mapping, pending: Mapping) -> str | None:
        if all(isinstance(pending.get(k), str) and pending[k] for k in STATE_KEYS) and signature(pending) == signature(current):
            self._pending_path.unlink(missing_ok=True)  # the swap was to the recorded release: only the marker was left behind
            return None
        try:
            p = self._prepare(current)
            self._activate(p)
            self._swap(p)
            self._drop_gateway_if_left_out(p, bool(pending.get("support_gateway_image")))  # the interrupted swap may have started the gateway of a release that was never recorded
        except Exception as e:  # noqa: BLE001
            self.log(f"reconcile failed: {self._scrub(str(e)) if isinstance(e, DeployError) else type(e).__name__}")
            return "reconcile-failed"
        self._pending_path.unlink(missing_ok=True)
        return None

    def _stop_first_release(self, pending: Mapping) -> str | None:
        """no release was ever recorded, yet a swap started: it was the first deploy and its candidate may still be running — stop it (the database stays up)"""
        if not all(isinstance(pending.get(k), str) and pending[k] for k in STATE_KEYS):
            return "failed-state-unknown"
        failed = read_failed(self.cfg.state_dir / "failed.json")
        if not failed or failed["signature"] != signature(pending):
            # that swap was never recorded as FAILED: it may be a healthy first release whose run died before writing current.json. Do not stop it —
            # the next normal pass (same desired version) deploys it again, which is a no-op for a healthy stack, and records it.
            return None
        try:
            p = self._prepare(release_state(pending))
            self._activate(p)
            rc, out = self._compose(p.release, p.env, "stop", "backend", "frontend", "caddy", *([renv.GATEWAY_SERVICE] if p.gateway else []), timeout=120)
        except Exception as e:  # noqa: BLE001
            self.log(f"could not stop the unrecorded first release: {self._scrub(str(e)) if isinstance(e, DeployError) else type(e).__name__}")
            return "reconcile-failed"
        if rc != 0:
            self.log(f"could not stop the unrecorded first release: {out[-200:]}")
            return "reconcile-failed"
        self._pending_path.unlink(missing_ok=True)
        return None

    def db_only(self) -> str:
        """`--db-only`: start just the database of the desired release (folder, environment and data disk prepared), so the dump can be restored BEFORE the first deploy"""
        self._secret_cache.clear()
        try:
            raw = self.store.get(self.cfg.deploy_bucket, "desired.json")
            if raw is None:
                return "no-desired"
            p = self._prepare(validate_desired(json.loads(raw), self._image_prefix))
            self._activate(p)
        except Exception as e:  # noqa: BLE001
            self.log(f"db-only: {self._scrub(str(e)) if isinstance(e, DeployError) else type(e).__name__}")
            return "failed"
        rc, out = self._compose(p.release, p.env, "up", "-d", "--wait", "db", timeout=300)
        if rc != 0:
            self.log(f"db-only: database did not become healthy: {out[-300:]}")
            return "failed"
        return "db-up"

    # --- steps ---
    def _read_secret(self, secret_id: str) -> str:
        """one read per secret id per run, shared by all services — backend and frontend get the same JWT_SECRET even if it is rotated mid-deploy"""
        if secret_id not in self._secret_cache:
            self._secret_cache[secret_id] = self.secrets(secret_id)
        return self._secret_cache[secret_id]

    def _compose_env(self, decl: Mapping, images: Mapping[str, str], services: Mapping[str, Mapping[str, str]], db_password: str, gateway_password: str = "") -> dict[str, str]:
        db = decl["database"]
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
            "HOME": os.environ.get("HOME", "/root"),
            "DOCKER_CONFIG": str(self.cfg.state_dir / "docker"),
            "BACKEND_IMAGE": images["backend_image"],
            "FRONTEND_IMAGE": images["frontend_image"],
            **({"SUPPORT_GATEWAY_IMAGE": images["support_gateway_image"]} if images.get("support_gateway_image") else {}),
            "API_HOST": decl["hosts"]["api"],
            "REALTIME_HOST": decl["hosts"]["realtime"],
            "APP_HOST": decl["hosts"]["app"],
            "ACME_EMAIL": self.cfg.acme_email or "ops@sprintable.ai",
            "DB_USER": db["user"],
            "DB_NAME": db["name"],
            "DATA_DIR": str(self.cfg.data_dir),
            "CADDYDIR": str(self.cfg.install_dir / "runtime" / "caddy"),
            "POSTGRES_PASSWORD": db_password,
            "ALEMBIC_DATABASE_URL": f"postgresql://{db['user']}:{db_password}@db:5432/{db['name']}",
        }
        if images.get("support_gateway_image"):
            # by name into the gateway and its one-shot migrate (compose.yml); the role and database are the gateway's own, never the backend's
            env["SUPPORT_GATEWAY_DATABASE_URL"] = renv.gateway_database_url(decl, gateway_password)
        env.update(renv.process_environment(services))
        return env

    def _compose(self, release: Path, env: Mapping[str, str], *args: str, profile: str | None = None, timeout: float = 900, stdin: str | None = None) -> tuple[int, str]:
        cmd = ["docker", "compose", "-f", str(release / "compose.yml"), "-f", str(self.cfg.install_dir / "runtime" / "pass-through.yml")]
        profiles = [profile] if profile else []
        if "SUPPORT_GATEWAY_IMAGE" in env and GATEWAY_PROFILE not in profiles:
            profiles.append(GATEWAY_PROFILE)  # the gateway belongs to this release: every compose call of it sees the gateway services
        for name in profiles:
            cmd += ["--profile", name]
        rc, out = self.runner.run([*cmd, *args], env, cwd=release, timeout=timeout, stdin=stdin)
        return rc, self._scrub(out)

    def _prepare(self, desired: Mapping) -> Prepared:
        """everything one release needs, read and checked — nothing is changed on the VM yet (see `_activate`). Raises DeployError('pre-swap')."""
        sha = desired["sha"]
        release = self.cfg.install_dir / "releases" / sha
        stamp = release / ".bundle-sha256"
        # a folder from an earlier bundle of the SAME git sha (rebuilt, or damaged) is not reused: it must carry the checksum of THIS bundle
        if not ((release / "compose.yml").exists() and _stamp_matches(stamp, desired["bundle_sha256"])):
            blob = self.store.get(self.cfg.deploy_bucket, desired["bundle"])
            if blob is None:
                raise DeployError(f"bundle {desired['bundle']} is not in the deploy bucket", "pre-swap")
            if hashlib.sha256(blob).hexdigest() != desired["bundle_sha256"]:
                raise DeployError("bundle checksum differs from desired.json", "pre-swap")
            tmp = release.with_name(release.name + ".partial")
            shutil.rmtree(tmp, ignore_errors=True)
            safe_extract(blob, tmp)
            (tmp / COMPOSE_STAMP).unlink(missing_ok=True)  # only this deployer (or bootstrap) vouches for a compose file; a bundle must not be able to
            (tmp / ".bundle-sha256").write_text(desired["bundle_sha256"])
            shutil.rmtree(release, ignore_errors=True)
            os.replace(tmp, release)
        self._check_release_compose(release)
        try:
            caddyfile = (release / "Caddyfile").read_text(encoding="utf-8")
            if not caddyfile.strip() or not (release / "Caddyfile").is_file():
                raise renv.EnvError("the release has no usable Caddyfile")
            decl = renv.load_declaration(release / "env" / f"{self.cfg.environment}.yaml")
            if decl.get("format") != DECLARATION_FORMAT:
                raise renv.EnvError(f"declaration format {decl.get('format')!r} — this deployer reads {DECLARATION_FORMAT}")
            if decl["environment"] != self.cfg.environment or decl["buckets"]["deploy"] != self.cfg.deploy_bucket:
                raise renv.EnvError("the declaration is not for this VM (environment or deploy bucket differs from the VM configuration)")
            st = self.cfg.private_plain.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
                raise renv.EnvError(f"{self.cfg.private_plain} must be a plain file owned by the deploying user and not readable by group or others")
            plain = renv.load_private_plain(self.cfg.private_plain)
            # the password is hex (RUNBOOK §3): a value piped into `gcloud secrets create` carries the shell's line ending, which is not part of it — ONE trailing line ending is taken off, anything else is still refused below
            db_password = self._read_secret(decl["database"]["password_secret"])
            db_password = db_password[:-2] if db_password.endswith("\r\n") else db_password[:-1] if db_password.endswith("\n") else db_password
            wants_gateway = bool(desired.get("support_gateway_image"))
            if wants_gateway and renv.GATEWAY_SERVICE not in decl["services"]:
                raise renv.EnvError(f"the release carries a support gateway image but {self.cfg.environment}.yaml declares no «{renv.GATEWAY_SERVICE}» service")
            gateway_password = ""
            if wants_gateway:
                gateway_password = self._read_secret(decl["support_gateway"]["database"]["password_secret"])
                gateway_password = gateway_password[:-2] if gateway_password.endswith("\r\n") else gateway_password[:-1] if gateway_password.endswith("\n") else gateway_password
            # a gateway that is not part of this release reads none of its secrets (and gets no environment)
            services = {name: renv.build_service_env(decl, name, plain.get(name, {}), db_password, self._read_secret) for name in decl["services"] if name != renv.GATEWAY_SERVICE or wants_gateway}
        except (renv.EnvError, OSError, ValueError, KeyError, yaml.YAMLError, TypeError, AttributeError) as e:
            # our own EnvError messages carry names only; anything else (a failed secret read …) is reported by class, its message could hold a value
            raise DeployError(f"environment: {e}" if isinstance(e, renv.EnvError) else f"environment: {type(e).__name__}", "pre-swap") from e
        # every secret value (whatever its length) is removed from anything recorded; plain values are not secrets
        secret_values = {services[svc][n] for svc, d in decl["services"].items() if svc in services for n in (d.get("secrets") or {}) if services[svc].get(n)}
        self._scrub_values |= {v for v in (db_password, gateway_password, *secret_values) if v}
        return Prepared(release, decl, self._compose_env(decl, desired, services, db_password, gateway_password), services, caddyfile, gateway_password)

    def _check_release_compose(self, release: Path) -> None:
        """a release's compose.yml is accepted when it equals the installed (trusted) copy — or when THIS exact file was found equal to the trusted copy of its time (the stamp the deployer writes when it
        accepts a release, and bootstrap writes for the releases already on the VM before it replaces the copy). Without that, a compose change would refuse to prepare the release that is RUNNING
        (the way back), so the first deploy after it could never start."""
        compose, stamp = release / "compose.yml", release / COMPOSE_STAMP
        try:
            digest = hashlib.sha256(compose.read_bytes()).hexdigest()
        except OSError as e:
            raise DeployError(f"compose.yml cannot be read: {type(e).__name__}", "pre-swap") from e
        if _stamp_matches(stamp, digest):
            return
        check_compose(compose, self.cfg.trusted_compose)
        try:
            stamp.write_text(digest)
        except OSError:
            pass  # the release is accepted now; it is simply checked again next time

    def _activate(self, p: Prepared) -> None:
        """make the compose invocations of `p` possible: the pass-through file (names only) and the data folders"""
        runtime = self.cfg.install_dir / "runtime"
        runtime.mkdir(parents=True, exist_ok=True)
        renv.write_passthrough(runtime / "pass-through.yml", p.services)
        (self.cfg.data_dir / "postgres").mkdir(parents=True, exist_ok=True)
        (self.cfg.data_dir / "caddy").mkdir(parents=True, exist_ok=True)

    def _install_caddyfile(self, text: str) -> None:
        """the container mounts the DIRECTORY, so the file can be replaced atomically (write next to it, fsync, rename): a crash leaves the old or the new file, never half of one"""
        directory = self.cfg.install_dir / "runtime" / "caddy"
        tmp = directory / ".Caddyfile.new"
        try:
            directory.mkdir(parents=True, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(text)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, directory / "Caddyfile")
        except OSError as e:
            tmp.unlink(missing_ok=True)
            raise DeployError(f"could not write the Caddyfile: {type(e).__name__}", "post-swap") from e

    def _registry_login(self, env: Mapping[str, str]) -> None:
        """the token goes to our own registry host only (the image names were checked against it); the login is removed again right after the pull"""
        Path(env["DOCKER_CONFIG"]).mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(env["DOCKER_CONFIG"], 0o700)
        rc, _ = self.runner.run(["docker", "login", "-u", "oauth2accesstoken", "--password-stdin", self.cfg.registry], env, stdin=self.token(), timeout=60)
        if rc != 0:
            raise DeployError(f"registry login to {self.cfg.registry} failed", "pre-swap")

    def _registry_logout(self, env: Mapping[str, str]) -> None:
        self.runner.run(["docker", "logout", self.cfg.registry], env, timeout=30)

    def _healthy(self, p: Prepared) -> bool:
        rc, _ = self._compose(p.release, p.env, "exec", "-T", "backend", "python", "-c", HEALTH_SNIPPET, timeout=30)
        if rc != 0:
            return False
        rc, _ = self._compose(p.release, p.env, "exec", "-T", "frontend", "node", "-e", FRONTEND_SNIPPET, timeout=30)
        if rc != 0:
            return False
        if p.gateway:
            rc, _ = self._compose(p.release, p.env, "exec", "-T", renv.GATEWAY_SERVICE, "python", "-c", GATEWAY_SNIPPET, timeout=30)
        return rc == 0

    def _swap(self, p: Prepared) -> None:
        self._phase = "post-swap"
        self._install_caddyfile(p.caddyfile)  # here, not while preparing: a deploy that stops before the swap leaves the running Caddyfile alone
        rc, out = self._compose(p.release, p.env, "up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "120", timeout=T_UP)
        if rc != 0:
            raise DeployError(f"compose up failed: {out[-300:]}", "post-swap")
        rc, out = self._compose(p.release, p.env, "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", timeout=30)
        if rc != 0:
            raise DeployError(f"caddy reload failed: {out[-300:]}", "post-swap")
        deadline = self.now() + self.cfg.health_timeout
        while True:
            if self._healthy(p):
                return
            if self.now() >= deadline:
                raise DeployError(f"health/ready not green within {int(self.cfg.health_timeout)} s", "post-swap")
            self.sleep(self.cfg.health_interval)

    def _deploy(self, desired: Mapping, current: Mapping | None) -> None:
        # the way back is prepared BEFORE anything changes: a rollback must not depend on Secret Manager, the token or the private file still being fine afterwards
        if current:
            try:
                self._prev = self._prepare(current)
            except DeployError as e:
                # without a way back, a failed swap would leave the broken release serving: do not start
                raise DeployError(f"the running release cannot be prepared for a rollback, so nothing was changed: {e}", "pre-swap") from e
        cand = self._cand = self._prepare(desired)
        self._activate(cand)
        self._registry_login(cand.env)
        try:
            rc, out = self._compose(cand.release, cand.env, "pull", "backend", "frontend", *([renv.GATEWAY_SERVICE] if cand.gateway else []), timeout=T_PULL)
        finally:
            self._registry_logout(cand.env)
        if rc != 0:
            raise DeployError(f"image pull failed: {out[-300:]}", "pre-swap")
        rc, _ = self._compose(cand.release, cand.env, "up", "-d", "--wait", "db", timeout=T_DB)
        if rc != 0:
            raise DeployError("database did not become healthy", "pre-swap")
        rc, out = self._compose(cand.release, cand.env, "run", "--rm", "migrate", profile="migrate", timeout=T_MIGRATE)
        if rc != 0:
            raise DeployError(f"migrate failed: {out[-300:]}", "pre-swap")
        if cand.gateway:
            self._prepare_gateway_database(cand)
            rc, out = self._compose(cand.release, cand.env, "run", "--rm", "support-gateway-migrate", profile=GATEWAY_MIGRATE_PROFILE, timeout=T_MIGRATE)
            if rc != 0:
                raise DeployError(f"support gateway migrate failed: {out[-300:]}", "pre-swap")
        _write_json(self._pending_path, {**release_state(desired), "at": int(self.now())})  # «a swap started»: survives a crash before current.json is written
        self._swap(cand)
        self._drop_gateway_if_left_out(cand, bool(current and current.get("support_gateway_image")))
        record = release_state(desired)
        record["previous"] = release_state(current) if current else None
        _write_json(self._current_path, record)
        self._pending_path.unlink(missing_ok=True)
        self._prune(keep={desired["sha"], *([current["sha"]] if current else [])})

    def _prepare_gateway_database(self, p: Prepared) -> None:
        """the gateway's own role and database in the VM's Postgres (idempotent; an existing role's password is left alone)"""
        db, gw = p.decl["database"], p.decl["support_gateway"]["database"]
        sql = GATEWAY_DB_SQL.format(user=gw["user"], password=p.gateway_password, database=gw["name"], main=db["name"])
        rc, out = self._compose(p.release, p.env, "exec", "-T", "db", "psql", "-X", "-q", "-U", db["user"], "-d", "postgres", timeout=120, stdin=sql)
        if rc != 0:
            raise DeployError(f"support gateway database could not be prepared: {out[-300:]}", "pre-swap")

    def _drop_gateway_if_left_out(self, running: Prepared, previously_had_gateway: bool) -> None:
        """a release without the gateway after one with it: compose does not remove a container of a service that is merely not part of this release — stop it"""
        if running.gateway or not previously_had_gateway:
            return
        rc, out = self._compose(running.release, running.env, "stop", renv.GATEWAY_SERVICE, profile=GATEWAY_PROFILE, timeout=60)
        if rc != 0:
            # not best effort: a gateway that keeps running beside a release that left it out holds database connections nobody budgeted. After the swap this is a post-swap failure — the previous release
            # (which has the gateway) is put back; on the way back or in a reconcile it is reported as that step failing, and the pending marker stays so the next run tries again
            raise DeployError(f"could not stop the support gateway that this release leaves out: {out[-200:]}", "post-swap")

    def _rollback(self, current: Mapping | None) -> str:
        try:
            if not current and self._current_unknown:
                # current.json is damaged: something may be running and serving. Stopping it could take a working service down, so leave everything as it is and say so.
                return "failed-state-unknown"
            if not current:
                # nothing to go back to: do not leave a half-working candidate serving — stop it (the database stays up)
                if self._cand is not None:
                    self._activate(self._cand)
                    rc, out = self._compose(self._cand.release, self._cand.env, "stop", "backend", "frontend", "caddy", *([renv.GATEWAY_SERVICE] if self._cand.gateway else []), timeout=120)
                    if rc != 0:
                        # the candidate may still be serving: keep the marker (the next run tries to stop it again) and say the state is unknown
                        self.log(f"could not stop the failed first release: {out[-200:]}")
                        return "failed-state-unknown"
                    self._pending_path.unlink(missing_ok=True)
                return "failed-no-previous"
            if self._prev is None:
                return "rollback-failed"
            self._activate(self._prev)
            self._swap(self._prev)
            self._drop_gateway_if_left_out(self._prev, bool(self._cand and self._cand.gateway))
            self._pending_path.unlink(missing_ok=True)
        except Exception as e:  # noqa: BLE001 — the outcome is recorded, never a traceback
            self.log(f"rollback failed: {self._scrub(str(e)) if isinstance(e, DeployError) else type(e).__name__}")
            return "rollback-failed"
        return "rolled-back"

    def _prune(self, keep: set[str]) -> None:
        """best effort: a failure here must not change what the deploy reported"""
        try:
            releases = self.cfg.install_dir / "releases"
            dirs = sorted((d for d in releases.iterdir() if d.is_dir() and d.name not in keep), key=lambda d: d.stat().st_mtime, reverse=True)
            for d in dirs[max(0, self.cfg.keep_releases - len(keep)):]:
                shutil.rmtree(d, ignore_errors=True)
        except OSError as e:
            self.log(f"prune skipped: {type(e).__name__}")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="/etc/sprintable/deployer.json")
    ap.add_argument("--force", action="store_true", help="retry the desired version even if it failed before")
    ap.add_argument("--db-only", action="store_true", help="start only the database of the desired release (to restore a dump before the first deploy)")
    args = ap.parse_args(argv[1:])
    cfg = Config.load(args.config)
    cfg.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(cfg.state_dir, 0o700)
    lock = open(cfg.state_dir / "lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another deploy is running", flush=True)
        return 0
    reader = renv.MetadataSecretReader(cfg.project)
    d = Deployer(cfg, GcsStore(reader), Runner(), reader, reader.token)
    outcome = d.db_only() if args.db_only else d.run_once(force=args.force)
    print(f"deployer: {outcome}", flush=True)
    return 1 if outcome in ("failed", "rolled-back", "rollback-failed", "failed-no-previous", "failed-state-unknown", "reconcile-failed") else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
