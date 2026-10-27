"""story 4796 — the support gateway as a standby on the VM (step 1 of its move; nothing points at it yet).

desired.json may carry a third image, `support_gateway_image`. For a release that carries it the deployer (deploy/vm/bin/deployer.py) creates the gateway's own role and database in the VM's Postgres,
migrates them, and starts the gateway beside the rest; for a release that does not, nothing about the gateway happens and the records, signatures and calls are what they were. Pinned here: the optional
image (validation, signature, records), the deploy order and every compose call's profile, that the gateway's password reaches psql through standard input only and no file/log/status, the failure
paths (database prepare, gateway migrate, gateway health), the stop of a gateway a release leaves out, the declaration rules, the compose services, the bundle and the bundle build.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import subprocess
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
GATEWAY_URL = f"postgresql+asyncpg://support_gw:{GW_PASSWORD}@db:5432/support_gateway"


class GwRunner(S.FakeRunner):
    """the sibling's fake docker, plus the gateway's own probe"""

    def __init__(self) -> None:
        super().__init__()
        self.gateway_ok = True

    def run(self, args, env, cwd=None, timeout=900, stdin=None):
        joined = " ".join(args)
        if "/healthz" in joined:
            self.calls.append({"args": list(args), "env": dict(env), "stdin": stdin})
            return (0, "") if self.gateway_ok else (1, "gateway down")
        return super().run(args, env, cwd=cwd, timeout=timeout, stdin=stdin)


@pytest.fixture()
def world(tmp_path: Path):
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
        return {decl["database"]["password_secret"]: S.PASSWORD, GW_SECRET_ID: GW_PASSWORD + "\n"}.get(sid, S.SECRET)

    dep = D.Deployer(cfg, store, runner, secrets, lambda: "vm-token-abc123", sleep=clock.sleep, now=clock.now, log=logs.append)

    def publish(sha: str = "a" * 40, gateway: bool = True, bundle: bytes | None = None) -> dict:
        blob = bundle if bundle is not None else S._bundle()
        desired = {"sha": sha, "backend_image": f"{S.REG}/backend@{S._digest(sha)}", "frontend_image": f"{S.REG}/frontend-vm@{S._digest(sha)}",
                   "bundle": f"bundles/{sha}.tgz", "bundle_sha256": hashlib.sha256(blob).hexdigest()}
        if gateway:
            desired["support_gateway_image"] = f"{S.REG}/support-gateway@{S._digest('gw' + sha)}"
        store.objects[(S.BUCKET, f"bundles/{sha}.tgz")] = blob
        store.objects[(S.BUCKET, "desired.json")] = json.dumps(desired).encode()
        return desired

    return type("W", (), {"cfg": cfg, "store": store, "runner": runner, "clock": clock, "dep": dep, "publish": staticmethod(publish), "logs": logs, "asked": asked, "decl": decl})


def _compose_calls(w) -> list[dict]:
    return [c for c in w.runner.calls if c["args"][:2] == ["docker", "compose"]]


def _verb(c: dict) -> str:
    a = c["args"]
    for v in ("pull", "up", "run", "exec", "stop"):
        if v in a:
            return v
    return "?"


def _profiles(c: dict) -> list[str]:
    a = c["args"]
    return [a[i + 1] for i, x in enumerate(a) if x == "--profile"]


# ── the optional image: validation, signature, records ──────────────────────────────────────────────────────────────────────────────────────────

BASE = {"sha": "a" * 40, "backend_image": f"{S.REG}/backend@{S._digest('x')}", "frontend_image": f"{S.REG}/frontend-vm@{S._digest('y')}", "bundle": "bundles/x.tgz", "bundle_sha256": "0" * 64}
GW_IMAGE = f"{S.REG}/support-gateway@{S._digest('z')}"
PREFIX = f"{S.REG.rsplit('/', 1)[0]}/"


def test_a_desired_json_without_the_gateway_image_is_valid_and_its_signature_is_what_it_was() -> None:
    assert D.validate_desired(dict(BASE), PREFIX) == BASE
    assert D.signature(BASE) == "|".join([BASE["sha"], BASE["backend_image"], BASE["frontend_image"], BASE["bundle_sha256"]]), "a release recorded before the gateway existed keeps its signature"


def test_the_gateway_image_is_checked_like_the_other_images_and_joins_the_signature() -> None:
    ok = {**BASE, "support_gateway_image": GW_IMAGE}
    assert D.validate_desired(dict(ok), PREFIX) == ok
    assert D.signature(ok) == D.signature(BASE) + "|" + GW_IMAGE
    other = {**ok, "support_gateway_image": f"{S.REG}/support-gateway@{S._digest('other')}"}
    assert D.signature(other) != D.signature(ok), "a new gateway image alone is a new release"
    for bad in (f"{S.REG}/support-gateway:latest", "evil.example/proj/support-gateway@" + S._digest("z"), "", None, 5, f"{S.REG}/support gateway@{S._digest('z')}", "-" + GW_IMAGE):
        with pytest.raises(D.DeployError):
            D.validate_desired({**BASE, "support_gateway_image": bad}, PREFIX)


def test_a_record_keeps_the_gateway_image_only_when_there_is_one_and_an_old_record_is_still_a_record(tmp_path: Path) -> None:
    assert D.release_state(BASE) == {k: BASE[k] for k in D.STATE_KEYS}
    assert D.release_state({**BASE, "support_gateway_image": GW_IMAGE})["support_gateway_image"] == GW_IMAGE
    assert "support_gateway_image" not in D.release_state({**BASE, "support_gateway_image": ""})
    path = tmp_path / "current.json"
    path.write_text(json.dumps({**{k: BASE[k] for k in D.STATE_KEYS}, "previous": None}))
    assert D.read_current(path)["sha"] == BASE["sha"]


# ── a release that carries the gateway ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_deploy_order_prepares_the_database_and_migrates_the_gateway_before_the_swap(world) -> None:
    d = world.publish()
    assert world.dep.run_once() == "deployed"
    steps = [(c["args"][0], _verb(c) if c["args"][0] == "docker" and c["args"][1] == "compose" else c["args"][1], c) for c in world.runner.calls]
    labels = []
    for _, verb, c in steps:
        a = c["args"]
        if a[:2] == ["docker", "compose"]:
            if verb == "pull":
                labels.append("pull")
            elif verb == "up":
                labels.append("up:db" if a[-1] == "db" else "up:all")
            elif verb == "run":
                labels.append("run:gateway-migrate" if "support-gateway-migrate" in a else "run:migrate")
            elif verb == "exec":
                labels.append("psql" if "psql" in a else "reload" if "reload" in a else "health-gateway" if "/healthz" in " ".join(a) else "health")
        else:
            labels.append(a[1])
    assert labels == ["login", "pull", "logout", "up:db", "run:migrate", "psql", "run:gateway-migrate", "up:all", "reload", "health", "health", "health-gateway"]
    cur = json.loads((world.cfg.state_dir / "current.json").read_text())
    assert cur["support_gateway_image"] == d["support_gateway_image"] and cur["previous"] is None


def test_every_compose_call_of_a_gateway_release_sees_the_gateway_services_and_the_migrate_has_its_profile(world) -> None:
    world.publish()
    world.dep.run_once()
    for c in _compose_calls(world):
        assert "support-gateway" in _profiles(c), c["args"]
    mig = next(c for c in _compose_calls(world) if "support-gateway-migrate" in c["args"])
    assert "support-gateway-migrate" in _profiles(mig) and mig["args"][mig["args"].index("--profile") - 0] == "--profile"
    pull = next(c for c in _compose_calls(world) if _verb(c) == "pull")
    assert pull["args"][-3:] == ["backend", "frontend", "support-gateway"]


def test_the_environment_carries_the_image_and_the_gateways_own_connection_url_by_name(world) -> None:
    d = world.publish()
    world.dep.run_once()
    up = next(c for c in _compose_calls(world) if "--wait-timeout" in c["args"])
    assert up["env"]["SUPPORT_GATEWAY_IMAGE"] == d["support_gateway_image"]
    assert up["env"]["SUPPORT_GATEWAY_DATABASE_URL"] == GATEWAY_URL, "built from the gateway's secret (the trailing line ending taken off), its own role and its own database"
    assert S.PASSWORD not in up["env"]["SUPPORT_GATEWAY_DATABASE_URL"] and "sprintable:" not in up["env"]["SUPPORT_GATEWAY_DATABASE_URL"]
    assert up["env"]["SUPPORT_GATEWAY__SUPPORT_GATEWAY_TOKEN_SECRET"] == S.SECRET and up["env"]["SUPPORT_GATEWAY__SUPPORT_GATEWAY_CORS_ORIGINS"].startswith("https://dev-app.sprintable.ai")
    pt = yaml.safe_load((world.cfg.install_dir / "runtime/pass-through.yml").read_text())
    assert pt["services"]["support-gateway"]["environment"]["SUPPORT_GATEWAY_TOKEN_SECRET"] == "${SUPPORT_GATEWAY__SUPPORT_GATEWAY_TOKEN_SECRET}"
    assert "SUPPORT_GATEWAY_DATABASE_URL" not in pt["services"]["support-gateway"]["environment"], "passed by name from the process environment (compose.yml), not through the pass-through map"
    assert "BACKEND__JWT_SECRET" not in " ".join(k for k in up["env"] if k.startswith("SUPPORT_GATEWAY")), "no backend variable is in the gateway's environment"


def test_the_gateway_password_reaches_psql_on_standard_input_only(world) -> None:
    world.publish()
    world.dep.run_once()
    psql = next(c for c in _compose_calls(world) if "psql" in c["args"])
    assert GW_PASSWORD in psql["stdin"] and S.PASSWORD not in psql["stdin"]
    assert GW_PASSWORD not in " ".join(psql["args"]), "never in an argument list"
    assert psql["args"][psql["args"].index("exec"):] == ["exec", "-T", "db", "psql", "-X", "-q", "-U", "sprintable", "-d", "postgres"], "inside the database container, as the superuser over the local socket, connected to the maintenance database"
    for call in world.runner.calls:
        if call is not psql:
            assert GW_PASSWORD not in " ".join(call["args"]) and call["stdin"] in (None, "vm-token-abc123")
    written = S._text_tree(world.cfg.install_dir / "runtime") + S._text_tree(world.cfg.state_dir)
    assert GW_PASSWORD not in written and GW_PASSWORD not in json.dumps(world.store.puts) and GW_PASSWORD not in "\n".join(world.logs)


def test_the_database_script_is_idempotent_in_form_and_isolates_the_two_databases(world) -> None:
    world.publish()
    world.dep.run_once()
    sql = next(c for c in _compose_calls(world) if "psql" in c["args"])["stdin"]
    assert "\\set ON_ERROR_STOP on" in sql and "\\set gw_user 'support_gw'" in sql and "\\set gw_db 'support_gateway'" in sql and "\\set main_db 'sprintable'" in sql
    assert re.search(r"CREATE ROLE %I LOGIN PASSWORD %L.*WHERE NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = :'gw_user'\) \\gexec", sql)
    assert "ALTER ROLE %I PASSWORD %L" in sql, "a rotated secret is applied on the next deploy"
    assert re.search(r"CREATE DATABASE %I OWNER %I.*WHERE NOT EXISTS \(SELECT 1 FROM pg_database WHERE datname = :'gw_db'\) \\gexec", sql)
    assert "REVOKE ALL ON DATABASE %I FROM PUBLIC', :'main_db'" in sql and "REVOKE ALL ON DATABASE %I FROM PUBLIC', :'gw_db'" in sql and "GRANT CONNECT ON DATABASE %I TO %I', :'gw_db', :'gw_user'" in sql
    assert "SUPERUSER" not in sql.upper() and "CREATEDB" not in sql.upper() and "CREATEROLE" not in sql.upper(), "the role gets nothing beyond login"


def test_only_a_gateway_release_reads_the_gateways_secrets(world) -> None:
    world.publish(gateway=True)
    world.dep.run_once()
    assert GW_SECRET_ID in world.asked and "SUPPORT_GATEWAY_ADMIN_TOKEN_dev" in world.asked


# ── a release without the gateway behaves as before ─────────────────────────────────────────────────────────────────────────────────────────────

def test_a_release_without_the_image_never_touches_the_gateway(world) -> None:
    world.publish(gateway=False)
    assert world.dep.run_once() == "deployed"
    assert all(_profiles(c) == (["migrate"] if "migrate" in c["args"] else []) for c in _compose_calls(world))
    assert not any("psql" in c["args"] or "support-gateway" in " ".join(c["args"]) for c in world.runner.calls)
    assert GW_SECRET_ID not in world.asked and "SUPPORT_GATEWAY_ADMIN_TOKEN_dev" not in world.asked, "its secrets are not read"
    up = next(c for c in _compose_calls(world) if "--wait-timeout" in c["args"])
    assert "SUPPORT_GATEWAY_IMAGE" not in up["env"] and "SUPPORT_GATEWAY_DATABASE_URL" not in up["env"]
    assert "support-gateway" not in (world.cfg.install_dir / "runtime/pass-through.yml").read_text()
    assert "support_gateway_image" not in json.loads((world.cfg.state_dir / "current.json").read_text())


def test_a_declaration_without_the_gateway_service_refuses_a_release_that_carries_the_image(world) -> None:
    doc = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    doc.pop("support_gateway")
    doc["services"].pop("support-gateway")
    world.publish(bundle=S._bundle(extra={"env/dev.yaml": yaml.safe_dump(doc).encode()}))
    assert world.dep.run_once() == "failed" and world.runner.calls == [], "refused before any docker call"
    assert "declares no «support-gateway» service" in S._state(world, "failed.json")["detail"]


# ── failures ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_database_that_cannot_be_prepared_stops_before_the_swap_and_names_nothing_secret(world) -> None:
    world.publish("a" * 40, gateway=False)
    world.dep.run_once()
    world.publish("b" * 40)
    world.runner.fail_on["psql"] = 1
    world.runner.out_suffix = f" {GW_PASSWORD}"
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed"
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls), "no swap"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "support gateway database could not be prepared" in st["detail"] and GW_PASSWORD not in json.dumps(st)
    assert S._state(world, "current.json")["sha"] == "a" * 40


def test_a_gateway_migration_that_fails_stops_before_the_swap(world) -> None:
    world.publish()
    world.runner.fail_on["support-gateway-migrate"] = 1
    assert world.dep.run_once() == "failed"
    assert not any("--wait-timeout" in c["args"] for c in world.runner.calls)
    assert "support gateway migrate failed" in S._state(world, "failed.json")["detail"]


def test_a_gateway_that_is_not_healthy_after_the_swap_rolls_back_to_the_previous_release_and_stops_it(world) -> None:
    a = world.publish("a" * 40, gateway=False)
    world.dep.run_once()
    world.publish("b" * 40)
    orig = world.runner.run

    def run(args, env, **kw):
        if env.get("BACKEND_IMAGE") == a["backend_image"] and "up" in args:
            world.runner.gateway_ok = True
        return orig(args, env, **kw)

    world.runner.gateway_ok = False
    world.runner.run = run
    world.runner.calls.clear()
    assert world.dep.run_once() == "rolled-back"
    assert S._state(world, "current.json")["sha"] == "a" * 40
    stops = [c for c in _compose_calls(world) if _verb(c) == "stop"]
    assert stops and stops[-1]["args"][-1] == "support-gateway" and "support-gateway" in _profiles(stops[-1]), "the gateway of the failed release does not keep running"
    assert stops[-1]["env"]["BACKEND_IMAGE"] == a["backend_image"]


def test_a_release_without_the_gateway_after_one_with_it_stops_the_gateway(world) -> None:
    world.publish("a" * 40, gateway=True)
    world.dep.run_once()
    world.publish("b" * 40, gateway=False)
    world.runner.calls.clear()
    assert world.dep.run_once() == "deployed"
    stops = [c for c in _compose_calls(world) if _verb(c) == "stop"]
    assert len(stops) == 1 and stops[0]["args"][-1] == "support-gateway" and "SUPPORT_GATEWAY_IMAGE" not in stops[0]["env"]
    assert "support_gateway_image" not in S._state(world, "current.json") and S._state(world, "current.json")["previous"]["support_gateway_image"]


def test_two_releases_with_the_same_images_but_a_new_gateway_image_is_a_new_release(world) -> None:
    world.publish("a" * 40, gateway=False)
    world.dep.run_once()
    d = world.publish("a" * 40, gateway=True)
    assert world.dep.run_once() == "deployed", "the same sha with a gateway image added is a different release"
    assert S._state(world, "current.json")["support_gateway_image"] == d["support_gateway_image"]
    assert world.dep.run_once() == "up-to-date"


def test_a_failed_first_gateway_release_stops_the_gateway_with_the_rest(world) -> None:
    world.publish()
    world.runner.healthy_after = 10**6
    assert world.dep.run_once() == "failed-no-previous"
    stop = [c for c in _compose_calls(world) if _verb(c) == "stop"][-1]
    assert stop["args"][stop["args"].index("stop"):] == ["stop", "backend", "frontend", "caddy", "support-gateway"]


# ── the declaration, the compose file, the bundle and its build ──────────────────────────────────────────────────────────────────────────────

def _decl(tmp_path: Path, mutate) -> Path:
    doc = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    mutate(doc)
    p = tmp_path / "dev.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


def test_the_dev_declaration_has_the_gateway_and_prod_has_none_yet() -> None:
    dev, prod = renv.load_declaration(_VM / "env/dev.yaml"), renv.load_declaration(_VM / "env/prod.yaml")
    assert dev["support_gateway"]["database"] == {"user": "support_gw", "name": "support_gateway", "password_secret": GW_SECRET_ID}
    assert "support-gateway" in dev["services"] and "support_gateway" not in prod and "support-gateway" not in prod["services"]


@pytest.mark.parametrize("mutate,message", [
    (lambda d: d.pop("support_gateway"), "must be declared together"),
    (lambda d: d["services"].pop("support-gateway"), "must be declared together"),
    (lambda d: d["support_gateway"]["database"].pop("password_secret"), "lacks password_secret"),
    (lambda d: d["support_gateway"]["database"].update(user="Support GW; drop"), "plain lower-case identifiers"),
    (lambda d: d["support_gateway"]["database"].update(name="sprintable"), "must not share"),
    (lambda d: d["support_gateway"]["database"].update(user="sprintable"), "must not share"),
])
def test_a_half_declared_or_shared_gateway_is_refused(tmp_path: Path, mutate, message: str) -> None:
    with pytest.raises(renv.EnvError, match=message):
        renv.load_declaration(_decl(tmp_path, mutate))


def test_the_gateways_variable_namespace_has_no_hyphen_and_its_secret_id_is_listed_for_the_grants() -> None:
    assert renv.prefixed("support-gateway", "X") == "SUPPORT_GATEWAY__X" and renv.prefixed("backend", "X") == "BACKEND__X"
    ids = {sid for svc in renv.load_declaration(_VM / "env/dev.yaml")["services"].values() for sid in (svc.get("secrets") or {}).values()}
    assert {"SUPPORT_GATEWAY_ADMIN_TOKEN_dev", "SUPPORT_GATEWAY_TOKEN_SECRET_dev"} <= ids
    with pytest.raises(renv.EnvError):
        renv.gateway_database_url(renv.load_declaration(_VM / "env/dev.yaml"), "has a space or ' quote")
    assert renv.gateway_database_url(renv.load_declaration(_VM / "env/dev.yaml"), GW_PASSWORD) == GATEWAY_URL


def test_the_compose_file_has_the_two_gateway_services_in_profiles_and_the_others_do_not_mention_them() -> None:
    doc = yaml.safe_load((_VM / "compose.yml").read_text())["services"]
    assert doc["support-gateway"]["profiles"] == ["support-gateway"] and doc["support-gateway-migrate"]["profiles"] == ["support-gateway-migrate"]
    for name in ("support-gateway", "support-gateway-migrate"):
        assert doc[name]["image"] == "${SUPPORT_GATEWAY_IMAGE:-not-part-of-this-release}", "no required variable: a release without the image still loads"
        assert doc[name]["depends_on"]["db"]["condition"] == "service_healthy" and doc[name]["environment"] == ["SUPPORT_GATEWAY_DATABASE_URL"]
    assert doc["support-gateway"]["expose"] == ["8080"] and "ports" not in doc["support-gateway"], "reachable on the compose network only"
    assert "/healthz" in " ".join(doc["support-gateway"]["healthcheck"]["test"])
    for name in ("db", "migrate", "backend", "frontend", "caddy"):
        dumped = json.dumps(doc[name]).lower().replace("_", "-")
        assert "support-gateway" not in dumped, name
    assert doc["caddy"]["environment"].keys() == {"API_HOST", "REALTIME_HOST", "APP_HOST", "ACME_EMAIL"}, "Caddy's configuration is unchanged by this step, so a deploy does not recreate it"
    assert "support-gateway" not in doc["caddy"].get("depends_on", {})


def test_make_bundle_writes_the_gateway_image_only_when_given(tmp_path: Path) -> None:
    mk = _sibling_path("make_bundle")
    out1, out2 = tmp_path / "a", tmp_path / "b"
    base = ["make_bundle.py", "--sha", "abc1234", "--backend-image", "r/backend@sha256:" + "1" * 64, "--frontend-image", "r/frontend-vm@sha256:" + "2" * 64]
    assert mk.main([*base, "--out", str(out1)]) == 0
    assert mk.main([*base, "--support-gateway-image", "r/support-gateway@sha256:" + "3" * 64, "--out", str(out2)]) == 0
    d1, d2 = json.loads((out1 / "desired.json").read_text()), json.loads((out2 / "desired.json").read_text())
    assert "support_gateway_image" not in d1 and d2["support_gateway_image"] == "r/support-gateway@sha256:" + "3" * 64
    assert {k: v for k, v in d2.items() if k != "support_gateway_image"} == d1, "the bundle itself is the same bytes"


def _sibling_path(name: str):
    spec = importlib.util.spec_from_file_location(name, _VM / "bin" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_bundle_build_resolves_the_gateway_digest_and_hands_it_to_make_bundle() -> None:
    steps = {s["id"]: s for s in yaml.safe_load((_ROOT / "cloudbuild-vm.yaml").read_text())["steps"]}
    resolve, bundle = steps["resolve-backend"]["args"][1], steps["bundle-vm"]["args"][1]
    assert 'support-gateway:${COMMIT_SHA}' in resolve and "support-gateway-image.txt" in resolve and "image_summary.digest" in resolve
    assert "sha256:[0-9a-f]{64}" in resolve.split("gw_digest")[2], "the digest is checked before it is written"
    assert '--support-gateway-image "$$gateway"' in bundle and "support-gateway-image.txt" in bundle
    assert bundle.index("support-gateway-image.txt") < bundle.index("make_bundle.py"), "no bundle is built without the gateway image of this sha"


def test_the_runbook_section_says_what_is_added_in_what_order_and_what_each_step_interrupts() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    sec = text.split("## 13. The support gateway on the VM")[1]
    for token in ("support_gateway_image", "role `support_gw`", "psql's standard input", "no container is restarted", "the database and Caddy are not touched", "SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV",
                  "**Undo:** copy the previous `desired.json` back (a release without the image)", "`compose stop support-gateway`", "Security note for the second reviewer", "Not in this step", "dev-support.sprintable.ai", "is **refused**"):
        assert token in sec, token
    assert "SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV" in text.split("## 3. Database password")[1].split("## 4.")[0] and "SUPPORT_GATEWAY_ADMIN_TOKEN_dev" in text.split("## 3. Database password")[1].split("## 4.")[0]


def test_the_swap_marker_and_the_previous_release_keep_the_gateway_image(world) -> None:
    """pending.json is what a crashed swap leaves behind, and `previous` is what a rollback goes back to: both must name the gateway image or a reconcile would start the wrong thing"""
    a = world.publish("a" * 40, gateway=True)
    seen: dict = {}
    orig = world.runner.run

    def run(args, env, **kw):
        if "--wait-timeout" in args and (world.cfg.state_dir / "pending.json").exists():
            seen["pending"] = json.loads((world.cfg.state_dir / "pending.json").read_text())
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "deployed"
    assert seen["pending"]["support_gateway_image"] == a["support_gateway_image"]
    b = world.publish("b" * 40, gateway=True)
    assert world.dep.run_once() == "deployed"
    assert S._state(world, "current.json")["previous"]["support_gateway_image"] == a["support_gateway_image"]
    assert S._state(world, "current.json")["support_gateway_image"] == b["support_gateway_image"]


def test_a_crashed_gateway_swap_is_settled_to_the_recorded_gateway_release(world) -> None:
    a = world.publish("a" * 40, gateway=True)
    assert world.dep.run_once() == "deployed"
    cur = S._state(world, "current.json")
    # a later swap died after it began: pending names a different release than the recorded one, so the recorded one (gateway included) is put back
    (world.cfg.state_dir / "pending.json").write_text(json.dumps({**{k: cur[k] for k in D.STATE_KEYS}, "sha": "c" * 40, "at": 1}))
    world.runner.calls.clear()
    world.publish("a" * 40, gateway=True)
    assert world.dep.run_once() == "up-to-date"
    ups = [c for c in _compose_calls(world) if "--wait-timeout" in c["args"]]
    assert ups and ups[0]["env"]["SUPPORT_GATEWAY_IMAGE"] == a["support_gateway_image"] and "support-gateway" in _profiles(ups[0])


def test_a_crashed_first_gateway_release_is_stopped_with_the_gateway_when_it_was_recorded_failed(world) -> None:
    """no release was ever recorded, a swap began (pending.json), and the failure was recorded: the next run stops what that swap started — the gateway among it"""
    d = world.publish("a" * 40, gateway=True)
    pending = {**D.release_state(d), "at": 1}
    (world.cfg.state_dir).mkdir(parents=True, exist_ok=True)
    (world.cfg.state_dir / "pending.json").write_text(json.dumps(pending))
    (world.cfg.state_dir / "failed.json").write_text(json.dumps({"signature": D.signature(pending), "phase": "post-swap", "detail": "x", "at": 1}))
    assert world.dep.run_once() == "skipping-failed", "the stop settled the leftover, then the version that failed after its swap is not tried again"
    stops = [c for c in _compose_calls(world) if _verb(c) == "stop"]
    assert stops, "the unrecorded first release is stopped"
    first = stops[0]
    assert first["args"][first["args"].index("stop"):] == ["stop", "backend", "frontend", "caddy", "support-gateway"]
    assert first["env"]["SUPPORT_GATEWAY_IMAGE"] == d["support_gateway_image"], "prepared from the pending record, which names the gateway image"


def test_the_gateways_call_into_the_backend_is_the_route_the_pipeline_gave_it_on_the_port_the_backend_exposes() -> None:
    cb = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
    deploy = next(s for s in cb["steps"] if s["id"] == "deploy-support-gateway")["args"][1]
    route = re.search(r"SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL=\$\{_FASTAPI_URL\}(/[\w/.-]+)", deploy).group(1)
    url = yaml.safe_load((_VM / "env/dev.yaml").read_text())["services"]["support-gateway"]["overrides"]["SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL"]
    exposed = yaml.safe_load((_VM / "compose.yml").read_text())["services"]["backend"]["expose"]
    assert url == f"http://backend:{exposed[0]}{route}"


def test_the_gateway_role_is_not_the_backends() -> None:
    d = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    assert d["support_gateway"]["database"]["user"] == "support_gw" and d["support_gateway"]["database"]["user"] != d["database"]["user"]
