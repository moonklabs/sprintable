"""story #4827 — the app updates its own database, and its safety rests on one fact: `alembic upgrade heads` runs ALL pending migrations in ONE transaction.

A migration that fails then leaves the database exactly as it was (postgres undoes all of it) — measured on a real postgres by the Mac app's test (desktop-electron
test/backup-realpg-4827.test.ts). The app therefore does not restore after a failed migration that left the database as its copy says; it checks, and leaves a good database alone.
If someone turned `transaction_per_migration` on, ran a migration in autocommit, committed inside one, or built an index CONCURRENTLY, a failed run could leave the schema half-way — and
that check would be a lie. This test keeps the fact true: it fails when any of those appears (no DB needed), with a planted-violation control for each so the scan can be trusted.

What it is: a guard against honest mistakes, read from the code (`ast`), not a proof against someone who hides a statement (a command assembled from pieces it cannot see). The
backstop for that is the app's own check after a failed migration (revision and every table's rows against its copy) and the real-postgres measurement.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
ENV_PY = BACKEND / "alembic" / "env.py"
ALEMBIC_INI = BACKEND / "alembic.ini"
VERSIONS = BACKEND / "alembic" / "versions"

_TX_WORDS = r"(?:COMMIT|BEGIN|START\s+TRANSACTION|ROLLBACK|END|ABORT)"
_TX_STATEMENT = re.compile(rf"^\s*{_TX_WORDS}\b", re.IGNORECASE)
_ENDS_TX_ATTRS = ("commit", "rollback", "autocommit_block")
_DBAPI_SETTERS = ("set_session", "set_isolation_level")
_DBAPI_ATTRS = ("autocommit", "isolation_level")


def _is_docstring(tree: ast.AST, const: ast.Constant) -> bool:
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body:
            first = n.body[0]
            if isinstance(first, ast.Expr) and first.value is const:
                return True
    return False


def _fold(node: ast.AST) -> str | None:
    """the text a string expression builds, as far as it can be read without running it (`"COM" + "MIT"`, an f-string's literal parts with `{}` where a value goes,
    `"…".format(…)`, `"…" % …`); None when it is not a string expression"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _fold(node.left), _fold(node.right)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        return _fold(node.left)
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format":
        return _fold(node.func.value)
    return None


def _sql_statements(text: str) -> list[str]:
    """the statements of a piece of SQL, read the way postgres reads it: string literals ('' escapes), quoted identifiers, `-- …` and `/* … */` comments and dollar-quoted bodies
    are each replaced by a placeholder, and the text is split at the `;` that remain — so `'legacy -- x'` is not a comment and `'x; END'` is not a statement"""
    out: list[str] = []
    cur: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in ("'", '"'):
            # E'…' is an escape string: a backslash escapes the next character (E'it\'s' is one string)
            escaped = c == "'" and i > 0 and text[i - 1] in "eE" and (i < 2 or not (text[i - 2].isalnum() or text[i - 2] == "_"))
            j = i + 1
            while j < n:
                if escaped and text[j] == "\\":
                    j += 2
                    continue
                if text[j] == c:
                    if j + 1 < n and text[j + 1] == c:
                        j += 2
                        continue
                    break
                j += 1
            cur.append(" ? ")
            i = j + 1
        elif text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j == -1 else j + 1
            cur.append(" ")
        elif text.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            i = j
            cur.append(" ")
        elif c == "$" and (m := re.match(r"\$\w*\$", text[i:])):
            tag = m.group(0)
            j = text.find(tag, i + len(tag))
            i = n if j == -1 else j + len(tag)
            cur.append(" $ ")
        elif c == ";":
            out.append("".join(cur).strip())
            cur = []
            i += 1
        else:
            cur.append(c)
            i += 1
    out.append("".join(cur).strip())
    return [x for x in out if x]


def sql_violations(text: str) -> list[str]:
    out: list[str] = []
    for stmt in _sql_statements(text):
        if _TX_STATEMENT.match(stmt):
            out.append(f"a transaction statement ({stmt[:20]!r})")
    flat = " ".join(_sql_statements(text))  # (code only: strings and comments are placeholders)
    if re.search(r"\bCONCURRENTLY\b", flat, re.IGNORECASE) and re.search(
        r"\bCREATE\s+(UNIQUE\s+)?INDEX\b|\bREINDEX\b|\bDROP\s+INDEX\b|\bDETACH\s+PARTITION\b|\bREFRESH\s+MATERIALIZED\s+VIEW\b", flat, re.IGNORECASE
    ):
        out.append("a CONCURRENTLY statement (cannot run inside a transaction)")
    return out


def _kw_value_ends_transaction(kw: ast.keyword) -> str | None:
    """`isolation_level=…` / `execution_options={…}` given to a call"""
    if kw.arg is None:
        return "a **dict is passed (cannot be read)"
    if kw.arg == "isolation_level":
        return "isolation_level is set"
    if kw.arg == "execution_options":
        if isinstance(kw.value, ast.Dict):
            if any(k is None for k in kw.value.keys):
                return "execution_options holds a **dict (cannot be read)"
            if any(isinstance(k, ast.Constant) and k.value == "isolation_level" for k in kw.value.keys):
                return "execution_options sets isolation_level"
            return None
        return "execution_options is not a literal (cannot be read)"
    return None


def env_violations(source: str) -> list[str]:
    """alembic/env.py: `context.configure(...)` must not switch off transactional DDL, turn on one transaction per migration or set an isolation level; nothing may end the
    transaction BETWEEN two `run_migrations()` calls"""
    out: list[str] = []
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute) and node.func.attr == "configure":
            for kw in node.keywords:
                if kw.arg == "transaction_per_migration" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                    out.append(f"env.py:{node.lineno}: transaction_per_migration is switched on")
                if kw.arg == "transactional_ddl" and not (isinstance(kw.value, ast.Constant) and kw.value.value is True):
                    out.append(f"env.py:{node.lineno}: transactional_ddl is not True")
                why = _kw_value_ends_transaction(kw)
                if why and kw.arg != "execution_options":
                    out.append(f"env.py:{node.lineno}: configure(): {why}")
                if why and kw.arg == "execution_options":
                    out.append(f"env.py:{node.lineno}: configure(): {why}")
        if isinstance(node.func, ast.Attribute) and node.func.attr == "execution_options":
            for kw in node.keywords:
                if kw.arg == "isolation_level" or kw.arg is None:
                    out.append(f"env.py:{node.lineno}: execution_options(isolation_level=…)")
    # the driver's own switches (a raw DBAPI connection in autocommit makes every statement its own transaction)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _DBAPI_SETTERS:
            out.append(f"env.py:{node.lineno}: .{node.func.attr}()")
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Attribute) and t.attr in _DBAPI_ATTRS:
                    out.append(f"env.py:{node.lineno}: .{t.attr} assigned")
    # the migrations are run once: no ending of the transaction between two run_migrations() calls, none in a loop
    for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        runs = [n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "run_migrations"]
        ends = [n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("commit", "rollback")]
        if len(runs) >= 2:
            out.append(f"env.py:{fn.name}: run_migrations() is called {len(runs)} times in one function (one transaction per call)")
        if runs and any(min(runs) < e < max(runs) for e in ends):
            out.append(f"env.py:{fn.name}: the transaction is ended between two run_migrations() calls")
        for loop in [n for n in ast.walk(fn) if isinstance(n, (ast.For, ast.While, ast.AsyncFor))]:
            if any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "run_migrations" for n in ast.walk(loop)):
                out.append(f"env.py:{loop.lineno}: run_migrations() in a loop")
    return out


def ini_violations(text: str) -> list[str]:
    """alembic.ini: an uncommented line that turns on autocommit/isolation, one transaction per migration, or other places for migrations (the scan reads only alembic/versions)"""
    out: list[str] = []
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if re.search(r"transaction_per_migration|isolation_level|autocommit|version_locations", line, re.IGNORECASE):
            out.append(f"alembic.ini:{i}: {line[:60]!r}")
    return out


def _binding_kinds(tree: ast.AST) -> dict[str, list[bool]]:
    """for each name: what each of its bindings in the file is — True when it is `….begin_nested()` (a SAVEPOINT), False for anything else (a parameter, another value)"""
    kinds: dict[str, list[bool]] = {}

    def add(target: ast.AST, is_savepoint: bool) -> None:
        if isinstance(target, ast.Name):
            kinds.setdefault(target.id, []).append(is_savepoint)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for t in target.elts:
                add(t, False)
        elif isinstance(target, ast.Starred):
            add(target.value, False)

    def is_nested(v: ast.AST | None) -> bool:
        return isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == "begin_nested"

    for n in ast.walk(tree):
        if isinstance(n, ast.Assign):
            for t in n.targets:
                add(t, is_nested(n.value) and isinstance(t, ast.Name))
        elif isinstance(n, ast.AnnAssign):
            add(n.target, is_nested(n.value))
        elif isinstance(n, ast.AugAssign):
            add(n.target, False)
        elif isinstance(n, ast.NamedExpr):
            add(n.target, is_nested(n.value))
        elif isinstance(n, (ast.For, ast.AsyncFor)):
            add(n.target, False)
        elif isinstance(n, (ast.With, ast.AsyncWith)):
            for item in n.items:
                if item.optional_vars is not None:
                    add(item.optional_vars, is_nested(item.context_expr))
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            a = n.args
            for arg in [*a.posonlyargs, *a.args, *a.kwonlyargs, *([a.vararg] if a.vararg else []), *([a.kwarg] if a.kwarg else [])]:
                kinds.setdefault(arg.arg, []).append(False)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            kinds.setdefault(n.name, []).append(False)
    return kinds


def version_violations(source: str, name: str = "migration") -> list[str]:
    """code (not comments or docstrings) that ends the single transaction"""
    out: list[str] = []
    tree = ast.parse(source)
    # a SAVEPOINT may be committed or rolled back — it ends only the nested part (0354a's dry run), not the migration's transaction. A name counts as one only when EVERY binding
    # of it in the file is `….begin_nested()`: `sp = bind.begin_nested(); sp = bind; sp.commit()` is the connection
    savepoints = {n for n, ks in _binding_kinds(tree).items() if ks and all(ks)}
    call_funcs = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in _ENDS_TX_ATTRS and id(node) not in call_funcs:
            # a bound method taken without calling it (`commit = conn.commit`) is the same thing, later
            if not (isinstance(node.value, ast.Name) and node.value.id in savepoints and node.attr != "autocommit_block"):
                out.append(f"{name}:{node.lineno}: .{node.attr} taken as a value (called later)")
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Attribute) and t.attr in _DBAPI_ATTRS:
                    out.append(f"{name}:{node.lineno}: .{t.attr} assigned")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr" and len(node.args) >= 2:
            a1 = node.args[1]
            if isinstance(a1, ast.Constant) and a1.value in _ENDS_TX_ATTRS:
                out.append(f"{name}:{node.lineno}: getattr(…, {a1.value!r})")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            if attr == "autocommit_block":
                out.append(f"{name}:{node.lineno}: autocommit_block()")
            if attr in ("commit", "rollback") and not (isinstance(node.func.value, ast.Name) and node.func.value.id in savepoints):
                out.append(f"{name}:{node.lineno}: .{attr}() inside a migration")
            if attr == "begin" and not node.args and not node.keywords:
                out.append(f"{name}:{node.lineno}: .begin() (a transaction of its own commits when it ends)")
            if attr in _DBAPI_SETTERS:
                out.append(f"{name}:{node.lineno}: .{attr}()")
            if attr == "execution_options":
                for kw in node.keywords:
                    if kw.arg == "isolation_level" or kw.arg is None:
                        out.append(f"{name}:{node.lineno}: execution_options(isolation_level=…)")
                    elif kw.arg == "autocommit" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                        out.append(f"{name}:{node.lineno}: execution_options(autocommit=…)")
    # the SQL text: every string constant that is not a docstring, plus the strings that are BUILT from pieces (`"COM" + "MIT"`, an f-string, .format)
    texts: list[tuple[int, str]] = []
    built = [n for n in ast.walk(tree) if isinstance(n, (ast.BinOp, ast.JoinedStr)) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "format")]
    # the pieces of a built string are read as part of the whole, never alone (an f-string cut at `{…}` would show half of a `$$ … $$` body)
    parts: set[int] = set()
    for n in built:
        if isinstance(n, ast.JoinedStr):
            parts |= {id(v) for v in n.values if isinstance(v, ast.Constant)}
        elif isinstance(n, ast.BinOp):
            parts |= {id(x) for x in (n.left, n.right) if isinstance(x, ast.Constant)}
        elif isinstance(n.func, ast.Attribute):  # type: ignore[union-attr]
            parts.add(id(n.func.value))  # type: ignore[union-attr]
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in parts and not _is_docstring(tree, n):
            texts.append((n.lineno, n.value))
    for n in built:
        folded = _fold(n)
        if folded and id(n) not in parts:
            texts.append((n.lineno, folded))
    seen: set[tuple[int, str]] = set()
    for lineno, text in texts:
        for v in sql_violations(text):
            if (lineno, v) not in seen:
                seen.add((lineno, v))
                out.append(f"{name}:{lineno}: {v}")
    return out


def test_env_py_keeps_all_pending_migrations_in_one_transaction() -> None:
    assert ENV_PY.is_file()
    assert env_violations(ENV_PY.read_text(encoding="utf-8")) == []


def test_alembic_ini_does_not_change_the_transaction_or_the_places_migrations_are_read_from() -> None:
    assert ALEMBIC_INI.is_file()
    assert ini_violations(ALEMBIC_INI.read_text(encoding="utf-8")) == []


def test_env_py_runs_the_migrations_through_a_configure_call_the_scan_reads() -> None:
    tree = ast.parse(ENV_PY.read_text(encoding="utf-8"))
    online = [
        fn
        for fn in ast.walk(tree)
        if isinstance(fn, ast.FunctionDef)
        and any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "configure" and any(k.arg == "connection" for k in n.keywords) for n in ast.walk(fn))
        and any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "run_migrations" for n in ast.walk(fn))
    ]
    assert len(online) >= 1


def test_no_migration_ends_the_single_transaction() -> None:
    files = sorted(VERSIONS.rglob("*.py"))
    assert len(files) > 100  # the scan looks at the real set
    assert {f.parent for f in files} == {VERSIONS}  # no migration in a folder inside (the scan would still read it, but the set is meant to be flat)
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
        ("context.configure(connection=c, execution_options={'isolation_level': 'AUTOCOMMIT'})", "isolation_level"),
        ("context.configure(connection=c, **opts)", "**dict"),
        ("context.configure(connection=c, execution_options=opts)", "not a literal"),
        ("context.configure(connection=c, execution_options={**base})", "**dict"),
        ("c.execution_options(isolation_level='AUTOCOMMIT')", "isolation_level"),
        ("c.execution_options(**o)", "isolation_level"),
        ("def f(c):\n    context.run_migrations()\n    c.commit()\n    context.run_migrations()\n", "between two run_migrations"),
        ("def f():\n    context.run_migrations()\n    context.run_migrations()\n", "called 2 times"),
        ("def f(c):\n    c.connection.set_session(autocommit=True)\n", "set_session"),
        ("def f(c):\n    c.connection.set_isolation_level(0)\n", "set_isolation_level"),
        ("def f(c):\n    c.connection.autocommit = True\n", ".autocommit assigned"),
        ("def f(xs):\n    for x in xs:\n        context.run_migrations()\n", "in a loop"),
    ],
)
def test_control_env_violations_are_seen(source: str, expect: str) -> None:
    assert any(expect in v for v in env_violations(source)), (source, env_violations(source))


def test_control_env_commit_after_the_one_run_and_before_it_is_allowed() -> None:
    ok = "def f(c):\n    c.commit()\n    with context.begin_transaction():\n        context.run_migrations()\n    c.commit()\n"
    assert env_violations(ok) == []
    assert env_violations("context.configure(connection=c, target_metadata=m, transactional_ddl=True, transaction_per_migration=False)") == []
    assert env_violations("context.configure(connection=c, execution_options={'schema_translate_map': {}})") == []


@pytest.mark.parametrize(
    "text, expect",
    [
        ("sqlalchemy.url = x\ntransaction_per_migration = true\n", "transaction_per_migration"),
        ("sqlalchemy.isolation_level = AUTOCOMMIT\n", "isolation_level"),
        ("version_locations = a b\n", "version_locations"),
    ],
)
def test_control_ini_violations_are_seen(text: str, expect: str) -> None:
    assert any(expect in v for v in ini_violations(text)), text


def test_control_ini_comments_are_not_flagged() -> None:
    assert ini_violations("# isolation_level = AUTOCOMMIT\n; version_locations = x\n\nscript_location = alembic\n") == []


@pytest.mark.parametrize(
    "source, expect",
    [
        ("def upgrade():\n    with op.get_context().autocommit_block():\n        op.execute('x')\n", "autocommit_block"),
        ("def upgrade():\n    op.get_bind().commit()\n", ".commit()"),
        ("def upgrade():\n    op.get_bind().rollback()\n", ".rollback()"),
        ("def upgrade():\n    op.execute('CREATE INDEX CONCURRENTLY ix ON t (a)')\n", "CONCURRENTLY"),
        ("def upgrade():\n    op.execute('create unique index concurrently ix on t (a)')\n", "CONCURRENTLY"),
        ("def upgrade():\n    op.execute('DROP INDEX CONCURRENTLY ix')\n", "CONCURRENTLY"),
        ("def upgrade():\n    op.execute('COMMIT')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('  begin;')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('/* note */ COMMIT')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('SET lock_timeout = 0; COMMIT')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('-- x\\nCOMMIT')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('COM' + 'MIT')\n", "transaction statement"),
        ("def upgrade():\n    op.execute(f'COM{x}')\n    op.execute(f'COMMIT{x}')\n", "transaction statement"),
        ("def upgrade():\n    op.execute('{} {}'.format('COMMIT', 'x'))\n", "transaction statement"),
        ("def upgrade():\n    op.execute('CREATE INDEX CONC' + 'URRENTLY ix ON t (a)')\n", "CONCURRENTLY"),
        ("def upgrade():\n    op.execute(sa.text('COMMIT'))\n", "transaction statement"),
        ("def upgrade():\n    op.get_bind().exec_driver_sql('COMMIT')\n", "transaction statement"),
        ("def upgrade():\n    op.get_bind().execution_options(isolation_level='AUTOCOMMIT')\n", "isolation_level"),
        ("def upgrade():\n    op.get_bind().execution_options(**o)\n", "isolation_level"),
        ("def upgrade():\n    getattr(op.get_bind(), 'commit')()\n", "getattr"),
        ("def upgrade():\n    commit = op.get_bind().commit\n    commit()\n", "taken as a value"),
        ("def upgrade():\n    op.get_bind().connection.autocommit = True\n", ".autocommit assigned"),
        ("def upgrade():\n    op.get_bind().connection.set_session(autocommit=True)\n", "set_session"),
        ("def upgrade():\n    with op.get_bind().begin():\n        pass\n", ".begin()"),
    ],
)
def test_control_migration_violations_are_seen(source: str, expect: str) -> None:
    assert any(expect in v for v in version_violations(source)), (source, version_violations(source))


@pytest.mark.parametrize(
    "source",
    [
        '"""the docstring may say CREATE INDEX CONCURRENTLY and autocommit_block() and COMMIT"""\n\ndef upgrade():\n    op.execute("CREATE INDEX ix ON t (a)")\n',
        "# a comment: CREATE INDEX CONCURRENTLY, op.get_bind().commit()\n\ndef upgrade():\n    op.create_table('x')\n",
        "def upgrade():\n    op.execute(\"UPDATE t SET note = 'COMMIT later'\")\n",
        "def upgrade():\n    '''doc: COMMIT'''\n    op.add_column('t', sa.Column('a', sa.Integer()))\n",
        "def upgrade():\n    op.execute(\"DO $$ BEGIN IF true THEN PERFORM 1; END IF; END $$;\")\n",
        "def upgrade():\n    op.execute(\"CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM 1; END; $body$ LANGUAGE plpgsql\")\n",
        "def upgrade():\n    op.execute(\"UPDATE t SET a = 1 -- COMMIT\")\n",
        "def upgrade():\n    op.execute(f'UPDATE t SET a = {x}')\n",
        "def upgrade():\n    op.execute('CREATE INDEX ix ON t (a)')\n    op.execute('SELECT 1 AS endpoint')\n",
    ],
)
def test_control_prose_and_ordinary_statements_are_not_flagged(source: str) -> None:
    assert version_violations(source) == [], version_violations(source)


def test_control_sql_is_read_like_sql() -> None:
    # a `--` inside a string is not a comment: the COMMIT after it is a statement
    assert version_violations("def upgrade():\n    op.execute(sa.text(\"UPDATE audit_log SET note = 'legacy -- marker'; COMMIT\"))\n")
    # a `;` or a word inside a string is not a statement
    assert version_violations("def upgrade():\n    op.execute(sa.text(\"UPDATE records SET note = 'legacy; COMMIT'\"))\n") == []
    assert version_violations("def upgrade():\n    op.execute(sa.text(\"UPDATE records SET label = CASE WHEN kind = 'legacy' THEN 'x; END' ELSE label END\"))\n") == []
    # a doubled quote stays inside the string
    assert version_violations("def upgrade():\n    op.execute(\"UPDATE t SET a = 'it''s; COMMIT'\")\n") == []
    # CONCURRENTLY as data is not the keyword
    assert version_violations("def upgrade():\n    op.execute(\"UPDATE t SET a = 'CREATE INDEX CONCURRENTLY'\")\n") == []
    # a quoted identifier is not a statement either
    assert version_violations("def upgrade():\n    op.execute('ALTER TABLE \"commit\" ADD COLUMN a int; SELECT 1')\n") == []
    # an escape string: E'it\\'s' is one string, so the COMMIT after it is a statement — and a word inside it is not
    assert version_violations("def upgrade():\n    op.get_bind().exec_driver_sql(r\"SELECT E'it\\'s'; COMMIT\")\n")
    assert version_violations("def upgrade():\n    op.get_bind().exec_driver_sql(r\"SELECT E'it\\'s; COMMIT'\")\n") == []
    # a nested block comment hides nothing that follows it
    assert version_violations("def upgrade():\n    op.execute('/* a /* b */ c */ SELECT 1; COMMIT')\n")


def test_control_built_strings_are_read_as_a_whole() -> None:
    assert version_violations("def upgrade():\n    op.execute('COMMIT {}'.format(x))\n")
    assert version_violations("def upgrade():\n    op.execute('COMMIT %s' % x)\n")
    assert version_violations("def upgrade():\n    op.execute(f'COMMIT {x}')\n")
    assert version_violations("def upgrade():\n    op.execute('SELECT 1; ' + 'COMMIT')\n")


def test_control_a_savepoint_may_be_rolled_back_but_the_connection_may_not() -> None:
    savepoint = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin_nested()\n    sp.rollback()\n"
    assert version_violations(savepoint) == []
    savepoint_commit = "def upgrade():\n    sp = op.get_bind().begin_nested()\n    sp.commit()\n"
    assert version_violations(savepoint_commit) == []
    with_savepoint = "def upgrade():\n    bind = op.get_bind()\n    with bind.begin_nested() as sp:\n        sp.commit()\n"
    assert version_violations(with_savepoint) == []
    not_a_savepoint = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin()\n    sp.rollback()\n"
    assert any(".rollback()" in v for v in version_violations(not_a_savepoint))
    the_connection = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin_nested()\n    bind.rollback()\n"
    assert any(".rollback()" in v for v in version_violations(the_connection))


def test_control_a_name_rebound_to_the_connection_is_not_a_savepoint() -> None:
    rebound = "def upgrade():\n    bind = op.get_bind()\n    sp = bind.begin_nested()\n    sp = bind\n    sp.commit()\n"
    assert any(".commit()" in v for v in version_violations(rebound))
    as_parameter = "def helper(sp):\n    sp.commit()\n\ndef upgrade():\n    sp = op.get_bind().begin_nested()\n    helper(sp)\n"
    assert any(".commit()" in v for v in version_violations(as_parameter))
    in_a_loop = "def upgrade():\n    for sp in conns:\n        sp.commit()\n    sp = op.get_bind().begin_nested()\n"
    assert any(".commit()" in v for v in version_violations(in_a_loop))
    held_by_an_object = "def upgrade():\n    self.sp = op.get_bind().begin_nested()\n    self.sp.commit()\n"
    assert any(".commit()" in v for v in version_violations(held_by_an_object))
