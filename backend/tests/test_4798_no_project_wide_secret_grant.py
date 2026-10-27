"""story 4798 (AC14) — no script hands out a PROJECT-LEVEL secret-reader role; access to a secret is granted one secret at a time.

A project-level `roles/secretmanager.secretAccessor` lets one account read every secret of the project — here, both environments'. The operator removed those grants from the live accounts (story 4798); the setup scripts used to put them back
on a re-run. These tests (1) scan the scripts, the build and the workflows for a project-level grant of that role, (2) run the three setup scripts with a recording `gcloud` and look at what they would do, and (3) run the one helper
that grants access (`grant_secret_access.sh`) and check it grants one secret at a time, to the right account, and refuses odd input."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_ROOT = _BACKEND.parent
_SCRIPTS = _BACKEND / "scripts"

# a project-level grant of a secret-management role, or of a role that carries it (owner · editor)
_ROLES = ("secretmanager.secretAccessor", "secretmanager.admin", "roles/owner", "roles/editor")
_PROJECT_GRANT = re.compile(r"gcloud(?:\s+(?:beta|alpha))?\s+projects\s+(?:add-iam-policy-binding|set-iam-policy)|projects/[^\s\"']*:setIamPolicy|cloudresourcemanager\.googleapis\.com[^\n]*setIamPolicy")
_SKIP_PARTS = {"node_modules", ".git", "tests", "__tests__", "__pycache__", ".next", ".qa-worktrees"}
_SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".gz", ".zip", ".lock", ".pyc", ".woff", ".woff2", ".pdf")


def _tracked(root: Path = _ROOT) -> list[Path]:
    """every tracked file (the whole tree, documents included), not a hand-picked set of folders"""
    try:
        raw = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
        names = [os.fsdecode(n) for n in raw.split(b"\0") if n]
    except (OSError, subprocess.SubprocessError):
        names = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()]
    out = []
    for n in names:
        rel = Path(n)
        if any(part in _SKIP_PARTS for part in rel.parts[:-1]) or rel.name.endswith(_SKIP_SUFFIX) or rel.name == "test_4798_no_project_wide_secret_grant.py":
            continue
        out.append(root / rel)
    return out


def _statement(lines: list[str], i: int) -> str:
    """the grant at line i: its backslash continuations, and — when it sits inside a `for … in … ; do` loop — the loop header (the roles it lists), found by walking up to the nearest `for` of the enclosing loop"""
    j = i
    while j + 1 < len(lines) and lines[j].rstrip().endswith("\\"):
        j += 1
    start = i
    k = i - 1
    while k >= 0 and i - k <= 40:
        stripped = lines[k].strip()
        if stripped in ("done",) or stripped.startswith("done "):
            break  # a loop that ended above: not ours
        if re.match(r"for\s+\w+\s+in\b", stripped):
            start = k
            break
        k -= 1
    return "\n".join(lines[start: j + 1])


def _project_level_secret_grants(text: str) -> list[int]:
    """line numbers of a project-level IAM grant (`gcloud [beta] projects add-iam-policy-binding|set-iam-policy`, or a REST `:setIamPolicy` of a project) whose statement — or whose enclosing role loop — names a secret role or owner/editor"""
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#") or not _PROJECT_GRANT.search(line):
            continue
        window = _statement(lines, i)
        if any(r in window for r in _ROLES):
            out.append(i + 1)
    return out


def test_no_tracked_file_grants_a_secret_role_at_project_level():
    hits = []
    files = _tracked()
    assert len(files) > 500, "the scan saw almost nothing — it is not scanning the tree"
    for p in files:
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for n in _project_level_secret_grants(text):
            hits.append(f"{p.relative_to(_ROOT)}:{n}")
    assert hits == [], hits


@pytest.mark.parametrize(
    "name, text, expected",
    [
        ("single line", 'gcloud projects add-iam-policy-binding "$P" --member="$M" --role="roles/secretmanager.secretAccessor"\n', [1]),
        ("continuation lines", 'gcloud projects add-iam-policy-binding "$P" \\\n  --member="$M" \\\n  --role="roles/secretmanager.secretAccessor" \\\n  --condition=None\n', [1]),
        ("a role loop above", 'for ROLE in \\\n    roles/secretmanager.secretAccessor \\\n    roles/cloudsql.client; do\n    gcloud projects add-iam-policy-binding "$P" \\\n        --role="${ROLE}"\ndone\n', [4]),
        ("a role loop on one line", 'for ROLE in roles/a roles/secretmanager.secretAccessor; do\n    gcloud projects add-iam-policy-binding "$P" --role="${ROLE}"\ndone\n', [2]),
        ("set-iam-policy", 'gcloud projects set-iam-policy "$P" policy.json # roles/secretmanager.admin\n', [1]),
        ("per-secret grant is fine", 'gcloud secrets add-iam-policy-binding "$S" --member="$M" --role="roles/secretmanager.secretAccessor"\n', []),
        ("another project role is fine", 'gcloud projects add-iam-policy-binding "$P" --member="$M" --role="roles/cloudsql.client"\n', []),
        ("beta track", 'gcloud beta projects add-iam-policy-binding "$P" --member="$M" --role="roles/secretmanager.secretAccessor"\n', [1]),
        ("owner", 'gcloud projects add-iam-policy-binding "$P" --member="$M" --role="roles/owner"\n', [1]),
        ("editor", 'gcloud projects add-iam-policy-binding "$P" --member="$M" --role=roles/editor\n', [1]),
        ("REST setIamPolicy", 'curl -X POST "https://cloudresourcemanager.googleapis.com/v1/projects/p:setIamPolicy" -d \'{"policy":{"bindings":[{"role":"roles/secretmanager.admin"}]}}\'\n', [1]),
        ("a role loop whose list is far above the call", 'for ROLE in \\\n  roles/cloudsql.client \\\n  roles/secretmanager.secretAccessor; do\n  echo a\n  echo b\n  echo c\n  echo d\n  echo e\n  gcloud projects add-iam-policy-binding "$P" --role="${ROLE}"\ndone\n', [9]),
        ("a finished loop above does not count", 'for ROLE in roles/secretmanager.secretAccessor; do\n  echo "$ROLE"\ndone\ngcloud projects add-iam-policy-binding "$P" --role="roles/cloudsql.client"\n', []),
        ("a comment is fine", '# gcloud projects add-iam-policy-binding $P --role=roles/secretmanager.secretAccessor\n', []),
    ],
)
def test_the_scan_sees_every_shape_of_a_project_level_secret_grant(name, text, expected):
    assert _project_level_secret_grants(text) == expected, name


@pytest.fixture
def recording_gcloud(tmp_path):
    """a `gcloud` that records every call (one line per call) and answers nothing"""
    log = tmp_path / "gcloud-calls.txt"
    g = tmp_path / "bin" / "gcloud"
    g.parent.mkdir()
    # K_FAIL (an env variable of the test): a call whose arguments contain it fails — to see what the scripts do when gcloud refuses
    g.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\nif [ -n "$K_FAIL" ] && echo "$*" | grep -q -- "$K_FAIL"; then exit 1; fi\nexit 0\n')
    g.chmod(0o755)
    return g.parent, log


def _run(script: str, args: list[str], recording_gcloud, extra_env: dict | None = None):
    bin_dir, log = recording_gcloud
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "GCP_PROJECT": "proj-x", **(extra_env or {})}
    proc = subprocess.run(["bash", str(_SCRIPTS / script), *args], capture_output=True, text=True, env=env, timeout=120)
    calls = log.read_text().splitlines() if log.exists() else []
    return proc, calls


_SECRET_ENV = {
    "SECRET_JWT_SECRET": "x", "SECRET_JWT_SECRET_DEV": "x", "SECRET_JWT_SECRET_PROD": "x",
}


@pytest.mark.parametrize("script", ["setup_iam.sh", "setup_secret_manager.sh", "setup_workload_identity.sh"])
def test_the_setup_scripts_never_grant_a_secret_role_at_project_level(script, recording_gcloud):
    proc, calls = _run(script, [], recording_gcloud, {**_SECRET_ENV, "GITHUB_OWNER": "o", "GITHUB_REPO": "r"})
    assert proc.returncode == 0, proc.stderr[-400:]
    assert calls, "the script ran no gcloud call at all — the recorder did not see it"
    bad = [c for c in calls if c.startswith("projects") and "iam-policy-binding" in c and any(r in c for r in _ROLES)]
    assert bad == [], bad


def test_setup_iam_still_grants_the_database_role_and_nothing_about_secrets(recording_gcloud):
    proc, calls = _run("setup_iam.sh", [], recording_gcloud)
    grants = [c for c in calls if c.startswith("projects add-iam-policy-binding")]
    assert any("roles/cloudsql.client" in c and "cloudrun-runtime-dev@proj-x" in c for c in grants), grants
    assert any("roles/cloudsql.client" in c and "cloudrun-runtime-prod@proj-x" in c for c in grants), grants
    assert not [c for c in grants if "secretmanager" in c], grants


def test_the_workload_identity_script_keeps_its_other_roles(recording_gcloud):
    proc, calls = _run("setup_workload_identity.sh", [], recording_gcloud, {"GITHUB_OWNER": "o", "GITHUB_REPO": "r"})
    roles = {re.search(r"--role=(\S+)", c).group(1) for c in calls if c.startswith("projects add-iam-policy-binding") and "--role=" in c}
    assert {"roles/cloudbuild.builds.editor", "roles/artifactregistry.writer", "roles/run.admin"} <= roles, roles


@pytest.mark.parametrize("target, account", [("dev", "cloudrun-runtime-dev@proj-x"), ("prod", "cloudrun-runtime-prod@proj-x"), ("ci", "github-actions@proj-x")])
def test_the_helper_grants_one_secret_at_a_time_to_the_right_account(target, account, recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", [target, "SECRET_A", "SECRET_B"], recording_gcloud)
    assert proc.returncode == 0, proc.stderr
    grants = [c for c in calls if "add-iam-policy-binding" in c]
    assert len(grants) == 2
    for c, name in zip(grants, ("SECRET_A", "SECRET_B")):
        assert c.startswith(f"secrets add-iam-policy-binding {name} "), c
        assert f"--member=serviceAccount:{account}.iam.gserviceaccount.com" in c
        assert "--role=roles/secretmanager.secretAccessor" in c
    assert not [c for c in calls if c.startswith("projects")], calls


@pytest.mark.parametrize(
    "args",
    [[], ["dev"], ["staging", "A"], ["dev", "bad name"], ["dev", "A/B"], ["dev", "A;rm"], ["prod", "../x"], ["ci", ""], ["dev", "-x"], ["dev", "--help"], ["prod", "--member=serviceAccount:x@y"], ["ci", "-"], ["dev", "A\nB"], ["dev", "Ä"]],
)
def test_the_helper_refuses_odd_input_and_grants_nothing(args, recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", args, recording_gcloud)
    assert proc.returncode != 0
    assert [c for c in calls if "add-iam-policy-binding" in c] == []


def test_the_helper_checks_the_secret_exists_before_granting_it(recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", ["dev", "SECRET_A"], recording_gcloud)
    assert calls[0].startswith("secrets describe SECRET_A "), calls


def test_a_missing_secret_stops_everything_before_any_grant(recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", ["dev", "SECRET_A", "SECRET_B", "SECRET_C"], recording_gcloud, {"K_FAIL": "describe SECRET_C"})
    assert proc.returncode != 0
    assert "nothing was granted" in proc.stderr and "SECRET_C" in proc.stderr
    assert [c for c in calls if "add-iam-policy-binding" in c] == [], calls  # the typo in the last name left none of the first ones granted


def test_a_failed_grant_is_reported_and_names_the_secret(recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", ["dev", "SECRET_A", "SECRET_B"], recording_gcloud, {"K_FAIL": "add-iam-policy-binding SECRET_B"})
    assert proc.returncode != 0
    assert "grant failed for SECRET_B" in proc.stderr
    assert "granted SECRET_A" in proc.stdout and "granted SECRET_B" not in proc.stdout  # what was granted before stays, and the message says so


def test_the_ci_account_follows_the_setup_scripts_variable(recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", ["ci", "SECRET_A"], recording_gcloud, {"SA_NAME": "custom-ci"})
    assert proc.returncode == 0, proc.stderr
    assert any("--member=serviceAccount:custom-ci@proj-x.iam.gserviceaccount.com" in c for c in calls), calls


def test_setup_iam_prints_the_real_account_names_in_its_guidance(recording_gcloud):
    proc, _ = _run("setup_iam.sh", [], recording_gcloud)
    assert proc.returncode == 0, proc.stderr[-300:]
    assert "--service-account=cloudrun-runtime-dev@proj-x.iam.gserviceaccount.com" in proc.stdout, proc.stdout
    assert "--service-account=cloudrun-runtime-prod@proj-x.iam.gserviceaccount.com" in proc.stdout, proc.stdout
    assert not re.search(r"--service-account=\S*\s", proc.stdout.replace("--service-account=cloudrun-runtime-dev@proj-x.iam.gserviceaccount.com", "").replace("--service-account=cloudrun-runtime-prod@proj-x.iam.gserviceaccount.com", "")), proc.stdout  # no timestamp or log text in a value


def test_the_workflow_comments_no_longer_claim_a_project_level_secret_role():
    text = (_ROOT / ".github" / "workflows" / "cloud-build.yml").read_text(encoding="utf-8")
    assert "project-level roles/secretmanager.secretAccessor" not in text
    assert not re.search(r"run\.admin/secretmanager\.secretAccessor", text)
