"""A test that switches a rate limiter must put it back AS IT FOUND it — never «on», and never off without a restore.

Found when more test files made the CI shards split differently: `test_5023a_first_owner_realdb`'s world ended with `limiter.enabled = True`. The suite runs the limiter OFF, and the tests of `test_cbd578d4_c4_*` call the
route functions directly (no `Request`), which only works with it off — so every file after the leaker, in the same process, failed with «parameter `request` must be an instance of starlette.requests.Request». Two unrelated
pull requests lost the same shard in the same way while develop stayed green: whether a leak shows depends on which files share a process, i.e. on the shard split, so it cannot be found by running one file.

A static pin (no database), read from the SYNTAX TREE (a comment or a string that mentions the text is not code), covering every object called `…limiter` (`limiter` · `rate_limit.limiter` · `open_setup_limiter` …):
  (a) `X.enabled = True` / `setattr(X, "enabled", True)` is forbidden — a literal «on» is never «as found»;
  (b) `X.enabled = False` (or the `setattr` form) needs, IN THE SAME FUNCTION and on a LATER line, an assignment of a non-literal value (the saved one) back to `X.enabled`;
  (c) `monkeypatch.setattr(X, "enabled", …)` is left alone — pytest undoes it.
The checking function is itself tested on small sources (the shapes it must refuse and the shapes it must accept), and the files that do the switching today are named so a pattern that matched nothing could not pass for ever.
"""
from __future__ import annotations

import ast
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def _is_limiter(node: ast.AST) -> bool:
    """`limiter` · `rate_limit.limiter` · `open_setup_limiter` …: a name or the last attribute of a chain that ends in «limiter»"""
    name = node.id if isinstance(node, ast.Name) else node.attr if isinstance(node, ast.Attribute) else ""
    return name.lower().endswith("limiter")


def _target_key(node: ast.AST) -> str | None:
    """«<limiter>.enabled» → a key for the limiter object (its dotted text), else None"""
    if isinstance(node, ast.Attribute) and node.attr == "enabled" and _is_limiter(node.value):
        return ast.unparse(node.value)
    return None


def _constant(node: ast.AST | None) -> object:
    return node.value if isinstance(node, ast.Constant) else NotImplemented  # NotImplemented = not a literal


class _Walk(ast.NodeVisitor):
    def __init__(self) -> None:
        self.stack: list[ast.AST] = []
        self.sets: list[tuple[ast.AST | None, str, int, object, bool]] = []  # (enclosing function, limiter key, line, literal · NotImplemented = a value · AUG = augmented, reachable?)
        self.dead = 0  # >0 inside a branch that cannot run (`if False:`) or after a `return` / `raise` of the same block

    def _function(self, node: ast.AST) -> None:
        self.stack.append(node); self.generic_visit(node); self.stack.pop()

    visit_FunctionDef = visit_AsyncFunctionDef = _function  # noqa: N815

    def _where(self) -> ast.AST | None:
        return self.stack[-1] if self.stack else None

    def generic_visit(self, node: ast.AST) -> None:
        for _field, value in ast.iter_fields(node):
            if isinstance(value, list) and value and all(isinstance(v, ast.stmt) for v in value):
                ended = False
                for st in value:
                    self.dead += 1 if ended else 0
                    self.visit(st)
                    self.dead -= 1 if ended else 0
                    ended = ended or isinstance(st, (ast.Return, ast.Raise))
            elif isinstance(value, list):
                for v in value:
                    if isinstance(v, ast.AST):
                        self.visit(v)
            elif isinstance(value, ast.AST):
                self.visit(value)

    def visit_If(self, node: ast.If) -> None:  # noqa: N802
        self.visit(node.test)
        never = isinstance(node.test, ast.Constant) and not node.test.value
        self.dead += 1 if never else 0
        for st in node.body:
            self.visit(st)
        self.dead -= 1 if never else 0
        for st in node.orelse:
            self.visit(st)

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        for t in node.targets:
            k = _target_key(t)
            if k is not None:
                self.sets.append((self._where(), k, node.lineno, _constant(node.value), self.dead == 0))
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:  # noqa: N802
        k = _target_key(node.target)
        if k is not None:
            self.sets.append((self._where(), k, node.lineno, "AUG", self.dead == 0))  # `|=` / `&=` can turn it on: never a restore
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        # the builtin `setattr(X, "enabled", v)` — NOT `monkeypatch.setattr(...)` (pytest restores that one)
        if isinstance(node.func, ast.Name) and node.func.id == "setattr" and len(node.args) == 3 and _is_limiter(node.args[0]):
            a1 = _constant(node.args[1])
            if a1 == "enabled":
                self.sets.append((self._where(), ast.unparse(node.args[0]), node.lineno, _constant(node.args[2]), self.dead == 0))
        self.generic_visit(node)


def problems(source: str, name: str = "<source>") -> list[str]:
    """what is wrong with the limiter switching in this source (empty = nothing)"""
    tree = ast.parse(source)
    w = _Walk(); w.visit(tree)
    out: list[str] = []
    for func, key, line, value, _live in w.sets:
        if value is True:
            out.append(f"{name}:{line}  {key}.enabled = True — never «as found»; save `was = {key}.enabled` and restore `{key}.enabled = was`")
        elif value == "AUG":
            out.append(f"{name}:{line}  {key}.enabled with an augmented assignment — it can switch the limiter on; assign the saved value back instead")
        elif value is False:
            restored = any(f is func and k == key and ln > line and v is NotImplemented and live for f, k, ln, v, live in w.sets)
            if not restored:
                out.append(f"{name}:{line}  {key}.enabled = False with no later restore of the saved value in the same function")
    return out


def _repo_problems() -> list[str]:
    out: list[str] = []
    for path in sorted(TESTS.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        try:
            out += problems(path.read_text(encoding="utf-8", errors="replace"), path.name)
        except SyntaxError:
            continue  # not this guard's business (the collection says it)
    return out


def _switchers() -> set[str]:
    names: set[str] = set()
    for path in sorted(TESTS.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        w = _Walk()
        try:
            w.visit(ast.parse(path.read_text(encoding="utf-8", errors="replace")))
        except SyntaxError:
            continue
        if w.sets:
            names.add(path.name)
    return names


# ── the repository ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_no_test_leaves_a_rate_limiter_on_or_off_without_restoring_it():
    bad = _repo_problems()
    assert not bad, "a test leaves a rate limiter switched for every later test of the process:\n" + "\n".join(bad)


def test_the_guard_sees_the_files_that_do_the_switching():
    assert {"test_5023a_first_owner_realdb.py", "test_4722_invite_auto_accept_verified_realdb.py", "test_4725_reclaim_notice_realdb.py"} <= _switchers()


# ── the checking function itself ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
BAD = {
    "a literal on": "limiter.enabled = True\n",
    "a literal on, no spaces": "limiter.enabled=True\n",
    "a literal on through setattr": "setattr(limiter, 'enabled', True)\n",
    "a dotted limiter": "from app.core import rate_limit\nrate_limit.limiter.enabled = True\n",
    "another limiter object": "open_setup_limiter.enabled = True\n",
    "off and never restored": "def f():\n    limiter.enabled = False\n    do()\n",
    "off, restored by a literal": "def f():\n    limiter.enabled = False\n    do()\n    limiter.enabled = True\n",
    "off, a restore of ANOTHER limiter": "def f():\n    limiter.enabled = False\n    other_limiter.enabled = was\n",
    "off, restored BEFORE (an earlier line)": "def f():\n    limiter.enabled = was\n    limiter.enabled = False\n",
    "off, restored in a different function": "def f():\n    limiter.enabled = False\n\ndef g():\n    limiter.enabled = was\n",
    "off through setattr, never restored": "def f():\n    setattr(limiter, 'enabled', False)\n",
    "a restore that never runs (if False)": "def f():\n    limiter.enabled = False\n    if False:\n        limiter.enabled = was\n",
    "a restore after a return": "def f():\n    limiter.enabled = False\n    return\n    limiter.enabled = was\n",
    "an augmented assignment is not a restore": "def f():\n    limiter.enabled = False\n    limiter.enabled |= other\n",
}
GOOD = {
    "saved and restored in a finally": "def f():\n    was = limiter.enabled\n    limiter.enabled = False\n    try:\n        do()\n    finally:\n        limiter.enabled = was\n",
    "a fixture that restores after the yield": "def f():\n    was = limiter.enabled\n    limiter.enabled = False\n    yield\n    limiter.enabled = was\n",
    "an async function": "async def f():\n    was = limiter.enabled\n    limiter.enabled = False\n    await do()\n    limiter.enabled = was\n",
    "restored through setattr": "def f():\n    was = limiter.enabled\n    setattr(limiter, 'enabled', False)\n    setattr(limiter, 'enabled', was)\n",
    "a comment and a string that mention it": "# limiter.enabled = True\nx = 'limiter.enabled = False'\n\"\"\"limiter.enabled = True\"\"\"\n",
    "monkeypatch handles its own undo": "def f(monkeypatch):\n    monkeypatch.setattr(limiter, 'enabled', False)\n",
    "an object that is not a limiter": "widget.enabled = True\nwidget.enabled = False\n",
    "only a read": "was = limiter.enabled\n",
}


def test_the_checker_refuses_every_bad_shape():
    for label, src in BAD.items():
        assert problems(src), f"missed: {label}"


def test_the_checker_accepts_every_good_shape():
    for label, src in GOOD.items():
        assert problems(src) == [], f"false alarm: {label}: {problems(src)}"
