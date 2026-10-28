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
import re
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
        self.metadata_rc = 1

    def run(self, args, env, cwd=None, timeout=900, stdin=None):
        joined = " ".join(args)
        if args[:2] == ["docker", "compose"] and args[-1] == "gateway-db" and "up" in args:
            self.calls.append({"args": list(args), "env": dict(env), "stdin": stdin})
            return (0, "") if self.gateway_db_up_ok else (1, "gateway-db unhealthy")
        if "pg_isready" in joined:
            self.calls.append({"args": list(args), "env": dict(env), "stdin": stdin})
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
    assert world.runner.verbs() == ["login", "pull", "logout", "up:db", "up:gwdb", "exec:gwdb-metadata", "run", "up:all", "exec:reload", "exec:gwdb-reload", "exec:health-be", "exec:health-fe", "exec:health-gwdb"]


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

    world.runner.gateway_db_probe_ok = False
    world.runner.run = run
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
    assert "${GATEWAY_DB_HBA:-./gateway-db-pg_hba.conf}:/etc/postgresql/pg_hba.conf:ro" in gw["volumes"] and "./gateway-db-init.sh:/docker-entrypoint-initdb.d/10-gateway-db.sh:ro" in gw["volumes"]
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
    assert len(mentions) == 1 and "pg_reload_conf()" in mentions[0], "the one psql command of the deployer reloads the access rules and carries no value"
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
    assert rules == [["local", "all", "all", "trust"], ["host", "support_gateway", "support_gw", "10.178.0.0/20", "scram-sha-256"], ["host", "all", "all", "0.0.0.0/0", "reject"], ["host", "all", "all", "::/0", "reject"]]
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
    a_backend = S._state(world, "current.json")["backend_image"]
    world.publish("b" * 40, bundle=_bundle_with_networks(["10.200.0.0/20"]))
    world.runner.fail_on["migrate"] = 1
    assert world.dep.run_once() == "failed"
    assert path.read_text() == before and "10.200.0.0" not in path.read_text(), "the file is put back, so a restart of the container cannot pick the candidate's networks up"
    after = _reloads(world)[reloads:]
    assert len(after) == 1 and after[0]["env"]["BACKEND_IMAGE"] == a_backend, "and the server is told once, with the RUNNING release's environment (compose may have re-created the container with the candidate's file mounted)"


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


def test_the_real_declaration_names_the_default_subnet_of_the_region() -> None:
    assert renv.gateway_networks(renv.load_declaration(_VM / "env/dev.yaml")["support_gateway"]["allow_from"]) == ["10.178.0.0/20"]


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
    for token in ("default-allow-internal", "--priority 900 --action DENY --rules tcp:5432", "--priority 800 --action ALLOW --rules tcp:5432 --target-tags $VM --source-tags support-gateway-dev",
                  "Negative: the same connection from another Cloud Run workload", "a **subnet of its own for the gateway**", "`gw_admin|t` and `support_gw|f`", "permission denied to COPY to or from an external program",
                  "never 0", "grep -c -F -- \"$PW\"", "no password and no way in over any network address", "ordinary role", "never logs what a statement was run with",
                  "subnets describe default", "an empty value means the variable is not sent at all"):
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
