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

_ROLES = ("secretmanager.secretAccessor", "secretmanager.admin")
_PROJECT_GRANT = re.compile(r"gcloud\s+projects\s+(add-iam-policy-binding|set-iam-policy)")
_SCAN = [_BACKEND / "scripts", _ROOT / "infra", _ROOT / "cloudbuild.yaml", _ROOT / ".github" / "workflows", _ROOT / "deploy"]


def _files():
    for base in _SCAN:
        files = [base] if base.is_file() else [p for p in base.rglob("*") if p.is_file()] if base.exists() else []
        for p in files:
            if p.suffix in {".png", ".jpg", ".gz", ".zip", ".lock", ".pyc"} or "__pycache__" in p.parts:
                continue
            yield p


def _project_level_secret_grants(text: str) -> list[int]:
    """line numbers of a `gcloud projects add-iam-policy-binding` (or `set-iam-policy`) that has a secret-reader role in its statement: the role may be on a continuation line,
    or in the header of the `for ROLE in …; do` loop right above it"""
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#") or not _PROJECT_GRANT.search(line):
            continue
        # the statement: this line and its backslash continuations; plus up to 4 lines above (a role loop header)
        j = i
        while j + 1 < len(lines) and lines[j].rstrip().endswith("\\"):
            j += 1
        window = "\n".join(lines[max(0, i - 4): j + 1])
        if any(r in window for r in _ROLES):
            out.append(i + 1)
    return out


def test_no_script_build_or_workflow_grants_a_secret_role_at_project_level():
    hits = []
    for p in _files():
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
    g.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\nexit 0\n')
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
    [[], ["dev"], ["staging", "A"], ["dev", "bad name"], ["dev", "A/B"], ["dev", "A;rm"], ["prod", "../x"], ["ci", ""]],
)
def test_the_helper_refuses_odd_input_and_grants_nothing(args, recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", args, recording_gcloud)
    assert proc.returncode != 0
    assert [c for c in calls if "add-iam-policy-binding" in c] == []


def test_the_helper_checks_the_secret_exists_before_granting_it(recording_gcloud):
    proc, calls = _run("grant_secret_access.sh", ["dev", "SECRET_A"], recording_gcloud)
    assert calls[0].startswith("secrets describe SECRET_A "), calls
