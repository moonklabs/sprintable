#!/usr/bin/env python3
"""The input id of the VM's frontend image (story 4805).

  frontend_input_id.py <declaration.yaml> [--set NAME=VALUE]... [--root DIR]   → prints `inputs-<32 hex>`

Two builds with the same id build the same frontend: the same sources, the same base image, the same build values, the same build scripts. cloudbuild-vm.yaml uses it to reuse the
image an earlier build made (frontend-vm-image.sh): the commit that is baked in (APP_COMMIT_SHA, build time) is put on top again, nothing else is rebuilt. An id that is NOT the same
means a full build, as before. Everything that cannot be told for sure ends in a full build (exit 3, nothing printed): the reuse is only ever a shortcut.

What goes into the id (a change in any of it makes a new id):
  • the files the Dockerfile copies into the build (INPUT_PATHS — and the Dockerfile itself, which is under apps/web). Every `COPY` source of apps/web/Dockerfile must lie inside INPUT_PATHS,
    or the script stops with exit 3: a source that is not counted would let an old image be reused for new code.
  • the digest of every base image (`FROM …@sha256:`). A base image named by a tag only cannot be counted → exit 3. A new base image (a security patch) is a new digest, hence a new id.
  • the build arguments (the hosts of the environment's declaration and the five public values), exactly as frontend_build_args.py derives them, without the commit.
  • the build scripts themselves (build-frontend-vm.sh, frontend-vm-image.sh, frontend_build_args.py, render_env.py, this file) and the restamp Dockerfile, and ID_VERSION.
Not in it: docs, tests of the backend, the rest of the repository — they are not in the image. node_modules / .next / .turbo / .git / .vercel folders are skipped as .dockerignore skips them.
"""
from __future__ import annotations

import argparse
import hashlib
import posixpath
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frontend_build_args as fba  # noqa: E402
import render_env as renv  # noqa: E402

ID_VERSION = "1"
# what `apps/web/Dockerfile` COPYs from the build context (checked at run time against its COPY lines), and what decides how the image is built from them
INPUT_PATHS = (
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages", "apps/web", "ee",
    ".dockerignore",
    "deploy/vm/bin/build-frontend-vm.sh", "deploy/vm/bin/frontend-vm-image.sh", "deploy/vm/bin/frontend_build_args.py", "deploy/vm/bin/render_env.py", "deploy/vm/bin/frontend_input_id.py",
    "deploy/vm/frontend-restamp/Dockerfile",
)
SKIP_DIRS = {"node_modules", ".next", ".turbo", ".git", ".vercel"}
DOCKERFILE = "apps/web/Dockerfile"


class NotReusable(Exception):
    """the id cannot be told for sure — the caller builds in full"""


def copy_sources(dockerfile_text: str) -> list[str]:
    """the build-context sources of the Dockerfile's COPY / ADD lines. A `--from=` copy comes from another stage of the same Dockerfile, not from the context; one that names anything else
    (an external image, whose tag can move without a line of ours changing) cannot be counted → NotReusable. A source outside the context (`..`, absolute) too."""
    out: list[str] = []
    stages: set[str] = set()
    for raw in re.sub(r"\\\n", " ", dockerfile_text).splitlines():
        line = raw.strip()
        fm = re.match(r"(?i)FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?", line)
        if fm:
            if fm.group(1):
                stages.add(fm.group(1).lower())
            continue
        m = re.match(r"(?i)(COPY|ADD)\s+(.*)", line)
        if not m:
            continue
        words = m.group(2).split()
        flags = [w for w in words if w.startswith("--")]
        src_from = next((f.split("=", 1)[1] for f in flags if f.startswith("--from=")), None)
        if src_from is not None:
            if src_from.lower() not in stages and not src_from.isdigit():
                raise NotReusable(f"«{line}» copies from «{src_from}», which is not a stage of this Dockerfile")
            continue
        args = [w for w in words if not w.startswith("--")]
        if len(args) < 2:
            raise NotReusable(f"cannot read the COPY line «{line}»")
        for a in args[:-1]:
            s = a.rstrip("/") or "/"
            n = posixpath.normpath(s)
            if n != s or n.startswith("/") or n == ".." or n.startswith("../") or n == ".":
                raise NotReusable(f"the COPY source «{a}» is not a path inside the build context")
            out.append(n)
    return out


def base_digests(dockerfile_text: str) -> list[str]:
    """the `FROM … @sha256:…` digests; a base image named by a tag only cannot be counted"""
    found: list[str] = []
    stages: set[str] = set()
    for line in dockerfile_text.splitlines():
        m = re.match(r"(?i)\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?", line)
        if not m:
            continue
        ref, stage = m.group(1), m.group(2)
        if ref in stages:  # FROM <an earlier stage>
            if stage:
                stages.add(stage)
            continue
        d = re.search(r"@(sha256:[0-9a-f]{64})$", ref)
        if not d:
            raise NotReusable(f"base image «{ref}» is named by a tag, not a digest")
        found.append(d.group(1))
        if stage:
            stages.add(stage)
    if not found:
        raise NotReusable("no base image found in the Dockerfile")
    return found


def _covered(src: str) -> bool:
    return any(src == p or src.startswith(p + "/") for p in INPUT_PATHS)


def _files(root: Path, rel: str) -> list[Path]:
    p = root / rel
    if p.is_file():
        return [p]
    if not p.is_dir():
        raise NotReusable(f"input «{rel}» is not there")
    return sorted(f for f in p.rglob("*") if f.is_file() and not (set(f.relative_to(root).parts) & SKIP_DIRS))


def input_id(root: Path, declaration: Path, given: dict[str, str]) -> str:
    dockerfile = (root / DOCKERFILE).read_text()
    uncounted = [s for s in copy_sources(dockerfile) if not _covered(s)]
    if uncounted:
        raise NotReusable(f"the Dockerfile copies {uncounted} but they are not among the inputs of the id")
    digests = base_digests(dockerfile)
    try:
        args = [(n, v) for n, v in fba.build_args(renv.load_declaration(declaration), "0" * 40, given) if n != "APP_COMMIT_SHA"]
    except (fba.BuildArgsError, renv.EnvError) as e:
        raise NotReusable(str(e)) from e
    h = hashlib.sha256()

    def put(*parts: str) -> None:
        for part in parts:
            b = part.encode()
            h.update(len(b).to_bytes(8, "big"))
            h.update(b)

    put("frontend-input-id", ID_VERSION)
    for d in digests:
        put("base", d)
    for n, v in sorted(args):
        put("arg", n, v)
    for rel in INPUT_PATHS:
        for f in _files(root, rel):
            put("file", f.relative_to(root).as_posix(), hashlib.sha256(f.read_bytes()).hexdigest())
    return "inputs-" + h.hexdigest()[:32]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("declaration")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[3]))
    a = ap.parse_args(argv[1:])
    given: dict[str, str] = {}
    for item in a.set:
        if "=" not in item:
            print(f"error: --set expects NAME=VALUE, got «{item}»", file=sys.stderr)
            return 2
        name, value = item.split("=", 1)
        given[name] = value
    try:
        print(input_id(Path(a.root), Path(a.declaration), given))
    except NotReusable as e:
        print(f"not reusable: {e}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
