"""Builds the environment of the compose services from deploy/vm/env/<environment>.yaml (story 4796).

Merge order, lowest first:  private plain file (the live service's non-secret values)  <  overrides  <  computed  <  secrets (Secret Manager).
The result is handed to `docker compose` as the PROCESS ENVIRONMENT of the command (names prefixed with the service, `BACKEND__JWT_SECRET`), and a compose override maps each one (`write_passthrough`): nothing is written to an
.env file, because an env file cannot carry the multi-line PEM keys some secrets are, and a value never reaches a file this tool writes. (Docker keeps a container's
environment in its own root-only config, as it does for any container — rotating a secret means deploying again.)

`dropped` names are simply never put into the environment: they are documentation of what the live service had and the VM does not (the tests keep every name in exactly one group).
Names are checked against the live service by the tests (the declaration must place every live variable exactly once). Values are never printed.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable, Mapping

import yaml

# a VM that sets either of these would run with the cloud-only / self-hosting behaviour switched on (config.py:577-608, docker-compose.yml:56-60)
FORBIDDEN_NAMES = frozenset({"SPRINTABLE_LOCAL_DEV", "K_SERVICE"})
_SAFE_PASSWORD = re.compile(r"[A-Za-z0-9_-]{16,}")


class EnvError(Exception):
    """the environment cannot be built — the deploy must stop before it touches anything running"""


def check_private_address(value: str) -> str:
    """the VM's own private IPv4 address (the one the gateway database is published on): an RFC 1918 address, never «all interfaces», loopback, link-local or a public address"""
    try:
        ip = ipaddress.ip_address(value.strip())
    except ValueError as e:
        raise EnvError("the VM's private address is not an IP address") from e
    if ip.version != 4 or not ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
        raise EnvError("the VM's private address is not a private IPv4 address")
    return str(ip)


def gateway_networks(value: object, where: object = "the declaration") -> list[str]:
    """the networks the gateway database's access rules let the application role in from: one to four private IPv4 networks, each at most a /16 wide — never «everywhere»"""
    if not isinstance(value, list) or not 1 <= len(value) <= 4:
        raise EnvError(f"{where}: support_gateway.allow_from must be a list of one to four networks")
    out = []
    for item in value:
        try:
            net = ipaddress.ip_network(str(item), strict=True)
        except ValueError as e:
            raise EnvError(f"{where}: support_gateway.allow_from has a value that is not a network address") from e
        if net.version != 4 or not net.is_private or net.is_loopback or net.is_link_local or net.is_unspecified or net.prefixlen < 16:
            raise EnvError(f"{where}: support_gateway.allow_from must be private IPv4 networks of /16 or narrower")
        out.append(str(net))
    return out


def gateway_hba(decl: Mapping) -> str:
    """the access rules of the gateway database's server, as the deployer renders them: the application role into its own database from the allowed networks over a password (scram), the
    superuser over the container's unix socket only, everything else refused — no rule names a password or any other value"""
    gw = decl["support_gateway"]["database"]
    lines = ["# rendered by the deployer from env/<environment>.yaml (support_gateway.allow_from) — do not edit", "local   all   all   trust"]
    lines += [f"host    {gw['name']}   {gw['user']}   {net}   scram-sha-256" for net in gateway_networks(decl["support_gateway"].get("allow_from"))]
    lines += ["host    all   all   0.0.0.0/0   reject", "host    all   all   ::/0   reject"]
    return "\n".join(lines) + "\n"


def check_password(password: str, what: str) -> None:
    if not _SAFE_PASSWORD.fullmatch(password):
        raise EnvError(f"{what} must be letters, digits, «_» or «-» only (it is placed inside a connection URL) — make it with `openssl rand -hex 24`")


def load_declaration(path: str | Path) -> dict:
    decl = yaml.safe_load(Path(path).read_text())
    for key in ("environment", "project", "hosts", "buckets", "database", "services"):
        if key not in decl:
            raise EnvError(f"{path}: missing «{key}»")
    # the names of the application's database are used in shell commands of the operations scripts and in the container's environment: plain identifiers only (checked again where they are read, lib.sh)
    for key in ("user", "name"):
        if not isinstance(decl["database"].get(key), str) or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", decl["database"][key]):
            raise EnvError(f"{path}: database.{key} must be a plain lower-case identifier")
    # the support gateway's database (story 4796): a block of its own — a second Postgres with its own user, database and password, published on the VM's private address
    if "support_gateway" in decl:
        gw_db = (decl["support_gateway"] or {}).get("database") or {}
        missing = [k for k in ("user", "name", "password_secret") if not isinstance(gw_db.get(k), str) or not gw_db[k]]
        if missing:
            raise EnvError(f"{path}: support_gateway.database lacks {', '.join(missing)}")
        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", gw_db["user"]) or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", gw_db["name"]):
            raise EnvError(f"{path}: support_gateway.database user and name must be plain lower-case identifiers")
        if gw_db["user"] == decl["database"]["user"] or gw_db["password_secret"] == decl["database"]["password_secret"]:
            raise EnvError(f"{path}: the gateway database must not share the backend database's user or password secret")
        gateway_networks(decl["support_gateway"].get("allow_from"), path)
    return decl


def load_private_plain(path: str | Path) -> dict[str, dict[str, str]]:
    """the non-secret values of the live services, as JSON {service: {name: value}} (the RUNBOOK says how the PO makes it). Per service, because
    the same name can hold different values in the backend and the frontend."""
    raw = json.loads(Path(path).read_text())
    ok = isinstance(raw, dict) and all(
        isinstance(svc, str) and isinstance(vals, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in vals.items()) for svc, vals in raw.items()
    )
    if not ok:
        raise EnvError(f"{path}: expected a JSON object {{service: {{name: value}}}} of strings")
    return raw


def build_service_env(
    decl: Mapping,
    service: str,
    private_plain: Mapping[str, str],
    db_password: str,
    read_secret: Callable[[str], str],
) -> dict[str, str]:
    svc = decl["services"][service]
    db = decl["database"]
    if not _SAFE_PASSWORD.fullmatch(db_password):
        raise EnvError("the database password must be letters, digits, «_» or «-» only (it is placed inside a connection URL) — make it with `openssl rand -hex 24`")
    env: dict[str, str] = {}

    missing_plain = [n for n in svc["live_plain"] if n not in private_plain]
    if missing_plain:
        raise EnvError(f"{service}: the private plain file lacks {len(missing_plain)} variable(s): {', '.join(sorted(missing_plain))}")
    for name in svc["live_plain"]:
        env[name] = private_plain[name]

    env.update({k: str(v) for k, v in (svc.get("overrides") or {}).items()})
    for name, template in (svc.get("computed") or {}).items():
        env[name] = template.format(db_user=db["user"], db_password=db_password, db_name=db["name"])
    env.update({k: str(v) for k, v in (svc.get("added") or {}).items()})

    secrets = svc.get("secrets") or {}
    cache: dict[str, str] = {}
    failed: list[str] = []
    for name, secret_id in secrets.items():
        try:
            if secret_id not in cache:
                cache[secret_id] = read_secret(secret_id)
            env[name] = cache[secret_id]
        except Exception as e:  # noqa: BLE001 — names only; the reason class, never a value
            failed.append(f"{name} ({secret_id}: {type(e).__name__})")
    if failed:
        raise EnvError(f"{service}: could not read {len(failed)} secret(s): {', '.join(failed)}")

    bad = FORBIDDEN_NAMES & env.keys()
    if bad:
        raise EnvError(f"{service}: forbidden variable(s) present: {', '.join(sorted(bad))}")
    for name, value in env.items():
        if "\x00" in value:
            raise EnvError(f"{service}: {name} contains a NUL byte")
    return env


def prefixed(service: str, name: str) -> str:
    """the name a service variable has in the process environment of `docker compose` (backend and frontend both have JWT_SECRET, NEXT_PUBLIC_APP_URL … — one shared namespace would collide)"""
    return f"{service.upper()}__{name}"


def process_environment(services: Mapping[str, Mapping[str, str]]) -> dict[str, str]:
    return {prefixed(svc, name): value for svc, env in services.items() for name, value in env.items()}


def write_passthrough(path: str | Path, services: Mapping[str, Mapping[str, str]]) -> None:
    """a compose override that points each service variable at its prefixed name in the process environment of `docker compose …` (`NAME: ${BACKEND__NAME}`).
    The file holds names only. Compose does not expand a value again, so a `$` inside a secret stays as it is."""
    doc = {"services": {svc: {"environment": {name: "${" + prefixed(svc, name) + "}" for name in sorted(env)}} for svc, env in services.items()}}
    Path(path).write_text(yaml.safe_dump(doc, sort_keys=True, default_flow_style=False))


# ───────────────────────── Secret Manager through the VM's own identity (no gcloud, no key file) ─────────────────────────

_METADATA = "http://metadata.google.internal/computeMetadata/v1"
_SM = "https://secretmanager.googleapis.com/v1"


class MetadataSecretReader:
    """reads `latest` of a secret with the VM service account's token. `urlopen` is injected by the tests."""

    def __init__(self, project: str, urlopen: Callable = urllib.request.urlopen, now: Callable[[], float] = time.time) -> None:
        self._project = project
        self._urlopen = urlopen
        self._now = now
        self._token: str | None = None
        self._token_until = 0.0

    def _get(self, url: str, headers: Mapping[str, str]) -> bytes:
        req = urllib.request.Request(url, headers=dict(headers))
        with self._urlopen(req, timeout=20) as resp:  # noqa: S310 — fixed https/metadata URLs
            return resp.read()

    def token(self) -> str:
        if self._token is None or self._now() >= self._token_until:
            body = json.loads(self._get(f"{_METADATA}/instance/service-accounts/default/token", {"Metadata-Flavor": "Google"}))
            self._token = body["access_token"]
            # a long migration or rollback can outlive the token: ask again a minute before it expires
            self._token_until = self._now() + max(0, int(body.get("expires_in", 300)) - 60)
        return self._token

    def private_ip(self) -> str:
        """the VM's own private address, from the metadata server (checked: a private IPv4 address and nothing else)"""
        return check_private_address(self._get(f"{_METADATA}/instance/network-interfaces/0/ip", {"Metadata-Flavor": "Google"}).decode("ascii", "replace"))

    def __call__(self, secret_id: str) -> str:
        if not secret_id or "/" in secret_id or ".." in secret_id:
            raise EnvError(f"not a secret id: {secret_id!r}")
        url = f"{_SM}/projects/{self._project}/secrets/{secret_id}/versions/latest:access"
        body = self._get(url, {"Authorization": f"Bearer {self.token()}"})
        return base64.b64decode(json.loads(body)["payload"]["data"]).decode("utf-8")


def main(argv: list[str]) -> int:
    """`render_env.py <declaration.yaml> <service>` — prints the variable NAMES the service would get and what is missing in the private file (never a value)"""
    if len(argv) == 3 and argv[1] == "--secret-ids":
        # every Secret Manager id the VM will read (the RUNBOOK grants access to exactly these, one by one)
        decl = load_declaration(argv[2])
        ids = {sid for svc in decl["services"].values() for sid in (svc.get("secrets") or {}).values()} | {decl["database"]["password_secret"]}
        if "support_gateway" in decl:
            ids.add(decl["support_gateway"]["database"]["password_secret"])
        print("\n".join(sorted(ids)))
        return 0
    if len(argv) != 3:
        print("usage: render_env.py <declaration.yaml> <service>  |  render_env.py --secret-ids <declaration.yaml>", file=sys.stderr)
        return 2
    decl = load_declaration(argv[1])
    svc = decl["services"][argv[2]]
    names = sorted({*svc["live_plain"], *(svc.get("overrides") or {}), *(svc.get("computed") or {}), *(svc.get("added") or {}), *(svc.get("secrets") or {})} - set(svc.get("dropped") or {}))
    print("\n".join(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
