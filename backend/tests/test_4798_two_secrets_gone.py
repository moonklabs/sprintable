"""story 4798 (AC9) — the secrets `DATABASE_URL_DEV_PGBOUNCER` and `MIGRATION_ADMIN_PASSWORD` are gone from the repository's deploy wiring and from the secret manifest.

Measured by the operator on 2026-10-28 (names and counts only): no Cloud Run revision still serving, no job, no VM and no VM template references either name; every version of both is disabled; the repository's build never bound them (the
manifest was the only place that named them, plus two comments). This change takes both lines out of the manifest; the operator deletes the two secrets after it is merged. This keeps the names from coming back into the build, the
scripts or the manifest without a reason."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT / "infra"))
from cloudbuild_secret_refs import extract_all_secret_refs  # noqa: E402  (the repository's own definition of «the build and the scripts reference this secret»)
_NAMES = ("DATABASE_URL_DEV_PGBOUNCER", "MIGRATION_ADMIN_PASSWORD")
_SKIP_PARTS = {"node_modules", ".git", "tests", "__tests__", "__pycache__", ".next", ".qa-worktrees"}


def _manifest_names() -> list[str]:
    text = (_ROOT / "infra/cloudbuild-secret-manifest.txt").read_text()
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def test_the_manifest_lists_neither_name_and_still_lists_the_names_the_wiring_uses():
    names = _manifest_names()
    for gone in _NAMES:
        assert gone not in names, gone
    # positive controls: the list is read, and the names the build and the scripts really resolve to today are still listed (the removal is not collateral)
    refs = extract_all_secret_refs().resolved
    current = {"DATABASE_URL_DEV", "DATABASE_URL_PROD", "DATABASE_URL_PROD_PGBOUNCER", "DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE", "DATABASE_URL_DIRECT_DEV_SPRINTABLE"}
    assert current <= refs, sorted(current - refs)  # these are what the wiring references…
    assert current <= set(names), sorted(current - set(names))  # …and the manifest keeps them


def test_the_repositorys_own_reference_extraction_finds_neither_name():
    """the extraction the pull-request gate uses (the build, the deploy scripts, names assembled from parts): neither name is a resolved reference and no unresolved token could stand for one"""
    refs = extract_all_secret_refs()
    assert len(refs.resolved) > 20, "the extraction saw almost nothing — it is not reading the wiring"
    for name in _NAMES:
        assert name not in refs.resolved, name
    assert not [tok for tok in refs.unresolved if any(name in tok for name in _NAMES)]


def test_no_tracked_code_file_names_either_secret_as_more_than_a_comment():
    """A line heuristic over the tracked files outside the test folders (a name on a line that does not start with a comment mark). It is a supplement to the extraction above, not a proof: it does not follow a name split over adjacent
    strings, built from parts, or put in a docstring of a test (the test folders are skipped on purpose — they may mention a name to explain a change)."""
    raw = subprocess.run(["git", "-C", str(_ROOT), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
    hits = []
    for rel in (x.decode() for x in raw.split(b"\0") if x):
        path = Path(rel)
        if any(part in _SKIP_PARTS for part in path.parts[:-1]) or path.name in {"cloudbuild-secret-manifest.txt", "test_4798_two_secrets_gone.py"}:
            continue
        try:
            text = (_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), start=1):
            if any(re.search(rf"\b{name}\b", line) for name in _NAMES) and not line.lstrip().startswith(("#", "//", "*", "--", "<!--")):
                hits.append(f"{rel}:{n}")
    assert hits == [], hits


def test_the_manifest_header_describes_the_file_as_the_hand_kept_copy_it_is():
    """the workflow and the sync script the old header relied on were removed by story 4659; the header says so, and it no longer forbids the hand edits that are now the only way to keep the copy true"""
    header = "\n".join(line for line in (_ROOT / "infra/cloudbuild-secret-manifest.txt").read_text().splitlines() if line.startswith("#"))
    assert "story 4659" in header and "손 관리 사본" in header
    assert "손으로 추가/수정 금지" not in header
    assert "매일 스케줄) 가 GCP 실물과" not in header
    assert not (_ROOT / ".github/workflows/cloudbuild-secret-manifest-guard.yml").exists()
    assert not (_ROOT / "infra/sync_cloudbuild_secret_manifest.py").exists()
