"""story 4798 (AC7) — every project-level IAM binding call names its condition.

Once a project policy holds a binding with an IAM condition (the prod database jobs' account gets the Cloud SQL role for the prod instance only), `gcloud projects add-iam-policy-binding` without `--condition` is refused in a
non-interactive run and asks a question in an interactive one. The scripts already pass `--condition=None` (or a condition); this keeps it that way — in the scripts, the build, the workflows and the runbooks (documents are copied
into a terminal).

How a call is found (the scan reads text the way a shell does, in four steps):
1. a comment is cut off — a `#` at the start of a word, outside quotes; a comment never continues onto the next line, even when it ends with a backslash;
2. lines are joined where the code part ends with a backslash (a backslash followed by a space is not a continuation);
3. the joined line is split into words by `shlex` (quotes honoured) and then into commands at `;` `&&` `||` `|` `&` and parentheses;
4. in each command, leading words that only introduce it (`do` `then` `else` `if` `!` `command` `sudo` `time` `env VAR=x` …) are skipped, and the command is a call when it reads `gcloud [beta|alpha] projects add|remove-iam-policy-binding …`.
A call is a violation when none of its own words is `--condition` or `--condition=…`; EVERY call of a statement is judged on its own, and quoting that does not balance is a violation (never a pass).
Not covered, on purpose: a command name held in a variable, a wrapper function, a here-document. The sites that hold a call today are pinned (with a minimum count), so the scan cannot silently go blind on one of them."""
from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SKIP_PARTS = {"node_modules", ".git", "tests", "__tests__", "__pycache__", ".next", ".qa-worktrees"}
_SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".gz", ".zip", ".lock", ".pyc", ".woff", ".woff2", ".pdf")
_INTRODUCERS = {"do", "then", "else", "elif", "if", "while", "until", "!", "{", "command", "exec", "sudo", "time", "nohup", "builtin"}
# the sites that hold a call today, with the least number of calls each holds: if one stops holding that many, this table is updated on purpose
_KNOWN_SITES = {
    "backend/scripts/setup_iam.sh": 3,
    "backend/scripts/setup_workload_identity.sh": 1,
    "backend/scripts/setup_artifact_registry.sh": 1,
    "deploy/vm/RUNBOOK.md": 4,
}


def _statements(text: str) -> list[tuple[int, str]]:
    """(the line a statement starts on, its code) for every logical line — one pass over the WHOLE text, so quote and escape state carry across physical lines the way they do in a shell:
    a backslash right before a newline joins the lines (inside double quotes too; never inside single quotes); a newline inside quotes is part of the word; a `#` at the start of a word, outside quotes, cuts
    the rest of the physical line off (a comment never continues onto the next line, even when it ends with a backslash); an unquoted newline ends the statement"""
    out: list[tuple[int, str]] = []
    buf: list[str] = []
    line = start = 1
    single = double = has_content = False
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and not single:
            nxt = text[i + 1] if i + 1 < n else ""
            if nxt == "\n":
                i += 2
                line += 1
                continue
            if not has_content:
                start, has_content = line, True
            buf.append(ch)
            if nxt:
                buf.append(nxt)
                i += 2
            else:
                i += 1
            continue
        if ch == "\n":
            line += 1
            i += 1
            if single or double:
                buf.append(" ")
                continue
            out.append((start, "".join(buf)))
            buf, has_content, start = [], False, line
            continue
        if ch == "#" and not single and not double and (not buf or buf[-1].isspace() or buf[-1] in ";&|("):
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if ch == "'" and not double:
            single = not single
        elif ch == '"' and not single:
            double = not double
        if not has_content and not ch.isspace():
            start, has_content = line, True
        buf.append(ch)
        i += 1
    out.append((start, "".join(buf)))
    return out


def _commands(logical: str):
    """the commands of a logical line, each a list of words; None when the quoting does not balance. `shlex` groups adjacent punctuation (`);` is one token): a token made only of command operators is split
    into its operators here; a token holding a redirection (`>` `<`, as in `2>&1`) stays a word"""
    lexer = shlex.shlex(logical, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    cmds: list[list[str]] = [[]]
    try:
        for tok in lexer:
            if tok and all(c in "();|&" for c in tok):
                for op in re.findall(r"&&|\|\||;;|[;&|()]", tok):
                    cmds.append([])
            else:
                cmds[-1].append(tok)
    except ValueError:
        return None
    return [c for c in cmds if c]


def _is_project_binding_call(words: list[str]) -> bool:
    k = 0
    while k < len(words) and (words[k] in _INTRODUCERS or words[k] == "env" or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[k])):
        k += 1
    rest = words[k:]
    if rest[:1] != ["gcloud"]:
        return False
    rest = rest[1:]
    if rest[:1] in (["beta"], ["alpha"]):
        rest = rest[1:]
    return len(rest) >= 2 and rest[0] == "projects" and rest[1] in ("add-iam-policy-binding", "remove-iam-policy-binding")


def kind_of(path: str) -> str:
    """how a file's text is read: a shell script as one piece of shell; a markdown document as the shell inside its code fences and inline code spans (prose is not shell: an apostrophe there must not open a quote);
    anything else (yaml, python, json …) one physical line at a time, with its backslash continuations"""
    name = path.lower()
    if name.endswith((".sh", ".bash")):
        return "shell"
    if name.endswith((".md", ".markdown")):
        return "markdown"
    return "lines"


def _regions(text: str, kind: str) -> list[tuple[int, str]]:
    """(the line a region starts on, its text) — each region is read on its own, so quote state never leaks from one to the next"""
    lines = text.splitlines()
    if kind == "shell":
        return [(1, text)]
    if kind == "markdown":
        out: list[tuple[int, str]] = []
        block: list[str] | None = None
        first = 0
        for n, line in enumerate(lines, start=1):
            if line.lstrip().startswith("```"):
                if block is None:
                    block, first = [], n + 1
                else:
                    out.append((first, "\n".join(block)))
                    block = None
                continue
            if block is not None:
                block.append(line)
            else:
                out += [(n, m) for m in re.findall(r"`([^`\n]+)`", line)]
        if block:
            out.append((first, "\n".join(block)))
        return out
    out = []
    i = 0
    while i < len(lines):
        j = i
        while j + 1 < len(lines) and lines[j].endswith("\\"):
            j += 1
        group = "\n".join(lines[i: j + 1])
        # a yaml key or list marker in front of the command (`run: gcloud …`, `- gcloud …`) is not part of the command
        out.append((i + 1, re.sub(r"^\s*(?:-\s+)?(?:[A-Za-z0-9_.-]+:\s+)?", "", group, count=1)))
        i = j + 1
    return out


def project_binding_calls(text: str, kind: str = "shell") -> list[tuple[int, bool]]:
    """(line, names a condition) for every project-level binding call of the text, read as `kind` says (see `kind_of`)"""
    out: list[tuple[int, bool]] = []
    for offset, region in _regions(text, kind):
        for line_no, logical in _statements(region):
            if "gcloud" not in logical:
                continue
            cmds = _commands(logical)
            if cmds is None:
                # unbalanced quoting: judge by a plain look — if it mentions a project binding call at all, it is a violation
                if re.search(r"gcloud(?:\s+(?:beta|alpha))?\s+projects\s+(?:add|remove)-iam-policy-binding", logical):
                    out.append((offset + line_no - 1, False))
                continue
            for words in cmds:
                if _is_project_binding_call(words):
                    out.append((offset + line_no - 1, any(w == "--condition" or w.startswith("--condition=") for w in words)))
    return out


def _calls_without_condition(text: str, kind: str = "shell") -> list[int]:
    return [ln for ln, ok in project_binding_calls(text, kind) if not ok]


@pytest.mark.parametrize(
    "name, text, expected",
    [
        ("one line, no condition", 'gcloud projects add-iam-policy-binding $P --member m --role r\n', [1]),
        ("remove, no condition", 'gcloud projects remove-iam-policy-binding "$P" --member m --role r\n', [1]),
        ("beta track, no condition", 'gcloud beta projects add-iam-policy-binding "$P" --member m --role r\n', [1]),
        ("alpha track, no condition", 'gcloud alpha projects add-iam-policy-binding "$P" --member m --role r\n', [1]),
        ("continuation lines, condition on the last", 'gcloud projects add-iam-policy-binding "$P" \\\n  --member m \\\n  --role r \\\n  --condition=None\n', []),
        ("continuation lines, no condition", 'gcloud projects add-iam-policy-binding "$P" \\\n  --member m \\\n  --role r\n', [1]),
        ("a backslash followed by a space is NOT a continuation", 'gcloud projects add-iam-policy-binding "$P" --member m --role r \\ \n  --condition=None\n', [1]),
        ("a comment after a continuation holding the flag does not count", 'gcloud projects add-iam-policy-binding "$P" --member m --role r \\\n  # --condition=None\n', [1]),
        ("a trailing comment holding the flag does not count", 'gcloud projects add-iam-policy-binding "$P" --member m --role r  # --condition=None\n', [1]),
        ("an escaped backslash at the end is NOT a continuation", 'echo a \\\\\ngcloud projects add-iam-policy-binding $P --role r\n', [2]),
        ("a comment that ends with a backslash does NOT hide the next line", 'echo ok  # note \\\ngcloud projects add-iam-policy-binding "$P" --member m --role r\n', [2]),
        ("a comment mentioning do/then and a call is not a call", 'gcloud projects add-iam-policy-binding "$P" --role r --condition=None  # do gcloud projects add-iam-policy-binding "$P" --role r\n', []),
        ("a hash inside quotes is not a comment", 'gcloud projects add-iam-policy-binding "$P" --role "r#1" --condition=None\n', []),
        ("a conditioned call followed by an UNconditioned one on the same line", 'gcloud projects add-iam-policy-binding "$P" --role r --condition=None && gcloud projects add-iam-policy-binding "$P" --role r\n', [1]),
        ("an unconditioned call followed by a conditioned one on the same line", 'gcloud projects add-iam-policy-binding "$P" --role r && gcloud projects add-iam-policy-binding "$P" --role r --condition=None\n', [1]),
        ("two calls on the same line, both conditioned", 'gcloud projects add-iam-policy-binding "$P" --role r --condition=None; gcloud projects remove-iam-policy-binding "$P" --role r --condition=None\n', []),
        ("two calls on the same line, neither conditioned", 'gcloud projects add-iam-policy-binding "$P" --role r; gcloud projects add-iam-policy-binding "$P" --role q\n', [1, 1]),
        ("the second call starts on a continuation line", 'gcloud projects add-iam-policy-binding "$P" --role r --condition=None \\\n  && gcloud projects add-iam-policy-binding "$P" --role q\n', [1]),
        ("a parenthesis and a semicolon glued together end the command", '(gcloud projects add-iam-policy-binding "$P" --role r); echo --condition=None\n', [1]),
        ("a quoted word spanning lines, then a comment holding the flag", 'gcloud projects add-iam-policy-binding "$P" --role "r \\\nfoo" # --condition=None\n', [1]),
        ("a quoted word spanning lines, then the real flag", 'gcloud projects add-iam-policy-binding "$P" --role "r\nfoo" --condition=None\n', []),
        ("a redirection `2>&1` does not end the command", 'gcloud projects add-iam-policy-binding "$P" --role r 2>&1 --condition=None\n', []),
        ("a redirection to a file keeps the words", 'gcloud projects add-iam-policy-binding "$P" --role r --condition=None > /dev/null\n', []),
        ("a brace group", '{ gcloud projects add-iam-policy-binding "$P" --role r; }\n', [1]),
        ("a semicolon ends the command", 'gcloud projects add-iam-policy-binding "$P" --member m --role r; echo --condition=None\n', [1]),
        ("a pipe ends the command", 'gcloud projects add-iam-policy-binding "$P" --member m --role r | grep --condition=None\n', [1]),
        ("a quoted condition is a condition", "gcloud projects add-iam-policy-binding $P --member m --role r --condition='expression=true,title=t'\n", []),
        ("one line with condition None", 'gcloud projects add-iam-policy-binding $P --member m --role r --condition=None\n', []),
        ("--condition as its own word", 'gcloud projects add-iam-policy-binding $P --member m --role r --condition None\n', []),
        ("inside a loop, with the condition", 'for R in a b; do\n  gcloud projects add-iam-policy-binding $P --role "$R" --condition=None\ndone\n', []),
        ("inside a loop, without it", 'for R in a b; do\n  gcloud projects add-iam-policy-binding $P --role "$R"\ndone\n', [2]),
        ("after `do` on the same line", 'for R in a; do gcloud projects add-iam-policy-binding $P --role "$R"; done\n', [1]),
        ("after `then`", 'if x; then gcloud projects add-iam-policy-binding $P --role r; fi\n', [1]),
        ("after `if !`", 'if ! gcloud projects add-iam-policy-binding $P --role r; then echo no; fi\n', [1]),
        ("after `command`", 'command gcloud projects add-iam-policy-binding $P --role r\n', [1]),
        ("after `sudo` and an environment assignment", 'sudo CLOUDSDK_CORE_PROJECT=x gcloud projects remove-iam-policy-binding $P --role r\n', [1]),
        ("unbalanced quoting is a violation, not a pass", 'gcloud projects add-iam-policy-binding $P --role "r --condition=None\n', [1]),
        ("a resource-level binding is not a project call", 'gcloud secrets add-iam-policy-binding S --member m --role r\n', []),
        ("a whole-line comment is fine", '# gcloud projects add-iam-policy-binding $P --member m --role r\n', []),
        ("a mention in prose or backticks is not a call", 'Run `gcloud projects add-iam-policy-binding` without a condition and it asks.\n', []),
        ("the next statement's condition does not count", 'gcloud projects add-iam-policy-binding $P --member m --role r\ngcloud projects add-iam-policy-binding $P --member m --role r --condition=None\n', [1]),
    ],
)
def test_the_scan_sees_every_shape_of_a_binding_call_without_a_condition(name, text, expected):
    assert _calls_without_condition(text) == expected, name


@pytest.mark.parametrize(
    "name, kind, text, expected",
    [
        ("markdown: prose with an apostrophe does not swallow the code fence", "markdown", "It's a note.\n\n```bash\ngcloud projects add-iam-policy-binding $P --role r\n```\n", [4]),
        ("markdown: a conditioned call in a fence passes", "markdown", "Don't worry.\n```\ngcloud projects add-iam-policy-binding $P --role r --condition=None\n```\n", []),
        ("markdown: every line of a fence is a command", "markdown", "```\ngcloud projects add-iam-policy-binding $P --role a --condition=None\ngcloud projects add-iam-policy-binding $P --role b\n```\n", [3]),
        ("markdown: an inline code span holding a call without a condition", "markdown", "Run `gcloud projects add-iam-policy-binding $P --role r` first.\n", [1]),
        ("markdown: an inline code span holding a conditioned call", "markdown", "Run `gcloud projects add-iam-policy-binding $P --role r --condition=None` first.\n", []),
        ("markdown: prose naming the command outside code is not a call", "markdown", "The gcloud projects add-iam-policy-binding command asks a question.\n", []),
        ("lines (yaml): an apostrophe on an earlier line does not swallow the call", "lines", "name: Don't\nrun: gcloud projects add-iam-policy-binding $P --role r\n", [2]),
        ("lines (yaml): a list item", "lines", "steps:\n  - gcloud projects add-iam-policy-binding $P --role r\n", [2]),
        ("lines (yaml): a list item with the flag", "lines", "steps:\n  - gcloud projects add-iam-policy-binding $P --role r --condition=None\n", []),
        ("lines (yaml): a call with a continuation and the flag", "lines", "run: gcloud projects add-iam-policy-binding $P \\\n  --role r --condition=None\n", []),
        ("shell: the same apostrophe INSIDE a script is a quote", "shell", "echo 'it\ngcloud projects add-iam-policy-binding $P --role r'\n", []),
    ],
)
def test_each_kind_of_file_is_read_the_way_that_kind_is_run(name, kind, text, expected):
    assert _calls_without_condition(text, kind) == expected, name


@pytest.mark.parametrize("path, kind", [("a.sh", "shell"), ("deploy/x.bash", "shell"), ("deploy/vm/RUNBOOK.md", "markdown"), (".github/workflows/x.yml", "lines"), ("cloudbuild.yaml", "lines"), ("a.py", "lines")])
def test_the_kind_of_a_file_follows_its_name(path, kind):
    assert kind_of(path) == kind


def test_no_tracked_file_has_a_project_binding_call_without_a_condition():
    raw = subprocess.run(["git", "-C", str(_ROOT), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
    names = [os.fsdecode(n) for n in raw.split(b"\0") if n]
    assert len(names) > 500, "the scan saw almost nothing — it is not scanning the tree"
    hits: list[str] = []
    seen: dict[str, int] = {}
    for n in names:
        rel = Path(n)
        if any(part in _SKIP_PARTS for part in rel.parts[:-1]) or rel.name.endswith(_SKIP_SUFFIX) or rel.name == "test_4798_project_binding_names_condition.py":
            continue
        try:
            text = (_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        calls = project_binding_calls(text, kind_of(n))
        if calls:
            seen[n] = len(calls)
        hits += [f"{n}:{ln}" for ln, ok in calls if not ok]
    short = {site: (seen.get(site, 0), least) for site, least in _KNOWN_SITES.items() if seen.get(site, 0) < least}
    assert not short, f"the scan sees fewer calls than are known to exist (site: seen, expected at least) {short} — it is blind there, or a call was removed on purpose: update _KNOWN_SITES"
    assert hits == [], hits
