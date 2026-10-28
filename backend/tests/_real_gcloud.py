"""The one way a test starts the REAL gcloud (story 4796): to see whether it accepts a command line - flags are parsed before anything is read or sent, and without credentials it stops with «no active account».

Why a helper: gcloud first asks whether it runs on Google Compute Engine, by calling the metadata server (3 s per try, 3 retries). On a developer's machine that fails at once; on a GitHub runner the address does not answer, and every start of gcloud then waited about 12 s. Two starts were enough to pass pytest's 30 s limit, and the seventy of the cutover sheet's test far more: twice a red CI that had nothing to do with the change.
Measured here with a local server that accepts a connection and never answers, each time with a fresh configuration directory (gcloud caches its answer in the configuration directory, which makes a second start look fast and led to a wrong first conclusion):
  nothing set                                          12.5 s
  core/check_gce_metadata = false                      12.5 s   (no effect on this question)
  compute/gce_metadata_check_timeout_sec = 1            4.5 s
  GCE_METADATA_ROOT = a loopback port nobody listens on  0.3 s
The fix is to make the test independent of the network, not to give it more time: the question is sent to a local port that refuses at once, and the time it may take is cut to 1 s as a second line of defence. `tests/test_4796_real_gcloud_independent_of_the_network.py` holds the proof and a guard that every test using the real gcloud goes through here.
"""
from __future__ import annotations

import os
import re
import socket
import subprocess
import uuid
from pathlib import Path

_QUIET = {
    "SPRINTABLE_TEST_GCLOUD_ENV": "1",                           # tells tests/_no_real_network.py that this start came through here (a spawn of the real gcloud without it is refused)
    "CLOUDSDK_COMPUTE_GCE_METADATA_CHECK_TIMEOUT_SEC": "1",      # 4 tries of 1 s at the worst, if the question is ever answered by silence
    "CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK": "1",      # no look for a newer SDK
    "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING": "true",             # no report
    "CLOUDSDK_CORE_DISABLE_PROMPTS": "1",
}


def closed_port() -> int:
    """a loopback port with nothing behind it: a connection to it is refused at once"""
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


def env(home: Path, config: Path | None = None, project: str | None = "parse-only-project") -> dict[str, str]:
    """the environment of a gcloud start that needs neither credentials nor a network; `config` = an EMPTY configuration directory (default: one inside `home`)"""
    cfg = config if config is not None else home / f"gcloud-empty-config-{uuid.uuid4().hex[:12]}"   # one of its own for EVERY start: gcloud caches its answers in it, and a start must not inherit one
    cfg.mkdir(parents=True, exist_ok=True)
    if any(cfg.iterdir()):
        raise AssertionError(f"the configuration directory of a gcloud start in a test must be empty (no credentials, no cached answers): {cfg}")
    out = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "CLOUDSDK_CONFIG": str(cfg), "GCE_METADATA_ROOT": f"127.0.0.1:{closed_port()}", **_QUIET}
    if project:
        out["CLOUDSDK_CORE_PROJECT"] = project
    return out


def run(argv: list[str], home: Path, *, config: Path | None = None, project: str | None = "parse-only-project", timeout: float = 60) -> subprocess.CompletedProcess:
    """`gcloud <argv>` in `home`; the timeout is an upper bound for a hang, not a budget - a start takes well under a second"""
    return subprocess.run(["gcloud", *argv], capture_output=True, text=True, timeout=timeout, env=env(home, config, project), cwd=home)


def text(p: subprocess.CompletedProcess) -> str:
    """what gcloud said, without colour codes"""
    return re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
