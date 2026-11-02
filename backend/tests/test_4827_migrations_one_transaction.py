"""story #4827 — the app updates its own database, and its safety rests on one fact: `alembic upgrade heads` runs ALL pending migrations in ONE transaction.

A migration that fails then leaves the database exactly as it was (postgres undoes all of it) — measured on a real postgres by the Mac app's test (desktop-electron
test/backup-realpg-4827.test.ts). The app therefore does not restore after a failed migration that left the database as its copy says; it checks, and leaves a good database alone.
If someone turned `transaction_per_migration` on, ran a migration in autocommit, committed inside one, or built an index CONCURRENTLY, a failed run could leave the schema half-way — and
that check would be a lie. This test keeps the fact true: it fails when any of those appears (no DB needed), with a planted-violation control for each so the scan can be trusted.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
ENV_PY = BACKEND / "alembic" / "env.py"
VERSIONS = BACKEND / "alembic" / "versions"

_TX_STATEMENT = re.compile(r"^\s*(COMMIT|BEGIN|START\s+TRANSACTION|ROLLBACK|END)\b", re.IGNORECASE)


def _strings(node: ast.AST) -> list[str]:
    return [n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def _is_docstring(tree: ast.AST, const: ast.Constant) -> bool:
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body:
            first = n.body[0]
            if isinstance(first, ast.Expr) and first.value is const:
                return True
    return False


def env_violations(source: str) -> list[str]:
    """`context.configure(...)` must not switch off transactional DDL or turn on one transaction per migration"""
    out: list[str] = []
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "configure":
            for kw in node.keywords:
                if kw.arg == "transaction_per_migration" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                    out.append(f"env.py:{node.lineno}: transaction_per_migration is switched on")
                if kw.arg == "transactional_ddl" and not (isinstance(kw.value, ast.Constant) and kw.value.value is True):
                    out.append(f"env.py:{node.lineno}: transactional_ddl is not True")
                if kw.arg == "isolation_level" or (kw.arg == "execution_options"):
                    out.append(f"env.py:{node.lineno}: {kw.arg} is set (autocommit would end the single transaction)")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "execution_options":
            if any(kw.arg == "isolation_level" for kw in node.keywords):
                out.append(f"env.py:{node.lineno}: execution_options(isolation_level=…)")
    return out


def version_violations(source: str, name: str = "migration") -> list[str]:
    """code (not comments or docstrings) that ends the single transaction"""
    out: list[str] = []
    tree = ast.parse(source)
    # a SAVEPOINT (`sp = bind.begin_nested()`) may be committed or rolled back: it ends only the nested part (0354a's dry run), not the migration's transaction
    savepoints = {
        t.id
        for n in ast.walk(tree)
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute) and n.value.func.attr == "begin_nested"
        for t in n.targets
        if isinstance(t, ast.Name)
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            if attr == "autocommit_block":
                out.append(f"{name}:{node.lineno}: autocommit_block()")
            if attr in ("commit", "rollback") and not (isinstance(node.func.value, ast.Name) and node.func.value.id in savepoints):
                out.append(f"{name}:{node.lineno}: .{attr}() inside a migration")
            if attr == "execution_options" and any(kw.arg == "isolation_level" for kw in node.keywords):
                out.append(f"{name}:{node.lineno}: execution_options(isolation_level=…)")
    for const in (n for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)):
        if _is_docstring(tree, const):
            continue
        text = const.value
        if re.search(r"\bCONCURRENTLY\b", text, re.IGNORECASE) and re.search(r"\bCREATE\s+(UNIQUE\s+)?INDEX\b|\bREINDEX\b|\bDETACH\s+PARTITION\b", text, re.IGNORECASE):
            out.append(f"{name}:{const.lineno}: a CONCURRENTLY statement (cannot run inside a transaction)")
        if _TX_STATEMENT.match(text):
            out.append(f"{name}:{const.lineno}: a transaction statement ({text.strip()[:20]!r})")
    return out


def test_env_py_keeps_all_pending_migrations_in_one_transaction() -> None:
    assert ENV_PY.is_file()
    assert env_violations(ENV_PY.read_text(encoding="utf-8")) == []


def test_env_py_really_calls_configure_so_the_scan_looks_at_something() -> None:
    tree = ast.parse(ENV_PY.read_text(encoding="utf-8"))
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "configure"]
    assert len(calls) >= 1


def test_no_migration_ends_the_single_transaction() -> None:
    files = sorted(VERSIONS.glob("*.py"))
    assert len(files) > 100  # the scan looks at the real set
    found: list[str] = []
    for f in files:
        found += version_violations(f.read_text(encoding="utf-8"), f.name)
    assert found == []


# ── positive controls: each way of breaking the fact is caught ──
@pytest.mark.parametrize(
    "source, expect",
    [
        ("context.configure(connection=c, transaction_per_migration=True)", "transaction_per_migration"),
        ("context.configure(connection=c, transactional_ddl=False)", "transactional_ddl"),
        ("context.configure(connection=c, isolation_level='AUTOCOMMIT')", "isolation_level"),
        ("context.configure(connection=c, execution_options={'isolation_level': 'AUTOCOMMIT'})", "execution_options"),
        ("c.execution_options(isolation_level='AUTOCOMMIT')", "isolation_level"),
    ],
)
def test_control_env_violations_are_seen(source: str, expect: str) -> None:
    assert any(expect in v for v in env_violations(source)), source


@pytest.mark.parametrize(
    "source, expect",
    [
        ("def upgrade():\n    with op.get_context().autocommit_block():\n        op.execute('x')\n", "autocommit_block"),
        ("def upgrade():\n    op.get_bind().commit()\n", ".commit()"),
        ("def upgrade():\n    op.get_bind().rollback()\n", ".rollback()"),
        ("def upgrade():\n    op.execute('CREATE INDEX CONCURRENTLY ix ON t (a)')\n", "CONCURRENTLY"),
        ("def upgrade():\n    op.execute('create unique index concurrently ix on t (a)')\n", "CONCURRENTLY"),
        ("def upgrade():\n    op.execute('COMMIT')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('  begin;')\n", "transaction statement"),
        ("def upgrade():\n    op.get_bind().execution_options(isolation_level='AUTOCOMMIT')\n", "isolation_level"),
    ],
)
def test_control_migration_violations_are_seen(source: str, expect: str) -> None:
    assert any(expect in v for v in version_violations(source)), source


@pytest.mark.parametrize(
    "source",
    [
        '"""the docstring may say CREATE INDEX CONCURRENTLY and autocommit_block() and COMMIT"""\n\ndef upgrade():\n    op.execute("CREATE INDEX ix ON t (a)")\n',
        "# a comment: CREATE INDEX CONCURRENTLY, op.get_bind().commit()\n\ndef upgrade():\n    op.create_table('x')\n",
        "def upgrade():\n    op.execute(\"UPDATE t SET note = 'COMMIT later'\")\n",
        "def upgrade():\n    '''doc: COMMIT'''\n    op.add_column('t', sa.Column('a', sa.Integer()))\n",
    ],
)
def test_control_prose_and_ordinary_statements_are_not_flagged(source: str) -> None:
    assert version_violations(source) == []


def test_control_a_savepoint_may_be_rolled_back_but_the_connection_may_not() -> None:
    savepoint = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin_nested()\n    sp.rollback()\n"
    assert version_violations(savepoint) == []
    savepoint_commit = "def upgrade():\n    sp = op.get_bind().begin_nested()\n    sp.commit()\n"
    assert version_violations(savepoint_commit) == []
    not_a_savepoint = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin()\n    sp.rollback()\n"
    assert any(".rollback()" in v for v in version_violations(not_a_savepoint))
    the_connection = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin_nested()\n    bind.rollback()\n"
    assert any(".rollback()" in v for v in version_violations(the_connection))
