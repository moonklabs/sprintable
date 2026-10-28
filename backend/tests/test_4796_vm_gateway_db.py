"""story 4796 — the support gateway's own database on the VM (a second Postgres container, `gateway-db`), published on the VM's private address for the gateway on Cloud Run.

Decision (PO 2026-10-28): the gateway stays on Cloud Run (its own service account, no key, no VM identity), its database moves to the VM. The VPC-facing port belongs to a server that holds only the
gateway's data and a role of its own — nothing of the backend (its database, role or password) is reachable through it. Pinned: the deploy order and every compose call's profile, the environment (own
user, own database, own password, the bind address), that the address is the VM's PRIVATE one and nothing else, that a release without the block behaves as before, the failure paths, that a deploy never
stops the gateway's database, the compose pin (a release stays preparable after a compose change; a bundle cannot vouch for itself), the declaration rules, the compose service and the bundle build.
"""
from __future__ import annotations

import hashlib
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
_VM = _ROOT / "deploy/vm"


def _sibling(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


S = _sibling("test_4796_vm_deployer")
D, renv = S.D, S.renv
GW_PASSWORD = "feedfacefeedfacefeedfacefeedface"
GW_SECRET_ID = "SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV"
PRIVATE_IP = "10.178.0.2"


class GwRunner(S.FakeRunner):
    def __init__(self) -> None:
        super().__init__()
        self.gateway_db_up_ok = True
        self.gateway_db_probe_ok = True
        self.gateway_role_fails_for = 0   # how many times the question «does the application role own the database?» is answered «no»
        self.metadata_rc = 1

    def run(self, args, env, cwd=None, timeout=900, stdin=None):
        joined = " ".join(args)
        if args[:2] == ["docker", "compose"] and args[-1] == "gateway-db" and "up" in args:
            self.calls.append({"args": list(args), "env": dict(env), "stdin": stdin})
            return (0, "") if self.gateway_db_up_ok else (1, "gateway-db unhealthy")
        if "pg_isready" in joined:
            self.calls.append({"args": list(args), "env": dict(env), "stdin": stdin})
            if "pg_database" in joined and self.gateway_role_fails_for:
                self.gateway_role_fails_for -= 1
                return (1, "")
            return (0, "") if self.gateway_db_probe_ok else (1, "no response")
        return super().run(args, env, cwd=cwd, timeout=timeout, stdin=stdin)


def _make_world(tmp_path: Path, private_ip=lambda: PRIVATE_IP, secret_overrides: dict | None = None, extra_bundle: dict | None = None):
    decl = renv.load_declaration(_VM / "env/dev.yaml")
    plain = {name: {n: "plain" for n in svc["live_plain"]} for name, svc in decl["services"].items()}
    pp = tmp_path / "private-plain.json"
    pp.write_text(json.dumps(plain))
    pp.chmod(0o600)
    cfg = D.Config(environment="dev", project="proj", deploy_bucket=S.BUCKET, backups_bucket=S.BACKUPS, install_dir=tmp_path / "opt", state_dir=tmp_path / "state",
                   data_dir=tmp_path / "data", private_plain=pp, acme_email="ops@example.test", health_timeout=30, health_interval=5, trusted_compose=_VM / "compose.yml")
    store, runner, clock = S.FakeStore(), GwRunner(), S.Clock()
    logs: list[str] = []
    asked: list[str] = []

    def secrets(sid: str) -> str:
        asked.append(sid)
        table = {decl["database"]["password_secret"]: S.PASSWORD, GW_SECRET_ID: GW_PASSWORD + "\n", **(secret_overrides or {})}
        return table.get(sid, S.SECRET)

    dep = D.Deployer(cfg, store, runner, secrets, lambda: "vm-token-abc123", private_ip=private_ip, sleep=clock.sleep, now=clock.now, log=logs.append)

    def publish(sha: str = "a" * 40, bundle: bytes | None = None, **extra) -> dict:
        blob = bundle if bundle is not None else S._bundle(extra=extra_bundle)
        desired = {"sha": sha, "backend_image": f"{S.REG}/backend@{S._digest(sha)}", "frontend_image": f"{S.REG}/frontend-vm@{S._digest(sha)}",
                   "bundle": f"bundles/{sha}.tgz", "bundle_sha256": hashlib.sha256(blob).hexdigest(), **extra}
        store.objects[(S.BUCKET, f"bundles/{sha}.tgz")] = blob
        store.objects[(S.BUCKET, "desired.json")] = json.dumps(desired).encode()
        return desired

    return type("W", (), {"cfg": cfg, "store": store, "runner": runner, "clock": clock, "dep": dep, "publish": staticmethod(publish), "logs": logs, "asked": asked, "decl": decl})


@pytest.fixture()
def world(tmp_path: Path):
    return _make_world(tmp_path)


def _compose_calls(w) -> list[dict]:
    return [c for c in w.runner.calls if c["args"][:2] == ["docker", "compose"]]


def _profiles(c: dict) -> list[str]:
    a = c["args"]
    return [a[i + 1] for i, x in enumerate(a) if x == "--profile"]


def _without_block(tmp_path: Path) -> bytes:
    doc = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    doc.pop("support_gateway")
    return S._bundle(extra={"env/dev.yaml": yaml.safe_dump(doc).encode()})


# ── a release that carries the gateway's database ───────────────────────────────────────────────────────────────────────────────────────────

def test_the_gateway_database_comes_up_healthy_before_the_swap_and_is_checked_after_it(world) -> None:
    world.publish()
    assert world.dep.run_once() == "deployed"
    assert world.runner.verbs() == ["login", "pull", "logout", "up:db", "up:gwdb", "exec:gwdb-ready", "exec:gwdb-metadata", "run", "up:all", "exec:reload", "exec:gwdb-reload", "exec:health-be", "exec:health-fe", "exec:gwdb-ready"]


def test_every_compose_call_of_such_a_release_sees_the_gateway_database_service(world) -> None:
    world.publish()
    world.dep.run_once()
    for c in _compose_calls(world):
        assert "gateway-db" in _profiles(c), c["args"]
    assert (world.cfg.data_dir / "gateway-postgres").is_dir(), "its data folder is made before the container needs it"


def test_the_environment_gives_it_its_own_user_database_password_and_the_private_bind_address(world) -> None:
    world.publish()
    world.dep.run_once()
    up = next(c for c in _compose_calls(world) if "--wait-timeout" in c["args"])
    env = up["env"]
    assert (env["GATEWAY_DB_USER"], env["GATEWAY_DB_NAME"], env["GATEWAY_DB_BIND"]) == ("support_gw", "support_gateway", PRIVATE_IP)
    assert env["GATEWAY_DB_PASSWORD"] == GW_PASSWORD, "the gateway's own secret, one trailing line ending taken off"
    assert env["GATEWAY_DB_PASSWORD"] != env["POSTGRES_PASSWORD"] and "sprintable" not in env["GATEWAY_DB_USER"]
    assert not any(GW_PASSWORD in " ".join(c["args"]) for c in world.runner.calls), "the password is in no argument list"
    assert S.PASSWORD not in json.dumps({k: v for k, v in env.items() if k.startswith("GATEWAY_DB")}), "nothing of the backend's database in the gateway's environment"


def test_the_password_reaches_no_file_log_or_status(world) -> None:
    world.publish()
    world.dep.run_once()
    written = S._text_tree(world.cfg.install_dir / "runtime") + S._text_tree(world.cfg.state_dir)
    assert GW_PASSWORD not in written and GW_PASSWORD not in json.dumps(world.store.puts) and GW_PASSWORD not in "\n".join(world.logs)


@pytest.mark.parametrize("address", ["0.0.0.0", "127.0.0.1", "169.254.169.254", "8.8.8.8", "34.64.1.2", "::1", "fd20:ce::254", "", "not an ip", "10.0.0.1/8", "224.0.0.1"])
def test_only_a_private_ipv4_address_is_ever_a_bind_address(tmp_path: Path, address: str) -> None:
    w = _make_world(tmp_path, private_ip=lambda: address)
    w.publish()
    assert w.dep.run_once() == "failed" and w.runner.calls == []
    assert "private address" in S._state(w, "failed.json")["detail"] or "private IPv4" in S._state(w, "failed.json")["detail"]


@pytest.mark.parametrize("address", ["10.178.0.2", "172.16.5.4", "192.168.1.9", " 10.1.2.3\n"])
def test_a_private_address_is_accepted(tmp_path: Path, address: str) -> None:
    w = _make_world(tmp_path, private_ip=lambda: address)
    w.publish()
    assert w.dep.run_once() == "deployed"
    assert next(c for c in _compose_calls(w) if "--wait-timeout" in c["args"])["env"]["GATEWAY_DB_BIND"] == address.strip()


def test_an_unreachable_metadata_server_stops_the_release_before_anything_runs(tmp_path: Path) -> None:
    def down() -> str:
        raise OSError("metadata server unreachable")

    w = _make_world(tmp_path, private_ip=down)
    w.publish()
    assert w.dep.run_once() == "failed" and w.runner.calls == []


def test_a_deploy_that_cannot_read_the_address_at_all_stops_too(tmp_path: Path) -> None:
    w = _make_world(tmp_path)
    w.dep.private_ip = None
    w.publish()
    assert w.dep.run_once() == "failed" and w.runner.calls == []
    assert "cannot read the VM's private address" in S._state(w, "failed.json")["detail"]


def test_a_gateway_password_that_is_not_safe_stops_the_release(tmp_path: Path) -> None:
    w = _make_world(tmp_path, secret_overrides={GW_SECRET_ID: "has a space and 'quotes'"})
    w.publish()
    assert w.dep.run_once() == "failed" and w.runner.calls == []


# ── a release without the block behaves as before ────────────────────────────────────────────────────────────────────────────────────────────

def test_a_declaration_without_the_block_changes_nothing(tmp_path: Path) -> None:
    w = _make_world(tmp_path)
    w.publish(bundle=_without_block(tmp_path))
    assert w.dep.run_once() == "deployed"
    assert w.runner.verbs() == ["login", "pull", "logout", "up:db", "run", "up:all", "exec:reload", "exec:health-be", "exec:health-fe"]
    assert all(_profiles(c) == (["migrate"] if "migrate" in c["args"] else []) for c in _compose_calls(w))
    assert GW_SECRET_ID not in w.asked, "its secret is not read"
    up = next(c for c in _compose_calls(w) if "--wait-timeout" in c["args"])
    assert not [k for k in up["env"] if k.startswith("GATEWAY_DB")]
    assert not (w.cfg.data_dir / "gateway-postgres").exists()


def test_the_prod_declaration_has_no_gateway_database_yet() -> None:
    assert "support_gateway" not in renv.load_declaration(_VM / "env/prod.yaml")


def test_an_old_candidate_that_still_names_a_gateway_image_is_deployed_without_one(world) -> None:
    """candidates written by the build of the previous step carried `support_gateway_image`; the gateway no longer runs on the VM, so the key is simply not used"""
    d = world.publish(support_gateway_image=f"{S.REG}/support-gateway@{S._digest('gw')}")
    assert world.dep.run_once() == "deployed"
    assert "support-gateway" not in " ".join(" ".join(c["args"]) for c in world.runner.calls)
    assert not any(k.startswith("SUPPORT_GATEWAY") for c in world.runner.calls for k in c["env"])
    assert "support_gateway_image" not in S._state(world, "current.json")
    assert d["sha"] == S._state(world, "current.json")["sha"]


# ── failures ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_gateway_database_that_does_not_become_healthy_stops_the_release_before_the_swap(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.gateway_db_up_ok = False
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed"
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls), "no swap"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "support gateway database did not become healthy" in st["detail"]
    assert S._state(world, "current.json")["sha"] == "a" * 40


def test_a_gateway_database_that_stops_answering_after_the_swap_rolls_the_release_back(world) -> None:
    a = world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    orig = world.runner.run

    def run(args, env, **kw):
        if env.get("BACKEND_IMAGE") == a["backend_image"] and "up" in args:
            world.runner.gateway_db_probe_ok = True
        return orig(args, env, **kw)

    swapped = {"up": False}

    def run2(args, env, **kw):
        if env.get("BACKEND_IMAGE") != a["backend_image"] and "up" in args and "--wait-timeout" in args:
            world.runner.gateway_db_probe_ok = False   # the swap has happened: from here on the database does not answer
        return run(args, env, **kw)

    world.runner.run = run2
    assert world.dep.run_once() == "rolled-back"
    assert S._state(world, "current.json")["sha"] == "a" * 40


def test_a_deploy_never_stops_the_gateway_database_it_holds_the_gateways_data(world) -> None:
    """not on a rollback, not when the first release fails, not when a reconcile settles a dead swap"""
    a = world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.healthy_after = 10**6
    world.dep.run_once()          # b never becomes healthy → rolled back
    world.runner.healthy_after = 0
    (world.cfg.install_dir.parent / "fresh").mkdir()
    fresh = _make_world(world.cfg.install_dir.parent / "fresh")
    fresh.publish("c" * 40)
    fresh.runner.healthy_after = 10**6
    assert fresh.dep.run_once() == "failed-no-previous"
    for w in (world, fresh):
        stops = [c for c in _compose_calls(w) if "stop" in c["args"]]
        assert not [c for c in stops if "gateway-db" in c["args"][c["args"].index("stop"):]], "no compose call stops the gateway database"
    assert a["sha"] == S._state(world, "current.json")["sha"]


# ── the compose pin and the release that is running ─────────────────────────────────────────────────────────────────────────────────────────

def _with_own_trusted_compose(w, tmp_path: Path) -> Path:
    trusted = tmp_path / "trusted-compose.yml"
    trusted.write_text((_VM / "compose.yml").read_text())
    w.cfg.trusted_compose = trusted
    return trusted


def _changed_compose() -> bytes:
    doc = yaml.safe_load((_VM / "compose.yml").read_text())
    doc["x-after-the-change"] = "a compose change that needs a bootstrap run"
    return yaml.safe_dump(doc).encode()


def test_a_compose_change_does_not_strand_the_release_that_is_running(world, tmp_path: Path) -> None:
    """bootstrap installs the NEW compose as the trusted copy; the running release's folder still holds the old one. It was accepted when it was deployed, and that is remembered — otherwise the way back
    could not be prepared and the first deploy after a compose change could never start"""
    trusted = _with_own_trusted_compose(world, tmp_path)
    a = world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    stamp = world.cfg.install_dir / "releases" / ("a" * 40) / ".compose-sha256"
    assert stamp.read_text() == hashlib.sha256((_VM / "compose.yml").read_bytes()).hexdigest()
    new = _changed_compose()
    trusted.write_bytes(new)                                    # what `bootstrap.sh` does
    world.publish("b" * 40, bundle=S._bundle(extra={"compose.yml": new}))
    assert world.dep.run_once() == "deployed"
    assert S._state(world, "current.json")["previous"]["sha"] == a["sha"]


def test_without_the_stamp_the_old_release_is_refused_and_the_message_says_why(world, tmp_path: Path) -> None:
    trusted = _with_own_trusted_compose(world, tmp_path)
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    (world.cfg.install_dir / "releases" / ("a" * 40) / ".compose-sha256").unlink()
    new = _changed_compose()
    trusted.write_bytes(new)
    world.publish("b" * 40, bundle=S._bundle(extra={"compose.yml": new}))
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed" and world.runner.calls == []
    assert "running release cannot be prepared for a rollback" in S._state(world, "failed.json")["detail"]


def test_a_stamp_vouches_for_the_file_it_was_made_for_and_nothing_else(world, tmp_path: Path) -> None:
    trusted = _with_own_trusted_compose(world, tmp_path)
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    folder = world.cfg.install_dir / "releases" / ("a" * 40)
    new = _changed_compose()
    trusted.write_bytes(new)
    (folder / "compose.yml").write_text((folder / "compose.yml").read_text() + "\n# edited after it was accepted\n")
    world.publish("b" * 40, bundle=S._bundle(extra={"compose.yml": new}))
    assert world.dep.run_once() == "failed", "the stamp is a checksum of the file: an edited file is checked against the trusted copy again"


def test_a_bundle_cannot_bring_its_own_stamp(world, tmp_path: Path) -> None:
    _with_own_trusted_compose(world, tmp_path)
    evil = yaml.safe_load((_VM / "compose.yml").read_text())
    evil["services"]["backend"]["privileged"] = True
    blob = yaml.safe_dump(evil).encode()
    world.publish("a" * 40, bundle=S._bundle(extra={"compose.yml": blob, ".compose-sha256": hashlib.sha256(blob).hexdigest().encode()}))
    assert world.dep.run_once() == "failed" and world.runner.calls == []
    assert "compose.yml differs from the one installed" in S._state(world, "failed.json")["detail"]
    assert not (world.cfg.install_dir / "releases" / ("a" * 40) / ".compose-sha256").exists()


def test_a_release_whose_stamp_cannot_be_written_is_not_deployed(world) -> None:
    d = world.publish("a" * 40)
    release = world.cfg.install_dir / "releases" / d["sha"]
    obstacle = release / ".compose-sha256"
    obstacle.mkdir(parents=True)
    (obstacle / "in-the-way").write_text("x")  # a non-empty folder where the stamp file belongs: neither reading nor replacing it works
    (release / "compose.yml").write_bytes((_VM / "compose.yml").read_bytes())
    (release / ".bundle-sha256").write_text(d["bundle_sha256"])
    assert world.dep.run_once() == "failed"
    assert "compose stamp of the release cannot be written" in S._state(world, "failed.json")["detail"]
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls), "nothing was swapped"


def _stamp_block() -> str:
    text = (_VM / "bin/bootstrap.sh").read_text()
    return text[text.index("# releases already on this VM were checked against the compose copy"):text.index("# the compose file the deployer holds bundles to")]


def test_bootstrap_stamps_the_releases_whose_compose_equals_the_copy_it_is_about_to_replace(tmp_path: Path) -> None:
    import subprocess
    root = tmp_path / "opt"
    (root / "bin").mkdir(parents=True)
    (root / "bin/compose.yml").write_text("services: {a: {image: x}}\n")
    for name, body in (("same", "services: {a: {image: x}}\n"), ("other", "services: {a: {image: y}}\n")):
        (root / "releases" / name).mkdir(parents=True)
        (root / "releases" / name / "compose.yml").write_text(body)
    (root / "releases" / "empty").mkdir()
    script = _stamp_block().replace("/opt/sprintable", str(root))
    for _ in range(2):  # idempotent
        subprocess.run(["bash", "-euc", script], check=True, capture_output=True, text=True)
    assert (root / "releases/same/.compose-sha256").read_text() == hashlib.sha256((root / "releases/same/compose.yml").read_bytes()).hexdigest()
    assert not (root / "releases/other/.compose-sha256").exists() and not (root / "releases/empty/.compose-sha256").exists()
    fresh = tmp_path / "fresh"
    (fresh / "releases").mkdir(parents=True)
    subprocess.run(["bash", "-euc", _stamp_block().replace("/opt/sprintable", str(fresh))], check=True, capture_output=True, text=True)  # a first bootstrap: nothing to stamp, nothing to fail


def test_the_stamp_is_written_before_the_trusted_copy_is_replaced() -> None:
    text = (_VM / "bin/bootstrap.sh").read_text()
    assert text.index("compose-sha256") < text.index('install -m 0644 "$src/compose.yml" /opt/sprintable/bin/compose.yml')


# ── the declaration, the compose service, the bundle and its build ───────────────────────────────────────────────────────────────────────────

def _decl(tmp_path: Path, mutate) -> Path:
    doc = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    mutate(doc)
    p = tmp_path / "dev.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


def test_the_dev_declaration_names_the_gateway_database_and_its_own_secret() -> None:
    dev = renv.load_declaration(_VM / "env/dev.yaml")
    assert dev["support_gateway"]["database"] == {"user": "support_gw", "name": "support_gateway", "password_secret": GW_SECRET_ID}
    assert "support-gateway" not in dev["services"], "the gateway itself is not a service of the VM"


@pytest.mark.parametrize("mutate,message", [
    (lambda d: d["support_gateway"]["database"].pop("password_secret"), "lacks password_secret"),
    (lambda d: d["support_gateway"]["database"].update(user="Support GW; drop"), "plain lower-case identifiers"),
    (lambda d: d["support_gateway"]["database"].update(name="x y"), "plain lower-case identifiers"),
    (lambda d: d["support_gateway"]["database"].update(user="sprintable"), "must not share"),
    (lambda d: d["support_gateway"]["database"].update(password_secret="DB_PASSWORD_VM_DEV"), "must not share"),
])
def test_a_malformed_or_shared_gateway_database_is_refused(tmp_path: Path, mutate, message: str) -> None:
    with pytest.raises(renv.EnvError, match=message):
        renv.load_declaration(_decl(tmp_path, mutate))


def test_the_secret_list_for_the_grants_includes_the_gateway_password() -> None:
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        assert renv.main(["render_env.py", "--secret-ids", str(_VM / "env/dev.yaml")]) == 0
    ids = set(buf.getvalue().split())
    assert GW_SECRET_ID in ids and "DB_PASSWORD_VM_DEV" in ids


def test_the_private_address_check_is_the_one_the_deployer_uses() -> None:
    assert renv.check_private_address("10.1.2.3") == "10.1.2.3"
    for bad in ("0.0.0.0", "127.0.0.1", "8.8.8.8", "::1", "x"):
        with pytest.raises(renv.EnvError):
            renv.check_private_address(bad)


def test_the_metadata_reader_asks_for_the_first_interfaces_address_with_the_flavor_header() -> None:
    seen = {}

    def urlopen(req, timeout=0):
        seen["url"], seen["headers"] = req.full_url, dict(req.header_items())

        class R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"10.178.0.2"

        return R()

    reader = renv.MetadataSecretReader("proj", urlopen=urlopen)
    assert reader.private_ip() == "10.178.0.2"
    assert seen["url"] == "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip" and seen["headers"].get("Metadata-flavor") == "Google"


def test_the_compose_service_is_a_second_postgres_of_its_own_published_on_the_private_bind_only() -> None:
    doc = yaml.safe_load((_VM / "compose.yml").read_text())
    compose = doc["services"]
    gw = compose["gateway-db"]
    assert gw["image"] == compose["db"]["image"] == "pgvector/pgvector:pg15", "the image already on the VM, same major as the application's"
    assert gw["profiles"] == ["gateway-db"] and gw["restart"] == "no"
    assert gw["ports"] == ["${GATEWAY_DB_BIND:-127.0.0.1}:5432:5432"], "the private address the deployer reads, or the loopback address — never all interfaces"
    assert gw["volumes"][0] == "${DATA_DIR:?}/gateway-postgres:/var/lib/postgresql/data" and compose["db"]["volumes"] == ["${DATA_DIR:?}/postgres:/var/lib/postgresql/data"], "its own data folder"
    assert "max_connections=30" in gw["command"] and "max_connections=60" in compose["db"]["command"], "its own budget"
    assert gw["command"][:3] == ["postgres", "-c", "hba_file=/etc/postgresql/pg_hba.conf"], "the access rules are the mounted file"
    env = gw["environment"]
    assert "POSTGRES_PASSWORD" not in env, "the superuser has no password at all"
    assert env["POSTGRES_USER"] == "${GATEWAY_DB_ADMIN:-gw_admin}" and env["GATEWAY_APP_USER"] == "${GATEWAY_DB_USER:-support_gw}" and env["GATEWAY_APP_PASSWORD"].startswith("${GATEWAY_DB_PASSWORD")
    assert "${GATEWAY_DB_HBA:-./gateway-db-pg_hba.conf}:/etc/postgresql/pg_hba.conf:ro" in gw["volumes"] and "${GATEWAY_DB_INIT:-./gateway-db-init.sh}:/docker-entrypoint-initdb.d/10-gateway-db.sh:ro" in gw["volumes"]
    assert gw["networks"] == ["gateway-db"] and doc["networks"]["gateway-db"]["driver_opts"]["com.docker.network.bridge.name"] == "br-gwdb", "its own bridge, with the name the firewall rule uses"
    assert all("networks" not in compose[n] for n in ("db", "migrate", "backend", "frontend", "caddy")), "the others stay on the default network: they cannot reach the gateway's server"
    assert gw["healthcheck"]["test"][0] == "CMD-SHELL" and "pg_isready" in gw["healthcheck"]["test"][1]
    for name in ("db", "migrate", "backend", "frontend", "caddy"):
        assert "gateway" not in json.dumps(compose[name]).lower(), f"{name} knows nothing of the gateway's database"


def test_the_bundle_build_no_longer_resolves_a_gateway_image() -> None:
    build = (_ROOT / "cloudbuild-vm.yaml").read_text()
    assert "support-gateway" not in build and "support_gateway" not in build
    assert "--support-gateway-image" not in (_VM / "bin/make_bundle.py").read_text()


def test_the_runbook_section_says_the_decision_the_order_the_interruptions_the_commands_the_undo_and_the_tls_gap() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    sec = text.split("## 13. The support gateway's database on the VM")[1]
    for token in ("the gateway stays on Cloud Run", "a **second Postgres container of its own**", "34 + 6 = 40 of 57", "never «all interfaces»", "A deploy **never stops it**", "`DB_SERVICE=gateway-db`",
                  "**no container is restarted — no database or Caddy restart, no deploy interruption.**", "`deployer --force` measured 68 s", "the main database and Caddy are not touched",
                  "gcloud compute addresses create $VM-internal", "**Undo of this step:**", "ss -ltnp | grep ':5432'`",
                  "**No application-layer TLS in dev (accepted by the PO)", "**Required before prod", "unmeasured until this check", "Not in this step"):
        assert token in sec, token
    assert "SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV" in text.split("## 3. Database password")[1].split("## 4.")[0]
    prod = text.split("## 12. Prod")[1].split("## 13.")[0]
    assert "6. **TLS for the gateway's database**" in prod and "ssl=on" in prod and "sslmode=require" in prod
    assert "SUPPORT_GATEWAY_ADMIN_TOKEN_dev" not in text.split("## 3. Database password")[1].split("## 4.")[0], "the gateway is not on the VM: the VM account is granted nothing of the gateway's"


# ── what a database server writes to its log (the lens of the security domain, 2026-10-28) ──────────────────────────────────────────────────

def test_no_statement_carries_a_password_anywhere_in_the_deployer_or_the_compose_file() -> None:
    """the earlier design set the gateway's role with a psql script, whose statements (slow or failing) were written to the server's log with the password in them. Now the password reaches the server as the
    container's POSTGRES_PASSWORD, which the image hands to initdb through a password FILE — no statement holds it. Nothing in the deployer builds SQL or runs psql any more."""
    deployer = (_VM / "bin/deployer.py").read_text()
    assert "PASSWORD %L" not in deployer and "\\gexec" not in deployer and "CREATE ROLE" not in deployer.upper() and "ALTER ROLE" not in deployer.upper()
    mentions = [l.strip() for l in deployer.splitlines() if "psql" in l]
    assert len(mentions) == 2 and any("pg_reload_conf()" in m for m in mentions) and any("pg_database d join pg_roles r" in m or "-c '" in m for m in mentions), "the two psql commands of the deployer reload the access rules and ask whether the role owns the database"
    assert "PASSWORD" not in " ".join(mentions).upper(), "and neither carries a value"
    compose = (_VM / "compose.yml").read_text()
    assert "ALTER ROLE" not in compose.upper() and "CREATE ROLE" not in compose.upper()


def test_the_gateway_server_never_logs_the_values_a_statement_was_run_with() -> None:
    cmd = yaml.safe_load((_VM / "compose.yml").read_text())["services"]["gateway-db"]["command"]
    settings = {c.split("=", 1)[0]: c.split("=", 1)[1] for c in cmd if "=" in c and c != "postgres"}
    assert settings["log_parameter_max_length"] == "0" and settings["log_parameter_max_length_on_error"] == "0"
    assert settings["log_min_duration_statement"] == "1000", "slow statements are still logged — their text without the values"


@pytest.mark.parametrize("key,value", [("user", "sprintable'; DROP"), ("name", 'x" y'), ("name", "has\nnewline"), ("user", "UPPER"), ("name", ""), ("user", "a" * 64)])
def test_the_application_databases_names_are_plain_identifiers_too(tmp_path: Path, key: str, value: str) -> None:
    with pytest.raises(renv.EnvError, match=f"database.{key} must be a plain lower-case identifier"):
        renv.load_declaration(_decl(tmp_path, lambda d: d["database"].update({key: value})))


def test_the_real_declarations_pass_that_check() -> None:
    for env in ("dev", "prod"):
        assert renv.load_declaration(_VM / f"env/{env}.yaml")["database"]["name"] == "sprintable"


# ── AC7 (the security domain's lens): the access rules, the role, the metadata server, the budget ───────────────────────────────────────────

def test_the_access_rules_are_rendered_from_the_declaration_and_let_only_the_application_role_in(world) -> None:
    world.publish()
    world.dep.run_once()
    text = (world.cfg.install_dir / "runtime/gateway-db-pg_hba.conf").read_text()
    assert text == renv.gateway_hba(world.decl)
    rules = [l.split() for l in text.splitlines() if l and not l.startswith("#")]
    assert rules == [["local", "all", "all", "trust"], ["host", "support_gateway", "support_gw", "10.120.0.0/25", "scram-sha-256"], ["host", "all", "all", "0.0.0.0/0", "reject"], ["host", "all", "all", "::/0", "reject"]]
    assert oct((world.cfg.install_dir / "runtime/gateway-db-pg_hba.conf").stat().st_mode & 0o777) == "0o644"
    default = [l.split() for l in (_VM / "gateway-db-pg_hba.conf").read_text().splitlines() if l and not l.startswith("#")]
    assert default == [["local", "all", "all", "trust"], ["host", "all", "all", "0.0.0.0/0", "reject"], ["host", "all", "all", "::/0", "reject"]], "the fallback file lets nobody in over the network"


def _bundle_with_networks(networks: list[str]) -> bytes:
    doc = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    doc["support_gateway"]["allow_from"] = networks
    return S._bundle(extra={"env/dev.yaml": yaml.safe_dump(doc).encode()})


def _reloads(w) -> list[dict]:
    return [c for c in _compose_calls(w) if "pg_reload_conf" in " ".join(c["args"])]


def test_the_rules_file_is_rewritten_in_place_only_when_it_differs_and_every_swap_tells_the_server(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    path = world.cfg.install_dir / "runtime/gateway-db-pg_hba.conf"
    inode, mtime = path.stat().st_ino, path.stat().st_mtime_ns
    assert len(_reloads(world)) == 1
    world.publish("b" * 40)
    world.dep.run_once()
    assert path.stat().st_ino == inode and path.stat().st_mtime_ns == mtime, "the same content: the file is not touched"
    assert len(_reloads(world)) == 2, "each swap tells the server (cheap, and it makes the file and the running rules one thing)"
    path.write_text("# something else\n")   # a file that differs is put right again — in place, so the single-file mount still sees it
    world.publish("c" * 40)
    world.dep.run_once()
    assert path.stat().st_ino == inode and path.read_text() == renv.gateway_hba(world.decl) and len(_reloads(world)) == 3


def test_a_release_that_fails_before_the_swap_does_not_change_what_the_running_server_enforces(world) -> None:
    world.publish("a" * 40, bundle=_bundle_with_networks(["10.178.0.0/20"]))
    world.dep.run_once()
    path = world.cfg.install_dir / "runtime/gateway-db-pg_hba.conf"
    before = path.read_text()
    reloads = len(_reloads(world))
    world.publish("b" * 40, bundle=_bundle_with_networks(["10.200.0.0/20"]))
    world.runner.fail_on["migrate"] = 1
    assert world.dep.run_once() == "failed"
    assert path.read_text() == before and "10.200.0.0" not in path.read_text(), "the file was never changed, so a container started meanwhile (reboot, re-creation) reads the running release's networks"
    assert not _reloads(world)[reloads:], "and the server was not told anything"


def test_nothing_is_reloaded_when_there_was_no_gateway_database_to_go_back_to(world) -> None:
    world.publish("a" * 40, bundle=_without_block(Path(".")))
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    assert world.dep.run_once() == "failed"
    assert not _reloads(world), "the previous release has no gateway database: nothing to tell"


def test_a_rollback_gives_the_running_server_the_previous_releases_rules_again(world) -> None:
    a = world.publish("a" * 40, bundle=_bundle_with_networks(["10.178.0.0/20"]))
    world.dep.run_once()
    path = world.cfg.install_dir / "runtime/gateway-db-pg_hba.conf"
    world.publish("b" * 40, bundle=_bundle_with_networks(["10.200.0.0/20"]))
    orig = world.runner.run

    def run(args, env, **kw):
        if env.get("BACKEND_IMAGE") == a["backend_image"] and "up" in args:
            world.runner.healthy_after = 0
            world.runner._probes = 0
        return orig(args, env, **kw)

    world.runner.healthy_after = 10**6
    world.runner.run = run
    reloads_before = len(_reloads(world))
    assert world.dep.run_once() == "rolled-back"
    assert "10.178.0.0/20" in path.read_text() and "10.200.0.0" not in path.read_text()
    assert len(_reloads(world)) == reloads_before + 2, "the candidate's swap and the way back each told the server"


def test_a_rules_file_that_cannot_be_written_stops_the_release(world) -> None:
    world.publish()
    runtime = world.cfg.install_dir / "runtime"
    (runtime / "gateway-db-pg_hba.conf").mkdir(parents=True)   # a folder where the file belongs
    assert world.dep.run_once() == "failed" and "access rules of the gateway database cannot be written" in S._state(world, "failed.json")["detail"]
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls)


def test_a_reload_that_fails_after_the_swap_is_a_failed_swap(world) -> None:
    world.publish()
    world.runner.fail_on["pg_reload_conf"] = 1
    assert world.dep.run_once() == "failed-no-previous", "the server may enforce rules nobody checked: the release is not left serving"
    assert "did not reload its access rules" in S._state(world, "failed.json")["detail"]


def test_a_release_is_refused_when_the_gateway_database_container_can_reach_the_metadata_server(world) -> None:
    world.publish()
    world.runner.metadata_rc = 0
    assert world.dep.run_once() == "failed"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "metadata server is reachable from the gateway database container" in st["detail"]
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls), "no swap"


@pytest.mark.parametrize("rc,ok", [(1, True), (124, True), (0, False), (127, False), (126, False), (2, False)])
def test_only_a_refused_or_timed_out_connection_counts_as_unreachable(world, rc: int, ok: bool) -> None:
    """127/126 mean the probe itself could not run (no bash, no timeout): that is not an answer, so it is not accepted as one"""
    world.publish()
    world.runner.metadata_rc = rc
    assert (world.dep.run_once() == "deployed") is ok


def test_the_probe_asks_from_inside_the_gateway_container_with_a_timeout(world) -> None:
    world.publish()
    world.dep.run_once()
    probe = next(c for c in _compose_calls(world) if "169.254.169.254" in " ".join(c["args"]))
    tail = probe["args"][probe["args"].index("exec"):]
    assert tail[:4] == ["exec", "-T", "gateway-db", "bash"] and "timeout 3" in tail[-1] and "/dev/tcp/169.254.169.254/80" in tail[-1]


@pytest.mark.parametrize("value", [None, [], "10.178.0.0/20", ["8.8.8.0/24"], ["0.0.0.0/0"], ["10.0.0.0/8"], ["10.178.0.1/20"], ["fd00::/8"], ["not a network"], ["127.0.0.0/16"], ["169.254.0.0/16"],
                                    ["10.0.0.0/16", "10.1.0.0/16", "10.2.0.0/16", "10.3.0.0/16", "10.4.0.0/16"]])
def test_the_allowed_networks_are_a_short_list_of_narrow_private_networks(tmp_path: Path, value) -> None:
    with pytest.raises(renv.EnvError, match="allow_from"):
        renv.load_declaration(_decl(tmp_path, lambda d: d["support_gateway"].update(allow_from=value) if value is not None else d["support_gateway"].pop("allow_from")))


def test_the_real_declaration_names_the_gateways_own_subnet() -> None:
    assert renv.gateway_networks(renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"]) == ["10.120.0.0/25"]


def _init_run(tmp_path: Path, **env: str):
    """the first-start script, run for real with a fake psql that records its arguments and its standard input"""
    import os
    import stat
    import subprocess
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    psql = bin_dir / "psql"
    psql.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGS"\ncat > "$FAKE_STDIN"\n')
    psql.chmod(psql.stat().st_mode | stat.S_IEXEC)
    pgdata = tmp_path / "pgdata"
    pgdata.mkdir(exist_ok=True)
    rules = tmp_path / "pg_hba.conf"
    rules.write_text("local all all trust\n")
    script = tmp_path / "init.sh"
    script.write_text((_VM / "gateway-db-init.sh").read_text().replace("/etc/postgresql/pg_hba.conf", str(rules)))
    base = {"PATH": f"{bin_dir}:/usr/bin:/bin", "PGDATA": str(pgdata), "POSTGRES_USER": "gw_admin", "POSTGRES_DB": "support_gateway", "GATEWAY_APP_USER": "support_gw",
            "GATEWAY_APP_PASSWORD": GW_PASSWORD, "FAKE_ARGS": str(tmp_path / "args"), "FAKE_STDIN": str(tmp_path / "stdin"), "HOME": str(tmp_path)}
    p = subprocess.run(["bash", str(script)], env={**base, **env}, capture_output=True, text=True, timeout=30)
    args = (tmp_path / "args").read_text() if (tmp_path / "args").exists() else None
    stdin = (tmp_path / "stdin").read_text() if (tmp_path / "stdin").exists() else None
    return p, args, stdin, pgdata, rules


def test_the_first_start_script_makes_an_ordinary_role_with_logging_off_and_the_password_on_standard_input_only(tmp_path: Path) -> None:
    p, args, sql, pgdata, rules = _init_run(tmp_path)
    assert p.returncode == 0, p.stderr
    assert GW_PASSWORD not in args and GW_PASSWORD not in p.stdout + p.stderr, "the password is in no argument list and no output"
    lines = [l for l in sql.splitlines() if l.strip()]
    assert lines[:3] == ["SET log_min_duration_statement = -1;", "SET log_min_error_statement = 'panic';", "SET log_statement = 'none';"], "logging off BEFORE any statement that holds the password"
    create = next(l for l in lines if l.startswith("CREATE ROLE"))
    assert lines.index(create) > 2 and f"PASSWORD '{GW_PASSWORD}'" in create
    for word in ("NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOREPLICATION", "NOBYPASSRLS", "CONNECTION LIMIT 24"):
        assert word in create, word
    assert 'ALTER DATABASE "support_gateway" OWNER TO "support_gw";' in lines
    assert 'REVOKE ALL ON DATABASE "support_gateway" FROM PUBLIC;' in lines and 'GRANT CONNECT ON DATABASE "support_gateway" TO "support_gw";' in lines
    assert "REVOKE ALL ON DATABASE postgres FROM PUBLIC;" in lines and "REVOKE ALL ON DATABASE template1 FROM PUBLIC;" in lines
    assert "--username" in args and "gw_admin" in args and "ON_ERROR_STOP=1" in args
    assert (pgdata / "pg_hba.conf").read_text() == rules.read_text() and oct((pgdata / "pg_hba.conf").stat().st_mode & 0o777) == "0o600", "the data folder's own rules are replaced by the strict ones"


@pytest.mark.parametrize("env", [
    {"GATEWAY_APP_PASSWORD": "short"}, {"GATEWAY_APP_PASSWORD": "has a space in it 123456789"}, {"GATEWAY_APP_PASSWORD": "quote'quote'quote'quote'quote"}, {"GATEWAY_APP_PASSWORD": "semi;colon;semi;colon;123456"},
    {"GATEWAY_APP_USER": 'bad"name'}, {"GATEWAY_APP_USER": "Upper"}, {"POSTGRES_DB": "x y"}, {"POSTGRES_USER": "a;b"}, {"GATEWAY_APP_USER": "gw_admin"}, {"GATEWAY_APP_PASSWORD": ""}, {"GATEWAY_APP_USER": ""},
])
def test_the_first_start_script_refuses_anything_that_is_not_a_plain_name_or_a_safe_password_before_it_runs_a_statement(tmp_path: Path, env: dict) -> None:
    p, args, sql, pgdata, _ = _init_run(tmp_path, **env)
    assert p.returncode != 0 and args is None and sql is None, "psql was never called"
    assert not (pgdata / "pg_hba.conf").exists()


def test_the_first_start_script_stops_at_the_first_error_and_leaves_the_data_folders_rules_alone(tmp_path: Path) -> None:
    import stat
    (tmp_path / "bin").mkdir(exist_ok=True)
    failing = tmp_path / "bin" / "psql"
    failing.write_text("#!/bin/sh\ncat > /dev/null\nexit 3\n")
    failing.chmod(failing.stat().st_mode | stat.S_IEXEC)
    import subprocess
    pgdata = tmp_path / "pgdata"
    pgdata.mkdir()
    rules = tmp_path / "r.conf"
    rules.write_text("x\n")
    script = tmp_path / "init.sh"
    script.write_text((_VM / "gateway-db-init.sh").read_text().replace("/etc/postgresql/pg_hba.conf", str(rules)))
    p = subprocess.run(["bash", str(script)], env={"PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin", "PGDATA": str(pgdata), "POSTGRES_USER": "gw_admin", "POSTGRES_DB": "support_gateway", "GATEWAY_APP_USER": "support_gw",
                                                  "GATEWAY_APP_PASSWORD": GW_PASSWORD}, capture_output=True, text=True, timeout=30)
    assert p.returncode != 0 and not (pgdata / "pg_hba.conf").exists(), "a failed first start does not go on to install the rules as if it had worked"


def test_the_firewall_script_adds_its_rule_once_and_names_the_bridge_compose_gives_the_network(tmp_path: Path) -> None:
    import stat
    import subprocess
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    state = tmp_path / "rules"
    ipt = bin_dir / "iptables"
    ipt.write_text('#!/bin/sh\necho "iptables $*" >> "$LOG"\ncase "$1" in -C) [ -f "$STATE" ] ;; -I) touch "$STATE" ;; esac\n')
    ipt.chmod(ipt.stat().st_mode | stat.S_IEXEC)
    dk = bin_dir / "docker"
    dk.write_text("#!/bin/sh\nexit 0\n")
    dk.chmod(dk.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "LOG": str(tmp_path / "log"), "STATE": str(state), "HOME": str(tmp_path)}
    for _ in range(2):
        assert subprocess.run(["bash", str(_VM / "bin/gateway-db-firewall.sh")], env=env, capture_output=True, text=True, timeout=30).returncode == 0
    calls = (tmp_path / "log").read_text().splitlines()
    assert calls == ["iptables -C DOCKER-USER -i br-gwdb -d 169.254.169.254 -j DROP", "iptables -I DOCKER-USER 1 -i br-gwdb -d 169.254.169.254 -j DROP", "iptables -C DOCKER-USER -i br-gwdb -d 169.254.169.254 -j DROP"], calls
    compose = yaml.safe_load((_VM / "compose.yml").read_text())
    assert compose["networks"]["gateway-db"]["driver_opts"]["com.docker.network.bridge.name"] == "br-gwdb"


def test_bootstrap_installs_and_starts_the_firewall_unit_and_the_bundle_carries_the_two_files() -> None:
    boot = (_VM / "bin/bootstrap.sh").read_text()
    assert "gateway-db-firewall.sh; do" in boot and "systemctl enable --now sprintable-gateway-db-firewall.service" in boot
    assert "ExecStart=/opt/sprintable/bin/gateway-db-firewall.sh" in (_VM / "systemd/sprintable-gateway-db-firewall.service").read_text()
    bundle = _sibling_path("make_bundle")
    names = {p.relative_to(_VM).as_posix() for p in bundle.bundle_files(_VM)}
    assert {"gateway-db-init.sh", "gateway-db-pg_hba.conf", "bin/gateway-db-firewall.sh", "systemd/sprintable-gateway-db-firewall.service"} <= names


def _sibling_path(name: str):
    spec = importlib.util.spec_from_file_location(name, _VM / "bin" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_connection_budget_of_the_gateway_server_holds_the_overlap_of_two_revisions() -> None:
    """Cloud Run's maximum of 2 instances is per REVISION: while one is replaced the old revision's idle instances still hold their pool (3) beside the new revision's (3 + 2) — 2 × 3 + 2 × 5 = 16"""
    compose = yaml.safe_load((_VM / "compose.yml").read_text())["services"]["gateway-db"]["command"]
    max_connections = int(next(c for c in compose if c.startswith("max_connections=")).split("=")[1].split()[0])
    usable = max_connections - 3
    pool, overflow, instances = 3, 2, 2
    worst_overlap = instances * pool + instances * (pool + overflow)
    init = (_VM / "gateway-db-init.sh").read_text()
    limit = int(__import__("re").search(r"CONNECTION LIMIT (\d+)", init).group(1))
    assert (max_connections, usable, worst_overlap) == (30, 27, 16)
    assert worst_overlap + 1 <= limit <= usable, "the overlap and the migration job fit under the role's limit, and the limit under what the server leaves to ordinary roles"
    runbook = (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]
    assert "overlap worst case 2 × 3 + 2 × 5 = 16 of 27" in runbook and "The application role's own limit is 24" in runbook


def test_the_lens_of_the_security_domain_is_in_the_runbook_as_controls_that_can_be_run() -> None:
    sec = (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]
    for token in ("--priority 900 --action DENY --rules tcp:5432", "--priority 800 --action ALLOW --rules tcp:5432 --target-tags $VM --source-ranges \"$GWRANGE\"",
                  "**Negative — before step 5, as its hard condition:**", "told apart by SUBNET, not by tag", "`gw_admin|t` and `support_gw|f`", "permission denied to COPY to or from an external program",
                  "never 0", "grep -c -F -- \"$PW\"", "no password and no way in over any network address", "ordinary role", "never logs what a statement was run with",
                  "gcloud compute networks subnets create support-gateway-$ENV", "an empty value means the variable is not sent at all"):
        assert token in sec, token


def test_the_compose_environment_points_the_mount_at_the_rendered_rules_file(world) -> None:
    world.publish()
    world.dep.run_once()
    up = next(c for c in _compose_calls(world) if "--wait-timeout" in c["args"])
    assert up["env"]["GATEWAY_DB_HBA"] == str(world.cfg.install_dir / "runtime" / "gateway-db-pg_hba.conf")


def test_a_password_that_a_failing_command_echoes_is_scrubbed_from_what_is_recorded(world) -> None:
    world.publish()
    world.runner.gateway_db_up_ok = False
    world.runner.out_suffix = ""
    orig = world.runner.run

    def run(args, env, **kw):
        rc, out = orig(args, env, **kw)
        return (rc, out + f" … {GW_PASSWORD} …") if rc != 0 else (rc, out)

    world.runner.run = run
    assert world.dep.run_once() == "failed"
    st = S._state(world, "failed.json")
    assert GW_PASSWORD not in json.dumps(st) and "***" in st["detail"]
    assert GW_PASSWORD not in json.dumps(world.store.puts) and GW_PASSWORD not in "\n".join(world.logs)


def test_the_documents_that_describe_the_open_ports_know_about_the_gateway_databases_port() -> None:
    compose = (_VM / "compose.yml").read_text()
    assert "One more server listens, on the VM's PRIVATE address only" in compose.split("name: sprintable")[0]
    runbook = (_VM / "RUNBOOK.md").read_text()
    section4 = runbook.split("## 4. Address, firewall, disk, VM")[1].split("## 5.")[0]
    assert "The one other port** is 5432 of the support gateway's own database server" in section4 and "deny rule for everyone and an allow rule" in section4
    assert "**Rolling back across this step:**" in runbook.split("## 13. The support gateway's database")[1]
    assert "--remove-orphans" in runbook.split("**Rolling back across this step:**")[1].split("**Undo of this step:**")[0]


@pytest.mark.parametrize("rc", [0, 127])
def test_a_gateway_database_that_may_reach_the_metadata_server_is_stopped_and_the_release_refused(world, rc: int) -> None:
    world.publish()
    world.runner.metadata_rc = rc
    assert world.dep.run_once() == "failed"
    stops = [c for c in _compose_calls(world) if "stop" in c["args"]]
    assert len(stops) == 1 and stops[0]["args"][stops[0]["args"].index("stop"):] == ["stop", "gateway-db"], stops
    assert "was stopped" in S._state(world, "failed.json")["detail"] or "stopped" in S._state(world, "failed.json")["detail"]


@pytest.mark.parametrize("rc", [1, 124])
def test_a_refused_or_timed_out_probe_leaves_the_gateway_database_running(world, rc: int) -> None:
    world.publish()
    world.runner.metadata_rc = rc
    assert world.dep.run_once() == "deployed"
    assert not [c for c in _compose_calls(world) if "stop" in c["args"] and "gateway-db" in c["args"]]


def test_the_deploy_service_cannot_run_without_the_metadata_firewall_unit() -> None:
    unit = (_VM / "systemd/sprintable-deploy.service").read_text()
    assert re.search(r"^Requires=.*\bsprintable-gateway-db-firewall\.service\b", unit, re.M) and re.search(r"^After=.*\bsprintable-gateway-db-firewall\.service\b", unit, re.M)


def test_the_runbook_states_the_one_case_in_which_a_deploy_stops_the_gateway_database() -> None:
    rb = (_VM / "RUNBOOK.md").read_text()
    assert "except when the metadata server answers from inside it" in rb and "**requires** `sprintable-gateway-db-firewall.service`" in rb


def test_a_gateway_database_that_will_not_stop_is_killed_and_if_that_fails_the_failure_says_it_is_still_running(world) -> None:
    world.publish()
    world.runner.metadata_rc = 0
    world.runner.fail_on[" stop gateway-db"] = 1
    assert world.dep.run_once() == "failed"
    verbs = [c["args"][-2] for c in _compose_calls(world) if c["args"][-1] == "gateway-db" and c["args"][-2] in ("stop", "kill")]
    assert verbs == ["stop", "kill"] and "which was stopped" in S._state(world, "failed.json")["detail"]
    (world.cfg.install_dir.parent / "o").mkdir()
    other = _make_world(world.cfg.install_dir.parent / "o")
    other.publish("d" * 40)
    other.runner.metadata_rc = 0
    other.runner.fail_on[" stop gateway-db"] = 1
    other.runner.fail_on[" kill gateway-db"] = 1
    assert other.dep.run_once() == "failed"
    assert "COULD NOT BE STOPPED" in S._state(other, "failed.json")["detail"] and "still running" in S._state(other, "failed.json")["detail"]


def test_the_gateway_database_container_has_no_restart_policy_so_that_only_the_firewall_unit_starts_it() -> None:
    gw = yaml.safe_load((_VM / "compose.yml").read_text())["services"]["gateway-db"]
    assert gw["restart"] == "no"
    unit = (_VM / "systemd/sprintable-gateway-db-firewall.service").read_text()
    assert re.search(r"^WantedBy=multi-user\.target$", unit, re.M) and re.search(r"^PartOf=docker\.service$", unit, re.M), "it runs at every boot and again whenever docker restarts"


def _firewall_world(tmp_path: Path, container_id: str, iptables_ok: bool = True):
    import stat
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ipt = bin_dir / "iptables"
    ipt.write_text('#!/bin/sh\necho "iptables $*" >> "$LOG"\n' + ('case "$1" in -C) [ -f "$STATE" ] ;; -I) touch "$STATE" ;; esac\n' if iptables_ok else 'exit 1\n'))
    dk = bin_dir / "docker"
    dk.write_text('#!/bin/sh\necho "docker $*" >> "$LOG"\ncase "$1" in ps) printf "%s" "$CID" ;; esac\n')
    for f in (ipt, dk):
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return {"PATH": f"{bin_dir}:/usr/bin:/bin", "LOG": str(tmp_path / "log"), "STATE": str(tmp_path / "rules"), "HOME": str(tmp_path), "CID": container_id}


def test_the_firewall_unit_starts_the_gateway_database_only_after_the_rule_is_in_place(tmp_path: Path) -> None:
    import subprocess
    env = _firewall_world(tmp_path, "gwc999")
    assert subprocess.run(["bash", str(_VM / "bin/gateway-db-firewall.sh")], env=env, capture_output=True, text=True, timeout=30).returncode == 0
    calls = (tmp_path / "log").read_text().splitlines()
    rule = next(i for i, c in enumerate(calls) if c.startswith("iptables -I"))
    start = next(i for i, c in enumerate(calls) if c == "docker start gwc999")
    assert rule < start
    ps = next(c for c in calls if c.startswith("docker ps"))
    assert "-a" in ps and "label=com.docker.compose.service=gateway-db" in ps and "label=com.docker.compose.project=sprintable" in ps


def test_nothing_is_started_when_the_rule_could_not_be_put_in_place_or_when_there_is_no_container(tmp_path: Path) -> None:
    import subprocess
    env = _firewall_world(tmp_path / "a", "gwc999", iptables_ok=False) if (tmp_path / "a").mkdir() is None else None
    assert subprocess.run(["bash", str(_VM / "bin/gateway-db-firewall.sh")], env=env, capture_output=True, text=True, timeout=30).returncode != 0
    assert "docker start" not in (tmp_path / "a" / "log").read_text() if (tmp_path / "a" / "log").exists() else True
    (tmp_path / "b").mkdir()
    env2 = _firewall_world(tmp_path / "b", "")
    assert subprocess.run(["bash", str(_VM / "bin/gateway-db-firewall.sh")], env=env2, capture_output=True, text=True, timeout=30).returncode == 0
    assert "docker start" not in (tmp_path / "b" / "log").read_text()


def test_the_runbook_states_boot_order_the_stuck_container_and_the_shut_door() -> None:
    rb = (_VM / "RUNBOOK.md").read_text()
    for token in ("its restart policy is «no»", "and only THEN starts it", "COULD NOT BE STOPPED", "first **shuts the door**", "leaves the door shut and prints the one command that opens it", "It never drops the gateway's database before the replacement has loaded"):
        assert token in rb, token


def test_the_candidates_rules_reach_the_file_only_after_pending_json_and_a_first_start_finds_its_file(world) -> None:
    world.publish("a" * 40, bundle=_bundle_with_networks(["10.178.0.0/20"]))
    path = world.cfg.install_dir / "runtime/gateway-db-pg_hba.conf"
    seen: dict[str, tuple[str | None, bool]] = {}
    orig = world.runner.run

    def run(args, env, **kw):
        joined = " ".join(args)
        stage = "gwdb-up" if "up -d --wait gateway-db" in joined else "migrate" if " run --rm migrate" in joined or "run --rm" in joined else "swap-up" if "--wait-timeout" in joined else None
        if stage:
            seen[stage] = (path.read_text() if path.exists() else None, (world.cfg.state_dir / "pending.json").exists())
        return orig(args, env, **kw)

    world.runner.run = run
    world.dep.run_once()
    a_rules = path.read_text()
    assert seen["gwdb-up"][0] == a_rules and "10.178.0.0/20" in a_rules, "a first start finds its rules file"
    seen.clear()
    world.publish("b" * 40, bundle=_bundle_with_networks(["10.200.0.0/20"]))
    world.dep.run_once()
    assert "10.178.0.0/20" in seen["gwdb-up"][0] and "10.200.0.0" not in seen["gwdb-up"][0], "the running release's rules while the database is brought up"
    assert "10.200.0.0" not in seen["migrate"][0] and seen["migrate"][1] is False, "and still while the migration runs, before pending.json"
    assert "10.200.0.0" in seen["swap-up"][0] and seen["swap-up"][1] is True, "the candidate's rules are in the file only inside the swap, with pending.json already written"


def test_the_backup_and_restore_check_units_come_after_the_unit_that_starts_the_gateway_database() -> None:
    for name in ("sprintable-backup.service", "sprintable-restore-check.service"):
        unit = (_VM / "systemd" / name).read_text()
        assert re.search(r"^After=.*\bsprintable-gateway-db-firewall\.service\b", unit, re.M) and re.search(r"^Wants=.*\bsprintable-gateway-db-firewall\.service\b", unit, re.M), name


def test_the_firewall_unit_waits_until_the_database_answers_and_does_not_fail_when_it_does_not(tmp_path: Path) -> None:
    import subprocess
    env = _firewall_world(tmp_path, "gwc999")
    (tmp_path / "bin" / "docker").write_text('#!/bin/sh\necho "docker $*" >> "$LOG"\ncase "$1" in ps) printf "%s" "$CID" ;; exec) exit 1 ;; esac\n')
    (tmp_path / "bin" / "sleep").write_text("#!/bin/sh\necho sleep >> \"$LOG\"\n")
    (tmp_path / "bin" / "sleep").chmod(0o755)
    p = subprocess.run(["bash", str(_VM / "bin/gateway-db-firewall.sh")], env=env, capture_output=True, text=True, timeout=60)
    calls = (tmp_path / "log").read_text().splitlines()
    assert p.returncode == 0, "a server that never answers is not this unit's failure"
    assert calls.count("sleep") == 60 and sum(1 for c in calls if c.startswith("docker exec gwc999 pg_isready")) == 60, "bounded at 60 tries"


def test_the_runbook_states_when_the_rules_file_changes_and_the_order_of_the_backup_after_boot() -> None:
    rb = (_VM / "RUNBOOK.md").read_text()
    for token in ("**only inside the swap, after `pending.json` exists**", "settled by the next run, which puts the recorded release's rules back", "the backup and restore-check units are ordered after that unit"):
        assert token in rb, token


def test_no_mount_of_the_gateway_database_depends_on_the_release_folder() -> None:
    gw = yaml.safe_load((_VM / "compose.yml").read_text())["services"]["gateway-db"]
    for v in gw["volumes"]:
        source = v.split(":")[0]
        assert source.startswith("${"), f"{v}: a relative source changes with every release folder and makes compose re-create the running container"
    assert any(v.startswith("${GATEWAY_DB_INIT:-") for v in gw["volumes"]) and any(v.startswith("${GATEWAY_DB_HBA:-") for v in gw["volumes"])


def test_the_environment_of_the_gateway_database_is_the_same_for_every_release_and_points_outside_the_release_folders(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    world.dep.run_once()
    ups = [c for c in _compose_calls(world) if "up" in c["args"] and c["args"][-1] == "gateway-db" and "--wait" in c["args"]]
    assert len(ups) == 2
    mounts = [(c["env"]["GATEWAY_DB_INIT"], c["env"]["GATEWAY_DB_HBA"]) for c in ups]
    assert mounts[0] == mounts[1], "the same mount sources for both releases"
    runtime = str(world.cfg.install_dir / "runtime")
    assert all(m.startswith(runtime + "/") and "/releases/" not in m for m in mounts[0])
    assert (world.cfg.install_dir / "runtime/gateway-db-init.sh").read_text() == (_VM / "gateway-db-init.sh").read_text(), "the script the first start runs is the release's own"


def _bundle_without(name: str) -> bytes:
    import io
    import tarfile
    src = tarfile.open(fileobj=io.BytesIO(S._bundle()), mode="r:gz")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as out:
        for m in src.getmembers():
            if m.name != name:
                out.addfile(m, src.extractfile(m))
    return buf.getvalue()


def test_a_release_without_the_first_start_script_stops_before_anything_runs(world) -> None:
    world.publish("a" * 40, bundle=_bundle_without("gateway-db-init.sh"))
    assert world.dep.run_once() == "failed"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "gateway-db-init.sh" in st["detail"]
    assert not [c for c in _compose_calls(world) if "up" in c["args"]], "nothing was started"


def _gateway_ups(w) -> list[dict]:
    return [c for c in _compose_calls(w) if "up" in c["args"] and c["args"][-1] == "gateway-db" and "--wait" in c["args"]]


def test_a_release_that_fails_before_the_swap_brings_the_gateway_database_back_as_the_running_release_has_it(world) -> None:
    a = world.publish("a" * 40)
    world.dep.run_once()
    ups_before = len(_gateway_ups(world))
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    assert world.dep.run_once() == "failed"
    ups = _gateway_ups(world)[ups_before:]
    assert len(ups) == 2, "the candidate's own start, then the way back"
    assert ups[0]["env"]["BACKEND_IMAGE"] != a["backend_image"] and ups[1]["env"]["BACKEND_IMAGE"] == a["backend_image"], "with the RUNNING release's environment"


def test_a_gateway_database_that_was_stopped_for_the_metadata_server_is_not_started_again_by_the_way_back(world) -> None:
    world.publish("a" * 40)
    world.dep.run_once()
    ups_before = len(_gateway_ups(world))
    world.publish("b" * 40)
    world.runner.metadata_rc = 0
    assert world.dep.run_once() == "failed"
    assert len(_gateway_ups(world)) == ups_before + 1, "only the candidate's own start: the closed container stays closed"


def test_nothing_is_brought_back_when_the_running_release_had_no_gateway_database(world) -> None:
    world.publish("a" * 40, bundle=_without_block(Path(".")))
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    assert world.dep.run_once() == "failed"
    assert len(_gateway_ups(world)) == 1, "the candidate's own start only"


def test_the_runbook_states_that_a_failed_release_gives_the_gateway_database_back_as_it_was() -> None:
    assert "the deployer brings the database back **as the running release has it**" in (_VM / "RUNBOOK.md").read_text()


def test_the_runbook_says_the_internal_address_must_stay_the_same_after_step_3() -> None:
    rb = (_VM / "RUNBOOK.md").read_text()
    assert "**the address must never change afterwards**" in rb and "the secret would have to follow before the next deploy" in rb


# ── the review of the security domain (2026-10-28): one transaction, two different secrets, the order of the firewall, what a public repository says ──────────────────────

def test_the_first_start_statements_run_as_one_transaction_after_the_logging_is_off(tmp_path: Path) -> None:
    p, args, sql, pgdata, rules = _init_run(tmp_path)
    assert p.returncode == 0, p.stderr
    lines = [l for l in sql.splitlines() if l.strip()]
    begin, commit = lines.index("BEGIN;"), lines.index("COMMIT;")
    assert lines[:3] == ["SET log_min_duration_statement = -1;", "SET log_min_error_statement = 'panic';", "SET log_statement = 'none';"] and begin == 3, "the session settings come first and stay outside the transaction"
    assert commit == len(lines) - 1
    inside = lines[begin + 1:commit]
    assert [l.split()[0] for l in inside] == ["CREATE", "ALTER", "REVOKE", "GRANT", "REVOKE", "REVOKE"] and all(l.endswith(";") for l in inside), inside


def _postgres_binaries() -> Path | None:
    import glob
    import shutil
    found = shutil.which("initdb")
    cands = [Path(found).parent] if found else []
    cands += [Path(p).parent for p in sorted(glob.glob("/usr/lib/postgresql/*/bin/initdb") + glob.glob("/opt/homebrew/opt/postgresql@*/bin/initdb"), reverse=True)]
    return cands[0] if cands else None


@pytest.mark.skipif(_postgres_binaries() is None or os.geteuid() == 0, reason="needs the Postgres binaries and a user that is not root (initdb refuses root)")
def test_on_a_real_server_a_first_start_that_fails_leaves_no_role_behind_and_can_be_run_again(tmp_path: Path) -> None:
    """what the lens of the security domain reproduced: with statements that commit one by one, the second one failing left the role of the first one (and the script could not be run again: «role exists»)"""
    import shutil
    import subprocess
    import tempfile
    bins = _postgres_binaries()
    work = Path(tempfile.mkdtemp(prefix="gwinit"))   # short: a unix socket path has a length limit
    port = str(50000 + (os.getpid() % 10000))
    try:
        data, sock = work / "data", work / "sock"
        sock.mkdir()
        run = lambda *a, **kw: subprocess.run([str(bins / a[0]), *a[1:]], capture_output=True, text=True, timeout=60, **kw)  # noqa: E731
        assert run("initdb", "-D", str(data), "-U", "gw_admin", "--auth-local=trust", "--auth-host=trust").returncode == 0
        assert run("pg_ctl", "-D", str(data), "-l", str(work / "log"), "-o", f"-c listen_addresses='' -k {sock} -p {port} -c log_min_duration_statement=0", "-w", "start").returncode == 0
        assert run("createdb", "-h", str(sock), "-p", port, "-U", "gw_admin", "support_gateway").returncode == 0
        rules = work / "pg_hba.conf"
        rules.write_text("local all all trust\n")
        script = work / "init.sh"
        script.write_text((_VM / "gateway-db-init.sh").read_text().replace("/etc/postgresql/pg_hba.conf", str(rules)))
        env = {"PATH": f"{bins}:/usr/bin:/bin", "PGHOST": str(sock), "PGPORT": port, "PGDATA": str(data), "POSTGRES_USER": "gw_admin", "POSTGRES_DB": "support_gateway",
               "GATEWAY_APP_USER": "support_gw", "GATEWAY_APP_PASSWORD": GW_PASSWORD, "HOME": str(work)}
        roles = lambda: run("psql", "-h", str(sock), "-p", port, "-U", "gw_admin", "-d", "postgres", "-X", "-A", "-t", "-c", "select rolname from pg_roles where rolname = 'support_gw'").stdout.strip()  # noqa: E731
        failing = subprocess.run(["bash", str(script)], env={**env, "POSTGRES_DB": "no_such_database"}, capture_output=True, text=True, timeout=60)
        assert failing.returncode != 0 and roles() == "", "the role of the first statement is not left behind by the second one failing"
        again = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=60)
        assert again.returncode == 0 and roles() == "support_gw", again.stderr
        flags = run("psql", "-h", str(sock), "-p", port, "-U", "gw_admin", "-d", "postgres", "-X", "-A", "-t", "-c",
                    "select rolsuper::text || rolconnlimit from pg_roles where rolname = 'support_gw'").stdout.strip()
        assert flags == "false24"
        assert GW_PASSWORD not in (work / "log").read_text(), "and the password is in no line of the log, with every statement logged"
    finally:
        subprocess.run([str(bins / "pg_ctl"), "-D", str(work / "data"), "-m", "immediate", "stop"], capture_output=True, timeout=60)
        shutil.rmtree(work, ignore_errors=True)


@pytest.mark.parametrize("gw_secret_value", [S.PASSWORD, S.PASSWORD + "\n", S.PASSWORD + "\r\n"])
def test_a_gateway_password_that_is_the_same_value_as_the_main_databases_stops_the_release(tmp_path: Path, gw_secret_value: str) -> None:
    world = _make_world(tmp_path, secret_overrides={GW_SECRET_ID: gw_secret_value})
    world.publish()
    assert world.dep.run_once() == "failed"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "the same value as the main database's" in st["detail"]
    assert S.PASSWORD not in st["detail"] and not [c for c in world.runner.calls if "up" in c["args"]], "named by words only, nothing was started"


def test_two_different_passwords_are_still_accepted(tmp_path: Path) -> None:
    world = _make_world(tmp_path)
    world.publish()
    assert world.dep.run_once() == "deployed"


def test_the_runbook_makes_the_firewall_a_hard_condition_of_step_five_and_measures_the_negative_control_before_it() -> None:
    rb = (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]
    row5 = next(l for l in rb.splitlines() if l.startswith("| 5 |"))
    assert "only after the firewall pair of step 3 exists and the negative control below has been measured" in row5 and "times out" in row5 and "«refused»" in row5
    assert "**Negative — before step 5, as its hard condition:**" in rb and "**Positive — after step 5, before any data moves:**" in rb


def test_the_public_repository_does_not_describe_what_the_projects_broad_rule_lets_reach_the_vm() -> None:
    """patterns, not the phrases themselves: this file must not carry the sentence it forbids"""
    banned = [r"default-allow-\w+", r"\bEVERY\s+machine", r"every\s+machine\s+on\s+the\s+default", r"priority\s+6553\d", r"prod's\s+among"]
    for path in ("RUNBOOK.md", "compose.yml", "bin/gateway-db-firewall.sh", "CUTOVER-gateway-dev.md"):
        f = _VM / path
        if not f.exists():
            continue
        text = f.read_text()
        for pattern in banned:
            assert not re.search(pattern, text), (path, pattern)
    assert "A broader allow rule exists separately in the project, so an allow rule alone would narrow nothing" in (_VM / "RUNBOOK.md").read_text()


def test_the_metadata_rule_is_ipv4_only_and_says_so_while_nothing_enables_ipv6() -> None:
    script = (_VM / "bin/gateway-db-firewall.sh").read_text()
    assert "IPv4 only, on purpose" in script and "ip6tables" in script
    compose = yaml.safe_load((_VM / "compose.yml").read_text())
    assert not compose["networks"]["gateway-db"].get("enable_ipv6"), "the bridge has no IPv6 network"
    assert "The rule that keeps the metadata server out of reach is IPv4 only" in (_VM / "RUNBOOK.md").read_text()


def _runbook_probe_program() -> str:
    rb = (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]
    return rb.split("**Step 3b")[1].split("PROBE='^@^-c@")[1].split("@'\"$VMIP\"")[0]


def test_the_negative_control_of_step_five_can_be_run_from_the_runbook_alone() -> None:
    rb = (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]
    sec = rb.split("**Step 3b")[1].split("The tag reaches the gateway's revisions")[0]
    for token in ("STAMP=$(date -u +%m%d%H%M%S)$RANDOM", "PROBESA_ID=gwdb-probe-$STAMP", "PJU=gwdb-probe-untagged-$STAMP", "gcloud iam service-accounts create $PROBESA_ID", "&& SA_MADE=$PROBESA_ID",
                  '[ "$SA_MADE" = "$PROBESA_ID" ] && gcloud run jobs create "$PJU"', "&& JOB_MADE=$PJU", "--network default --subnet default --vpc-egress private-ranges-only",
                  '[ "$JOB_MADE" = "$PJU" ] && gcloud run jobs execute "$PJU"', "--wait || true", '[ "$JOB_MADE" = "$PJU" ] && for n in 1 2 3 4 5 6; do gcloud logging read', "| grep '^result' && break; sleep 10; done",
                  '[ -n "$VMIP" ] && gcloud iam service-accounts create $PROBESA_ID', "STOP: no address to probe",
                  '[ "$JOB_MADE" = "$PJU" ] && gcloud run jobs delete "$PJU"', '[ "$SA_MADE" = "$PROBESA_ID" ] && gcloud iam service-accounts delete $PROBESA', "--service-account $PROBESA",
                  "**Pass: the log line is `result <n> TIMEOUT`**", "is not the container's exit code", "**`REFUSED`: the deny rule is missing — stop**", "**`OTHER`: the job could not reach the network at all", "positive control after step 5",
                  "holds **no role at all**"):
        assert token in sec, token
    command_lines = [l for l in sec.split("**Pass:")[0].splitlines() if "gcloud run jobs create" in l and not l.startswith("#")]
    assert len(command_lines) == 1 and "--network-tags" not in command_lines[0], "the job that is meant to carry NO tag carries none"
    assert "support-gateway-dev@" not in sec.split("**Pass:")[0], "the gateway's own account is not used"
    assert 'echo "untagged' not in sec, "gcloud's status after --wait is not printed as if it were the container's exit code"
    assert "next change" not in rb.split("**Step 3b")[1].split("**Checks after step 5")[0], "nothing the gate needs is deferred to a later change"


def _run_probe(code: str, tmp: Path) -> subprocess.CompletedProcess:
    """the program of the RUNBOOK, as written, with a socket whose connect_ex answers the given errno (by name)"""
    import subprocess
    (tmp / "socket.py").write_text(
        "import errno, os\n\nclass socket:\n    def settimeout(self, t):\n        pass\n    def connect_ex(self, addr):\n        assert addr[1] == 5432\n        n = os.environ['FAKE_ERRNO']\n        return 0 if n == '0' else getattr(errno, n)\n")
    return subprocess.run(["python3", "-c", _runbook_probe_program(), "10.178.0.9"], capture_output=True, text=True, timeout=30,
                          env={"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(tmp), "FAKE_ERRNO": code})


@pytest.mark.parametrize("name,exit_code,word", [("0", 0, "REACHED"), ("ECONNREFUSED", 4, "REFUSED"), ("EAGAIN", 3, "TIMEOUT"), ("ETIMEDOUT", 3, "TIMEOUT"),
                                                  ("EHOSTUNREACH", 5, "OTHER"), ("ENETUNREACH", 5, "OTHER"), ("EPERM", 5, "OTHER")])
def test_the_probe_of_the_runbook_tells_a_dropped_packet_from_a_refusal_and_from_a_missing_route(tmp_path: Path, name: str, exit_code: int, word: str) -> None:
    p = _run_probe(name, tmp_path)
    assert p.returncode == exit_code and p.stdout.split()[0] == "result" and p.stdout.split()[-1] == word, (p.stdout, p.stderr)


def _step_3b_block() -> str:
    rb = (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]
    return rb.split("**Step 3b")[1].split("```bash\n")[1].split("```")[0]


def _run_step_3b(tmp_path: Path, shell_flags: tuple = (), vmip_empty: bool = False, **fail) -> tuple[subprocess.CompletedProcess, list[str]]:
    """the block of the RUNBOOK as written, against a fake gcloud that records its calls; `fail` names the commands that fail (iam_create, job_create, execute) or answer nothing (no_log)"""
    import stat
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    calls = tmp_path / "calls.log"
    calls.write_text("")
    g = b / "gcloud"
    g.write_text(
        "#!/bin/sh\n"
        'echo "gcloud $*" >> "$CALLS"\n'
        'case "$*" in\n'
        '  "compute instances describe"*) [ -n "$F_NOIP" ] || printf 10.178.0.9 ;;\n'
        '  "run services describe"*) printf img ;;\n'
        '  "iam service-accounts create"*) [ -n "$F_IAM" ] && exit 1 ;;\n'
        '  "run jobs create"*) [ -n "$F_JOB" ] && exit 1 ;;\n'
        '  "run jobs execute"*) exit 1 ;;\n'
        '  "logging read"*) [ -n "$F_NOLOG" ] || echo "result 11 TIMEOUT" ;;\n'
        "esac\n"
        "exit 0\n")
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    slp = b / "sleep"
    slp.write_text('#!/bin/sh\necho sleep >> "$CALLS"\n')
    slp.chmod(slp.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "CALLS": str(calls), "ENV": "dev", "PROJECT": "p", "REGION": "r", "ZONE": "z", "VM": "vm",
           "F_IAM": "1" if fail.get("iam_create") else "", "F_JOB": "1" if fail.get("job_create") else "", "F_NOLOG": "1" if fail.get("no_log") else "",
           "F_NOIP": "1" if vmip_empty else ""}
    p = subprocess.run(["bash", *shell_flags, "-c", _step_3b_block()], capture_output=True, text=True, timeout=30, env=env, cwd=tmp_path)
    return p, calls.read_text().splitlines()


def _count(calls: list[str], prefix: str) -> int:
    return sum(1 for c in calls if c.startswith(prefix))


def test_step_3b_runs_the_job_even_though_its_expected_answer_is_a_failure_and_cleans_up_what_it_made(tmp_path: Path) -> None:
    p, calls = _run_step_3b(tmp_path)
    assert p.returncode == 0, p.stderr
    assert _count(calls, "gcloud iam service-accounts create gwdb-probe-") == 1 and _count(calls, "gcloud run jobs create gwdb-probe-untagged-") == 1
    assert _count(calls, "gcloud run jobs execute gwdb-probe-untagged-") == 1 and _count(calls, "gcloud run jobs delete gwdb-probe-untagged-") == 1, "the execute failed, the job is still deleted"
    assert "result 11 TIMEOUT" in p.stdout and _count(calls, "sleep") == 0, "the log line is found at once"
    names = {c.split()[4] for c in calls if c.startswith("gcloud run jobs create") or c.startswith("gcloud run jobs delete")}
    assert len(names) == 1, "the job that is deleted is the job that was created"
    sa_id = next(c.split()[4] for c in calls if c.startswith("gcloud iam service-accounts create"))
    assert any(f"--service-account {sa_id}@p.iam.gserviceaccount.com" in c for c in calls if c.startswith("gcloud run jobs create")), "the job runs as the account made for it"


def test_step_3b_does_nothing_after_a_create_that_failed(tmp_path: Path) -> None:
    p, calls = _run_step_3b(tmp_path, iam_create=True)
    assert _count(calls, "gcloud run jobs create") == 0 and _count(calls, "gcloud run jobs execute") == 0 and _count(calls, "gcloud run jobs delete") == 0, "an account that could not be made means no job, and no delete"
    (tmp_path / "j").mkdir()
    p2, calls2 = _run_step_3b(tmp_path / "j", job_create=True)
    assert _count(calls2, "gcloud run jobs create") == 1 and _count(calls2, "gcloud run jobs execute") == 0 and _count(calls2, "gcloud run jobs delete") == 0, "a job that could not be made is neither executed nor deleted"


def test_step_3b_reads_the_log_again_a_bounded_number_of_times_and_still_cleans_up(tmp_path: Path) -> None:
    p, calls = _run_step_3b(tmp_path, no_log=True)
    assert _count(calls, "gcloud logging read") == 6 and _count(calls, "sleep") == 6, "six reads, ten seconds apart, then it stops"
    assert _count(calls, "gcloud run jobs delete gwdb-probe-untagged-") == 1, "the job is deleted whether or not a line was found"


def test_step_3b_also_cleans_up_when_the_caller_runs_it_with_errexit(tmp_path: Path) -> None:
    p, calls = _run_step_3b(tmp_path, shell_flags=("-e",))
    assert p.returncode == 0, p.stderr
    assert _count(calls, "gcloud run jobs delete gwdb-probe-untagged-") == 1, "the expected failure of the execute does not end a `set -e` shell before the cleanup"


def test_step_3b_does_not_read_a_log_when_it_made_no_job(tmp_path: Path) -> None:
    p, calls = _run_step_3b(tmp_path, job_create=True)
    assert _count(calls, "gcloud logging read") == 0 and _count(calls, "sleep") == 0 and _count(calls, "gcloud run jobs execute") == 0 and _count(calls, "gcloud run jobs delete") == 0
    (tmp_path / "i").mkdir()
    p2, calls2 = _run_step_3b(tmp_path / "i", iam_create=True)
    assert _count(calls2, "gcloud logging read") == 0, "a log of a job that exists under the same name is never read as ours"


def test_step_3b_makes_nothing_when_the_address_to_probe_is_empty(tmp_path: Path) -> None:
    p, calls = _run_step_3b(tmp_path, vmip_empty=True)
    assert "STOP: no address to probe" in p.stdout
    assert _count(calls, "gcloud iam service-accounts create") == 0 and _count(calls, "gcloud run jobs") == 0 and _count(calls, "gcloud logging") == 0


# ── the gateway's own subnet (PO decision 2026-10-28: option A; Google's list of limits has no network tags in ingress firewall rules for Direct VPC egress) ────────────────

def _runbook13() -> str:
    return (_VM / "RUNBOOK.md").read_text().split("## 13. The support gateway's database on the VM")[1]


def test_the_range_is_written_once_in_the_declaration_and_the_runbook_commands_take_it_from_there() -> None:
    rb = _runbook13()
    declared = renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"]
    assert len(declared) == 1
    line = next(l for l in rb.splitlines() if l.startswith("GWRANGE=$(awk"))
    root = _VM.parent.parent
    got = subprocess.run(["bash", "-c", line.split("   #")[0] + '; printf %s "$GWRANGE"'], capture_output=True, text=True, timeout=30, cwd=root)
    assert got.stdout.strip().splitlines()[-1] == declared[0], (got.stdout, got.stderr)
    allow = next(l for l in rb.splitlines() if "gcloud compute firewall-rules create $VM-gateway-db-allow" in l)
    create = next(l for l in rb.splitlines() if "gcloud compute networks subnets create support-gateway-$ENV" in l)
    assert '--source-ranges "$GWRANGE"' in allow and '--range "$GWRANGE"' in create
    assert "--source-tags" not in allow and "--priority 800 --action ALLOW" in allow and "--target-tags $VM" in allow
    assert not re.search(r"\b10\.(?!128\.0\.0/9)\d+\.\d+\.\d+/\d+", rb), "the range is named by `allow_from`, not repeated as a number in the runbook (the automatic block of the network is a general fact)"


def test_the_gateways_subnet_lies_outside_the_automatic_subnets_and_clear_of_the_ranges_already_in_use() -> None:
    import ipaddress
    net = ipaddress.ip_network(renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"][0])
    assert not net.overlaps(ipaddress.ip_network("10.128.0.0/9")), "the automatic subnets of an auto-mode network lie in 10.128.0.0/9"
    assert not net.overlaps(ipaddress.ip_network("10.110.0.0/16")) and not net.overlaps(ipaddress.ip_network("10.178.0.0/20")), "Cloud SQL's peering and the default subnet of the region"
    assert net.prefixlen <= 26, "Google's minimum for Direct VPC egress"
    assert net.num_addresses >= 4 * 10 + 4, "the service's ceiling of 10 instances at 4 addresses each, and the network's reserved addresses"
    assert net.is_private


def test_the_runbook_says_why_the_subnet_and_not_the_tag_and_the_negative_control_stays_on_the_default_subnet() -> None:
    rb = _runbook13()
    for token in ("cannot be named by a network tag in an ingress firewall rule", "told apart by SUBNET, not by tag", "placed OUTSIDE it", "A /25 (128 addresses) holds the service's ceiling of 10 instances with room to spare (a service takes about twice the addresses of an instance, kept 20 minutes after a scale-in)",
                  "`--subnet support-gateway-$ENV` instead of `--subnet default`", "the default subnet is not allowed, because it also holds other Cloud Run services"):
        assert token in rb, token
    assert "source-tags" not in rb and "--network-tags" not in rb, "no tag is used as the source of the allow rule or on the pipeline's flags"
    probe_job = next(l for l in rb.splitlines() if "gcloud run jobs create" in l and "$PJU" in l)
    assert "--subnet default" in probe_job, "the negative control runs on the default subnet"


def test_the_runbook_keeps_the_subnet_to_the_gateway_and_does_not_publish_the_topology_around_it() -> None:
    rb = _runbook13()
    assert "**This subnet hosts only the gateway service, its migrate job and the throw-away probe job.**" in rb and "no other Cloud Run service or job goes on this subnet" in rb
    assert "`gcloud compute addresses list --global`" in rb and "`gcloud compute networks subnets list --network default`" in rb
    assert "gcloud iam service-accounts list --project $PROJECT --filter='email~gwdb-probe'" in rb
    for gone in ("10.110.", "peering", "10.178."):
        assert gone not in rb, f"the runbook does not name {gone}"


def test_the_runbook_notes_that_the_subnet_has_no_private_google_access_and_when_that_matters() -> None:
    rb = _runbook13()
    assert "Private Google Access **off**" in rb and "`private-ranges-only`" in rb and "changing it to `all-traffic` later needs NAT or Private Google Access first" in rb


def test_step_3_creates_the_subnet_only_when_it_is_missing_and_compares_the_range_when_it_is_there(tmp_path: Path) -> None:
    import stat
    rb = _runbook13()
    block = rb.split("```bash\n", 1)[1].split("```")[0]
    lines = block.splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("GWCUR=$("))
    snippet = "\n".join(lines[start:start + 3])
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text('#!/bin/sh\necho "gcloud $*" >> "$CALLS"\ncase "$*" in "compute networks subnets describe"*) [ -n "$CUR" ] && printf %s "$CUR" || exit 1 ;; esac\nexit 0\n')
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    base = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "ENV": "dev", "REGION": "r", "PROJECT": "p", "GWRANGE": "10.1.2.0/25", "CALLS": str(tmp_path / "calls")}
    outcomes = {}
    for name, cur in (("missing", ""), ("same", "10.1.2.0/25"), ("other", "10.9.9.0/25")):
        (tmp_path / "calls").write_text("")
        p = subprocess.run(["bash", "-c", snippet], capture_output=True, text=True, timeout=30, env={**base, "CUR": cur})
        outcomes[name] = (p.stdout.strip(), (tmp_path / "calls").read_text())
    assert "subnets create support-gateway-dev" in outcomes["missing"][1] and "--range 10.1.2.0/25" in outcomes["missing"][1]
    assert "subnets create" not in outcomes["same"][1] and "exists with the declared range" in outcomes["same"][0]
    assert "subnets create" not in outcomes["other"][1] and outcomes["other"][0].startswith("STOP: the subnet has the range 10.9.9.0/25, the declaration says 10.1.2.0/25")


def test_step_3_looks_at_the_firewall_rules_before_creating_the_pair_and_says_what_to_do_with_a_tag_rule() -> None:
    rb = _runbook13()
    look = rb.index("gcloud compute firewall-rules list --project $PROJECT --filter=\"name~$VM-gateway-db\"")
    assert look < rb.index("gcloud compute firewall-rules create $VM-gateway-db-deny") < rb.index("gcloud compute firewall-rules create $VM-gateway-db-allow")
    assert "whose TAGS column is not empty, delete it" in rb and "gcloud compute firewall-rules delete $VM-gateway-db-allow --project $PROJECT --quiet" in rb.split("# the port.")[0]


def test_the_subnet_delete_in_the_undo_carries_its_condition() -> None:
    assert "(only when no Cloud Run revision uses it any more)" in _runbook13()


def _run_step_3(tmp_path: Path, cur: str, shell: str = "bash", fw_has: str = "") -> tuple[subprocess.CompletedProcess, list[str]]:
    """the first block of step 3, as written, from the repository root, against a fake gcloud that answers the subnet question with `cur` (empty = there is none)"""
    import stat
    block = _runbook13().split("```bash\n", 1)[1].split("```")[0]
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    calls = tmp_path / "calls"
    calls.write_text("")
    g = b / "gcloud"
    g.write_text('#!/bin/sh\necho "gcloud $*" >> "$CALLS"\ncase "$*" in "compute networks subnets describe"*) [ -n "$CUR" ] && printf %s "$CUR" || exit 1 ;; "compute firewall-rules describe"*) case "$*" in *"$FWHAS"*) exit 0 ;; *) exit 1 ;; esac ;; esac\nexit 0\n')
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "ENV": "dev", "REGION": "r", "PROJECT": "p", "VM": "vm", "ZONE": "z", "CALLS": str(calls), "CUR": cur, "FWHAS": fw_has or "no-such-rule"}
    p = subprocess.run([shell, "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=_VM.parent.parent)
    return p, calls.read_text().splitlines()


def test_a_stop_at_the_subnet_really_stops_the_firewall_lines(tmp_path: Path) -> None:
    declared = renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"][0]
    states = {"missing": "", "same": declared, "other": "10.9.9.0/25"}
    got = {}
    for name, cur in states.items():
        (tmp_path / name).mkdir()
        p, calls = _run_step_3(tmp_path / name, cur)
        got[name] = (p, calls)
    for name in ("missing", "same"):
        calls = got[name][1]
        assert sum(1 for c in calls if c.startswith("gcloud compute firewall-rules create")) == 2, (name, calls)
        assert sum(1 for c in calls if c.startswith("gcloud compute firewall-rules list")) == 1
    p, calls = got["other"]
    assert "STOP: the subnet has the range 10.9.9.0/25" in p.stdout
    assert not [c for c in calls if c.startswith("gcloud compute firewall-rules")], "the STOP stops the firewall lines: nothing is listed, nothing is created"
    assert sum(1 for c in got["missing"][1] if c.startswith("gcloud compute networks subnets create")) == 1
    assert not [c for c in calls if c.startswith("gcloud compute networks subnets create")]


def test_a_subnet_that_could_not_be_created_does_not_open_the_firewall_lines(tmp_path: Path) -> None:
    import stat
    block = _runbook13().split("```bash\n", 1)[1].split("```")[0]
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text('#!/bin/sh\necho "gcloud $*" >> "$CALLS"\ncase "$*" in "compute networks subnets describe"*) exit 1 ;; "compute networks subnets create"*) exit 1 ;; esac\nexit 0\n')
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    (tmp_path / "calls").write_text("")
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "ENV": "dev", "REGION": "r", "PROJECT": "p", "VM": "vm", "ZONE": "z", "CALLS": str(tmp_path / "calls")}
    subprocess.run(["bash", "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=_VM.parent.parent)
    assert not [c for c in (tmp_path / "calls").read_text().splitlines() if c.startswith("gcloud compute firewall-rules")]


@pytest.mark.skipif(__import__("shutil").which("zsh") is None, reason="no zsh on this machine")
def test_the_stop_also_stops_under_zsh(tmp_path: Path) -> None:
    declared = renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"][0]
    (tmp_path / "o").mkdir()
    (tmp_path / "s").mkdir()
    p, calls = _run_step_3(tmp_path / "o", "10.9.9.0/25", shell="zsh")
    assert "STOP:" in p.stdout and not [c for c in calls if c.startswith("gcloud compute firewall-rules")]
    p2, calls2 = _run_step_3(tmp_path / "s", declared, shell="zsh")
    assert sum(1 for c in calls2 if c.startswith("gcloud compute firewall-rules create")) == 2


def test_a_rule_that_is_already_there_is_not_created_again(tmp_path: Path) -> None:
    declared = renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"][0]
    for n, (has, created) in enumerate([("vm-gateway-db-deny", ["allow"]), ("vm-gateway-db-allow", ["deny"]), ("vm-gateway-db", []), ("", ["deny", "allow"])]):
        (tmp_path / str(n)).mkdir()
        p, calls = _run_step_3(tmp_path / str(n), declared, fw_has=has)
        made = sorted(c.split("create vm-gateway-db-")[1].split()[0] for c in calls if c.startswith("gcloud compute firewall-rules create"))
        assert made == sorted(created), (has, made, calls)
        if has:
            assert "exists (compare it with the list above)" in p.stdout


def test_the_runbook_explains_why_the_nightly_backup_of_an_empty_gateway_database_fails_and_why_that_is_not_loosened() -> None:
    rb = _runbook13()
    row5 = next(l for l in rb.splitlines() if l.startswith("| 5 |"))
    assert "in the same window as the load of the gateway's data" in row5 and "only after the firewall pair of step 3 exists and the negative control below has been measured" in row5
    para = rb.split("**Why step 5 belongs to the window of the load.**")[1].split("**Step 3 in commands**")[0]
    for token in ("«lists no table data — refusing»", "the main dump is uploaded first", "expected and loses nothing", "so it is not loosened", "looks for a new `db-gateway-…` dump"):
        assert token in para, token


# ── a first start that was cut short: the server answers, the application role is not there ───────────────────────────────────────────────────────────────────────────────

def test_the_readiness_question_asks_for_the_role_and_the_owner_not_only_for_an_answer() -> None:
    q = D.GATEWAY_DB_READY
    assert "pg_isready" in q and "from pg_database d join pg_roles r on r.oid = d.datdba" in q and "$POSTGRES_DB" in q and "$GATEWAY_APP_USER" in q and q.rstrip().endswith("grep -qx 1")
    assert "$GATEWAY_APP_PASSWORD" not in q, "no value of a secret in a command"


def test_a_database_that_answers_but_has_no_application_role_stops_the_release_before_anything_else(world) -> None:
    world.publish()
    world.runner.gateway_role_fails_for = 10**6
    assert world.dep.run_once() == "failed"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "first start did not finish" in st["detail"] and "does not own the database" in st["detail"]
    verbs = world.runner.verbs()
    assert verbs.count("exec:gwdb-ready") == D.GATEWAY_DB_READY_TRIES and "run" not in verbs and "up:all" not in verbs, "asked a bounded number of times; no migration, no swap"
    assert not any(w in " ".join(world.logs) for w in (GW_PASSWORD,))


def test_a_first_start_still_running_its_script_is_waited_for(world) -> None:
    world.publish()
    world.runner.gateway_role_fails_for = 3   # the temporary server of the first start answers before the script has made the role
    assert world.dep.run_once() == "deployed"
    assert world.runner.verbs().count("exec:gwdb-ready") == 3 + 1 + 1, "three «no», the «yes», and the probe after the swap"


def test_a_role_that_vanishes_after_the_swap_is_not_healthy_and_rolls_the_release_back(world) -> None:
    a = world.publish("a" * 40)
    world.dep.run_once()
    world.publish("b" * 40)
    orig = world.runner.run
    state = {"asked": 0}

    def run(args, env, **kw):
        if "pg_database" in " ".join(args):
            state["asked"] += 1
            if state["asked"] == 2 and env.get("BACKEND_IMAGE") != a["backend_image"]:
                world.runner.gateway_role_fails_for = 10**6   # from the probe after the swap on
        if env.get("BACKEND_IMAGE") == a["backend_image"] and "up" in args:
            world.runner.gateway_role_fails_for = 0
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rolled-back"
    assert S._state(world, "current.json")["sha"] == "a" * 40


def test_the_runbook_says_how_to_recover_a_first_start_that_was_cut_short_and_when_not_to() -> None:
    rb = _runbook13()
    para = rb.split("**A first start that was cut short.**")[1].split("**Rolling back across this step:**")[0]
    for token in ("only while the data folder is empty", "the application role does not own the database", "**no data in any database**", "**First look, read only**", "select count(*) from pg_stat_user_tables",
                  "`template1` included", "ONE chain that stops where anything fails and asks the same question again as its first link", "&& sudo docker stop sprintable-gateway-db-1 && ", "-mindepth 1 -delete`",
                  "sudo python3 /opt/sprintable/bin/deployer.py --force", "With data in it, do not empty anything"):
        assert token in para, token
    assert " deployer --force" not in para, "the installed command, not a bare name that is not on the PATH"
    assert para.index("**First look, read only**") < para.index("ONE chain") < para.index("sudo docker stop sprintable-gateway-db-1 &&"), "the look first, then the chain that asks again, stops and only then wipes"
    assert "docker compose" not in para, "a compose command would need the deployer's environment"


@pytest.mark.skipif(_postgres_binaries() is None or os.geteuid() == 0, reason="needs the Postgres binaries and a user that is not root (initdb refuses root)")
def test_on_a_real_server_the_readiness_question_tells_a_half_made_server_from_a_whole_one(tmp_path: Path) -> None:
    """a server that answers but has no application role (a first start that was cut short) is NOT ready; one whose database the role owns is"""
    import shutil
    import tempfile
    bins = _postgres_binaries()
    work = Path(tempfile.mkdtemp(prefix="gwrdy"))
    port = str(51000 + (os.getpid() % 9000))
    try:
        data, sock = work / "data", work / "sock"
        sock.mkdir()
        run = lambda *a: subprocess.run([str(bins / a[0]), *a[1:]], capture_output=True, text=True, timeout=60)  # noqa: E731
        assert run("initdb", "-D", str(data), "-U", "gw_admin", "--auth-local=trust", "--auth-host=trust").returncode == 0
        assert run("pg_ctl", "-D", str(data), "-l", str(work / "log"), "-o", f"-c listen_addresses='' -k {sock} -p {port}", "-w", "start").returncode == 0
        assert run("createdb", "-h", str(sock), "-p", port, "-U", "gw_admin", "support_gateway").returncode == 0
        env = {"PATH": f"{bins}:/usr/bin:/bin", "PGHOST": str(sock), "PGPORT": port, "POSTGRES_USER": "gw_admin", "POSTGRES_DB": "support_gateway", "GATEWAY_APP_USER": "support_gw", "HOME": str(work)}
        ready = lambda: subprocess.run(["sh", "-c", D.GATEWAY_DB_READY], capture_output=True, text=True, timeout=60, env=env).returncode  # noqa: E731
        psql = lambda sql: run("psql", "-h", str(sock), "-p", port, "-U", "gw_admin", "-d", "postgres", "-X", "-q", "-c", sql)  # noqa: E731
        assert ready() != 0, "the server answers, the database exists, there is no application role: not ready"
        assert psql("CREATE ROLE support_gw LOGIN").returncode == 0
        assert ready() != 0, "the role exists but does not own the database: not ready"
        assert psql('ALTER DATABASE support_gateway OWNER TO support_gw').returncode == 0
        assert ready() == 0, "the role owns the database: ready"
        assert subprocess.run(["sh", "-c", D.GATEWAY_DB_READY], capture_output=True, text=True, timeout=60, env={**env, "GATEWAY_APP_USER": "someone_else"}).returncode != 0
        assert psql('ALTER DATABASE support_gateway OWNER TO gw_admin').returncode == 0 and psql('CREATE DATABASE some_other OWNER support_gw').returncode == 0
        assert ready() != 0, "the role owns ANOTHER database, not the gateway's: not ready"
    finally:
        subprocess.run([str(bins / "pg_ctl"), "-D", str(work / "data"), "-m", "immediate", "stop"], capture_output=True, timeout=60)
        shutil.rmtree(work, ignore_errors=True)


def test_the_password_in_the_log_check_names_the_project_and_does_not_pass_on_an_empty_log() -> None:
    rb = _runbook13()
    line = rb.split("no password in the server's log:")[1].split("From outside")[0]
    assert "gcloud compute ssh $VM --project $PROJECT --zone $ZONE --tunnel-through-iap" in line
    assert '&& [ -n "$LOG" ] && printf' in line and "grep -c -F -- \"$PW\"" in line and "a failed ssh or an empty log prints nothing: that is not a pass" in line


def _recovery_paragraph() -> str:
    return _runbook13().split("**A first start that was cut short.**")[1].split("**Rolling back across this step:**")[0]


def _recovery_script() -> str:
    return _recovery_paragraph().split("sh -c '")[1].split("'")[0]


def _recovery_chain() -> str:
    return _recovery_paragraph().split("ONE chain that stops where anything fails and asks the same question again as its first link: `")[1].split("` (the container's own name")[0]


def _fake_psql(tmp: Path, databases: str, counts: dict, list_fails: bool = False) -> dict:
    """a psql that answers the list question with `databases` and the count question per database from `counts` (a missing key = the query fails)"""
    import json
    import stat
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    (tmp / "answers.json").write_text(json.dumps({"databases": databases, "counts": counts, "list_fails": list_fails}))
    p = b / "psql"
    p.write_text(
        "#!" + sys.executable + "\nimport json, os, sys\n"
        "a = json.load(open(os.environ['ANSWERS']))\n"
        "args = sys.argv[1:]\n"
        "sql = args[args.index('-c') + 1]\n"
        "db = args[args.index('-d') + 1]\n"
        "if 'pg_database' in sql:\n"
        "    sys.exit(1) if a['list_fails'] else print(a['databases'], end='')\n"
        "elif db in a['counts']:\n"
        "    print(a['counts'][db])\n"
        "else:\n"
        "    sys.stderr.write('connection failed\\n'); sys.exit(2)\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp), "ANSWERS": str(tmp / "answers.json"), "POSTGRES_USER": "gw_admin"}


@pytest.mark.parametrize("databases,counts,list_fails,ok", [
    ("postgres\nsupport_gateway", {"postgres": "0", "support_gateway": "0"}, False, True),
    ("postgres\nsupport_gateway", {"postgres": "0", "support_gateway": "3"}, False, False),
    ("postgres\nsupport_gateway\nrenamed", {"postgres": "0", "support_gateway": "0"}, False, False),          # the query for the third database FAILS: that must not read as «empty»
    ("postgres\nsupport_gateway", {"postgres": "0", "support_gateway": ""}, False, False),                    # an empty count is not a zero
    ("", {}, False, False),                                                                                     # no database at all is not «no data»
    ("postgres", {"postgres": "0"}, True, False),                                                              # the list question fails
])
def test_the_recovery_question_succeeds_only_when_every_count_was_obtained_and_is_zero(tmp_path: Path, databases: str, counts: dict, list_fails: bool, ok: bool) -> None:
    env = _fake_psql(tmp_path, databases, counts, list_fails)
    p = subprocess.run(["sh", "-c", _recovery_script()], capture_output=True, text=True, timeout=30, env=env)
    assert (p.returncode == 0) is ok, (p.returncode, p.stdout, p.stderr)
    if ok:
        assert p.stdout.split() == ["postgres", "0", "support_gateway", "0"]


@pytest.mark.skipif(_postgres_binaries() is None or os.geteuid() == 0, reason="needs the Postgres binaries and a user that is not root (initdb refuses root)")
def test_on_a_real_server_the_recovery_question_finds_data_in_any_database(tmp_path: Path) -> None:
    """a renamed database or a kept restore copy holds data too: the question covers every database that accepts connections, template1 included"""
    import shutil
    import tempfile
    bins = _postgres_binaries()
    work = Path(tempfile.mkdtemp(prefix="gwrec"))
    port = str(52000 + (os.getpid() % 8000))
    try:
        data, sock = work / "data", work / "sock"
        sock.mkdir()
        run = lambda *a: subprocess.run([str(bins / a[0]), *a[1:]], capture_output=True, text=True, timeout=60)  # noqa: E731
        assert run("initdb", "-D", str(data), "-U", "gw_admin", "--auth-local=trust", "--auth-host=trust").returncode == 0
        assert run("pg_ctl", "-D", str(data), "-l", str(work / "log"), "-o", f"-c listen_addresses='' -k {sock} -p {port}", "-w", "start").returncode == 0
        for name in ("support_gateway", "support_gateway_before_restore_x"):
            assert run("createdb", "-h", str(sock), "-p", port, "-U", "gw_admin", name).returncode == 0
        env = {"PATH": f"{bins}:/usr/bin:/bin", "PGHOST": str(sock), "PGPORT": port, "POSTGRES_USER": "gw_admin", "HOME": str(work)}
        ask = lambda: subprocess.run(["sh", "-c", _recovery_script()], capture_output=True, text=True, timeout=60, env=env)  # noqa: E731
        psql = lambda db, sql: run("psql", "-h", str(sock), "-p", port, "-U", "gw_admin", "-d", db, "-X", "-q", "-c", sql)  # noqa: E731
        first = ask()
        assert first.returncode == 0 and sorted(first.stdout.split()[::2]) == ["postgres", "support_gateway", "support_gateway_before_restore_x", "template1"], first.stdout
        assert psql("support_gateway_before_restore_x", "create table kept(id int)").returncode == 0
        found = ask()
        assert found.returncode != 0 and "support_gateway_before_restore_x 1" in found.stdout, "a table in a database that is NOT the gateway's own is found"
        assert psql("support_gateway_before_restore_x", "drop table kept").returncode == 0 and ask().returncode == 0
        assert psql("template1", "create table in_the_template(id int)").returncode == 0
        assert ask().returncode != 0, "template1 is a database like the others here: a table in it is data too"
    finally:
        subprocess.run([str(bins / "pg_ctl"), "-D", str(work / "data"), "-m", "immediate", "stop"], capture_output=True, timeout=60)
        shutil.rmtree(work, ignore_errors=True)


@pytest.mark.parametrize("shell", ["bash", "zsh"])
@pytest.mark.parametrize("exec_rc,stop_rc,inspect,wiped", [
    (0, 0, "false", True),             # empty, stopped, confirmed
    (1, 0, "false", False),            # the question failed or found data: nothing is stopped, nothing is wiped
    (0, 1, "false", False),            # the stop failed
    (0, 0, "true", False),             # «stopped» but still running
    (0, 0, "FAIL", False),             # the confirmation itself failed: that is not «stopped»
    (0, 0, "", False),                 # and an empty answer is not «false» either
])
def test_the_recovery_chain_wipes_only_an_empty_server_that_is_confirmed_stopped(tmp_path: Path, shell: str, exec_rc: int, stop_rc: int, inspect: str, wiped: bool) -> None:
    import shutil
    import stat
    if shutil.which(shell) is None:
        pytest.skip(f"no {shell}")
    folder = tmp_path / "gateway-postgres"
    folder.mkdir()
    for n in ("PG_VERSION", "base", "pg_wal"):
        (folder / n).write_text("x")
    b = tmp_path / "bin"
    b.mkdir()
    (b / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
    (b / "docker").write_text('#!/bin/sh\ncase "$1" in exec) exit "$FAKE_EXEC_RC" ;; stop) exit "$FAKE_STOP_RC" ;; inspect) [ "$FAKE_INSPECT" = FAIL ] && exit 1; printf %s "$FAKE_INSPECT"; exit 0 ;; esac\nexit 0\n')
    for f in (b / "sudo", b / "docker"):
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    chain = _recovery_chain().replace("/srv/sprintable/gateway-postgres", str(folder))
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "FAKE_EXEC_RC": str(exec_rc), "FAKE_STOP_RC": str(stop_rc), "FAKE_INSPECT": inspect}
    subprocess.run([shell, "-c", chain], capture_output=True, text=True, timeout=30, env=env)
    assert (sorted(p.name for p in folder.iterdir()) == []) is wiped, (exec_rc, stop_rc, inspect)


def test_the_first_look_and_the_chain_ask_the_very_same_question_and_the_stop_is_confirmed_by_inspect() -> None:
    para = _recovery_paragraph()
    assert _recovery_script() in _recovery_chain() and "sort -u" not in para and "docker ps" not in para and "not datistemplate" not in para
    assert "[ \"$(sudo docker inspect -f '{{.State.Running}}' sprintable-gateway-db-1)\" = false ]" in para and "a failed `inspect` is not «stopped»" in para
    assert "**It succeeds (exit status 0) only if the list is not empty, every count was obtained and every count is 0**" in para


def test_the_undo_removes_the_container_before_the_rules_and_the_rules_wait() -> None:
    rb = _runbook13()
    undo = rb.split("**Undo of this step:**")[1].split("\n")[0]
    assert undo.index("sudo docker stop sprintable-gateway-db-1 && sudo docker rm sprintable-gateway-db-1") < undo.index("sudo ss -ltn | grep ':5432'") < undo.index("delete `/srv/sprintable/gateway-postgres`") < undo.index("ONLY THEN the firewall rules of step 3")
    assert "**The rules stay until the container is gone**" in undo and "docker compose" not in undo
    assert "Undo (the rules LAST — only after `gateway-db` is gone" in rb
