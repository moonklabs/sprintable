"""story 4869 — the VM account must be able to sign AS ITSELF (roles/iam.serviceAccountTokenCreator on its own policy), or every attachment preview / file opening answers 400 «signBlob denied».

11-09: dev and prod, since the move from Cloud Run, because RUNBOOK §2 made the account without that grant. Two things are pinned here:
1. the RUNBOOK step that gives the grant — on the account itself, never project-wide;
2. `deploy/vm/bin/check-signing.sh` (run by bootstrap.sh last): one signBlob call as the VM's own account; anything but HTTP 200 fails loudly. Run for real against a fake `curl`;
   what the fake saw (URL, headers, where the token travelled) is what is asserted.
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"
_SCRIPT = _VM / "bin/check-signing.sh"
SA = "sprintable-vm-test@proj-1.iam.gserviceaccount.com"
TOKEN = "ya29.SECRET-TOKEN-VALUE"

# the fake curl: answers the two metadata reads, and for signBlob answers what FAKE_SIGN_CODE says; logs every call (arguments only) and whether the bearer token reached it on standard input
_FAKE_CURL = r"""#!/bin/sh
printf 'curl %s\n' "$*" >> "$FAKE_LOG"   # printf, not echo: sh's echo turns the backslash-n inside curl's -w argument into a real newline
# strict like the real service: curl must be started with -q (no ~/.curlrc may read the bearer header), the metadata server wants its header, and signBlob must be a POST of the exact JSON payload
# with the header file on standard input and the status code appended — anything else is answered 400 / refused
[ "$1" = "-q" ] || { printf 'NOQ %s\n' "$*" >> "$FAKE_LOG"; exit 2; }
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  *"/service-accounts/default/email")
    case "$*" in *"Metadata-Flavor: Google"*) ;; *) exit 22 ;; esac
    [ "${FAKE_NO_EMAIL-}" = 1 ] && exit 22; printf '%s' "$FAKE_SA" ;;
  *"/service-accounts/default/token")
    case "$*" in *"Metadata-Flavor: Google"*) ;; *) exit 22 ;; esac
    [ "${FAKE_NO_TOKEN-}" = 1 ] && exit 22; printf '{"access_token":"%s","expires_in":3599,"token_type":"Bearer"}' "$FAKE_TOKEN" ;;
  *":signBlob")
    printf 'SIGNCALL url=%s\n' "$url" >> "$FAKE_LOG"
    [ "${FAKE_SIGN_FAIL-}" = 1 ] && exit 7
    well_formed=1
    case " $* " in *" -X POST "*) ;; *) well_formed=0 ;; esac
    case " $* " in *" -H @- "*) ;; *) well_formed=0 ;; esac
    case "$*" in *"Content-Type: application/json"*) ;; *) well_formed=0 ;; esac
    case "$*" in *'-d {"payload":"c2lnbmluZy1jaGVjaw=="}'*) ;; *) well_formed=0 ;; esac
    case "$*" in *"-w "*"%{http_code}"*) ;; *) well_formed=0 ;; esac
    case " $* " in *" -H @- "*) hdr="$(cat)"; printf 'STDIN %s\n' "$hdr" >> "$FAKE_LOG" ;; esac
    n=$(cat "$FAKE_COUNT" 2> /dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_COUNT"
    code="${FAKE_SIGN_CODE-200}"
    # FAKE_SIGN_CODE_FIRST: the answers of the first calls (a fresh grant that has not reached the endpoint yet), then FAKE_SIGN_CODE
    set -- ${FAKE_SIGN_CODE_FIRST-}
    if [ "$n" -le "$#" ]; then eval "code=\${$n}"; fi
    [ "$well_formed" = 1 ] || code=400
    if [ "$code" = 200 ]; then printf '{"keyId":"k","signedBlob":"c2ln"}\n200'; else printf '{"error":{"code":%s,"message":"Permission '"'"'iam.serviceAccounts.signBlob'"'"' denied on resource (or it may not exist).","status":"PERMISSION_DENIED"}}\n%s' "$code" "$code"; fi ;;
esac
exit 0
"""


@pytest.fixture()
def box(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    curl = bin_dir / "curl"
    curl.write_text(_FAKE_CURL)
    curl.chmod(curl.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "curl.log"
    log.write_text("")

    def run(**env: str) -> tuple[subprocess.CompletedProcess, str]:
        full = {
            "PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(tmp_path),
            "FAKE_LOG": str(log), "FAKE_SA": SA, "FAKE_TOKEN": TOKEN, "FAKE_COUNT": str(tmp_path / "count"),
            "SIGNING_CHECK_WAIT": "0", "SIGNING_CHECK_TRIES": "3",
            **env,
        }
        p = subprocess.run(["bash", str(_SCRIPT)], capture_output=True, text=True, env=full, timeout=60)
        return p, log.read_text()

    return run


def test_signblob_200_passes_and_says_so(box) -> None:
    p, log = box()
    assert p.returncode == 0, p.stderr
    assert SA in p.stdout and "signBlob 200" in p.stdout
    assert f"SIGNCALL url=https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{SA}:signBlob" in log


def test_signblob_403_is_a_loud_failure_that_names_the_account_the_damage_and_the_fix(box) -> None:
    p, _ = box(FAKE_SIGN_CODE="403")
    assert p.returncode == 1
    err = p.stderr
    assert "SIGNING CHECK FAILED" in err and SA in err and "HTTP 403" in err
    assert "Attachment previews and file opening" in err and "BLOCKED" in err
    # the fix line is the account's OWN policy, one account only
    assert f"gcloud iam service-accounts add-iam-policy-binding {SA} --member serviceAccount:{SA} --role roles/iam.serviceAccountTokenCreator" in err
    assert "projects add-iam-policy-binding" not in err
    assert "signBlob' denied" in err, "the answer of the API is shown"


def test_a_grant_that_has_not_arrived_yet_is_retried_then_passes(box) -> None:
    p, log = box(FAKE_SIGN_CODE_FIRST="403 403", FAKE_SIGN_CODE="200", SIGNING_CHECK_TRIES="4")
    assert p.returncode == 0, p.stderr
    assert log.count("SIGNCALL") == 3


def test_it_gives_up_after_the_configured_tries_and_says_how_many(box) -> None:
    p, log = box(FAKE_SIGN_CODE="403", SIGNING_CHECK_TRIES="2")
    assert p.returncode == 1 and log.count("SIGNCALL") == 2 and "after 2 tries" in p.stderr


def test_no_answer_at_all_is_a_failure_not_a_pass_and_says_no_answer(box) -> None:
    """a real transport failure (curl exits non-zero with no output): the code is «000», not an empty string"""
    p, _ = box(FAKE_SIGN_FAIL="1", SIGNING_CHECK_TRIES="2")
    assert p.returncode == 1
    assert "SIGNING CHECK FAILED: no answer from the IAM API" in p.stderr and "HTTP  " not in p.stderr and "after 2 tries" in p.stderr


def test_a_metadata_server_that_cannot_be_read_is_exit_2_with_its_own_message(box) -> None:
    p, log = box(FAKE_NO_EMAIL="1")
    assert p.returncode == 2 and "metadata server" in p.stderr and "SIGNCALL" not in log


def test_no_access_token_from_the_metadata_server_fails(box) -> None:
    p, log = box(FAKE_NO_TOKEN="1", SIGNING_CHECK_TRIES="1")
    assert p.returncode == 1 and "SIGNCALL" not in log and "no access token" in p.stderr


def test_the_bearer_token_travels_on_standard_input_only_and_is_never_printed(box) -> None:
    for code in ("200", "403"):
        p, log = box(FAKE_SIGN_CODE=code, SIGNING_CHECK_TRIES="1")
        assert f"STDIN Authorization: Bearer {TOKEN}" in log, "the header is handed to curl on standard input (-H @-)"
        for line in log.splitlines():
            if line.startswith("curl "):
                assert TOKEN not in line and "Authorization" not in line, f"the token is in an argument list: {line}"
        assert TOKEN not in p.stdout and TOKEN not in p.stderr


def test_every_curl_call_starts_with_dash_q_so_no_curlrc_can_trace_the_bearer_header(box) -> None:
    _, log = box()
    calls = [l for l in log.splitlines() if l.startswith("curl ")]
    assert len(calls) == 3 and all(l.startswith("curl -q ") for l in calls), calls


def test_the_signblob_request_is_exactly_the_documented_one(box) -> None:
    """the fake answers 400 to anything but a POST of the exact payload with the header file on standard input, the JSON content type and the status code appended — a change to any of those fails the pass test above"""
    p, log = box()
    assert p.returncode == 0
    call = next(l for l in log.splitlines() if l.startswith("curl ") and ":signBlob" in l)
    assert "-X POST" in call and "-H @-" in call and "Content-Type: application/json" in call and '{"payload":"c2lnbmluZy1jaGVjaw=="}' in call and "%{http_code}" in call
    meta = [l for l in log.splitlines() if l.startswith("curl ") and "/service-accounts/default/" in l]
    assert len(meta) == 2 and all("Metadata-Flavor: Google" in l for l in meta)


@pytest.mark.parametrize("tries", ["abc", "0", "", "1.5", "-1"])
def test_a_bad_retry_count_is_refused_not_looped_forever_and_not_a_silent_single_try(box, tries: str) -> None:
    p, log = box(SIGNING_CHECK_TRIES=tries)
    assert p.returncode == 2 and "SIGNING_CHECK_TRIES" in p.stderr and "curl" not in log


@pytest.mark.parametrize("wait", ["abc", "", "-3", "1.5"])
def test_a_bad_wait_is_refused(box, wait: str) -> None:
    p, log = box(SIGNING_CHECK_WAIT=wait)
    assert p.returncode == 2 and "SIGNING_CHECK_WAIT" in p.stderr and "curl" not in log


@pytest.mark.parametrize("name", ["SIGNING_CHECK_IAM_URL", "SIGNING_CHECK_METADATA_URL"])
@pytest.mark.parametrize("url", [
    "http://attacker.example/v1", "https://127.0.0.1/v1", "http://127.0.0.1.evil.example/v1", "http://localhost.evil.example",
    "http://127.0.0.1:80@evil.example/v1", "http://localhost:8080@evil.example/v1", "http://localhost@evil.example/", "http://127.0.0.1",
])
def test_a_url_override_that_is_not_loopback_is_refused_so_the_token_cannot_be_sent_elsewhere(box, name: str, url: str) -> None:
    """including the user-info trick: in `http://127.0.0.1:80@evil.example/` the host is evil.example"""
    p, log = box(**{name: url})
    assert p.returncode == 2 and "refusing" in p.stderr and "curl" not in log and TOKEN not in p.stderr


def test_a_loopback_override_is_the_test_hook_and_is_used(box) -> None:
    p, log = box(SIGNING_CHECK_IAM_URL="http://127.0.0.1:8099")
    assert p.returncode == 0 and "SIGNCALL url=http://127.0.0.1:8099/v1/projects/-/serviceAccounts/" in log


# ───────────────────────── the setup path: RUNBOOK §2 gives the grant, bootstrap runs the check ─────────────────────────

def _runbook_account_step() -> str:
    text = (_VM / "RUNBOOK.md").read_text()
    return text.split("## 2. VM identity and its access")[1].split("## 3. Database password")[0]


def test_the_runbook_gives_the_account_the_signing_grant_on_itself_only() -> None:
    step = _runbook_account_step()
    lines = [l for l in step.splitlines() if "serviceAccountTokenCreator" in l and not l.lstrip().startswith("#")]
    assert lines == ["gcloud iam service-accounts add-iam-policy-binding $SAE --project $PROJECT --member serviceAccount:$SAE --role roles/iam.serviceAccountTokenCreator"], lines
    assert "projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/iam.serviceAccountTokenCreator" not in step, "never project-wide"
    # it comes after the account is made and before the section ends
    assert step.index("gcloud iam service-accounts create $SA") < step.index("serviceAccountTokenCreator")


def test_prod_takes_the_same_account_model_so_the_same_step_serves_both_environments() -> None:
    cutover = (_VM / "CUTOVER-prod.md").read_text()
    assert "prod takes the account model of [RUNBOOK §2](RUNBOOK.md) as it is" in cutover
    assert 'SA=sprintable-vm-$ENV' in (_VM / "RUNBOOK.md").read_text()


def test_bootstrap_installs_the_check_and_stops_when_it_fails() -> None:
    boot = (_VM / "bin/bootstrap.sh").read_text()
    installed = re.search(r"for f in ([^;]+); do\n  install", boot).group(1).split()
    assert "check-signing.sh" in installed
    code = re.sub(r"(?m)^\s*#.*$", "", boot)
    assert re.search(r"if ! /opt/sprintable/bin/check-signing\.sh; then\n.*\n  exit 1\nfi", code), "a failed check must stop bootstrap"
    # last thing before the final «done» line, after the tooling is installed
    assert code.index("check-signing.sh; then") > code.index('install -m 0755 "$src/bin/$f"') and code.index("check-signing.sh; then") < code.index("bootstrap done for")


def test_the_check_script_is_executable_and_in_the_runbook_by_name() -> None:
    assert _SCRIPT.stat().st_mode & 0o111
    assert "check-signing.sh" in (_VM / "RUNBOOK.md").read_text()


def test_the_only_signers_of_urls_in_the_repo_run_as_the_vm_account() -> None:
    """AC4: who makes signed URLs — the backend (`storage/gcs.py`) and the frontend (`providers/gcs.ts`); both are containers of the VM and see one identity (RUNBOOK «Accepted limit — one identity on the VM»).
    The support gateway, the MCP server, the connectors and the packages sign nothing: a new signer elsewhere must be added to this list on purpose."""
    hits = subprocess.run(
        ["git", "grep", "-lE", r"generate_signed_url|getSignedUrl|signBlob|sign_blob", "--", ".", ":!deploy", ":!docs", ":!*.md", ":!backend/tests", ":!*.test.*", ":!*.lock"],
        capture_output=True, text=True, cwd=_ROOT,
    ).stdout.split()
    s3 = {"apps/web/src/lib/storage/providers/s3.ts", "backend/app/services/storage/s3.py"}  # AWS presign (not the VM's Google account)
    assert set(hits) - s3 == {"backend/app/services/storage/gcs.py", "apps/web/src/lib/storage/providers/gcs.ts"}, hits
