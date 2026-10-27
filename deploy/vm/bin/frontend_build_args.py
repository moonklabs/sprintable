#!/usr/bin/env python3
"""The `docker build --build-arg` list of the VM's frontend image (story 4796).

`apps/web/Dockerfile` bakes `NEXT_PUBLIC_FASTAPI_URL` (and `NEXT_PUBLIC_APP_URL`) into the Next.js build (rewrites go into routes-manifest.json, the client bundle
inlines NEXT_PUBLIC_*). The Cloud Run image therefore keeps calling the Cloud Run backend; the VM needs its own build with the VM's API host. The Dockerfile already
takes both as build arguments, so no Dockerfile change is needed — only a different argument list. This prints it:

  frontend_build_args.py <declaration.yaml> --sha <git sha> [--set NAME=VALUE]...

* NEXT_PUBLIC_FASTAPI_URL / NEXT_PUBLIC_APP_URL come from the declaration's `hosts` (https://<api>, https://<app>) — never from --set.
* The remaining public build values (GA4 id, EE flag, support widget flag + gateway URL, Toss client key) must equal what the Cloud Run build of the SAME environment uses
  (cloud-build.yml `steps.env`), so they are required with --set; an explicit empty value (`--set NAME=`) is allowed.
* The two derived hosts must not be run.app addresses. The support gateway URL is its own service that stays on Cloud Run, so it may be one.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_env as renv  # noqa: E402

REQUIRED_SET = (
    "NEXT_PUBLIC_GA4_MEASUREMENT_ID",
    "NEXT_PUBLIC_EE_ENABLED",
    "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED",
    "NEXT_PUBLIC_SUPPORT_GATEWAY_URL",
    "NEXT_PUBLIC_TOSS_CLIENT_KEY",
)
DERIVED = ("NEXT_PUBLIC_FASTAPI_URL", "NEXT_PUBLIC_APP_URL")


class BuildArgsError(Exception):
    pass


def build_args(decl: dict, sha: str, given: dict[str, str]) -> list[tuple[str, str]]:
    if not re.fullmatch(r"[0-9a-f]{7,64}", sha):
        raise BuildArgsError("--sha must be a git sha (lower-case hex)")
    bad = [n for n in given if n in DERIVED]
    if bad:
        raise BuildArgsError(f"{', '.join(bad)} come from the declaration's hosts, not from --set")
    unknown = sorted(set(given) - set(REQUIRED_SET))
    if unknown:
        raise BuildArgsError(f"unknown build value(s): {', '.join(unknown)}")
    missing = [n for n in REQUIRED_SET if n not in given]
    if missing:
        raise BuildArgsError(f"missing --set for: {', '.join(missing)} (use the values of the Cloud Run build of this environment; `NAME=` for an empty one)")
    api, app = f"https://{decl['hosts']['api']}", f"https://{decl['hosts']['app']}"
    args = [("NEXT_PUBLIC_FASTAPI_URL", api), ("NEXT_PUBLIC_APP_URL", app), ("NEXT_PUBLIC_OAUTH_ENABLED", "true")]
    args += [(n, given[n]) for n in REQUIRED_SET]
    args += [("SPRINTABLE_DEPLOY_BUILD", "1"), ("APP_COMMIT_SHA", sha)]
    # the two hosts the image calls must be the VM's; the support gateway is its own Cloud Run service that stays where it is (design §3), so its URL may be a run.app address
    offenders = [n for n, v in args if n in DERIVED and "run.app" in v]
    if offenders:
        raise BuildArgsError(f"{', '.join(offenders)} point at run.app — the VM image must not call the Cloud Run backend")
    return args


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("declaration")
    ap.add_argument("--sha", required=True)
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
    a = ap.parse_args(argv[1:])
    try:
        given: dict[str, str] = {}
        for item in a.set:
            if "=" not in item:
                raise BuildArgsError(f"--set expects NAME=VALUE, got «{item}»")
            name, value = item.split("=", 1)
            given[name] = value
        for name, value in build_args(renv.load_declaration(a.declaration), a.sha, given):
            print(f"{name}={value}")
    except (BuildArgsError, renv.EnvError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
