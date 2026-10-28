"""story 4796 - the tests that start the REAL gcloud do not depend on the network, so they do not depend on the speed (or the neighbourhood) of the machine they run on.

What was wrong: gcloud starts by asking the metadata server whether it runs on Google Compute Engine (3 s per try, 3 retries). On a developer's machine that fails at once; on a GitHub runner the address does not answer and every start waited about 12 s, so a test with two starts hit pytest's 30 s limit (twice, on two unrelated PRs). The cure is not a longer limit but taking the question away (`tests/_real_gcloud.py`). Here: the proof against a metadata server that accepts a connection and never answers, and a guard so that no test starts gcloud any other way.
"""
from __future__ import annotations

import re
import shutil
import socket
import threading
import time
from pathlib import Path

import pytest

from tests import _real_gcloud as G

_TESTS = Path(__file__).resolve().parent
needs_gcloud = pytest.mark.skipif(shutil.which("gcloud") is None, reason="no gcloud on this machine")


class _HangingMetadataServer:
    """accepts connections and never answers - what the link-local address does on a runner"""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.conns: list[socket.socket] = []
        self.accepted = 0
        self._stop = False
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while not self._stop:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.accepted += 1
            self.conns.append(c)

    def close(self) -> None:
        self._stop = True
        self.sock.close()
        for c in self.conns:
            c.close()


def _start(env: dict[str, str], cwd: Path) -> tuple[float, str]:
    import subprocess
    t0 = time.monotonic()
    p = subprocess.run(["gcloud", "run", "services", "update", "s", "--region=r", "--clear-cloudsql-instances"], capture_output=True, text=True, timeout=60, env=env, cwd=cwd)
    return time.monotonic() - t0, G.text(p)


@needs_gcloud
def test_a_gcloud_start_with_the_helper_asks_a_port_that_refuses_and_takes_well_under_a_second_or_two(tmp_path: Path) -> None:
    e = G.env(tmp_path)
    host, port = e["GCE_METADATA_ROOT"].split(":")
    with socket.socket() as sk:
        sk.settimeout(2)
        assert sk.connect_ex((host, int(port))) != 0, "nothing listens where the helper sends the question"
    took, out = _start(e, tmp_path)
    assert "do not currently have an active account" in out, out[:300]
    assert took < 10, f"{took:.1f} s (a start that waits for the metadata question takes 12 s; this test does not time the helper, the lines above prove where the question goes)"


@needs_gcloud
def test_even_a_metadata_server_that_never_answers_costs_a_start_at_most_a_few_seconds_with_the_helper_environment(tmp_path: Path) -> None:
    """the second line of defence, and the proof that the question is the whole story: the question sent to a server that accepts and stays silent costs 4 tries of 1 s (12 s without the time limit of the helper)"""
    srv = _HangingMetadataServer()
    try:
        e = G.env(tmp_path)
        e["GCE_METADATA_ROOT"] = f"127.0.0.1:{srv.port}"
        took, out = _start(e, tmp_path)
    finally:
        srv.close()
    assert "do not currently have an active account" in out, out[:300]
    assert srv.accepted >= 1, "the question really went to the silent server (so the delay below is the question's)"
    assert took < 10, f"{took:.1f} s: 4 tries x 1 s is about 4.5 s; 12 s would mean the time limit is gone"


@needs_gcloud
def test_the_environment_of_the_helper_keeps_gcloud_off_the_network(tmp_path: Path) -> None:
    e = G.env(tmp_path)
    assert e["CLOUDSDK_COMPUTE_GCE_METADATA_CHECK_TIMEOUT_SEC"] == "1" and e["CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK"] == "1" and e["CLOUDSDK_CORE_DISABLE_USAGE_REPORTING"] == "true" and e["CLOUDSDK_CORE_DISABLE_PROMPTS"] == "1"
    assert e["CLOUDSDK_CONFIG"].startswith(str(tmp_path)) and e["HOME"] == str(tmp_path), "an empty configuration of its own: nothing of the developer's is read, and no answer cached by an earlier start"
    assert e["GCE_METADATA_ROOT"].startswith("127.0.0.1:") and "CLOUDSDK_CORE_PROJECT" not in G.env(tmp_path, project=None)


_PROCESS_CALL = re.compile(r"(?:subprocess\.(?:run|Popen|check_output|check_call|call|getoutput|getstatusoutput)|\bPopen|os\.system|os\.popen|asyncio\.create_subprocess_(?:exec|shell))\s*\(")


def _test_files() -> list[Path]:
    """every python file under tests/ at any depth, whatever its name, except the helper and this file"""
    return [f for f in sorted(_TESTS.rglob("*.py")) if f.name not in ("_real_gcloud.py", Path(__file__).name) and "__pycache__" not in f.parts]


def test_every_test_that_starts_the_real_gcloud_goes_through_the_helper() -> None:
    """a test that looks for gcloud on the machine (`which("gcloud")`, `needs_gcloud`) or builds a CLOUDSDK_ environment must use tests/_real_gcloud.py - a new test cannot bring the 12 s back by forgetting.
    The scan is static and is a guard against forgetting, not against intent: it reads every file under tests/ at any depth."""
    offenders = []
    for f in _test_files():
        src = f.read_text()
        looks_for = re.search(r'which\(\s*["\']gcloud["\']\s*\)|needs_gcloud', src)
        builds_env = re.search(r"""["']CLOUDSDK_\w+["']\s*[:\]]""", src)   # a dict key or an env[...] of an environment built by hand (a CLOUDSDK_X=... inside a string is a command line, not an environment)
        if (looks_for or builds_env) and "_real_gcloud" not in src:
            offenders.append(f"{f.relative_to(_TESTS)}: uses gcloud or CLOUDSDK_ without the helper")
    assert offenders == [], offenders


def test_no_test_starts_gcloud_by_hand_or_moves_the_metadata_question() -> None:
    """any process call that names gcloud as the program (list or shell string, whatever the call), and any test that sets the place of the metadata server itself, is the old way - found by reading each call and the 400 characters after it"""
    hand_made = []
    for f in _test_files():
        src = f.read_text()
        for m in _PROCESS_CALL.finditer(src):
            window = src[m.end(): m.end() + 400]
            first_arg = window.split(",")[0] if window.lstrip().startswith(("[", '"', "'", "f\"", "f'")) else window
            if re.search(r"""^\s*\[?\s*f?["']gcloud\b""", first_arg) or re.search(r"""^\s*f?["'][^"']*\bgcloud\s""", first_arg):
                hand_made.append(f"{f.relative_to(_TESTS)}:{src.count(chr(10), 0, m.start()) + 1}")
        if re.search(r"GCE_METADATA_(ROOT|HOST|IP)", src):
            hand_made.append(f"{f.relative_to(_TESTS)}: sets where the metadata server is")
    assert hand_made == [], hand_made


def test_the_guard_itself_catches_the_ways_around_it(tmp_path: Path) -> None:
    """the patterns of the two guards, run on sources that try to go around them"""
    sources = [
        'subprocess.run(["gcloud", "run"], env=e)', "subprocess.Popen(['gcloud','run'])", 'subprocess.check_output(["gcloud"])', 'os.system("gcloud run services list")',
        'subprocess.run("gcloud run services list", shell=True)', 'subprocess.run(f"gcloud {x}", shell=True)',
        'Popen(["gcloud", "version"])', 'asyncio.create_subprocess_exec("gcloud", "version")',
    ]
    for src in sources:
        m = _PROCESS_CALL.search(src)
        assert m, src
        window = src[m.end(): m.end() + 400]
        first_arg = window.split(",")[0] if window.lstrip().startswith(("[", '"', "'", "f\"", "f'")) else window
        assert re.search(r"""^\s*\[?\s*f?["']gcloud\b""", first_arg) or re.search(r"""^\s*f?["'][^"']*\bgcloud\s""", first_arg), src
    for fine in ('subprocess.run(["bash", "-c", script])', 'subprocess.run(["git", "status"])'):
        m = _PROCESS_CALL.search(fine)
        first_arg = fine[m.end():].split(",")[0]
        assert not (re.search(r"""^\s*\[?\s*f?["']gcloud\b""", first_arg) or re.search(r"""^\s*f?["'][^"']*\bgcloud\s""", first_arg)), fine


def test_every_start_gets_a_configuration_directory_of_its_own_and_it_must_be_empty(tmp_path: Path) -> None:
    """gcloud caches its answers (and keeps credentials) in its configuration directory: a start must not inherit either"""
    a, b = G.env(tmp_path), G.env(tmp_path)
    assert a["CLOUDSDK_CONFIG"] != b["CLOUDSDK_CONFIG"] and not any(Path(a["CLOUDSDK_CONFIG"]).iterdir())
    used = tmp_path / "used"
    used.mkdir()
    (used / "credentials.db").write_text("x")
    with pytest.raises(AssertionError, match="must be empty"):
        G.env(tmp_path, used)


# ── the guard that is not a scan: the spawn itself is refused (tests/_no_real_network.py) ──

def _guard():
    from tests import _no_real_network
    return _no_real_network


@needs_gcloud
@pytest.mark.parametrize("args,env_has_marker,refused", [
    (["gcloud", "version"], False, True),                                   # the real gcloud by name, an environment of its own
    (["/usr/local/bin/gcloud", "version"], False, True),                    # by path
    (["bash", "-c", "gcloud run services list"], False, True),              # inside a shell script, as a command
    (["bash", "-c", "echo x; sudo gcloud run services list"], False, True),
    (["bash", "-c", "set -e\n  gcloud run services list"], False, True),
    (["bash", "-c", "X=$(gcloud config list)"], False, True),
    (["bash", "-c", 'exec gcloud "$@"'], False, True),                      # the forms the repo's own scripts use
    (["bash", "-c", "if gcloud run services list; then echo ok; fi"], False, True),
    (["bash", "-euc", "gcloud run services list"], False, True),            # option bundles
    (["bash", "-ec", "cd /x && gcloud run services list"], False, True),
    (["sh", "-c", "while ! gcloud run services list; do sleep 1; done"], False, True),
    (["bash", "-c", "xargs gcloud run services describe < list"], False, True),
    (["bash", "-c", "env gcloud run services list"], False, True),          # assignments and env in front
    (["bash", "-c", "CLOUDSDK_CORE_PROJECT=x gcloud run services list"], False, True),
    (["bash", "-c", "A=1 B=2 gcloud run services list"], False, True),
    (["bash", "-c", "env -i PATH=/usr/bin CLOUDSDK_CORE_PROJECT=x gcloud version"], False, True),
    (["bash", "-c", "sudo CLOUDSDK_CORE_PROJECT=x gcloud projects list"], False, True),
    (["bash", "-c", "echo CLOUDSDK_CORE_PROJECT=x gcloud version"], False, False),    # words after echo are not a command
    (["bash", "-c", "gcloud() { echo stand-in; }\ngcloud run services list"], False, False),   # defines its own
    (["bash", "-c", "alias gcloud=echo; gcloud run services list"], False, False),
    (["gcloud", "version"], True, False),                                   # through the helper
    (["bash", "-c", "gcloud run services list"], True, False),
    (["grep", "gcloud", "file"], False, False),                             # the word as an argument is not a start
    (["bash", "-c", "echo gcloud is not run here"], False, False),
    (["git", "status"], False, False),
])
def test_the_spawn_of_the_real_gcloud_without_the_helpers_marker_is_refused(args: list[str], env_has_marker: bool, refused: bool) -> None:
    g = _guard()
    env = {"PATH": __import__("os").environ["PATH"], **({g.GCLOUD_MARKER: "1"} if env_has_marker else {})}
    assert g.real_gcloud_without_marker(args, env) is refused, (args, env_has_marker)


@needs_gcloud
def test_a_stand_in_gcloud_on_a_path_of_the_tests_own_is_not_the_real_one(tmp_path: Path) -> None:
    import os
    import stat
    fake = tmp_path / "bin" / "gcloud"
    fake.parent.mkdir()
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    g = _guard()
    env = {"PATH": f"{fake.parent}{os.pathsep}{os.environ['PATH']}"}
    assert g.real_gcloud_without_marker(["bash", "-c", "gcloud run services list"], env) is False, "the fake comes first on its PATH: the test is running the stand-in"
    assert g.real_gcloud_without_marker(["bash", "-c", "gcloud run services list"], {"PATH": os.environ["PATH"]}) is True


@needs_gcloud
def test_a_real_spawn_without_the_marker_fails_at_the_spawn_and_names_the_cause(tmp_path: Path) -> None:
    import os
    import subprocess
    g = _guard()
    before = list(g.CAUGHT)
    with pytest.raises(FileNotFoundError, match="the real gcloud without tests/_real_gcloud.py"):
        subprocess.run(["gcloud", "version"], env={"PATH": os.environ["PATH"], "HOME": str(tmp_path)}, capture_output=True, timeout=30)
    assert len(g.CAUGHT) == len(before) + 1
    del g.CAUGHT[len(before):]   # this test made the refusal on purpose: the autouse fixture must not fail it


@needs_gcloud
def test_a_shell_script_file_is_not_read_because_the_repos_scripts_name_gcloud_in_modes_that_never_start_it(tmp_path: Path) -> None:
    import os
    g = _guard()
    script = tmp_path / "deploy.sh"
    script.write_text("#!/bin/bash\nif [ -n \"$DRY_RUN\" ]; then echo gcloud run services list; else gcloud run services list; fi\n")
    assert g.real_gcloud_without_marker(["bash", str(script)], {"PATH": os.environ["PATH"]}) is False, "documented limit: the file's text does not say whether gcloud starts"


def test_the_limit_of_the_runtime_guard_is_written_down() -> None:
    """a guard against forgetting, not against intent: the module says what it sees and what it does not (a script FILE, a program that starts gcloud from inside another program, a binary under another name)"""
    doc = _guard().__doc__
    assert "guard against forgetting" in doc and "does not see" in doc
