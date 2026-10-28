"""story 4798 (AC16) — the secrets `GITHUB_CLIENT_ID_DEV` and `GITHUB_CLIENT_SECRET_DEV` are gone from the secret manifest and from the repository's deploy wiring.

Measured by the operator on 2026-10-28 (names and counts only): no Cloud Run revision still serving, no job, no VM and no VM template references either name (only old revisions of the prod backend from before 2026-07-23 point at them, and those no longer start);
every version of both was disabled for 20 hours without a read attempt, and the operator then deleted both. The repository's build and scripts never bind them (the reference extraction below finds neither); the manifest was the only place that named them.
This keeps the names from coming back into the build, the scripts or the manifest without a reason."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT / "infra"))
from cloudbuild_secret_refs import extract_all_secret_refs  # noqa: E402  (the repository's own definition of «the build and the scripts reference this secret»)
_NAMES = ("GITHUB_CLIENT_ID_DEV", "GITHUB_CLIENT_SECRET_DEV")
_SKIP_PARTS = {"node_modules", ".git", "tests", "__tests__", "__pycache__", ".next", ".qa-worktrees"}


def _manifest_names() -> list[str]:
    text = (_ROOT / "infra/cloudbuild-secret-manifest.txt").read_text()
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def test_the_manifest_lists_neither_name_and_still_lists_their_neighbours():
    names = _manifest_names()
    for gone in _NAMES:
        assert gone not in names, gone
    # positive controls: the list is read, and the names next to the removed ones (the live OAuth pair and the per-environment signing secrets) are still listed — the removal is not collateral
    for kept in ("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "JWT_SECRET_DEV", "JWT_SECRET_PROD"):
        assert kept in names, kept


def test_the_repositorys_own_reference_extraction_finds_neither_name():
    """the extraction the pull-request gate uses (the build, the deploy scripts, names assembled from parts): neither name is a resolved reference and no unresolved token could stand for one"""
    refs = extract_all_secret_refs()
    assert len(refs.resolved) > 20, "the extraction saw almost nothing — it is not reading the wiring"
    for name in _NAMES:
        assert name not in refs.resolved, name
    assert not [tok for tok in refs.unresolved if any(name in tok for name in _NAMES)]


def test_no_tracked_code_file_names_either_secret_as_more_than_a_comment():
    """A line heuristic over the tracked files outside the test folders (a name on a line that does not start with a comment mark). It is a supplement to the extraction above, not a proof: it does not follow a name split over adjacent
    strings or built from parts (the test folders are skipped on purpose — they may mention a name to explain a change)."""
    raw = subprocess.run(["git", "-C", str(_ROOT), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
    hits = []
    for rel in (x.decode() for x in raw.split(b"\0") if x):
        path = Path(rel)
        if any(part in _SKIP_PARTS for part in path.parts[:-1]) or path.name == "cloudbuild-secret-manifest.txt":
            continue
        try:
            text = (_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), start=1):
            if any(re.search(rf"\b{name}\b", line) for name in _NAMES) and not line.lstrip().startswith(("#", "//", "*", "--", "<!--")):
                hits.append(f"{rel}:{n}")
    assert hits == [], hits
