#!/usr/bin/env python3
"""Packs deploy/vm into a bundle and writes the desired.json that points at it (story 4796).

  make_bundle.py --sha <git sha> --backend-image <ref> --frontend-image <ref> --out <dir>
      → <dir>/bundles/<sha>.tgz   <dir>/desired.json

The bundle is reproducible (sorted names, no times, no owners), so the same content always has the same sha256 and a rebuild never looks like a new version to the VM.
Cloud Build runs this and uploads the bundle FIRST, desired.json LAST — the VM only ever sees a desired.json whose bundle and images already exist.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

SKIP_DIRS = {"__pycache__"}
# what a bundle may contain: these shapes only (the live-name exports are test fixtures, not deploy input)
TOP_FILES = {"compose.yml", "Caddyfile", "README.md", "RUNBOOK.md"}
DIR_SUFFIXES = {"env": {".yaml"}, "bin": {".py", ".sh", ".sql"}, "systemd": {".service", ".timer"}}
SECRET_LIKE = re.compile(r"(^\.env|\.pem$|\.key$|private-plain|secret|credential|\.p12$|id_rsa)", re.I)


def bundle_files(src: Path) -> list[Path]:
    out = []
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if set(rel.parts) & SKIP_DIRS or p.suffix == ".pyc":
            continue
        if p.is_symlink():
            raise SystemExit(f"refusing to bundle a link: {rel}")
        if not p.is_file():
            continue
        if SECRET_LIKE.search(p.name):
            raise SystemExit(f"refusing to bundle a secret-looking file: {rel}")
        if p.name.startswith("live-names"):
            continue
        parts = rel.parts
        if len(parts) == 1 and parts[0] in TOP_FILES:
            out.append(p)
        elif len(parts) == 2 and parts[0] in DIR_SUFFIXES and p.suffix in DIR_SUFFIXES[parts[0]]:
            out.append(p)
    return out


def build_bundle(src: Path) -> bytes:
    files = bundle_files(src)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for p in files:
            data = p.read_bytes()
            ti = tarfile.TarInfo(p.relative_to(src).as_posix())
            ti.size, ti.mtime, ti.uid, ti.gid, ti.uname, ti.gname = len(data), 0, 0, 0, "", ""
            ti.mode = 0o755 if p.stat().st_mode & 0o111 else 0o644
            tar.addfile(ti, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sha", required=True)
    ap.add_argument("--backend-image", required=True)
    ap.add_argument("--frontend-image", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--src", type=Path, default=Path(__file__).resolve().parent.parent)
    a = ap.parse_args(argv[1:])
    if not re.fullmatch(r"[0-9a-f]{7,64}", a.sha):
        print("--sha must be a git sha (lower-case hex)", file=sys.stderr)
        return 2
    blob = build_bundle(a.src)
    (a.out / "bundles").mkdir(parents=True, exist_ok=True)
    (a.out / "bundles" / f"{a.sha}.tgz").write_bytes(blob)
    desired = {
        "sha": a.sha, "backend_image": a.backend_image, "frontend_image": a.frontend_image,
        "bundle": f"bundles/{a.sha}.tgz", "bundle_sha256": hashlib.sha256(blob).hexdigest(),
    }
    (a.out / "desired.json").write_text(json.dumps(desired, indent=2, sort_keys=True) + "\n")
    print(json.dumps(desired))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
