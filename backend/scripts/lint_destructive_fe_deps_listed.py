"""story 4566 — infra/destructive-fe-deps.txt must be exactly the FE paths that destructive_schema tests read.

The destructive-schema shards (ci.yml backend-test-destructive) run on an FE-only change only when it touches a path on
that list (check_backend_relevant_diff.sh with FE_DEPS_FILE). A destructive test that starts reading an FE file not on the
list would then be skipped on the very change that can break it — this check fails first. A listed path no destructive
test reads any more fails too (the list stays exact, never «a little wider just in case»).

Destructive tests = the files registered in infra/destructive-schema-shard-weights/ (destructive-schema-weights-registered
-lint keeps every destructive_schema file registered). FE paths are taken with the same extractor backend-test uses
(extract_fe_paths_referenced_by_backend_tests.py: the three literal forms + its completeness fail-closed).
Run from backend/ (like the other lints): python3 scripts/lint_destructive_fe_deps_listed.py
exit 0 = exact · exit 1 = a difference (printed) or an unreadable input (fail-closed).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIST = ROOT / "infra" / "destructive-fe-deps.txt"
WEIGHTS = ROOT / "infra" / "destructive-schema-shard-weights"
TESTS = ROOT / "backend" / "tests"


def _extractor():
    spec = importlib.util.spec_from_file_location(
        "extract_fe_paths", Path(__file__).with_name("extract_fe_paths_referenced_by_backend_tests.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def listed(path: Path = LIST) -> set[str]:
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")}


def read_by_destructive(weights: Path = WEIGHTS, tests: Path = TESTS) -> tuple[set[str], list[str]]:
    """(FE paths the registered destructive tests read, files whose FE mention fits no known form)"""
    ext = _extractor()
    names = {p.stem for p in weights.glob("*.json")}
    found: set[str] = set()
    unknown: list[str] = []
    for f in sorted(tests.rglob("*.py")):
        if f.name not in names:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        paths = ext.extract_from_file(text)
        if paths:
            found.update(paths)
        elif ext._PATH_SUGGESTIVE_RE.search(text):
            unknown.append(str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f))
    return found, unknown


def main() -> int:
    try:
        want = listed(LIST)
    except OSError as e:
        print(f"lint_destructive_fe_deps_listed: {LIST} unreadable ({e}) — fail-closed", file=sys.stderr)
        return 1
    if not any(WEIGHTS.glob("*.json")):
        print(f"lint_destructive_fe_deps_listed: no destructive tests registered in {WEIGHTS} — fail-closed", file=sys.stderr)
        return 1
    got, unknown = read_by_destructive(WEIGHTS, TESTS)
    ok = True
    if unknown:
        ok = False
        print("destructive tests with an FE path in a form the extractor does not know (fail-closed):", *unknown, sep="\n  ")
    for p in sorted(got - want):
        ok = False
        print(f"read by a destructive test but not in infra/destructive-fe-deps.txt: {p} — add it (an FE-only change to it must run the shards)")
    for p in sorted(want - got):
        ok = False
        print(f"in infra/destructive-fe-deps.txt but no destructive test reads it: {p} — remove it")
    if ok:
        print(f"lint_destructive_fe_deps_listed: exact ({len(want)} FE paths)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
