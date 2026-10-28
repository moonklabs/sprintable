"""story 4796 — the environment of the VM (deploy/vm/env/dev.yaml + deploy/vm/bin/render_env.py).

The live services' variable NAMES (the PO's export) are the reference: every one of them must be placed exactly once — carried from the live service, overridden for the VM,
computed, read from a secret, or dropped with a reason — so moving to a VM cannot silently lose a setting. The VM-specific values that make «one process, no Redis» true are
pinned here too (a default in the code is `true` for the Redis consume loop; an edit that turned a flag back on would start a loop that has no Redis to read).
"""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import re
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"


def _load():
    spec = importlib.util.spec_from_file_location("render_env", _VM / "bin/render_env.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


R = _load()
DECL = R.load_declaration(_VM / "env/dev.yaml")
DECLS = {e: R.load_declaration(_VM / f"env/{e}.yaml") for e in ("dev", "prod")}
HOSTS = {"dev": ("dev-api", "dev-realtime", "dev-app"), "prod": ("api", "realtime", "app")}


def _live(path: Path, section: str) -> dict[str, tuple[str, str | None]]:
    out: dict[str, tuple[str, str | None]] = {}
    cur = None
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            cur = line[3:].strip()
            continue
        m = re.match(r"^([A-Za-z0-9_]+) <(plain|secret)(?: ([^>]+))?>$", line)
        if cur == section and m:
            out[m.group(1)] = (m.group(2), m.group(3))
    return out


@pytest.mark.parametrize("env", ["dev", "prod"])
@pytest.mark.parametrize("service", ["backend", "frontend"])
def test_every_live_variable_is_placed_exactly_once(env: str, service: str) -> None:
    svc = DECLS[env]["services"][service]
    live = _live(_VM / f"env/live-names.{env}.txt", svc["live_section"])
    assert live, "the live-names fixture has no such section"
    groups = {
        "overrides": set(svc.get("overrides") or {}),
        "secrets": set(svc.get("secrets") or {}),
        "computed": set(svc.get("computed") or {}),
        "dropped": set(svc.get("dropped") or {}),
        "live_plain": set(svc.get("live_plain") or []),
    }
    seen: dict[str, str] = {}
    for g, names in groups.items():
        for n in names:
            assert n not in seen, f"{n} is in both {seen[n]} and {g}"
            seen[n] = g
    assert set(seen) == set(live), f"missing: {sorted(set(live) - set(seen))} · not live: {sorted(set(seen) - set(live))}"
    # a variable the live service holds as a secret stays a secret (or is computed from the VM database), never plain text in this repository
    for name, (kind, _sid) in live.items():
        if kind == "secret":
            assert seen[name] in ("secrets", "computed", "dropped"), f"{name} is a live secret but is declared {seen[name]}"
    # the secret ids are the live ones, so the same Secret Manager entries feed the VM
    for name in groups["secrets"]:
        assert svc["secrets"][name] == live[name][1], f"{name}: secret id differs from the live service"
    # `added` is new on the VM — none of those names may already exist live (that would be an override)
    assert not (set(svc.get("added") or {}) & set(live))


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_the_vm_runs_one_process_without_redis(env: str) -> None:
    decl = DECLS[env]
    o = decl["services"]["backend"]["overrides"]
    for flag in (
        "EVENT_BROKER_REDIS_CONSUME_ENABLED", "EVENT_BROKER_REDIS_DISPATCH_ENABLED", "EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED",
        "FANOUT_WAKE_REDIS_ENABLED", "PRESENCE_ONLINE_REDIS_ENABLED", "PRESENCE_REDIS_ENABLED", "SSE_LEASE_REDIS_ENABLED",
    ):
        assert o[flag] == "false", f"{flag} must be off on the VM"
    # dev's live service sets the rate-limit backend (override); prod's does not and the code default is already «memory» — either way it must not be «redis»
    assert o.get("RATE_LIMIT_BACKEND", "memory") == "memory" and "RATE_LIMIT_BACKEND" not in decl["services"]["backend"]["secrets"]
    assert o["PG_LISTEN_ENABLED"] == "true" and o["DB_PGBOUNCER"] == "false"
    assert "REDIS_URL" in decl["services"]["backend"]["dropped"]
    assert decl["services"]["backend"]["added"]["TRUST_FORWARDED_FOR"] == "true", "behind Caddy the client address is the last X-Forwarded-For entry"


def test_the_dev_attachments_bucket_is_the_one_cloud_run_dev_uses_on_both_services_and_prod_names_none() -> None:
    """found by the first dev bootstrap: the live check reported GCS_MEMO_ATTACHMENTS_BUCKET on both services as «not in the declaration» — it went live (story 4798) after the declaration was written"""
    cloudbuild = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())["substitutions"]["_GCS_MEMO_ATTACHMENTS_BUCKET"]
    assert cloudbuild == "sprintable-memo-attachments-dev"
    for svc in ("backend", "frontend"):
        s = DECLS["dev"]["services"][svc]
        assert s["overrides"]["GCS_MEMO_ATTACHMENTS_BUCKET"] == cloudbuild, svc
        assert "GCS_MEMO_ATTACHMENTS_BUCKET" not in (s["added"] or {}), "it is live, so it is an override, not an addition"
        live = _live(_VM / "env/live-names.dev.txt", f"sprintable-{svc}-dev")
        assert "GCS_MEMO_ATTACHMENTS_BUCKET" in live, svc
        p = DECLS["prod"]["services"][svc]
        assert not any("GCS_MEMO_ATTACHMENTS_BUCKET" in (p.get(k) or {}) for k in ("overrides", "added", "secrets", "computed")) and "GCS_MEMO_ATTACHMENTS_BUCKET" not in (p.get("live_plain") or ())


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_the_public_addresses_are_the_vm_hosts_not_cloud_run(env: str) -> None:
    decl = DECLS[env]
    hosts = decl["hosts"]
    assert (hosts["api"], hosts["realtime"], hosts["app"]) == tuple(f"{h}.sprintable.ai" for h in HOSTS[env])
    api, app, rt = (f"https://{hosts[k]}" for k in ("api", "app", "realtime"))
    sb, sf = decl["services"]["backend"], decl["services"]["frontend"]
    # a name is an override when the live service has it, otherwise an addition — the value is the VM host either way
    b = {**(sb["overrides"] or {}), **(sb["added"] or {})}
    f = {**(sf["overrides"] or {}), **(sf["added"] or {})}
    assert b["BACKEND_URL"] == b["FASTAPI_URL"] == api
    if env == "dev":
        assert b["ADMIN_OPERATOR_AUDIENCE"] == api, "dev's live service sets an admin audience; it follows the API host"
    else:
        assert "ADMIN_OPERATOR_AUDIENCE" not in b, "prod's live service has none and the VM must not switch the admin lane on"
    assert b["APP_URL"] == b["NEXT_PUBLIC_APP_URL"] == f["APP_BASE_URL"] == f["NEXT_PUBLIC_APP_URL"] == app
    assert f["NEXT_PUBLIC_FASTAPI_URL"] == api and f["REALTIME_URL"] == rt
    assert "run.app" not in (_VM / f"env/{env}.yaml").read_text()
    assert set(hosts) == {"api", "realtime", "app"}
    assert decl["environment"] == env, "a declaration must say which environment it is for"
    assert decl["buckets"] == {"deploy": f"sprintable-vm-{env}-deploy", "backups": f"sprintable-vm-{env}-backups"}
    assert decl["database"]["password_secret"] == f"DB_PASSWORD_VM_{env.upper()}"


def test_prod_adds_nothing_the_live_prod_service_does_not_have_except_the_vm_switch() -> None:
    """prod behaves as prod does today: no new admin lane, no new rate-limit setting; the only new name is TRUST_FORWARDED_FOR (and it is in the live-name-free `added` group)"""
    assert set(DECLS["prod"]["services"]["backend"]["added"]) == {"TRUST_FORWARDED_FOR"}
    assert not DECLS["prod"]["services"]["frontend"]["added"]


def test_prod_carries_no_payment_secrets_and_no_dev_secret_ids() -> None:
    prod = DECLS["prod"]["services"]
    ids = {sid for svc in prod.values() for sid in svc["secrets"].values()}
    assert not any("TOSS" in n for svc in prod.values() for n in svc["secrets"]), "payments are outside this release"
    assert not any(i.endswith(("_DEV", "-dev", "_dev")) for i in ids), "a dev secret id leaked into the prod declaration"
    assert {"CRON_SECRET_PROD", "FIREBASE_BFF_INTERNAL_SECRET_PROD"} <= ids


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_cloud_only_and_self_hosting_switches_are_never_declared(env: str) -> None:
    for service, svc in DECLS[env]["services"].items():
        declared = set().union(*(set(svc.get(k) or ()) for k in ("live_plain", "overrides", "secrets", "computed", "added")))
        assert not (R.FORBIDDEN_NAMES & declared), f"{service} declares a forbidden variable"


# ───────────────────────── the build ─────────────────────────

def _decl() -> dict:
    return {
        "database": {"user": "u", "name": "n"},
        "services": {"backend": {
            "live_plain": ["PLAIN_A", "SHARED"],
            "overrides": {"SHARED": "from-override", "OVER": "o"},
            "computed": {"DATABASE_URL": "postgresql+asyncpg://{db_user}:{db_password}@db:5432/{db_name}"},
            "added": {"NEW": "n"},
            "secrets": {"KEY": "KEY_SECRET", "SAME": "KEY_SECRET"},
            "dropped": {"GONE": "why"},
        }},
    }


def test_merge_order_and_computed_values() -> None:
    reads: list[str] = []

    def read(sid: str) -> str:
        reads.append(sid)
        return "-----BEGIN KEY-----\nline2\n-----END KEY-----"

    env = R.build_service_env(_decl(), "backend", {"PLAIN_A": "a", "SHARED": "live", "GONE": "x"}, "pw0123456789abcdef", read)
    assert env["SHARED"] == "from-override" and env["PLAIN_A"] == "a" and env["OVER"] == "o" and env["NEW"] == "n"
    assert env["DATABASE_URL"] == "postgresql+asyncpg://u:pw0123456789abcdef@db:5432/n"
    assert env["KEY"].count("\n") == 2, "a multi-line secret (a PEM key) is kept as it is"
    assert env["SAME"] == env["KEY"] and reads == ["KEY_SECRET"], "one read per secret id"
    assert "GONE" not in env


def test_a_missing_private_value_or_secret_stops_the_build_without_printing_values() -> None:
    with pytest.raises(R.EnvError) as e:
        R.build_service_env(_decl(), "backend", {"PLAIN_A": "a"}, "pw0123456789abcdef", lambda s: "v")
    assert "SHARED" in str(e.value) and "PLAIN_A" not in str(e.value)

    def boom(sid: str) -> str:
        raise PermissionError("secret-value-that-must-not-print")

    with pytest.raises(R.EnvError) as e2:
        R.build_service_env(_decl(), "backend", {"PLAIN_A": "a", "SHARED": "s"}, "pw0123456789abcdef", boom)
    msg = str(e2.value)
    assert "KEY" in msg and "PermissionError" in msg and "secret-value-that-must-not-print" not in msg


def test_forbidden_names_and_nul_bytes_are_refused() -> None:
    d = _decl()
    d["services"]["backend"]["added"]["SPRINTABLE_LOCAL_DEV"] = "1"
    with pytest.raises(R.EnvError, match="SPRINTABLE_LOCAL_DEV"):
        R.build_service_env(d, "backend", {"PLAIN_A": "a", "SHARED": "s"}, "pw0123456789abcdef", lambda s: "v")
    d2 = _decl()
    with pytest.raises(R.EnvError, match="NUL"):
        R.build_service_env(d2, "backend", {"PLAIN_A": "a\x00", "SHARED": "s"}, "pw0123456789abcdef", lambda s: "v")


@pytest.mark.parametrize("pw", ["short", "has/slash0123456789", "has@at0123456789ab", "has:colon0123456789", "has space0123456789"])
def test_a_password_that_would_break_the_connection_url_is_refused(pw: str) -> None:
    with pytest.raises(R.EnvError, match="openssl rand"):
        R.build_service_env(_decl(), "backend", {"PLAIN_A": "a", "SHARED": "s"}, pw, lambda s: "v")


def test_the_compose_override_lists_names_only(tmp_path: Path) -> None:
    out = tmp_path / "pass.yml"
    R.write_passthrough(out, {"backend": {"B_KEY": "super-secret", "A_KEY": "other-secret"}})
    text = out.read_text()
    assert "super-secret" not in text and "other-secret" not in text
    assert yaml.safe_load(text) == {"services": {"backend": {"environment": {"A_KEY": "${BACKEND__A_KEY}", "B_KEY": "${BACKEND__B_KEY}"}}}}
    assert R.process_environment({"backend": {"A": "1"}, "frontend": {"A": "2"}}) == {"BACKEND__A": "1", "FRONTEND__A": "2"}, "same name in two services must not collide"


def test_private_plain_must_be_json_service_then_name_then_string(tmp_path: Path) -> None:
    ok = tmp_path / "ok.json"
    ok.write_text(json.dumps({"backend": {"A": "1"}, "frontend": {"A": "2"}}))
    assert R.load_private_plain(ok) == {"backend": {"A": "1"}, "frontend": {"A": "2"}}
    for bad in ('["A"]', '{"A": "1"}', '{"backend": {"A": 1}}', '{"backend": ["A"]}', "not json"):
        p = tmp_path / "bad.json"
        p.write_text(bad)
        with pytest.raises((R.EnvError, json.JSONDecodeError)):
            R.load_private_plain(p)


# ───────────────────────── Secret Manager through the VM's identity ─────────────────────────

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_the_secret_reader_uses_the_metadata_token_once_and_decodes_the_payload() -> None:
    calls: list[tuple[str, dict]] = []

    def urlopen(req, timeout=0):
        calls.append((req.full_url, dict(req.header_items())))
        if "metadata.google.internal" in req.full_url:
            return _Resp(json.dumps({"access_token": "tok"}).encode())
        data = base64.b64encode("-----BEGIN-----\nx\n".encode()).decode()
        return _Resp(json.dumps({"payload": {"data": data}}).encode())

    read = R.MetadataSecretReader("proj-1", urlopen=urlopen)
    assert read("S_ONE") == "-----BEGIN-----\nx\n"
    assert read("S_TWO") == "-----BEGIN-----\nx\n"
    meta = [c for c in calls if "metadata.google.internal" in c[0]]
    sm = [c for c in calls if "secretmanager" in c[0]]
    assert len(meta) == 1, "the token is fetched once"
    assert meta[0][1].get("Metadata-flavor") == "Google"
    assert [c[0] for c in sm] == [
        "https://secretmanager.googleapis.com/v1/projects/proj-1/secrets/S_ONE/versions/latest:access",
        "https://secretmanager.googleapis.com/v1/projects/proj-1/secrets/S_TWO/versions/latest:access",
    ]
    assert all(c[1].get("Authorization") == "Bearer tok" for c in sm)


@pytest.mark.parametrize("bad", ["", "a/b", "../x", "a..b"])
def test_the_secret_reader_refuses_odd_ids(bad: str) -> None:
    read = R.MetadataSecretReader("p", urlopen=lambda *a, **k: pytest.fail("no request may be made"))
    with pytest.raises(R.EnvError):
        read(bad)


def test_render_env_cli_prints_names_and_no_values(capsys: pytest.CaptureFixture[str]) -> None:
    assert R.main(["render_env.py", str(_VM / "env/dev.yaml"), "backend"]) == 0
    names = capsys.readouterr().out.split()
    assert "DATABASE_URL" in names and "JWT_SECRET" in names and "REDIS_URL" not in names and "TRUST_FORWARDED_FOR" in names
    assert all(re.fullmatch(r"[A-Za-z0-9_]+", n) for n in names)


def test_the_metadata_token_is_renewed_before_it_expires() -> None:
    tokens = iter(["tok1", "tok2", "tok3"])
    fetched: list[str] = []
    clock = {"t": 1000.0}

    def urlopen(req, timeout=0):
        if "metadata.google.internal" in req.full_url:
            fetched.append(next(tokens))
            return _Resp(json.dumps({"access_token": fetched[-1], "expires_in": 3600}).encode())
        return _Resp(json.dumps({"payload": {"data": base64.b64encode(b"v").decode()}}).encode())

    read = R.MetadataSecretReader("p", urlopen=urlopen, now=lambda: clock["t"])
    read("S1")
    clock["t"] += 3000
    read("S2")
    assert fetched == ["tok1"], "still valid after 50 minutes"
    clock["t"] += 600
    read("S3")
    assert fetched == ["tok1", "tok2"], "renewed a minute before the hour ends"


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_each_declaration_builds_a_complete_environment_with_fake_values(env: str) -> None:
    decl = DECLS[env]
    for name, svc in decl["services"].items():
        plain = {n: "plain" for n in svc["live_plain"]}
        built = R.build_service_env(decl, name, plain, "0123456789abcdef0123", lambda sid: "s-" + sid)
        live = _live(_VM / f"env/live-names.{env}.txt", svc["live_section"])
        expected = (set(live) - set(svc["dropped"] or {})) | set(svc["added"] or {})
        assert set(built) == expected, f"{env}/{name}: {sorted(set(built) ^ expected)}"
        assert not (R.FORBIDDEN_NAMES & set(built))
        if name == "backend":
            assert built["DATABASE_URL"].startswith("postgresql+asyncpg://sprintable:") and built["DATABASE_URL"].endswith("@db:5432/sprintable")
            assert "REDIS_URL" not in built and built["TRUST_FORWARDED_FOR"] == "true"


@pytest.mark.parametrize("env,wanted", [("dev", "JWT_SECRET_DEV"), ("prod", "JWT_SECRET_PROD")])
def test_the_jwt_secret_is_the_environments_own_and_the_shared_one_is_never_read(env: str, wanted: str) -> None:
    for service in ("backend", "frontend"):
        secrets = DECLS[env]["services"][service]["secrets"]
        assert secrets["JWT_SECRET"] == wanted, f"{env}/{service}"
    all_ids = {sid for d in DECLS.values() for svc in d["services"].values() for sid in svc["secrets"].values()}
    assert "JWT_SECRET" not in all_ids, "the shared JWT_SECRET entry is deleted at story 4798 AC9"
