"""story 4898 — a push to develop / main is not cancelled by the next push; a pull request is, as before; the `edited-only` group rule of story 3636 is untouched.

Why: with merges a few minutes apart every running develop CI was cancelled by the next merge (four develop heads in a row ended «cancelled», no green head), and the dev rollout — which takes green CI heads
only — starved. GitHub keeps one running and one pending run per concurrency group (a newer pending run replaces the older pending one), so with `cancel-in-progress: false` a push is run to the end and the
Actions minutes follow «one CI per CI duration», not «one CI per merge».

This test reads the REAL `concurrency` block of `.github/workflows/ci.yml` and EVALUATES its two expressions (a small evaluator of the subset of the GitHub expression language the block uses: `||` `&&` `==`
string/null literals, context paths, `format()`), for the events that matter — it does not compare the file to a copy of itself.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

CI = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"

# the group expression as it was before story 4898 (story 3636's edited-only isolation) — it must not change
GROUP_EXPR_BEFORE_4898 = (
    "${{ github.workflow }}-${{ github.ref }}${{ (github.event_name == 'pull_request' && github.event.action == 'edited' && github.event.changes.base == null) "
    "&& format('-edited-only-{0}', github.run_id) || '' }}"
)


# ── a small evaluator for the expression subset the concurrency block uses ───────────────────────────────────────

_TOKEN = re.compile(r"\s*(?:(\|\||&&|==|!=|\(|\)|,)|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_.\-]*))")


def _tokens(src: str) -> list[tuple[str, str]]:
    out, pos = [], 0
    while pos < len(src):
        if src[pos:].strip() == "":
            break
        m = _TOKEN.match(src, pos)
        assert m, f"cannot read the expression at: {src[pos:]!r}"
        if m.group(1):
            out.append(("op", m.group(1)))
        elif m.group(2) is not None:
            out.append(("str", m.group(2).replace("''", "'")))
        else:
            out.append(("name", m.group(3)))
        pos = m.end()
    return out


def _truthy(v) -> bool:
    return v not in (None, False, "", 0)


def _eq(a, b) -> bool:
    if a is None and b is None:
        return True
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    return a == b


def _evaluate(src: str, ctx: dict):
    toks, i = _tokens(src), 0

    def peek():
        return toks[i] if i < len(toks) else (None, None)

    def take():
        nonlocal i
        t = toks[i]
        i += 1
        return t

    def lookup(path: str):
        cur = ctx
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                return None
            cur = cur[part]
        return cur

    def primary():
        kind, val = take()
        if kind == "str":
            return val
        if kind == "op" and val == "(":
            v = or_expr()
            assert take() == ("op", ")")
            return v
        assert kind == "name", (kind, val)
        if val == "null":
            return None
        if val in ("true", "false"):
            return val == "true"
        if peek() == ("op", "("):
            take()
            args = []
            while peek() != ("op", ")"):
                args.append(or_expr())
                if peek() == ("op", ","):
                    take()
            take()
            assert val == "format", f"function {val} is not in the subset this test knows"
            text = args[0]
            for n, a in enumerate(args[1:]):
                text = text.replace("{%d}" % n, "" if a is None else str(a))
            return text
        return lookup(val)

    def eq_expr():
        left = primary()
        while peek() in (("op", "=="), ("op", "!=")):
            op = take()[1]
            right = primary()
            left = _eq(left, right) if op == "==" else not _eq(left, right)
        return left

    def and_expr():
        left = eq_expr()
        while peek() == ("op", "&&"):
            take()
            right = eq_expr()
            left = right if _truthy(left) else left
        return left

    def or_expr():
        left = and_expr()
        while peek() == ("op", "||"):
            take()
            right = and_expr()
            left = left if _truthy(left) else right
        return left

    value = or_expr()
    assert i == len(toks), "trailing tokens in the expression"
    return value


def _render(template: str, ctx: dict):
    """a string with `${{ ... }}` segments: one segment alone keeps its type, several are joined as text"""
    parts = re.split(r"(\$\{\{.*?\}\})", template)
    segs = [p for p in parts if p != ""]
    if len(segs) == 1 and segs[0].startswith("${{"):
        return _evaluate(segs[0][3:-2], ctx)
    out = ""
    for seg in segs:
        if seg.startswith("${{"):
            v = _evaluate(seg[3:-2], ctx)
            out += "" if v is None else ("true" if v is True else "false" if v is False else str(v))
        else:
            out += seg
    return out


def _concurrency() -> dict:
    return yaml.safe_load(CI.read_text())["concurrency"]


def _ctx(event_name, ref, run_id, action=None, changes=None):
    event = {}
    if action:
        event["action"] = action
    if changes is not None:
        event["changes"] = changes
    return {"github": {"workflow": "CI", "ref": ref, "run_id": str(run_id), "event_name": event_name, "event": event}}


def _group(ctx):
    return _render(_concurrency()["group"], ctx)


def _cancels(ctx) -> bool:
    return bool(_render(str(_concurrency()["cancel-in-progress"]), ctx)) if not isinstance(_concurrency()["cancel-in-progress"], bool) else _concurrency()["cancel-in-progress"]


# ── a push is not cancelled; two pushes to the same branch share one group (one running, one pending) ───────────────

@pytest.mark.parametrize("branch", ["develop", "main"])
def test_a_push_is_not_cancelled_and_two_pushes_to_the_same_branch_share_one_group(branch):
    first = _ctx("push", f"refs/heads/{branch}", 1001)
    second = _ctx("push", f"refs/heads/{branch}", 1002)
    assert _cancels(first) is False and _cancels(second) is False, "the running CI of a push finishes"
    assert _group(first) == _group(second) == f"CI-refs/heads/{branch}", "the next push queues behind it in the SAME group (GitHub keeps one pending run, the newest)"


def test_develop_and_main_pushes_do_not_share_a_group():
    assert _group(_ctx("push", "refs/heads/develop", 1)) != _group(_ctx("push", "refs/heads/main", 2))


# ── a pull request still cancels the superseded run ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("action", ["opened", "synchronize", "reopened"])
def test_a_pull_request_run_cancels_the_superseded_one_in_the_same_group(action):
    a = _ctx("pull_request", "refs/pull/77/merge", 2001, action=action)
    b = _ctx("pull_request", "refs/pull/77/merge", 2002, action=action)
    assert _cancels(a) is True and _cancels(b) is True
    assert _group(a) == _group(b) == "CI-refs/pull/77/merge"


def test_two_pull_requests_do_not_share_a_group():
    assert _group(_ctx("pull_request", "refs/pull/77/merge", 1, action="synchronize")) != _group(_ctx("pull_request", "refs/pull/78/merge", 2, action="synchronize"))


# ── story 3636's «edited-only» rule is untouched ─────────────────────────────────────────────────────────────────

def test_the_group_expression_is_exactly_what_it_was_before_this_change():
    assert _concurrency()["group"] == GROUP_EXPR_BEFORE_4898


def test_a_title_or_body_only_edit_runs_in_its_own_group_so_it_never_kills_a_live_run():
    live = _ctx("pull_request", "refs/pull/77/merge", 3001, action="synchronize")
    edit_a = _ctx("pull_request", "refs/pull/77/merge", 3002, action="edited", changes={"title": {"from": "old"}})
    edit_b = _ctx("pull_request", "refs/pull/77/merge", 3003, action="edited", changes={"body": {"from": "old"}})
    g_live, g_a, g_b = _group(live), _group(edit_a), _group(edit_b)
    assert g_a == "CI-refs/pull/77/merge-edited-only-3002" and g_b == "CI-refs/pull/77/merge-edited-only-3003"
    assert len({g_live, g_a, g_b}) == 3, "each edit is isolated from the live run and from the other edit"


def test_an_edit_that_changed_the_base_shares_the_stable_group_the_retarget_case_of_2912_and_3317():
    retarget = _ctx("pull_request", "refs/pull/77/merge", 4001, action="edited", changes={"base": {"ref": {"from": "main"}}})
    live = _ctx("pull_request", "refs/pull/77/merge", 4000, action="synchronize")
    assert _group(retarget) == _group(live) == "CI-refs/pull/77/merge"
    assert _cancels(retarget) is True


# ── the file itself ──────────────────────────────────────────────────────────────────────────────────────────────

def test_the_cancel_rule_is_the_one_expression_and_only_pull_request_events_cancel():
    assert str(_concurrency()["cancel-in-progress"]).replace(" ", "") == "${{github.event_name=='pull_request'}}"
