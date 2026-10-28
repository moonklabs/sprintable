"""story 4796 (D2) — the cutover sheet of the support gateway's database (deploy/vm/CUTOVER-gateway-dev.md) cannot go stale or unsafe.

Pinned: the names in the sheet are the names the pipeline, the declaration and RUNBOOK §13 use; the lines the PO asked to be in it are in it; the two one-line programs that touch the passwords are taken OUT OF THE SHEET and run (nothing
secret on standard error, in an argument or in the output of the first; the output of the second is the URL and nothing else); every gcloud command of the sheet is run through the REAL gcloud parser with an empty configuration
directory (no credentials: it stops at «no active account» or says the command is wrong); nothing in the sheet deletes Cloud SQL, a secret or the service.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
SHEET = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
RUNBOOK = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
REMOVALS = (_ROOT / "deploy/vm/REMOVALS-dev.md").read_text()
DECL = yaml.safe_load((_ROOT / "deploy/vm/env/dev.yaml").read_text())
CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()
PW = "pa/ss:w0rd@#x"
SAMPLE = {"PROJECT": "sprintable-494803", "REGION": "asia-northeast3", "ZONE": "asia-northeast3-a", "ENV": "dev", "VM": "sprintable-vm-dev", "BACKUPS_BUCKET": "sprintable-vm-dev-backups",
          "GW": "support-gateway-dev", "GWJOB": "sprintable-support-gateway-migrate-dev", "GWSA": "support-gateway-dev@sprintable-494803.iam.gserviceaccount.com", "VMIP": "10.178.0.9",
          "SRC_IP": "10.110.0.3", "REV_BEFORE": "support-gateway-dev-00012-abc", "OLD_VER": "3", "NEW_VER": "4", "GWIMG": "asia-northeast3-docker.pkg.dev/p/sprintable/support-gateway:abc", "GWURL": "https://gw.example.run.app",
          "PROBE": "^@^-c@print(1)@10.178.0.9", "CHECK": "^@^-c@print(1)", "TMO": "300", "BUILD_ID": "0123abcd-0000-4000-8000-000000000000", "STAMP": "10281200001234", "PROBESA_ID": "gwdb-probe-10281200001234",
          "PROBESA": "gwdb-probe-10281200001234@sprintable-494803.iam.gserviceaccount.com", "PJU": "gwdb-probe-untagged-10281200001234", "PJT": "gwdb-probe-tagged-10281200001234",
          "PJU2": "gwdb-probe-untagged2-10281200001234", "PJG": "gwdb-probe-gwsubnet-10281200001234", "CHK": "gwdb-check-10281200001234"}


def _blocks() -> list[str]:
    return re.findall(r"```\n(.*?)```", SHEET, flags=re.S)


def _python_programs() -> list[str]:
    """every `python3 -c '<program>'` of the sheet, as the shell would hand it to python"""
    out = []
    for block in _blocks():
        for line in block.splitlines():
            if "python3 -c" not in line:
                continue
            toks = shlex.split(line, comments=False, posix=True)
            out.append(toks[toks.index("-c") + 1])
    return out


def _program(name: str) -> str:
    progs = _python_programs()
    found = [p for p in progs if name in p]
    assert len(found) == 1, (name, len(found))
    return found[0]


def _py(prog: str, stdin: str, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["python3", "-c", prog, *args], input=stdin, capture_output=True, text=True, timeout=30, env={"PATH": os.environ.get("PATH", ""), **(env or {})})


# ── the names ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_names_in_the_sheet_are_the_names_the_pipeline_the_declaration_and_the_runbook_use() -> None:
    gw = DECL["support_gateway"]["database"]
    assert "support-gateway-${_DEPLOY_ENV}" in CLOUDBUILD and "sprintable-support-gateway-migrate-${_DEPLOY_ENV}" in CLOUDBUILD
    assert "GW=support-gateway-$ENV" in SHEET and "GWJOB=sprintable-support-gateway-migrate-$ENV" in SHEET
    assert "SUPPORT_GATEWAY_DATABASE_URL=SUPPORT_GATEWAY_DATABASE_URL_${_DEPLOY_ENV}" in CLOUDBUILD.replace("\\\n", "\n") or "SUPPORT_GATEWAY_DATABASE_URL_${_DEPLOY_ENV}:latest" in CLOUDBUILD
    assert "SUPPORT_GATEWAY_DATABASE_URL_dev" in SHEET
    assert gw["password_secret"] == "SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV" and "SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV" in SHEET
    assert gw["user"] == "support_gw" and gw["name"] == "support_gateway" and 'user == "support_gw" and db == "support_gateway"' in SHEET
    assert "--subnet support-gateway-$ENV" in SHEET and '--source-ranges "$GWRANGE"' in RUNBOOK and 'GW_SUBNET="support-gateway-${_DEPLOY_ENV}"' in CLOUDBUILD and "--subnet=$${GW_SUBNET}" in CLOUDBUILD
    assert "--network-tags" not in SHEET and "source-tags" not in RUNBOOK and "network-tags" not in CLOUDBUILD.split("deploy-support-gateway")[1].split("waitFor")[0], "no tag anywhere in the design"
    assert "sprintable-gateway-db-1" in SHEET and "sprintable-gateway-db-1" in RUNBOOK
    assert "5432" in SHEET and re.search(r"^export PROJECT=sprintable-494803 REGION=asia-northeast3 ZONE=asia-northeast3-a ENV=dev$", SHEET, flags=re.M)
    assert "SUPPORT_GATEWAY_DB_POOL_SIZE=3,SUPPORT_GATEWAY_DB_MAX_OVERFLOW=2" in SHEET


def test_the_sheet_and_the_runbook_and_the_removals_sheet_point_at_each_other() -> None:
    assert "[RUNBOOK §13](RUNBOOK.md)" in SHEET and "[`REMOVALS-dev.md`](REMOVALS-dev.md)" in SHEET
    assert "[`CUTOVER-gateway-dev.md`](CUTOVER-gateway-dev.md)" in RUNBOOK and "[`CUTOVER-gateway-dev.md`](CUTOVER-gateway-dev.md)" in REMOVALS
    gate0 = REMOVALS.split("| **0. support-gateway on the VM**")[1].split("\n")[0]
    for check in ("a widget session opened", "a message sent", "an escalation reaching the backend", "a real Vertex call"):
        assert check in gate0, check
    step10 = SHEET.split("## 10. The round trip")[1].split("## 11.")[0]
    for check in ("A widget session opened", "a message sent", "An escalation reaching the backend", "A real Vertex call"):
        assert check in step10, check


# ── what the PO asked to be in it ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_budget_line_the_allow_from_line_and_the_window_of_step_five_are_in_it() -> None:
    assert "겹침 최악 16 / 27" in SHEET
    assert "Its range is written **once**, as `support_gateway.allow_from`" in SHEET and "A network tag cannot be the source of an ingress rule for Direct VPC" in SHEET
    assert "**Nothing but the gateway service, its migrate job and the probe jobs may sit on the\ngateway's subnet**" in SHEET and "deploy/vm/bin/subnet-residents.py" in SHEET
    g1 = SHEET.split("| **G1. The VM side is live, in the right order**")[1].split("\n")[0]
    assert "only then step 5 (`desired.json`) — in the same window as this sheet, not earlier" in g1 and "negative firewall control (step 2a below) is measured" in g1
    assert "«lists no table data — refusing»" in g1 and "the main dump is uploaded first" in g1 and "loses nothing" in g1 and "not loosened" in g1
    assert "sudo systemctl start sprintable-backup.service" in SHEET.split("## 10. The round trip")[1] and "**A new** gateway dump" not in SHEET
    assert "lists a **new** gateway dump with a size" in SHEET
    assert "«미측정»" in SHEET and "T1 − T0" in SHEET, "the freeze window is a number to be measured, not a guess"


def test_the_runbook_carries_the_window_the_firewall_remark_and_the_pointer() -> None:
    assert "**in the same window as the cutover sheet's restore" in RUNBOOK and "**Why step 5 belongs to the window of the load.**" in RUNBOOK
    assert "«lists no table data — refusing»" in RUNBOOK.split("**Why step 5 belongs to the window of the load.**")[1].split("**Step 3 in commands**")[0]
    assert "GWRANGE=$(awk" in RUNBOOK and "A broader allow rule exists separately in the project, so an allow rule alone would narrow nothing" in RUNBOOK
    assert "[`CUTOVER-gateway-dev.md`](CUTOVER-gateway-dev.md) repeats them in its step 2 and adds the positive control" in RUNBOOK
    assert "**Not in this step:** the move itself" in RUNBOOK and "The freeze window is **unmeasured**" in RUNBOOK


def test_the_order_table_has_a_way_back_for_every_step_and_the_sections_follow_it() -> None:
    table = SHEET.split("## The order, and what each step interrupts")[1].split("**The freeze window")[0]
    rows = [r for r in table.splitlines() if re.match(r"^\| \d+ \|", r)]
    assert [int(re.match(r"^\| (\d+) \|", r).group(1)) for r in rows] == list(range(1, 13))
    for r in rows:
        cells = [c.strip() for c in r.strip("|").split("|")]
        assert len(cells) == 4 and cells[3], r
    heads = re.findall(r"^## (\d+)\. ", SHEET, flags=re.M)
    assert heads == [str(i) for i in range(1, 13)]
    assert "the widget is unavailable from here to step 9" in rows[3]


# ── the programs that touch the passwords, taken out of the sheet and run ───────────────────────────────────────────────────────────────────

SOCKET_URL = "postgresql+asyncpg://support_gw:" + "pa%2Fss%3Aw0rd%40%23x" + "@/support_gateway?host=/cloudsql/p:r:i"


def test_the_source_url_program_swaps_the_socket_for_the_private_address_and_keeps_role_password_and_database() -> None:
    prog = _program("sys.argv[2]")
    p = _py(prog, SOCKET_URL + "\n", "10.110.0.3")
    assert p.returncode == 0 and p.stderr == ""
    assert p.stdout == "postgresql://support_gw:pa%2Fss%3Aw0rd%40%23x@10.110.0.3:5432/support_gateway", "no scheme suffix, no query, no newline"
    with_ssl = _py(prog, SOCKET_URL, "10.110.0.3", "require")
    assert with_ssl.stdout.endswith("/support_gateway?sslmode=require")


def test_the_source_url_program_output_is_what_dump_source_sh_accepts() -> None:
    """the same checks dump-source.sh makes on the URL it reads: a postgres scheme, user, password and database, the host named equals --host"""
    out = _py(_program("sys.argv[2]"), SOCKET_URL, "10.110.0.3").stdout
    from urllib.parse import unquote, urlsplit
    u = urlsplit(out)
    assert re.fullmatch(r"postgres(ql)?(\+\w+)?", u.scheme) and unquote(u.username) == "support_gw" and unquote(u.password) == PW.replace("pa/ss:w0rd@#x", "pa/ss:w0rd@#x") and u.path == "/support_gateway"
    assert u.hostname == "10.110.0.3" and u.port == 5432


def test_the_new_url_program_keeps_scheme_role_and_database_takes_the_address_and_the_vm_password_from_the_environment_only() -> None:
    prog = _program('os.environ["GWPW"]')
    p = _py(prog, SOCKET_URL + "\n", "10.178.0.9", env={"GWPW": PW})
    assert p.returncode == 0 and p.stderr == ""
    assert p.stdout == "postgresql+asyncpg://support_gw:pa%2Fss%3Aw0rd%40%23x@10.178.0.9:5432/support_gateway"
    assert "cloudsql" not in p.stdout and "?" not in p.stdout, "no socket, no query"
    assert PW not in p.stdout and PW not in prog, "the password is URL-quoted in the output and is never in the program text"


@pytest.mark.parametrize("old", ["postgresql+asyncpg://other_role:x@/support_gateway?host=/cloudsql/p:r:i", "postgresql+asyncpg://support_gw:x@/another_db?host=/cloudsql/p:r:i"])
def test_the_new_url_program_refuses_a_url_that_names_another_role_or_database(old: str) -> None:
    p = _py(_program('os.environ["GWPW"]'), old, "10.178.0.9", env={"GWPW": PW})
    assert p.returncode != 0 and p.stdout == "" and "names another role or database" in p.stderr
    assert PW not in p.stderr


def test_the_shape_check_program_never_prints_the_password() -> None:
    prog = _program('"password-present"')
    p = _py(prog, SOCKET_URL)
    assert p.returncode == 0 and p.stdout.strip() == "postgresql+asyncpg support_gw support_gateway socket password-present"
    assert "w0rd" not in p.stdout and "pa%2F" not in p.stdout and len(p.stdout.split()) == 5
    assert "NO PASSWORD" in _py(prog, "postgresql+asyncpg://support_gw@/support_gateway").stdout


def test_the_passwords_are_never_in_an_argument_list_of_the_sheet() -> None:
    for block in _blocks():
        for line in block.splitlines():
            assert not re.search(r"--password|PGPASSWORD=|:[^/@\s'\"]{3,}@[0-9]", line), line
    assert 'GWPW=$(gcloud secrets versions access latest --secret=SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV --project $PROJECT) && [ -n "$GWPW" ] && export GWPW' in SHEET and "\nunset GWPW NEWURL\n" in SHEET


# ── what the sheet may and may not delete ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_sheet_deletes_only_what_it_made_itself_and_the_rehearsal_copy() -> None:
    lines = [l for b in _blocks() for l in b.splitlines()]
    deleting = [l for l in lines if re.search(r"\bdelete\b|\bDROP\b|\brm\b", l)]
    guard = re.compile(r'^\[ "\$(\w+_MADE)" = "\$(\w+)" \] && gcloud (run jobs|iam service-accounts) delete ')
    assert len(deleting) == 5 and all(guard.match(l) for l in deleting), deleting
    made = {(m.group(1), m.group(2)) for m in (guard.match(l) for l in deleting)}
    assert made == {("JOB_MADE", "PJU"), ("JOB_G_MADE", "PJG"), ("JOB_U2_MADE", "PJU2"), ("SA_MADE", "PROBESA_ID"), ("CHK_MADE", "CHK")}, made
    assert not re.search(r"gcloud (sql instances (delete|patch|restart|failover)|sql databases|secrets (delete|versions destroy)|run services delete|compute (instances|disks|firewall-rules|addresses) delete)", SHEET)
    drop = [l for l in SHEET.splitlines() if 'DROP DATABASE "' in l]
    assert len(drop) == 1 and 'DROP DATABASE "support_gateway_before_restore_<time>"' in drop[0], "the one drop command is the rehearsal copy, by name"
    for var in ("PJU", "PJG", "PJU2", "CHK", "PROBESA_ID"):
        assert re.search(rf"^{var}=|; {var}=", SHEET, flags=re.M) and "$STAMP" in SHEET.split(f"{var}=")[1].split("\n")[0], f"{var} carries the stamp of this run"


def test_the_way_back_adds_the_old_value_as_a_new_version_and_says_what_it_costs() -> None:
    back = SHEET.split("## 12. The way back")[1]
    assert 'OLDURL=$(gcloud secrets versions access "$OLD_VER" --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT) && [ -n "$OLDURL" ] && printf %s "$OLDURL" | gcloud secrets versions add SUPPORT_GATEWAY_DATABASE_URL_dev' in back
    assert "whatever `latest` means for a disabled version" in back and "`latest` is the most recently created version, and a disabled version cannot be read" in back
    assert "gcloud secrets versions disable $NEW_VER --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT" in back and "may then be disabled" in back
    assert "**lossless only if nothing was written to `gateway-db` since step 9**" in back and "no replay is provided" in back and "rowcounts.sh" in back and "no difference = nothing was written" in back
    assert "revert it first" in back and "keep the workflow\noff until the revert is merged" in back
    assert "--add-cloudsql-instances ${PROJECT}:${REGION}:sprintable-${ENV}" in back and "--remove-env-vars SUPPORT_GATEWAY_DB_POOL_SIZE,SUPPORT_GATEWAY_DB_MAX_OVERFLOW" in back


def test_the_freeze_is_closed_by_a_command_in_the_sheet_before_any_check_that_needs_traffic() -> None:
    order = [SHEET.index(f"## {n}. ") for n in range(1, 13)]
    assert order == sorted(order)
    freeze, unfreeze = SHEET.split("## 4. Freeze")[1].split("## 5.")[0], SHEET.split("## 9. Unfreeze")[1].split("## 10.")[0]
    assert "remove-iam-policy-binding" in freeze and "--member=allUsers --role=roles/run.invoker" in freeze and "add-iam-policy-binding" in unfreeze and "T0" in freeze and "T1" in unfreeze
    assert "Without a freeze this step would send traffic to a revision whose database is not checked yet" in SHEET


# ── every gcloud command, through the real parser ───────────────────────────────────────────────────────────────────────────────────────────

def _expand(token: str) -> str:
    def repl(m: re.Match) -> str:
        name = m.group(1) or m.group(2)
        assert name in SAMPLE, f"the sheet uses ${name} and nowhere defines it for the reader"
        return SAMPLE[name]
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", repl, token)


def _gcloud_commands() -> list[list[str]]:
    found = []
    inline = [m for m in re.findall(r"`([^`\n]*)`", SHEET) if "gcloud" in m and re.search(r" -{1,2}\w", m)]   # the commands written inside a sentence (a name of a command without flags is not one)
    for block in [*_blocks(), *inline]:
        for line in block.splitlines():
            if "gcloud" not in line:
                continue
            lex = shlex.shlex(line, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""
            toks = list(lex)
            cur: list[str] = []
            for t in [*toks, "|"]:
                if t in {"|", ";", "&&", "||", "(", ")", "$"} or set(t) <= set("|;&()<>$"):
                    if "gcloud" in cur:
                        found.append(cur[cur.index("gcloud"):])
                    cur = []
                else:
                    cur.append(t)
    return found


def test_the_sheet_has_the_gcloud_commands_this_test_parses() -> None:
    cmds = _gcloud_commands()
    verbs = {" ".join(c[1:3]) for c in cmds}
    for must in ("run services", "run jobs", "secrets versions", "compute ssh", "compute instances", "storage ls", "sql instances", "logging read", "compute firewall-rules"):
        assert must in verbs, (must, sorted(verbs))
    assert 40 <= len(cmds) <= 90, len(cmds)


needs_gcloud = pytest.mark.skipif(shutil.which("gcloud") is None, reason="no gcloud on this machine")


@needs_gcloud
@pytest.mark.timeout(900)   # about seventy gcloud starts: each takes a second or more on a busy runner, so they run side by side and the test has a limit of its own
def test_every_gcloud_command_of_the_sheet_parses_in_the_real_gcloud(tmp_path: Path) -> None:
    """no credentials, an empty configuration directory (one per command, so that parallel runs share nothing): «no active account» = the command line is well formed; anything else is printed"""
    from concurrent.futures import ThreadPoolExecutor
    unique: dict[tuple, int] = {}
    for cmd in _gcloud_commands():
        unique.setdefault(tuple(_expand(t) for t in cmd[1:]), len(unique))

    def parse(item: tuple[tuple, int]) -> tuple[str, str] | None:
        argv, n = item
        cfg = tmp_path / f"cfg-{n}"
        cfg.mkdir()
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cfg), "CLOUDSDK_CONFIG": str(cfg), "CLOUDSDK_CORE_DISABLE_PROMPTS": "1", "CLOUDSDK_CORE_PROJECT": "parse-only-project"}
        p = subprocess.run(["gcloud", *argv], capture_output=True, text=True, timeout=300, env=env, cwd=cfg)
        out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
        return None if "do not currently have an active account" in out else (" ".join(argv)[:140], out[:220])

    assert len(unique) >= 40, len(unique)
    with ThreadPoolExecutor(max_workers=6) as pool:
        bad = [r for r in pool.map(parse, unique.items()) if r]
    assert not bad, bad


def test_step_eight_of_the_sheet_gives_the_service_what_the_pipeline_gives_it_when_the_switch_is_on() -> None:
    """the hand command inside the freeze and the dev build after the flip must leave the same service: same socket handling, same tag, same pool"""
    workflow = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    pool = (re.search(r'support_gateway_db_pool_size=(\d+)"', workflow).group(1), re.search(r'support_gateway_db_max_overflow=(\d+)"', workflow).group(1))
    on_branch = CLOUDBUILD.split('if [ "${_SUPPORT_GATEWAY_DB_ON_VM}" = "true" ]; then')[1].split("fi\n        gcloud run deploy")[0]
    assert "--clear-cloudsql-instances" in on_branch and 'GW_SUBNET="support-gateway-${_DEPLOY_ENV}"' in on_branch
    cmd = next(c for c in _gcloud_commands() if c[1:4] == ["run", "services", "update"] and "--clear-cloudsql-instances" in c)
    flags = {c: i for i, c in enumerate(cmd)}
    assert _expand(cmd[flags["--subnet"] + 1]) == "support-gateway-dev" and cmd[flags["--network"] + 1] == "default" and "--network-tags" not in cmd
    env = cmd[flags["--update-env-vars"] + 1]
    assert env == f"SUPPORT_GATEWAY_DB_POOL_SIZE={pool[0]},SUPPORT_GATEWAY_DB_MAX_OVERFLOW={pool[1]}", "the sheet's pool is the workflow's pool"
    assert "--add-cloudsql-instances" not in cmd


# ── what the second review round found (codex, 2026-10-28) ──────────────────────────────────────────────────────────────────────────────────

def _bash_block(starts: str, ends: str) -> str:
    """the lines of the first fenced block that contain `starts`, up to and including the line that contains `ends`"""
    for block in _blocks():
        lines = block.splitlines()
        if any(starts in l for l in lines):
            a = next(i for i, l in enumerate(lines) if starts in l)
            b = next(i for i, l in enumerate(lines) if i >= a and ends in l)
            return "\n".join(lines[a:b + 1])
    raise AssertionError(starts)


def _fake_gcloud_for_step_seven(tmp: Path, *, password: str | None, old_url: str) -> tuple[dict, Path, Path]:
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    calls, added = tmp / "calls.log", tmp / "added.txt"
    calls.write_text("")
    shim = b / "gcloud"
    shim.write_text(
        "#!/bin/sh\n"
        'echo "gcloud $*" >> "$FAKE_CALLS"\n'
        'case "$*" in\n'
        '  *"versions access latest --secret=SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV"*) [ -n "$FAKE_PW_FAIL" ] && exit 1; printf %s "$FAKE_PW" ;;\n'
        '  *"versions access"*"--secret=SUPPORT_GATEWAY_DATABASE_URL_dev"*) printf %s "$FAKE_OLD_URL" ;;\n'
        '  *"versions add"*) cat > "$FAKE_ADDED" ;;\n'
        "esac\n")
    shim.chmod(0o755)
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp), "FAKE_CALLS": str(calls), "FAKE_ADDED": str(added), "FAKE_PW": password or "", "FAKE_PW_FAIL": "1" if password is None else "", "FAKE_OLD_URL": old_url,
           "PROJECT": "p", "OLD_VER": "3", "VMIP": "10.178.0.9"}
    return env, calls, added


def _run_step_seven(tmp: Path, **kw) -> tuple[subprocess.CompletedProcess, list[str], str | None]:
    code = _bash_block("GWPW=$(gcloud secrets versions access latest", "unset GWPW NEWURL")
    env, calls, added = _fake_gcloud_for_step_seven(tmp, **kw)
    p = subprocess.run(["bash", "-c", code], capture_output=True, text=True, timeout=30, env=env, cwd=tmp)
    return p, calls.read_text().splitlines(), (added.read_text() if added.exists() else None)


def test_step_seven_adds_a_version_only_when_every_part_worked_and_never_an_empty_one(tmp_path: Path) -> None:
    ok, calls, added = _run_step_seven(tmp_path, password=PW, old_url=SOCKET_URL)
    assert ok.returncode == 0 and added == "postgresql+asyncpg://support_gw:pa%2Fss%3Aw0rd%40%23x@10.178.0.9:5432/support_gateway"
    assert sum(1 for c in calls if "versions add" in c) == 1 and PW not in "\n".join(calls), "one version, and the password is in no argument list"
    assert "STOP" not in ok.stdout and PW not in ok.stdout + ok.stderr
    for n, case in enumerate([dict(password=None, old_url=SOCKET_URL), dict(password="", old_url=SOCKET_URL),
                              dict(password=PW, old_url="postgresql+asyncpg://other_role:x@/support_gateway?host=/cloudsql/p:r:i"), dict(password=PW, old_url="")]):
        (tmp_path / f"c{n}").mkdir()
        p, calls, added = _run_step_seven(tmp_path / f"c{n}", **case)
        assert not any("versions add" in c for c in calls), f"case {n}: no version may be added"
        assert added is None and "STOP" in p.stdout, (n, p.stdout, p.stderr)
        assert PW not in p.stdout + p.stderr


def _program_between(marker_start: str, marker_end: str) -> str:
    i = SHEET.index(marker_start) + len(marker_start)
    return SHEET[i:SHEET.index(marker_end, i)]


def _probe_program() -> str:
    return _program_between("PROBE='^@^-c@", "@'\"$VMIP\"")


@pytest.mark.parametrize("name,exit_code,word", [("0", 0, "REACHED"), ("ECONNREFUSED", 4, "REFUSED"), ("EAGAIN", 3, "TIMEOUT"), ("ETIMEDOUT", 3, "TIMEOUT"),
                                                  ("EHOSTUNREACH", 5, "OTHER"), ("ENETUNREACH", 5, "OTHER"), ("EPERM", 5, "OTHER")])
def test_the_probe_of_the_sheet_tells_a_dropped_packet_from_a_refusal_and_from_a_missing_route(tmp_path: Path, name: str, exit_code: int, word: str) -> None:
    (tmp_path / "socket.py").write_text("import errno, os\n\nclass socket:\n    def settimeout(self, t):\n        pass\n    def connect_ex(self, addr):\n        assert addr[1] == 5432\n        n = os.environ['FAKE_ERRNO']\n        return 0 if n == '0' else getattr(errno, n)\n")
    p = subprocess.run(["python3", "-c", _probe_program(), "10.178.0.9"], capture_output=True, text=True, timeout=30, env={"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(tmp_path), "FAKE_ERRNO": name})
    assert p.returncode == exit_code and p.stdout.split()[0] == "result" and p.stdout.split()[-1] == word, (p.stdout, p.stderr)


def test_the_probe_and_the_negative_control_lines_of_the_sheet_are_the_runbooks_word_for_word() -> None:
    rb = RUNBOOK.split("**Step 3b")[1].split("```bash\n")[1].split("```")[0]
    assert _probe_program() == rb.split("PROBE='^@^-c@")[1].split("@'\"$VMIP\"")[0], "the two documents carry one program"
    block2a = SHEET.split("**2a. Negative")[1].split("```\n")[1]
    rb_lines = [l.split("   #")[0] for l in rb.splitlines()]   # a trailing comment is not part of the command
    for line in block2a.splitlines():
        if line.startswith("```") or not line.strip():
            break
        assert line.split("   #")[0] in rb_lines, f"the sheet's 2a line is not in RUNBOOK step 3b: {line[:100]}"
    for line in rb.splitlines():
        if line.startswith(("PROBE=", "gcloud iam", "[ \"$SA_MADE", "[ \"$JOB_MADE", "for n in")):
            assert line.split("   #")[0] in [l.split("   #")[0] for l in SHEET.splitlines()], f"the runbook's line is not in the sheet: {line[:100]}"


def _run_sheet_block(block: str, tmp_path: Path, extra_env: dict[str, str], fail: dict[str, bool]) -> tuple[subprocess.CompletedProcess, list[str]]:
    """a block of the sheet as written, against a fake gcloud that records its calls (`fail`: iam, job, tagged_ok)"""
    import stat
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    calls = tmp_path / "calls.log"
    calls.write_text("")
    g = b / "gcloud"
    g.write_text(
        "#!/bin/sh\n"
        'echo "gcloud $*" >> "$CALLS"\n'
        'case "$*" in\n'
        '  "iam service-accounts create"*) [ -n "$F_IAM" ] && exit 1 ;;\n'
        '  "run jobs create"*) [ -n "$F_JOB" ] && exit 1 ;;\n'
        '  "run jobs execute"*) case "$*" in *gwsubnet-*) exit 0 ;; *) exit 1 ;; esac ;;\n'
        '  "logging read"*) case "$*" in *probe-gwsubnet*) echo "result 0 REACHED" ;; *) echo "result 11 TIMEOUT" ;; esac ;;\n'
        "esac\nexit 0\n")
    g.chmod(g.stat().st_mode | stat.S_IEXEC)
    slp = b / "sleep"
    slp.write_text('#!/bin/sh\necho sleep >> "$CALLS"\n')
    slp.chmod(slp.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "CALLS": str(calls), "F_IAM": "1" if fail.get("iam") else "", "F_JOB": "1" if fail.get("job") else "",
           **{k: v for k, v in SAMPLE.items() if k in ("PROJECT", "REGION", "ZONE", "ENV", "VM", "GW", "GWSA", "VMIP", "GWIMG", "STAMP", "PROBESA_ID", "PROBESA", "PJU", "PJG", "PJU2", "CHK", "PROBE")}, **extra_env}
    p = subprocess.run(["bash", "-c", block], capture_output=True, text=True, timeout=30, env=env, cwd=tmp_path)
    return p, calls.read_text().splitlines()


def _fence_after(marker: str) -> str:
    return SHEET.split(marker)[1].split("```\n")[1].split("```")[0]


def _n(calls: list[str], prefix: str) -> int:
    return sum(1 for c in calls if c.startswith(prefix))


def test_step_2a_cleans_up_after_the_expected_failure_and_does_nothing_after_a_create_that_failed(tmp_path: Path) -> None:
    block = _fence_after("**2a. Negative")
    p, calls = _run_sheet_block(block, tmp_path, {}, {})
    assert p.returncode == 0 and "result 11 TIMEOUT" in p.stdout
    assert _n(calls, "gcloud run jobs execute gwdb-probe-untagged-") == 1 and _n(calls, "gcloud run jobs delete gwdb-probe-untagged-") == 1, "the execute fails by design; the job is still deleted"
    (tmp_path / "a").mkdir()
    p2, calls2 = _run_sheet_block(block, tmp_path / "a", {}, {"iam": True})
    assert _n(calls2, "gcloud run jobs") == 0, "an account that could not be made: no job, no execute, no delete"
    (tmp_path / "b").mkdir()
    p3, calls3 = _run_sheet_block(block, tmp_path / "b", {}, {"job": True})
    assert _n(calls3, "gcloud run jobs create") == 1 and _n(calls3, "gcloud run jobs execute") == 0 and _n(calls3, "gcloud run jobs delete") == 0


def test_step_2b_reads_reached_for_the_job_on_the_gateway_subnet_and_timeout_for_the_one_on_the_default_subnet_and_removes_the_account(tmp_path: Path) -> None:
    block = _fence_after("**2b. Positive")
    p, calls = _run_sheet_block(block, tmp_path, {"SA_MADE": "gwdb-probe-10281200001234"}, {})
    assert p.returncode == 0 and "on the gateway subnet: gcloud status 0" in p.stdout
    lines = [l for l in p.stdout.splitlines() if l.startswith("result")]
    assert lines == ["result 0 REACHED", "result 11 TIMEOUT"], lines
    assert _n(calls, "gcloud run jobs delete gwdb-probe-gwsubnet-") == 1 and _n(calls, "gcloud run jobs delete gwdb-probe-untagged2-") == 1 and _n(calls, "gcloud iam service-accounts delete gwdb-probe-") == 1
    created_gw = next(c for c in calls if c.startswith("gcloud run jobs create gwdb-probe-gwsubnet-"))
    created_default = next(c for c in calls if c.startswith("gcloud run jobs create gwdb-probe-untagged2-"))
    assert "--subnet support-gateway-dev" in created_gw and "--subnet default" in created_default and "--network-tags" not in created_gw + created_default
    (tmp_path / "x").mkdir()
    p2, calls2 = _run_sheet_block(block, tmp_path / "x", {}, {})   # the account was never made in this shell: nothing is created and nothing is deleted
    assert _n(calls2, "gcloud run jobs") == 0 and _n(calls2, "gcloud iam") == 0 and _n(calls2, "gcloud logging") == 0, "and no log is read"


def test_the_database_check_job_is_only_deleted_when_this_run_made_it(tmp_path: Path) -> None:
    block = _fence_after("The database-backed check")
    p, calls = _run_sheet_block(block, tmp_path, {"CHK": "gwdb-check-10281200001234"}, {})
    assert "database check: exit 1" in p.stdout or "database check: exit 0" in p.stdout
    assert _n(calls, "gcloud run jobs create gwdb-check-") == 1 and _n(calls, "gcloud run jobs delete gwdb-check-") == 1
    (tmp_path / "y").mkdir()
    p2, calls2 = _run_sheet_block(block, tmp_path / "y", {}, {"job": True})
    assert _n(calls2, "gcloud run jobs execute") == 0 and _n(calls2, "gcloud run jobs delete") == 0, "a job that could not be made is neither executed nor deleted"


def test_the_new_url_program_refuses_an_empty_password_even_if_the_shell_guard_were_missing() -> None:
    p = _py(_program('os.environ["GWPW"]'), SOCKET_URL, "10.178.0.9", env={"GWPW": ""})
    assert p.returncode != 0 and p.stdout == "" and "no password" in p.stderr
    q = _py(_program('os.environ["GWPW"]'), SOCKET_URL, "10.178.0.9")
    assert q.returncode != 0 and q.stdout == ""


def test_the_probe_target_is_checked_before_a_job_is_made() -> None:
    assert '[ -n "$VMIP" ] || echo "STOP: no address to probe (VMIP is empty) - nothing is made below"' in SHEET and '[ -n "$VMIP" ] && gcloud iam service-accounts create $PROBESA_ID' in SHEET


def test_the_database_check_program_reads_the_url_from_the_environment_and_fails_when_the_connection_fails(tmp_path: Path) -> None:
    prog = _program_between("CHECK='^@^-c@", "'\nCHK=gwdb-check")
    fake = tmp_path / "asyncpg.py"
    fake.write_text("import os\nasync def connect(dsn, timeout=None):\n    open(os.environ['SEEN'], 'w').write(dsn + '|' + str(timeout))\n    if os.environ.get('REFUSE'):\n        raise OSError('refused')\n")
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(tmp_path), "SEEN": str(tmp_path / "seen"), "SUPPORT_GATEWAY_DATABASE_URL": "postgresql+asyncpg://support_gw:pw@10.178.0.9:5432/support_gateway"}
    ok = subprocess.run(["python3", "-c", prog], capture_output=True, text=True, timeout=30, env=env)
    assert ok.returncode == 0 and ok.stdout.strip() == "connected"
    assert (tmp_path / "seen").read_text() == "postgresql://support_gw:pw@10.178.0.9:5432/support_gateway|10", "the driver prefix is taken off for asyncpg and the wait is bounded"
    bad = subprocess.run(["python3", "-c", prog], capture_output=True, text=True, timeout=30, env={**env, "REFUSE": "1"})
    assert bad.returncode != 0 and "connected" not in bad.stdout


def test_the_database_is_checked_with_the_new_secret_before_the_unfreeze() -> None:
    step8 = SHEET.split("## 8. The gateway service on the VM's database")[1].split("## 9.")[0]
    assert "--set-secrets SUPPORT_GATEWAY_DATABASE_URL=SUPPORT_GATEWAY_DATABASE_URL_dev:latest" in step8 and "--subnet support-gateway-$ENV" in step8 and "--network-tags" not in step8
    assert "The gateway's own health path answers 200 without touching the database, so it proves nothing here" in step8
    assert "**Pass: `database check: exit 0` and `check job deleted`.**" in step8 and "step 12 (the way back)" in step8
    assert "database-backed check" in SHEET.split("| 8 |")[1].split("\n")[0]


def test_the_freeze_waits_for_the_request_timeout_because_a_message_commits_after_the_model_call() -> None:
    freeze = SHEET.split("## 4. Freeze")[1].split("## 5.")[0]
    assert "value(spec.template.spec.timeoutSeconds)" in freeze and "sleep $((TMO + 10))" in freeze
    assert "flushes its rows before the model call and commits after it" in freeze and "**The freeze is the IAM binding, not the ingress setting**" in freeze and "`--ingress internal` lets in the requests of the same project's VPC" in freeze


def test_no_dev_build_can_start_between_step_four_and_step_eleven() -> None:
    g4 = SHEET.split("| **G4. ")[1].split("\n")[0]
    for token in ("gh workflow disable cloud-build.yml", "gh run list --limit 200 --json databaseId,status,workflowName,headBranch", 'select(.status != \"completed\" and .workflowName == \"Cloud Build (GCP)\")', "leaves a disabled workflow out", "gh run cancel <id>", "--ongoing --limit 200", "even an old, queued one, or one started by hand"):
        assert token in g4, token
    step11 = SHEET.split("## 11. ")[1].split("## 12.")[0]
    assert "gh workflow enable cloud-build.yml" in step11 and step11.index("gh workflow enable") < step11.index("The agent opens a pull request")
    assert "would\nput the Cloud SQL socket back" in step11


def test_the_sheet_blocks_survive_errexit_and_read_no_log_of_a_job_they_did_not_make(tmp_path: Path) -> None:
    import stat
    block = _fence_after("**2a. Negative")
    p, calls = _run_sheet_block(block, tmp_path, {}, {})
    # the same block under `bash -e`: the expected failure of the execute must not end the shell before the cleanup
    b = tmp_path / "bin"
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "CALLS": str(tmp_path / "calls.log"), "F_IAM": "", "F_JOB": "",
           **{k: v for k, v in SAMPLE.items() if k in ("PROJECT", "REGION", "ZONE", "ENV", "VM", "GW", "GWSA", "VMIP", "GWIMG", "STAMP", "PROBESA_ID", "PROBESA", "PJU", "PJG", "PJU2", "CHK", "PROBE")}}
    (tmp_path / "calls.log").write_text("")
    q = subprocess.run(["bash", "-e", "-c", block], capture_output=True, text=True, timeout=30, env=env, cwd=tmp_path)
    assert q.returncode == 0 and _n((tmp_path / "calls.log").read_text().splitlines(), "gcloud run jobs delete gwdb-probe-untagged-") == 1, q.stderr
    (tmp_path / "n").mkdir()
    p2, calls2 = _run_sheet_block(block, tmp_path / "n", {}, {"job": True})
    assert _n(calls2, "gcloud logging read") == 0 and _n(calls2, "sleep") == 0, "no job made: no log read"
    (tmp_path / "e").mkdir()
    p3, calls3 = _run_sheet_block(block, tmp_path / "e", {"VMIP": ""}, {})
    assert _n(calls3, "gcloud iam") == 0 and _n(calls3, "gcloud run jobs") == 0, "an empty address: nothing is made"


def test_the_database_check_job_runs_where_the_service_will_run_with_the_gateways_own_account_and_the_new_secret() -> None:
    block = _fence_after("The database-backed check")
    create = next(l for l in block.splitlines() if "gcloud run jobs create" in l)
    assert "--network default --subnet support-gateway-$ENV" in create and "--subnet default" not in create, "on the gateway's subnet: that is what the check proves (the firewall rule, the access rules, the URL)"
    assert "--service-account $GWSA" in create and "--service-account $PROBESA" not in create, "the gateway's own account: it reads the secret"
    assert "--set-secrets SUPPORT_GATEWAY_DATABASE_URL=SUPPORT_GATEWAY_DATABASE_URL_dev:latest" in create and "--network-tags" not in create


def test_the_way_back_is_the_exact_inverse_of_step_eight_for_the_socket_the_subnet_and_the_pool() -> None:
    step8 = next(c for c in _gcloud_commands() if c[1:4] == ["run", "services", "update"] and "--clear-cloudsql-instances" in c)
    back = next(c for c in _gcloud_commands() if c[1:4] == ["run", "services", "update"] and "--add-cloudsql-instances" in c)
    f8, fb = {t: i for i, t in enumerate(step8)}, {t: i for i, t in enumerate(back)}
    assert _expand(step8[f8["--subnet"] + 1]) == "support-gateway-dev" and back[fb["--subnet"] + 1] == "default", "the service goes back to the default subnet"
    assert back[fb["--network"] + 1] == "default" and "--network-tags" not in back and "--clear-network-tags" not in back
    assert _expand(back[fb["--add-cloudsql-instances"] + 1]) == "sprintable-494803:asia-northeast3:sprintable-dev", "and gets Cloud SQL's socket back, the instance the pipeline names"
    pool8 = [kv.split("=")[0] for kv in step8[f8["--update-env-vars"] + 1].split(",")]
    poolb = back[fb["--remove-env-vars"] + 1].split(",")
    assert sorted(pool8) == sorted(poolb), "exactly the variables step 8 set are removed"
    assert "SUPPORT_GATEWAY_DB_POOL_SIZE=3" in step8[f8["--update-env-vars"] + 1]


def test_step_five_of_the_window_names_a_candidate_built_after_the_merge_and_why() -> None:
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    g1 = next(l for l in sheet.splitlines() if l.startswith("| **G1."))
    assert "Step 5 deploys a candidate built after D2" in g1 and "start gate on the metadata rule" in g1 and "keeps the rule first" in g1 and "not put in `desired.json`" in g1


def test_the_runbook_says_the_deployer_asks_iptables_itself_and_asks_again_on_the_way_back() -> None:
    rb = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    for token in ("a hand-run `deployer.py --force` included) it also asks `iptables` itself whether that rule is the **first** rule of `DOCKER-USER`", "the firewall script puts the rule first and removes copies further down",
                  "the way back to the previous release and the settling of a dead swap included, and the container is stopped when the metadata server answers"):
        assert token in rb, token


def test_the_freeze_is_measured_from_the_vm_too_and_the_build_list_is_part_of_the_gate() -> None:
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    freeze = sheet.split("## 4. Freeze")[1].split("## 5.")[0]
    assert "measured from the VM too, not assumed" in freeze and "a **200** there means the backend still reaches the gateway: stop, put the binding back and do not restore" in freeze
    g4 = next(l for l in sheet.splitlines() if l.startswith("| **G4."))
    assert "gcloud builds list --project $PROJECT --ongoing --limit 200" in g4 and "already SUBMITTED keeps running" in g4 and "gcloud builds cancel $BUILD_ID --project $PROJECT" in g4


def test_the_way_back_waits_for_requests_in_flight_before_it_points_the_service_at_cloud_sql() -> None:
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    back = sheet.split("## 12. The way back")[1]
    block = back.split("```\n")[1]
    lines = [l for l in block.splitlines() if l.strip()]
    i_freeze = next(i for i, l in enumerate(lines) if "remove-iam-policy-binding" in l)
    i_wait = next(i for i, l in enumerate(lines) if "sleep $((TMO + 10))" in l)
    i_repoint = next(i for i, l in enumerate(lines) if "--add-cloudsql-instances" in l)
    i_open = next(i for i, l in enumerate(lines) if "add-iam-policy-binding" in l)
    assert i_freeze < i_wait < i_repoint < i_open, (i_freeze, i_wait, i_repoint, i_open)
    assert "The pipeline does not take the two pool variables off again" in back


def test_each_line_of_the_way_back_runs_only_when_the_one_before_it_succeeded_and_a_failure_leaves_the_service_frozen() -> None:
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    back = sheet.split("## 12. The way back")[1]
    block = back.split("```\n")[1]
    assert "BACK=no" in block
    for gate, step in (('[ "$BACK" = frozen ]', "sleep $((TMO + 10))"), ('[ "$BACK" = waited ]', "gcloud secrets versions add"), ('[ "$BACK" = secret ]', "--add-cloudsql-instances"), ('[ "$BACK" = repointed ]', "add-iam-policy-binding")):
        line = next(l for l in block.splitlines() if step in l)
        assert line.startswith(gate), (gate, line[:80])
    assert "&& BACK=frozen" in block and "&& BACK=waited" in block and "&& BACK=secret" in block and "&& BACK=repointed" in block
    assert "leaves the service **frozen**" in back and "runs only after the service points at Cloud SQL again" in back


def _run_way_back(tmp_path: Path, fail: str = "", tmo: str = "300", shell: str = "bash") -> tuple[subprocess.CompletedProcess, list[str]]:
    """the block of step 12, as written, against a fake gcloud that fails on the call whose text contains `fail`; `sleep` does not wait"""
    import stat
    block = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text().split("## 12. The way back")[1].split("```\n")[1]
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text('#!/bin/sh\necho "gcloud $*" >> "$CALLS"\n[ -n "$FAIL" ] && case "$*" in *"$FAIL"*) exit 1 ;; esac\ncase "$*" in *"services describe"*) printf %s "$TMO" ;; *"secrets versions access"*) printf %s "postgresql://u@h/d" ;; esac\nexit 0\n')
    sl = b / "sleep"
    sl.write_text('#!/bin/sh\necho "sleep $*" >> "$CALLS"\n')
    for f in (g, sl):
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    calls = tmp_path / "calls"
    calls.write_text("")
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp_path), "CALLS": str(calls), "FAIL": fail, "TMO": tmo, "GW": "gw", "PROJECT": "p", "REGION": "r", "ENV": "dev", "OLD_VER": "3"}
    p = subprocess.run([shell, "-c", block], capture_output=True, text=True, timeout=60, env=env)
    return p, calls.read_text().splitlines()


def _did(calls: list[str], text: str) -> bool:
    return any(text in c for c in calls)


def test_the_way_back_goes_all_the_way_when_every_line_succeeds(tmp_path: Path) -> None:
    p, calls = _run_way_back(tmp_path)
    assert p.returncode == 0 and "STOP" not in p.stdout, p.stderr
    order = [next(i for i, c in enumerate(calls) if t in c) for t in ("remove-iam-policy-binding", "sleep 310", "secrets versions add", "--add-cloudsql-instances", "add-iam-policy-binding")]
    assert order == sorted(order), calls


@pytest.mark.parametrize("fail,must_not", [
    ("remove-iam-policy-binding", ["sleep", "secrets versions", "--add-cloudsql-instances", "add-iam-policy-binding"]),
    ("secrets versions access", ["secrets versions add", "--add-cloudsql-instances", "add-iam-policy-binding"]),
    ("secrets versions add", ["--add-cloudsql-instances", "add-iam-policy-binding"]),
    ("--add-cloudsql-instances", ["add-iam-policy-binding"]),
])
def test_a_line_of_the_way_back_that_fails_leaves_the_service_frozen(tmp_path: Path, fail: str, must_not: list[str]) -> None:
    p, calls = _run_way_back(tmp_path, fail=fail)
    for t in must_not:
        assert not _did(calls, t), (fail, t, calls)
    assert not _did([c for c in calls if "remove-iam-policy-binding" not in c], "add-iam-policy-binding") or fail == ""


def test_a_request_timeout_that_cannot_be_read_stops_the_way_back_before_the_secret(tmp_path: Path) -> None:
    p, calls = _run_way_back(tmp_path, tmo="")
    assert not _did(calls, "secrets versions") and not _did(calls, "--add-cloudsql-instances") and not _did(calls, "add-iam-policy-binding")


def test_the_workflow_name_the_gate_filters_on_is_the_name_of_the_workflow_file() -> None:
    name = next(l for l in (_ROOT / ".github/workflows/cloud-build.yml").read_text().splitlines() if l.startswith("name:"))[len("name:"):].strip()
    assert f'.workflowName == "{name}"' in SHEET.split("| **G4. ")[1].split("\n")[0]


def test_the_wait_of_the_freeze_is_a_command_in_a_fenced_block_not_only_prose() -> None:
    sheet = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    freeze = sheet.split("## 4. Freeze")[1].split("## 5.")[0]
    blocks = [b for i, b in enumerate(freeze.split("```\n")) if i % 2 == 1]
    assert len(blocks) == 2 and "remove-iam-policy-binding" in blocks[0] and "sleep" not in blocks[0]
    assert '[ -n "$TMO" ] && sleep $((TMO + 10)) && date -u +%FT%TZ' in blocks[1], "a PO who follows the fenced commands waits the request timeout and only then gets T0"
    assert freeze.index("```\n" + blocks[1]) > freeze.index("measured from the VM too"), "the wait comes after both measurements"


def test_the_flip_pr_is_followed_by_a_build_started_by_hand_because_a_merge_to_develop_starts_none() -> None:
    wf = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    on = wf.split("\non:")[1].split("\nconcurrency:")[0]
    assert "branches: [main]" in on and "develop" not in "\n".join(l for l in on.splitlines() if not l.strip().startswith("#")), "the premise: no push trigger on develop"
    step11 = SHEET.split("## 11. ")[1].split("## 12.")[0]
    assert "**Merging does not start a build**" in step11 and "gh workflow run cloud-build.yml --ref develop" in step11 and "`completed` and `success`" in step11
    assert step11.index("gh workflow run cloud-build.yml --ref develop") < step11.index("run.googleapis.com/cloudsql-instances"), "the checks of the job come after the build has finished"


def test_the_check_job_with_the_gateways_account_is_proved_deleted_before_the_unfreeze() -> None:
    step8 = SHEET.split("## 8. ")[1].split("## 9.")[0]
    assert "&& CHK_GONE=$CHK" in step8 and 'echo "check job deleted"' in step8 and "STOP: the check job is still there" in step8
    assert "`database check: exit 0` and `check job deleted`" in step8 and "the residents check of step 11 would name it too" in step8


def test_the_gate_does_not_cancel_prod_runs_of_the_same_workflow_and_the_wait_after_the_flip_names_its_branch() -> None:
    g4 = SHEET.split("| **G4. ")[1].split("\n")[0]
    assert '"\\(.databaseId) \\(.headBranch)"' in g4 and "A line of the branch `main` is a PROD run" in g4 and "not cancelled but waited for" in g4
    step11 = SHEET.split("## 11. ")[1].split("## 12.")[0]
    assert "gh run list --workflow cloud-build.yml --branch develop --event workflow_dispatch --limit 1" in step11


_ZSH_MODIFIER = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*:[$A-Za-z{]")


@pytest.mark.parametrize("doc", ["RUNBOOK.md", "REMOVALS-dev.md", "CUTOVER-gateway-dev.md"])
def test_no_code_block_of_the_operator_documents_has_a_variable_followed_by_a_colon_and_a_word(doc: str) -> None:
    """zsh (the PO's shell) reads `$VAR:x` as a history-style modifier and stops with «bad substitution»: write `${VAR}:x` (found by the security domain's scan of the three documents)"""
    text = (_ROOT / "deploy/vm" / doc).read_text()
    hits = [l.strip()[:120] for b in re.findall(r"```[a-z]*\n(.*?)```", text, re.S) for l in b.splitlines() if _ZSH_MODIFIER.search(l) and not l.lstrip().startswith("#")]
    assert hits == [], hits


def test_the_new_secret_is_not_added_when_the_address_of_the_vm_is_empty() -> None:
    import subprocess as sp
    block = SHEET.split("GWPW=$(gcloud secrets versions access latest")[1].split("unset GWPW NEWURL")[0]
    program = re.search(r"python3 -c '(.*?)' \"\$VMIP\"\)", block, re.S).group(1)
    ok = sp.run(["python3", "-c", program, "10.1.2.3"], input="postgresql+asyncpg://support_gw:old@10.9.9.9:5432/support_gateway", capture_output=True, text=True, env={"GWPW": "pw", "PATH": os.environ.get("PATH", "")})
    empty = sp.run(["python3", "-c", program, ""], input="postgresql+asyncpg://support_gw:old@10.9.9.9:5432/support_gateway", capture_output=True, text=True, env={"GWPW": "pw", "PATH": os.environ.get("PATH", "")})
    assert ok.returncode == 0 and "@10.1.2.3:5432/support_gateway" in ok.stdout
    assert empty.returncode != 0 and empty.stdout == "" and "no address" in empty.stderr


def test_the_runbook_has_the_read_only_look_at_the_chain_before_the_window_opens() -> None:
    rb = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    row4 = next(l for l in rb.splitlines() if l.startswith("| 4 | re-run `bootstrap.sh`"))
    assert "sudo iptables -S DOCKER-USER" in row4 and "-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb -j DROP" in row4 and "BEFORE step 5, not in its window" in row4


# ── what the first real run of the sheet found (2026-10-28): three defects, now written down ──

def test_the_freeze_is_the_public_invoker_binding_not_the_ingress_setting_in_every_place_it_is_made_or_undone() -> None:
    assert "--ingress" not in "\n".join(l for b in _blocks() for l in b.splitlines() if "gcloud run services update $GW" in l and "--clear-cloudsql-instances" not in l), "no block freezes or unfreezes by ingress"
    for where in ("## 4. Freeze", "## 9. Unfreeze", "## 12. The way back"):
        sec = SHEET.split(where)[1].split("\n## ")[0]
        assert "roles/run.invoker" in sec and "--member=allUsers" in sec, where
    assert "remove-iam-policy-binding" in SHEET.split("## 4. Freeze")[1].split("## 5.")[0] and "add-iam-policy-binding" in SHEET.split("## 9. Unfreeze")[1].split("## 10.")[0]


def test_the_sheet_measures_the_freeze_on_a_path_cloud_run_does_not_answer_itself() -> None:
    assert "/healthz" not in "\n".join(l for b in _blocks() for l in b.splitlines()), "Cloud Run reserves the paths ending in z and answers them with its own 404"
    freeze = SHEET.split("## 4. Freeze")[1].split("## 5.")[0]
    assert '"$GWURL/openapi.json"' in freeze and "Cloud Run reserves the paths that end in a `z`" in freeze and "prints **403**" in freeze


def test_the_cloud_sql_check_reads_the_value_not_the_key() -> None:
    for where, cmd in (("## 8. ", "gcloud run services describe $GW"), ("## 11. ", "gcloud run jobs describe $GWJOB")):
        sec = SHEET.split(where)[1].split("\n## ")[0]
        line = next(l for l in sec.splitlines() if l.startswith(cmd) and "cloudsql-instances" in l)
        assert "--format=json" in line and 'len(a.get("run.googleapis.com/cloudsql-instances", ""))' in line and "grep -c" not in line, (where, line)
    import subprocess as sp
    prog = re.search(r"python3 -c '(.*?)'", next(l for l in SHEET.splitlines() if l.startswith("gcloud run services describe $GW") and "cloudsql-instances" in l)).group(1)
    empty = sp.run(["python3", "-c", prog], input='{"spec": {"template": {"metadata": {"annotations": {"run.googleapis.com/cloudsql-instances": ""}}}}}', capture_output=True, text=True)
    full = sp.run(["python3", "-c", prog], input='{"spec": {"template": {"metadata": {"annotations": {"run.googleapis.com/cloudsql-instances": "p:r:i"}}}}}', capture_output=True, text=True)
    none = sp.run(["python3", "-c", prog], input='{"spec": {"template": {"metadata": {}}}}', capture_output=True, text=True)
    assert (empty.stdout.strip(), full.stdout.strip(), none.stdout.strip()) == ("0", "5", "0"), "an annotation left with an empty value reads 0 (the old check counted the key and printed 1)"
