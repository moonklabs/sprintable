"""story #4407 AC5 — no `:name::type` in SQL text (a bound parameter followed by a PostgreSQL cast).

SQLAlchemy's `text()` does not bind a `:name` that is directly followed by `::` — the parameter stays literal SQL text, so the
statement fails on every call (asyncpg: `syntax error at or near ":"`). `POST /api/v2/account/delete` failed like this on
every call until #4400 (its mocked-session test never saw it), and `seed_builtin_personas(:org_id::uuid …)` was the same
class. Write `CAST(:name AS type)` instead.

What it scans: every string literal in `.py` files under app/, ee/ and alembic/ (AST — comments are not strings, and
docstrings are skipped). A hit is `:<identifier>::<letter>` not preceded by another `:` (so `'x'::text`, `::error::` and
`a::b` outside a parameter do not count).

What it does not see (declared): SQL assembled from pieces across separate literals (`":org_id" + "::uuid"`), SQL read from
files, and parameters written as `%(name)s::uuid` (a different paramstyle, bound by the DB driver itself — fine).
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
SCANNED = ("app", "ee", "alembic")
_BIND_CAST = re.compile(r"(?<![:\w]):[A-Za-z_]\w*::[A-Za-z]")


def _docstring_nodes(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant):
                ids.add(id(body[0].value))
    return ids


def find_bind_casts(source: str, filename: str = "<string>") -> list[tuple[int, str]]:
    """(line, the matched piece) for every `:name::type` inside a non-docstring string literal."""
    tree = ast.parse(source, filename=filename)
    skip = _docstring_nodes(tree)
    hits: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            for m in _BIND_CAST.finditer(node.value):
                hits.append((node.lineno, m.group(0)))
    return hits


def main() -> int:
    found = 0
    for top in SCANNED:
        for path in sorted((BACKEND / top).rglob("*.py")):
            for line, piece in find_bind_casts(path.read_text(encoding="utf-8"), str(path)):
                found += 1
                print(f"{path.relative_to(BACKEND)}:{line}: `{piece}` — write CAST(:name AS type); text() does not bind ':name::'")
    if found:
        print(f"\n❌ {found} bound parameter(s) followed by '::' (story #4407 AC5)")
        return 1
    print("OK: no ':name::type' in SQL text (app/ · ee/ · alembic/)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
