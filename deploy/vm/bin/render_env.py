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


GATEWAY_SERVICE = "support-gateway"  # the compose service (and the declaration's service key) of the support gateway (story 4796): optional, dev first


def load_declaration(path: str | Path) -> dict:
    decl = yaml.safe_load(Path(path).read_text())
    for key in ("environment", "project", "hosts", "buckets", "database", "services"):
        if key not in decl:
            raise EnvError(f"{path}: missing «{key}»")
    # the gateway has its own database and role inside the same Postgres: the block and the service go together, so a half-declared gateway is refused before anything runs
    has_block, has_service = "support_gateway" in decl, GATEWAY_SERVICE in decl["services"]
    if has_block != has_service:
        raise EnvError(f"{path}: «support_gateway» (database block) and the «{GATEWAY_SERVICE}» service must be declared together")
    if has_block:
        gw_db = (decl["support_gateway"] or {}).get("database") or {}
        missing = [k for k in ("user", "name", "password_secret") if not isinstance(gw_db.get(k), str) or not gw_db[k]]
        if missing:
            raise EnvError(f"{path}: support_gateway.database lacks {', '.join(missing)}")
        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", gw_db["user"]) or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", gw_db["name"]):
            raise EnvError(f"{path}: support_gateway.database user and name must be plain lower-case identifiers")
        if gw_db["user"] == decl["database"]["user"] or gw_db["name"] == decl["database"]["name"]:
            raise EnvError(f"{path}: the gateway must not share the backend's database or role")
    return decl


def check_password(password: str, what: str) -> None:
    if not _SAFE_PASSWORD.fullmatch(password):
        raise EnvError(f"{what} must be letters, digits, «_» or «-» only (it is placed inside a connection URL and a SQL statement) — make it with `openssl rand -hex 24`")


def gateway_database_url(decl: Mapping, password: str) -> str:
    """the support gateway's connection URL (asyncpg, as its settings expect): its own role and database inside the VM's Postgres, never the backend's"""
    gw = decl["support_gateway"]["database"]
    check_password(password, "the support gateway's database password")
    return f"postgresql+asyncpg://{gw['user']}:{password}@db:5432/{gw['name']}"


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
    return f"{service.upper().replace('-', '_')}__{name}"


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
