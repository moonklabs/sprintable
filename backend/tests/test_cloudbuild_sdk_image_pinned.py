"""Every Cloud Build step that runs the cloud-sdk image names a version, not the moving `latest`.

11-03: the dev build failed at `apply-cloud-scheduler` with «python3: command not found» (exit 127). Neither cloudbuild.yaml
nor infra/apply_cloud_scheduler.py had changed since 10-29; the unversioned image had moved from 591.0.0 (digest aa2b2728…,
the 02:22Z build that passed) to a newer release without a system python3. A version is now named on every step, so the
image only changes when we change it here (and check the steps that need python3 first).
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_FILES = ("cloudbuild.yaml", "cloudbuild-vm.yaml")
_SDK = "gcr.io/google.com/cloudsdktool/cloud-sdk"
_VERSIONED = re.compile(re.escape(_SDK) + r":\d+\.\d+\.\d+$")


def _sdk_steps(text: str) -> list[tuple[str, str]]:
    doc = yaml.safe_load(text)
    return [(s.get("id", "?"), s["name"]) for s in doc.get("steps", []) if str(s.get("name", "")).startswith(_SDK)]


def test_every_cloud_sdk_step_names_a_version():
    unpinned = []
    seen = 0
    for f in _FILES:
        steps = _sdk_steps((_ROOT / f).read_text())
        seen += len(steps)
        unpinned += [(f, sid, name) for sid, name in steps if not _VERSIONED.fullmatch(name)]
    assert seen > 0, "no cloud-sdk step found: the check would pass on nothing"
    assert unpinned == [], unpinned


def test_the_check_refuses_the_moving_image():
    doc = "steps:\n  - id: a\n    name: gcr.io/google.com/cloudsdktool/cloud-sdk\n  - id: b\n    name: gcr.io/google.com/cloudsdktool/cloud-sdk:latest\n  - id: c\n    name: gcr.io/google.com/cloudsdktool/cloud-sdk:591.0.0\n"
    assert [sid for sid, name in _sdk_steps(doc) if not _VERSIONED.fullmatch(name)] == ["a", "b"]
