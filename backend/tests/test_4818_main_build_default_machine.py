"""story 4818 (INFRA-DIET ⑧) — the main build (cloudbuild.yaml, dev and prod) runs on Cloud Build's default worker.

Measured 2026-10-29: the build bill left after story 4805 was the main build on the 8-core worker (E2_HIGHCPU_8): 1,052 minutes a month, about 16 dollars. With the Cloud Run steps skipped (story 4796) the build is
2.4–2.8 minutes, mostly gcloud calls and the backend image; the default worker has a monthly allowance of free minutes per billing account.

Pinned here: `options` names no machine and no worker pool (so a paid machine coming back turns this red), the workflow's submission of this build adds neither, and the VM bundle build — which already ran on the default
worker (story 4805) — still names none either. These read the real files, so putting `machineType: E2_HIGHCPU_8` back, or `--machine-type` on the submission, is what fails.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_MAIN = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
_VM = yaml.safe_load((_ROOT / "cloudbuild-vm.yaml").read_text())
_WF_TEXT = (_ROOT / ".github/workflows/cloud-build.yml").read_text()

PAID_OPTION_KEYS = ("machineType", "pool", "workerPool")


def test_the_main_build_names_no_machine_and_no_pool() -> None:
    opts = _MAIN.get("options") or {}
    assert not [k for k in PAID_OPTION_KEYS if k in opts], f"the main build must run on the default worker, not a named one: {opts}"


def test_the_main_build_keeps_its_logging_option() -> None:
    # the line next to the removed one: removing `machineType` must not have taken the logging choice with it
    assert (_MAIN.get("options") or {}).get("logging") == "CLOUD_LOGGING_ONLY"


def test_no_text_of_the_main_build_still_selects_the_8_core_worker() -> None:
    # as a value (not in the comment that explains the one-line way back): `machineType: E2_HIGHCPU_8` at the start of a line under options
    text = (_ROOT / "cloudbuild.yaml").read_text()
    assert not re.search(r"^\s+machineType:\s*\S", text, re.M), "an uncommented machineType line is back in cloudbuild.yaml"


def test_the_submission_of_the_main_build_adds_no_machine_or_pool() -> None:
    # `gcloud builds submit --config=cloudbuild.yaml ...` — the command text up to its last argument line
    m = re.search(r"gcloud builds submit \\\n(?:\s+--config=cloudbuild\.yaml.*\n(?:\s+.*\\\n)*\s+.*\n)", _WF_TEXT)
    assert m, "the main build submission was not found in cloud-build.yml"
    assert not re.search(r"--machine-type|--worker-pool|--pool", m.group(0)), m.group(0)


def test_the_vm_bundle_build_is_on_the_default_worker_too() -> None:
    opts = _VM.get("options") or {}
    assert not [k for k in PAID_OPTION_KEYS if k in opts], opts
