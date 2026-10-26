#!/usr/bin/env python3
"""story 4798 (AC12) — every place that READS a secret's value is on one list, so that a new reader cannot arrive unseen.

Why: the list of which account reads which secret (story 4798, AC1) was made by reading the repository once. A reader assembled from a list (`run(["secrets", "versions", "access", …])`) escaped a one-line
search and was found only when a build was refused. This check finds readers by their SHAPE in every file that is not a test or a document, and compares the files with `infra/secret-reads.yml`:
- a file that reads a secret value and is not on the list  → FAIL (a new reader: add it with its reason, and make sure the account it runs as is allowed to read that secret — one secret at a time)
- a file on the list that no longer reads one              → FAIL (the list must stay exact)

What counts as a read: `versions access` in any spelling (a command line, or the words as separate list items), the client call `access_secret_version`, the client class `SecretManagerServiceClient`, the REST path
`secretmanager.googleapis.com/v1…`, and a `…/versions/<v>:access` path. NOT a read: `--set-secrets` / `--update-secrets` (a reference: the service's own account reads the value when it starts),
`versions add` (a write), IAM bindings.

Local run:  python3 infra/check_secret_reads.py        (exit 0 = exact, 1 = differs)
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = Path(__file__).resolve().parent / "secret-reads.yml"

_SKIP_DIRS = {".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv", "venv", "tests", "__tests__", "test", ".qa-worktrees"}
_SKIP_SUFFIXES = (".md", ".lock", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pdf", ".zip", ".tgz", ".gz", ".map", ".svg")
_SKIP_NAME_PARTS = (".test.", ".spec.", "pnpm-lock", "package-lock")
# the words «versions» then «access», whatever sits between them: spaces, quotes, commas, a line break, a backslash
_READ_SHAPES = (
    re.compile(r"""versions[\s"',\\]+access\b"""),
    re.compile(r"access_secret_version"),
    re.compile(r"SecretManagerServiceClient"),
    re.compile(r"secretmanager\.googleapis\.com/v1"),
    re.compile(r"/versions/[^\s\"']*:access"),
)


def _tracked_files(root: Path) -> list[Path]:
    try:
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout.decode()
        names = [n for n in out.split("\0") if n]
    except (OSError, subprocess.SubprocessError):
        names = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()]
    return [root / n for n in names]


def _skipped(rel: Path) -> bool:
    if any(part in _SKIP_DIRS for part in rel.parts[:-1]):
        return True
    name = rel.name
    return name.endswith(_SKIP_SUFFIXES) or any(p in name for p in _SKIP_NAME_PARTS) or name == "check_secret_reads.py" or name == "secret-reads.yml"


def find_readers(root: Path = ROOT, files: list[Path] | None = None) -> dict[str, list[int]]:
    """{relative file: [line numbers]} of every file that has a read shape"""
    hits: dict[str, list[int]] = {}
    for path in files if files is not None else _tracked_files(root):
        rel = path.relative_to(root)
        if _skipped(rel) or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for shape in _READ_SHAPES:
            for m in shape.finditer(text):
                hits.setdefault(rel.as_posix(), []).append(text.count("\n", 0, m.start()) + 1)
    return {k: sorted(set(v)) for k, v in hits.items()}


def load_registry(path: Path = REGISTRY) -> dict[str, dict]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("readers"), list):
        raise SystemExit(f"{path}: expected a mapping with a `readers:` list")
    out: dict[str, dict] = {}
    for item in doc["readers"]:
        if not (isinstance(item, dict) and isinstance(item.get("file"), str) and isinstance(item.get("runs_as"), str) and isinstance(item.get("reason"), str) and item["reason"].strip()):
            raise SystemExit(f"{path}: every reader needs `file`, `runs_as` and a non-empty `reason`: {item!r}")
        if item["file"] in out:
            raise SystemExit(f"{path}: {item['file']} is listed twice")
        out[item["file"]] = item
    return out


def compare(found: dict[str, list[int]], registered: dict[str, dict]) -> list[str]:
    problems = []
    for f in sorted(set(found) - set(registered)):
        problems.append(f"NEW READER {f} (line {', '.join(map(str, found[f]))}) reads a secret's value and is not in infra/secret-reads.yml — add it with `runs_as` and `reason`, and grant the account that runs it that one secret")
    for f in sorted(set(registered) - set(found)):
        problems.append(f"STALE ENTRY {f} is listed in infra/secret-reads.yml but no read shape is in the file any more — remove it (and the grant it needed)")
    return problems


def main() -> int:
    found = find_readers()
    problems = compare(found, load_registry())
    for p in problems:
        print(f"::error::{p}")
    if problems:
        return 1
    print(f"OK: {len(found)} file(s) read a secret's value and all are on infra/secret-reads.yml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
