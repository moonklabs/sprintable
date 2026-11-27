"""story 4796 AC4 - deploy/vm/CUTOVER-prod.md: the prod cutover sheet, pinned.

The sheet is the dev move with prod's names and the lessons of the dev run (the freeze is the IAM binding; the path is /openapi.json; the dependents are read, not assumed; ladders of lines that run only when the one before succeeded; the cloudsql check reads a value).
Here: the decisions the product owner made (2026-10-28) are in the text; the names agree with the declaration and the scripts they name; no block uses what dev showed to be wrong; every gcloud command goes through the REAL parser
(tests/_real_gcloud.py); the ladders are run as written (bash and zsh) against a fake gcloud and a failing line leaves the services frozen; the read-only blocks are run and write nothing.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

from tests import _real_gcloud as _gcloud

_ROOT = Path(__file__).resolve().parents[2]
SHEET = (_ROOT / "deploy/vm/CUTOVER-prod.md").read_text()
PROD = yaml.safe_load((_ROOT / "deploy/vm/env/prod.yaml").read_text())

SAMPLE = {"PROJECT": "sprintable-494803", "REGION": "asia-northeast3", "ZONE": "asia-northeast3-a", "ENV": "prod", "VM": "sprintable-vm-prod", "SQL": "sprintable-prod",
          "DEPLOY_BUCKET": "sprintable-vm-prod-deploy", "BACKUPS_BUCKET": "sprintable-vm-prod-backups", "BACKEND": "sprintable-backend-prod", "FRONTEND": "sprintable-frontend-prod",
          "MCP": "sprintable-mcp-prod", "API_HOST": "api.sprintable.ai", "APP_HOST": "app.sprintable.ai", "VMIP": "34.64.1.2", "SRC_IP": "10.110.0.3", "svc": "sprintable-backend-prod",
          "job": "sprintable-sched-prod", "JOB": "sprintable-sched-prod", "NAME": "some-job", "r": "services", "n": "sprintable-backend-prod", "TMO": "300", "BURL": "https://x.run.app", "FROZEN": "yes",
          "uri": "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app/api/v2/internal/cron/x", "new": "https://api.sprintable.ai/api/v2/internal/cron/x", "out": "", "CODE": "403",
          "WINDOW": "20261102", "VMBACK": "passing", "id": "JWT_SECRET_PROD", "b": "sprintable-vm-prod-backups", "route": "refresh", "path": "desktop/setup-codes", "m": "allUsers", "names": "a b", "d": "{}", "pol": "{}", "svcs": "a", "left": "0", "REPO": "/repo", "FWD_SA": "sprintable-forwarder-prod", "REH": "sprintable-rehearsal-forwarder", "REHID": "r20261029120000", "NET": "default", "SUBNET": "default", "TAGS": "egress-tag", "FWD_IMAGE": "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable/sprintable-forwarder@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "FWD_TAG": "fwd", "FWD_BUILD": "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable/sprintable-forwarder:20261102", "FWDREV": "sprintable-backend-prod-fwd-20261102", "REAL": "sprintable-backend-prod-00042-abc", "REALBACK": "proven", "FINAL_DUMP": "/srv/sprintable/import/prod-final-1.dump", "FINAL_COUNTS": "/srv/sprintable/import/prod-final-1.counts.tsv"}


def _blocks() -> list[str]:
    return re.findall(r"```\n(.*?)```", SHEET, flags=re.S)


def _block_with(marker: str) -> str:
    found = [b for b in _blocks() if marker in b]
    assert len(found) == 1, (marker, len(found))
    return found[0]


def _section(title: str, until: str) -> str:
    return SHEET.split(title)[1].split(until)[0]


# ── the text: what was decided, in the order of the sheet ───────────────────────────────────────────────────────────────────────────────────

def test_the_sheet_has_every_step_of_the_order_in_order() -> None:
    heads = ["## What dev taught, applied here", "## Names (prod)", "## Decisions already made", "## The order", "## G. Gates", "## 0. Read-only", "## 1. Rehearsal", "## 2. The notice",
             "## 3. Phase 1", "## 4. Phase 2", "## 5. Freeze", "## 6–7. The data and the takeover", "## 8. Unfreeze", "## 9. The lap", "## 10–11. The day after", "## 12. The way back", "## Questions for the owner"]
    pos = [SHEET.index(h) for h in heads]
    assert pos == sorted(pos), "the headings are in the order of the move"
    table = _section("## The order", "## G. Gates")
    for step in ("| G |", "| 0 |", "| 1 |", "| 2 |", "| 3 |", "| 4 |", "| 5 |", "| 6 |", "| 7 |", "| 8 |", "| 9 |", "| 10 |", "| 11 |", "| 12 |"):
        assert step in table, step


def test_the_decisions_of_the_product_owner_are_in_the_text() -> None:
    d = _section("## Decisions already made", "## The order")
    for token in ("**03:00–05:00 KST (18:00–20:00 UTC of the day before)**", "about 3,000–3,300 per hour in every Korean hour", "peak about 4,150", "Machine traffic does not go away at night",
                  "**The announcement is a notice, not a request for approval**", "Rollback loses what the VM wrote after the cutover", "**Fix forward first**", "**No prod support gateway in this move.**",
                  "**4789**", "**closes with this move**", "a **deploy gap**", "68 s"):
        assert token in d, token


def test_the_window_in_utc_is_the_window_in_kst_minus_nine_hours() -> None:
    from datetime import datetime, timedelta, timezone
    kst = timezone(timedelta(hours=9))
    start = datetime(2026, 11, 2, 3, 0, tzinfo=kst).astimezone(timezone.utc)
    end = datetime(2026, 11, 2, 5, 0, tzinfo=kst).astimezone(timezone.utc)
    assert (start.hour, end.hour) == (18, 20) and start.day == 1 and end.day == 1, "03:00-05:00 KST is 18:00-20:00 UTC of the day before"
    assert "(18:00–20:00 UTC of the day before)" in SHEET


def test_the_lessons_of_the_dev_run_are_each_written_down() -> None:
    lessons = _section("## What dev taught, applied here", "## Names (prod)")
    for token in ("The freeze is the IAM binding, not the ingress setting", "lets in the requests of the same project's VPC, and the VM is in it", "The measurement path is `/openapi.json`", "Cloud Run reserves the paths that end in a `z`",
                  "is read, not assumed", "**«I do not know» is a stop, not a yes.**", "A line runs only when the one before it succeeded", "reads the value of `cloudsql-instances`, not the key",
                  "«lists no table data — refusing»", "A sheet's first real run always finds something"):
        assert token in lessons, token


def test_what_the_sheet_leaves_out_is_said() -> None:
    assert "**Not in this move:** the support gateway" in SHEET and "Cloud SQL prod is **not deleted** here" in SHEET
    assert "A number nobody has measured is written «unmeasured», never guessed." in SHEET
    q = _section("## Questions for the owner", "\x00") if "\x00" in SHEET else SHEET.split("## Questions for the owner")[1]
    assert q.count("\n1. ") == 1 and "\n4. " in q, "four one-line questions"


def test_the_downtime_is_computed_from_the_rehearsal_not_promised() -> None:
    rehearsal = _section("## 1. Rehearsal", "## 2. The notice")
    for token in ("**The window is computed, not promised:**", "dump 45 s for 252 tables and 295 MB", "4 min 44 s", "scaled by prod's size ratio", "the number goes into the notice only after the rehearsal has produced it",
                  "If it does not fit in 03:00–05:00 KST with margin, the window is not used."):
        assert token in rehearsal, token
    assert "db-g1-small" in SHEET and "20 GB" in SHEET and "PG15" in SHEET, "what the product owner measured of the instance is quoted as his"
    assert "the **real data size and the row counts** come from the rehearsal" in SHEET


def test_the_lap_has_the_machine_traffic_cell_and_counts_it_from_the_access_log_of_the_front() -> None:
    lap = _section("## 9. The lap", "## 10–11.")
    for token in ("**Lanes · desktop · MCP reconnect — the machine traffic.**", "(a) every lane Mac's agent shows online", "(b) one desktop-app instruction round trip", "(c) one tool call through `sprintable-mcp-prod`",
                  "**The figure, from the VM (P5):**", "sudo docker logs --since 5m sprintable-caddy-1", "grep -F '\"msg\":\"handled request\"'", "times 12", "about 250–275 in five minutes",
                  "a floor that does not return in half an hour is a finding for the product owner, not a pass", "**The deploy gap, separately from 4789:**"):
        assert token in lap, token
    assert "Open item (a number without a source)" not in lap and "stays «unmeasured»" not in lap, "the open item is closed by P5"


# ── the names agree with the declaration and the scripts ────────────────────────────────────────────────────────────────────────────────────

def test_the_names_agree_with_the_prod_declaration() -> None:
    names = _section("## Names (prod)", "`sprintable-backend-prod`")
    assert f"DEPLOY_BUCKET={PROD['buckets']['deploy']}" in names and f"BACKUPS_BUCKET={PROD['buckets']['backups']}" in names
    assert f"API_HOST={PROD['hosts']['api']}" in names and f"APP_HOST={PROD['hosts']['app']}" in names
    assert f"PROJECT={PROD['project']}" in names and f"REGION={PROD['region']}" in names
    assert PROD["services"]["backend"]["live_section"] == "sprintable-backend-prod"
    live = (_ROOT / "deploy/vm/env/live-names.prod.txt").read_text()
    assert "<secret DATABASE_URL_PROD>" in live and "DATABASE_URL_PROD_PGBOUNCER" in live and "`DATABASE_URL_PROD`" in SHEET, "the direct URL the dump reads"
    assert "sprintable-frontend-prod" in live
    assert "sprintable-mcp-prod" in (_ROOT / "cloudbuild.yaml").read_text()


def test_the_scripts_and_flags_the_sheet_names_exist() -> None:
    for script in ("front-door.sh", "dump-source.sh", "restore.sh", "rowcounts.sh", "deployer.py"):
        assert (_ROOT / "deploy/vm/bin" / script).is_file(), script
    for named in ("/opt/sprintable/bin/front-door.sh", "/opt/sprintable/bin/dump-source.sh", "/opt/sprintable/bin/restore.sh", "/opt/sprintable/bin/rowcounts.sh", "/opt/sprintable/bin/deployer.py"):
        assert named in SHEET, named
    manifest = __import__("json").loads((_ROOT / "infra/cloud-scheduler/jobs.json").read_text())
    prod = manifest["environments"].get("prod")
    assert prod is None or sorted(prod["jobs"]) == ["a2a-task-deadline-sweep", "assets-grace-hard-delete", "publication-commands", "storage-usage-warn"], "P4's premise: until it is merged prod is not in the manifest; once it is, it names the four jobs and no more"
    assert "**P4 — before step 4:" in SHEET and "`apply_cloud_scheduler.py --env prod` stops with a `KeyError`" in SHEET, "the sheet says the script needs P4"
    assert 'python3 "$REPO/infra/apply_cloud_scheduler.py" --env prod --base-url https://api.sprintable.ai' in "\n".join(_blocks())
    door = (_ROOT / "deploy/vm/bin/front-door.sh").read_text()
    assert "prod:https://sprintable-backend-prod-787818285179.asia-northeast3.run.app" in door
    assert SHEET.count("--upstream https://sprintable-backend-prod-787818285179.asia-northeast3.run.app") == 2, "the front door (step 3) and the way back"
    assert "--host api.sprintable.ai" in SHEET and "prod) api_host=\"api.sprintable.ai\"" in door
    assert re.search(r"--label (rehearsal|final)", SHEET) and "--label final" in SHEET


def test_the_routes_the_sheet_reads_in_the_request_log_are_the_applications() -> None:
    toss = (_ROOT / "backend/app/routers/toss_webhooks.py").read_text()
    assert 'prefix="/api/v2/webhooks/toss"' in toss and "/api/v2/webhooks/toss" in SHEET
    assert "/github-webhook" in (_ROOT / "backend/app/routers/verdict_capture.py").read_text() and "github-webhook" in SHEET
    for table in ("users", "organizations", "team_members", "billing_orders"):
        assert re.search(rf'__tablename__ = "{table}"', "".join(p.read_text() for p in (_ROOT / "backend/app/models").glob("*.py"))), table
        assert table in SHEET


# ── what dev showed to be wrong must not be in a block ─────────────────────────────────────────────────────────────────────────────────────

def test_no_block_freezes_by_ingress_or_measures_on_a_reserved_path() -> None:
    code = "\n".join(_blocks())
    assert re.findall(r"--ingress\S*\s+\S+", code) == ["--ingress all"] and "--ingress all" in _block_with("--no-traffic --tag"), "the freeze is the IAM binding; the one `--ingress` is the forwarder revision stating that it is open to all, not a freeze"
    assert "/healthz" not in code and "/readyz" not in code, "Cloud Run answers the paths that end in z itself"
    assert code.count("remove-iam-policy-binding") >= 1 and code.count("add-iam-policy-binding") >= 2
    assert '--member="$m" --role=roles/run.invoker' in code, "members come from the record"
    assert code.count("--member=allUsers") == 2, "a literal allUsers only in the two lines of the forwarder (opened in 8c, closed in step 12), each behind a look at what is recorded or present"
    assert '"$BURL/openapi.json"' in code and "403" in _section("## 5. Freeze", "## 6–7.")


def test_no_block_counts_a_key_instead_of_a_value_and_none_has_a_placeholder_in_angle_brackets() -> None:
    code = "\n".join(_blocks())
    assert "grep -c 'cloudsql-instances'" not in code
    assert not re.findall(r"<[a-z][a-z-]*>", code), re.findall(r"<[a-z][a-z-]*>", code)


def test_zsh_would_not_read_a_variable_and_a_colon_as_a_modifier() -> None:
    mod = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*:[$A-Za-z{]")
    hits = [line.strip()[:120] for b in _blocks() for line in b.splitlines() if mod.search(line) and not line.lstrip().startswith("#")]
    assert hits == [], hits


# ── every gcloud command goes through the real parser ───────────────────────────────────────────────────────────────────────────────────────

def _expand(token: str) -> str:
    def repl(m: re.Match) -> str:
        name = m.group(1) or m.group(2)
        assert name in SAMPLE, f"the sheet uses ${name} and nowhere defines it for the reader"
        return SAMPLE[name]
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", repl, token)


def _gcloud_commands() -> list[list[str]]:
    found = []
    inline = [m for m in re.findall(r"`([^`\n]*)`", SHEET) if "gcloud" in m and re.search(r" -{1,2}\w", m)]
    for block in [*_blocks(), *inline]:
        for line in block.splitlines():
            if "gcloud" not in line:
                continue
            lex = shlex.shlex(line, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""
            toks = list(lex)
            toks = [t for k, t in enumerate(toks) if not (t.isdigit() and k + 1 < len(toks) and toks[k + 1].startswith(">"))]   # the `2` of `2>&1` belongs to the redirection
            cur: list[str] = []
            for t in [*toks, "|"]:
                if t in {"|", ";", "&&", "||", "(", ")", "$"} or (t != "" and set(t) <= set("|;&()<>$")):   # an empty word (`--command ""`) is a word, not a separator
                    if "gcloud" in cur:
                        found.append(cur[cur.index("gcloud"):])
                    cur = []
                else:
                    cur.append(t)
    return found


def test_the_sheet_has_the_gcloud_commands_this_test_parses() -> None:
    verbs = {" ".join(c[1:3]) for c in _gcloud_commands()}
    for must in ("sql instances", "compute instances", "run services", "run jobs", "scheduler jobs", "logging read", "secrets versions", "secrets list", "compute ssh", "builds list"):
        assert must in verbs, (must, sorted(verbs))
    assert 20 <= len(_gcloud_commands()) <= 110, len(_gcloud_commands())


@pytest.mark.skipif(shutil.which("gcloud") is None, reason="no gcloud on this machine")
@pytest.mark.timeout(120)
def test_every_gcloud_command_of_the_sheet_parses_in_the_real_gcloud(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor
    unique: dict[tuple, int] = {}
    for cmd in _gcloud_commands():
        unique.setdefault(tuple(_expand(t) for t in cmd[1:]), len(unique))

    def parse(item: tuple[tuple, int]) -> tuple[str, str] | None:
        argv, n = item
        home = tmp_path / f"home-{n}"
        home.mkdir()
        out = _gcloud.text(_gcloud.run(list(argv), home))
        if "(unset)" in out and argv[0:2] == ("config", "get-value"):
            return None   # `config get-value account` is answered from the local configuration (empty here): the flags were accepted
        return None if "do not currently have an active account" in out else (" ".join(argv)[:140], out[:220])

    assert len(unique) >= 20, len(unique)
    with ThreadPoolExecutor(max_workers=6) as pool:
        bad = [r for r in pool.map(parse, unique.items()) if r]
    assert not bad, bad


# ── the blocks, run as written ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

_WRITES = ("create", "update", "delete", "deploy", "execute", "pause", "resume", "add-iam-policy-binding", "remove-iam-policy-binding", "set-iam-policy", "patch", "replace", "restart", "import", "export", "cancel")

_FAKE = r"""#!/bin/sh
echo "gcloud $*" >> "$CALLS"
[ -n "$FAIL" ] && case "$*" in *"$FAIL"*) exit 1 ;; esac
case "$*" in
  *"services describe"*"value(status.url)"*) printf %s "https://x.run.app" ;;
  *"services describe"*"timeoutSeconds"*) printf %s "$TMO" ;;
  *"run services list"*|*"run jobs list"*) printf 'sprintable-backend-prod\nsprintable-frontend-prod\n' ;;
  *"run services describe"*|*"run jobs describe"*) echo "{\"x\":1,\"note\":\"$DESC_EXTRA\"}" ;;
  *"secrets get-iam-policy"*) case "$*" in *DATABASE_URL_PROD*) echo '{"bindings":[]}' ;; *) echo '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:vm-sa@sprintable-494803.iam.gserviceaccount.com"]}]}' ;; esac ;;
  *"logging read"*"NOT httpRequest"*) printf %s "$WRITE_ROWS" ;;
  *"config get-value account"*) echo "$OPERATOR" ;;
  *"remove-iam-policy-binding"*) svc="$4"; for a in "$@"; do case "$a" in --member=*) case " $STICKY " in *" ${a#--member=} "*) ;; *) echo "${a#--member=}" >> "$STATE/removed-$svc" ;; esac ;; esac; done ;;
  *"get-iam-policy"*) svc="$4"; case " $* " in *" $NOBIND "*) echo '{"bindings":[{"role":"roles/run.invoker","members":["user:operator@example.com"]}]}' ;; *" $GARBAGE "*) echo 'not json at all' ;; *) out=""; for m in allUsers serviceAccount:caller@p.iam.gserviceaccount.com user:operator@example.com $EXTRA_MEMBER; do grep -qxF "$m" "$STATE/removed-$svc" 2>/dev/null || out="$out\"$m\","; done; echo "{\"bindings\":[{\"role\":\"roles/run.invoker\",\"members\":[${out%,}]}]}"; [ -n "$LATEFAIL" ] && [ -s "$STATE/removed-$svc" ] && exit 1 ;; esac ;;
  *"executions list"*) case " $* " in *" $BUSY "*) echo "exec-1" ;; esac ;;
  *"compute instances describe"*"serviceAccounts"*) echo vm-sa@sprintable-494803.iam.gserviceaccount.com ;;
  *"compute instances describe"*) echo 34.64.1.2 ;;
  *"buckets describe"*"json"*) echo '{"lifecycle_config":{"rule":[{"condition":{"age":14,"matchesPrefix":["db/"]}},{"condition":{"age":7,"matchesPrefix":["status/"]}},{"condition":{"age":30,"matchesPrefix":["cloudsql-final/"]}},{"condition":{"age":7,"matchesPrefix":["import/"]}}]}}' ;;
  *"buckets describe"*) printf 'enforced\tTrue\n' ;;
  *"secrets versions list"*) echo 1 ;;
  *"firewall-rules list"*) printf 'NAME PRIORITY FROM TARGET ALLOW DENY\n' ;;
  *"sql instances describe"*"json"*) echo '{"ipAddresses":[{"type":"PRIVATE","ipAddress":"10.110.0.3"}]}' ;;
esac
exit 0
"""

_FAKE_CURL = """#!/bin/sh
echo "curl $*" >> "$CALLS"
case "$*" in *api.sprintable.ai*) printf %s "${VM_CODE:-200}" ;; *) printf %s "${CURL_CODE:-403}" ;; esac
"""


_FAKE_PY = """#!/bin/sh
echo "python3 $*" >> "$CALLS"
case "$1" in
  */apply_cloud_scheduler.py) case " $* " in *" --apply "*) echo "applied" ;; *) if grep -q -e '--apply' "$CALLS"; then printf '%s\\n' "$PLAN_POST"; else printf '%s\\n' "$PLAN_OUT"; fi ;; esac ;;
  */render_env.py) printf 'JWT_SECRET_PROD\\nDB_PASSWORD_VM_PROD\\n' ;;
  *) exec "$REAL_PYTHON" "$@" ;;
esac
"""

_FAKE_NC = """#!/bin/sh
echo "nc $*" >> "$CALLS"
case " $* " in *" $OPEN_PORT "*) exit 0 ;; esac
exit 1
"""

_FAKE_GREP = """#!/bin/sh
case "$1" in
  -P) shift; pattern="$1"; shift; exec "$REAL_PYTHON" -c 'import re, sys; p = re.compile(sys.argv[1]); rows = [l for l in (open(sys.argv[2]) if len(sys.argv) > 2 else sys.stdin) if p.search(l.rstrip("\\n"))]; sys.stdout.write("".join(rows)); sys.exit(0 if rows else 1)' "$pattern" "$@" ;;
  *) exec /usr/bin/grep "$@" ;;
esac
"""

_FAKE_SUDO = """#!/bin/sh
echo "sudo $*" >> "$CALLS"
[ -n "$FAILSUDO" ] && case "$*" in *"$FAILSUDO"*) exit 1 ;; esac
case "$*" in
  *restore.sh*) printf 'users\\t3\\n' ;;
  *rewrite_site_post_links*) case "$SUDO_REPORT" in -) ;; "") printf 'https://api.sprintable.ai\\t5\\n' ;; *) printf '%s\\n' "$SUDO_REPORT" ;; esac ;;
  "bash -c"*) exec "$@" ;;
  *"docker ps"*) [ -n "$NOSTACK" ] || echo sprintable-backend-1 ;;
esac
exit 0
"""


def _world(tmp_path: Path) -> dict[str, str]:
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    for name, text in (("gcloud", _FAKE), ("curl", _FAKE_CURL), ("sleep", "#!/bin/sh\necho \"sleep $*\" >> \"$CALLS\"\n"), ("dig", "#!/bin/sh\necho 34.64.1.2\n"), ("nc", _FAKE_NC), ("python3", _FAKE_PY), ("sudo", _FAKE_SUDO), ("grep", _FAKE_GREP)):
        f = b / name
        f.write_text(text)
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    calls = tmp_path / "calls"
    calls.write_text("")
    (tmp_path / "state").mkdir(exist_ok=True)
    import sys
    return {"PATH": f"{b}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": str(tmp_path), "CALLS": str(calls), "STATE": str(tmp_path / "state"), "TMO": "300", "REAL_PYTHON": sys.executable, "SUDO_REPORT": "", "WRITE_ROWS": "", "OPERATOR": "operator@example.com", "STICKY": "", "EXTRA_MEMBER": "", "LATEFAIL": "", "KEEP": "", "PLAN_OUT": "", "PLAN_POST": "UNCHANGED 4\ndry-run — nothing changed", "OPEN_PORT": "none", "DESC_EXTRA": "",
            **{k: v for k, v in SAMPLE.items() if k not in ("TMO",)}}


def _w(root: Path) -> Path:
    """the folder of the window, where the sheet's files live and where its ladders refuse to run anywhere else"""
    return root / "window-20261102"


def _run(block: str, tmp_path: Path, shell: str = "bash", extra: dict[str, str] | None = None, files: dict[str, str] | None = None, where: str = "window") -> tuple[subprocess.CompletedProcess, list[str]]:
    env = _world(tmp_path)
    env.update(extra or {})
    work = _w(tmp_path) if where == "window" else tmp_path
    work.mkdir(exist_ok=True)
    for name, text in (files or {}).items():
        (work / name).write_text(text)
    p = subprocess.run([shell, "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=work)
    return p, Path(env["CALLS"]).read_text().splitlines()


def _fresh(root: Path, name: str) -> Path:
    d = root / name
    d.mkdir()
    return d


def _verbs(calls: list[str], word: str) -> list[str]:
    return [c for c in calls if word in c]


IN_FOLDER = '[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ]'
FREEZE = 'STEP=no\nOP=$(gcloud config get-value account'
UNFREEZE = f"STEP=no\n{IN_FOLDER} && [ -s reopen.txt ]"
JOBS = f"RUN=no\n{IN_FOLDER} && [ -s jobs.txt ]"
SCH_MOVE = f"SCH=no\n{IN_FOLDER} && [ -s scheduler-before.tsv ]"
SCH_BACK = f"SCH=no\n{IN_FOLDER} && [ -s scheduler-moved.tsv ]"
CALLER = "serviceAccount:caller@p.iam.gserviceaccount.com"
PUBLIC = "".join(f"{svc}\t{m}\n" for svc in ("sprintable-mcp-prod", "svc-a", "svc-b", "svc-c") for m in ("allUsers", CALLER))
WP = "was-invoker-20261102.tsv"


def test_the_read_only_blocks_write_nothing(tmp_path: Path) -> None:
    for i, marker in enumerate(("SRC_IP=$(gcloud sql", "USES CLOUD SQL PROD", "Google-Cloud-Scheduler", "VMSA=$(gcloud compute", "for route in register token", "for route in desktop/setup-codes")):
        p, calls = _run(_block_with(marker), _fresh(tmp_path, f"ro{i}"))
        assert p.returncode == 0, (marker, p.stderr[:300])
        gcloud_calls = [c for c in calls if c.startswith("gcloud ")]
        assert gcloud_calls, marker
        writes = [c for c in gcloud_calls if any(w in c.split() for w in _WRITES)]   # the words of the command line, not parts of a bucket's name
        assert writes == [], (marker, writes)


def test_the_dependents_loop_lists_what_mounts_prods_cloud_sql_and_asks_who_may_call(tmp_path: Path) -> None:
    p, calls = _run(_block_with("USES CLOUD SQL PROD"), tmp_path)
    assert p.returncode == 0, p.stderr
    assert _verbs(calls, "get-iam-policy"), "it asks who may call each service"
    assert "== sprintable-backend-prod" in p.stdout and "allUsers" in p.stdout


def test_step_zero_saves_what_the_undo_and_the_job_check_need(tmp_path: Path) -> None:
    block = _block_with("> scheduler-before.tsv")
    assert "> scheduler-before.tsv" in block and "> jobs.txt" in block
    p, calls = _run(block, tmp_path)
    assert p.returncode == 0, p.stderr
    assert (_w(tmp_path) / "scheduler-before.tsv").exists() and (_w(tmp_path) / "jobs.txt").read_text().split() == ["sprintable-backend-prod", "sprintable-frontend-prod"]


def test_the_freeze_is_a_ladder_that_proves_before_it_waits_and_leaves_the_services_frozen_when_it_fails(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    ok, calls = _run(block, _fresh(tmp_path, "ok"), files={"frozen.txt": "svc-a\nsvc-b\n"})
    assert ok.returncode == 0, ok.stderr
    removed = _verbs(calls, "remove-iam-policy-binding")
    assert [c.split()[4] for c in removed] == ["svc-a", "svc-a", "svc-b", "svc-b"], removed
    assert not [c for c in removed if "user:operator@example.com" in c], "the operator account is never taken off"
    assert [c.split("--member=")[1].split()[0] for c in removed[:2]] == ["allUsers", CALLER], "every other member goes, not only the public one"
    assert "outside: 403" in ok.stdout and "freeze: waited" in ok.stdout and any(c.startswith("sleep 310") for c in calls), "proved from outside (403), then the wait of the request timeout + 10 s"
    assert max(i for i, c in enumerate(calls) if "remove-iam-policy-binding" in c) < next(i for i, c in enumerate(calls) if c.startswith("curl")) < next(i for i, c in enumerate(calls) if c.startswith("sleep")), "freeze, prove, wait"
    assert not _verbs(calls, "add-iam-policy-binding"), "a freeze never opens anything"
    assert (_w(tmp_path / "ok") / WP).read_text().splitlines() == [f"svc-a\tallUsers", f"svc-a\t{CALLER}", f"svc-b\tallUsers", f"svc-b\t{CALLER}"], "what the freeze really took off is written down, member by member: the way back puts back exactly that"
    # the freeze is not proved (the outside still answers 200): no wait, no T0
    p, calls2 = _run(block, _fresh(tmp_path, "open"), extra={"CURL_CODE": "200"}, files={"frozen.txt": "svc-a\n"})
    assert "outside: 200" in p.stdout and "freeze: frozen" in p.stdout and not any(c.startswith("sleep") for c in calls2), "a freeze that is not proved does not wait and does not start the clock"
    # no WINDOW: the record of this window would have no name - nothing runs
    p, calls_w = _run(block, _fresh(tmp_path, "nowindow"), extra={"WINDOW": ""}, files={"frozen.txt": "svc-a\n"})
    assert not _verbs(calls_w, "remove-iam-policy-binding") and "freeze: no" in p.stdout
    # FROZEN not set / empty list: no line runs
    p, calls3 = _run(block, _fresh(tmp_path, "none"), extra={"FROZEN": ""}, files={"frozen.txt": "svc-a\n"})
    assert not _verbs(calls3, "remove-iam-policy-binding") and "freeze: no" in p.stdout
    p, calls4 = _run(block, _fresh(tmp_path, "empty"), files={"frozen.txt": ""})
    assert not _verbs(calls4, "remove-iam-policy-binding") and "freeze: no" in p.stdout and not any(c.startswith("sleep") for c in calls4)


def test_a_failed_removal_stops_the_loop_at_once_and_no_later_service_is_touched(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    p, calls = _run(block, tmp_path, extra={"FAIL": "remove-iam-policy-binding svc-b"}, files={"frozen.txt": "svc-a\nsvc-b\nsvc-c\n"})
    touched = [c.split()[4] for c in _verbs(calls, "remove-iam-policy-binding")]
    assert touched == ["svc-a", "svc-a", "svc-b"], touched
    assert "freeze: failed" in p.stdout and not any(c.startswith(("sleep", "curl")) for c in calls), "no proof, no wait, no clock after a failure"


def test_a_service_that_is_already_frozen_is_skipped_so_the_block_can_be_run_again(tmp_path: Path) -> None:
    p, calls = _run(_block_with(FREEZE), tmp_path, extra={"NOBIND": "svc-a"}, files={"frozen.txt": "svc-a\nsvc-b\n"})
    assert [c.split()[4] for c in _verbs(calls, "remove-iam-policy-binding")] == ["svc-b", "svc-b"], "removing a binding that is not there is an error in gcloud: the block asks first"
    assert "freeze: waited" in p.stdout
    assert {line.split("\t")[0] for line in (_w(tmp_path) / WP).read_text().splitlines()} == {"svc-b"}, "svc-a had no caller but the operator: it is not in the file the way back reads"


def test_a_policy_that_cannot_be_read_is_a_stop_and_never_taken_for_already_frozen(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    p, calls = _run(block, _fresh(tmp_path, "readfail"), extra={"FAIL": "get-iam-policy svc-b"}, files={"frozen.txt": "svc-a\nsvc-b\nsvc-c\n"})
    assert "freeze: failed" in p.stdout and [c.split()[4] for c in _verbs(calls, "remove-iam-policy-binding")] == ["svc-a", "svc-a"] and not any(c.startswith(("sleep", "curl")) for c in calls)
    p, calls = _run(block, _fresh(tmp_path, "garbage"), extra={"GARBAGE": "svc-b"}, files={"frozen.txt": "svc-a\nsvc-b\nsvc-c\n"})
    assert "freeze: failed" in p.stdout and [c.split()[4] for c in _verbs(calls, "remove-iam-policy-binding")] == ["svc-a", "svc-a"], "a policy that is not JSON stops the block"
    assert not [c for c in calls if "svc-c" in c], "nothing after the unreadable one is touched"


def test_a_running_execution_of_any_job_stops_the_sheet(tmp_path: Path) -> None:
    block = _block_with(JOBS)
    p, calls = _run(block, _fresh(tmp_path, "quiet"), files={"jobs.txt": "job-a\njob-b\n"})
    assert "jobs: quiet" in p.stdout and len(_verbs(calls, "executions list")) == 2
    p, _ = _run(block, _fresh(tmp_path, "busy"), extra={"BUSY": "job-b"}, files={"jobs.txt": "job-a\njob-b\n"})
    assert "job-b running executions: 1" in p.stdout and "jobs: busy" in p.stdout and "jobs: quiet" not in p.stdout
    p, _ = _run(block, _fresh(tmp_path, "failed"), extra={"FAIL": "executions list --job job-a"}, files={"jobs.txt": "job-a\njob-b\n"})
    assert "jobs: failed" in p.stdout and "job-b running" not in p.stdout, "a question that could not be asked is not an answer"
    p, calls = _run(block, _fresh(tmp_path, "nofile"))
    assert "jobs: no" in p.stdout and not calls


def test_the_unfreeze_opens_only_what_reopen_txt_names_proves_the_vm_and_resumes_the_scheduler_last(tmp_path: Path) -> None:
    block = _block_with(UNFREEZE)
    files = {"reopen.txt": "sprintable-mcp-prod\n", "paused.txt": "job-1\njob-2\n", WP: PUBLIC, "frozen.txt": "sprintable-backend-prod\nsprintable-frontend-prod\nsprintable-mcp-prod\n"}
    p, calls = _run(block, _fresh(tmp_path, "ok"), files=files, extra={"BURL": ""})
    assert any("services describe" in c and "status.url" in c for c in calls), "the unfreeze derives the Cloud Run address too"
    adds = _verbs(calls, "add-iam-policy-binding")
    assert [c.split()[4] for c in adds] == ["sprintable-mcp-prod", "sprintable-mcp-prod"], "the Cloud Run backend and frontend stay closed (two databases otherwise)"
    assert [c.split("--member=")[1].split()[0] for c in adds] == ["allUsers", CALLER], "the service gets back exactly the members the freeze recorded for it, no other"
    assert [c.split()[4] for c in _verbs(calls, "scheduler jobs resume")] == ["job-1", "job-2"]
    assert "the VM: 200 · Cloud Run backend: 403" in p.stdout and "unfreeze: resumed" in p.stdout
    assert any("api.sprintable.ai/openapi.json" in c for c in calls), "the measurement is the VM's front"
    assert max(i for i, c in enumerate(calls) if "curl" in c) < min(i for i, c in enumerate(calls) if "scheduler jobs resume" in c), "measured first, resumed after"
    # the measurement is a gate: the VM does not answer 200 / Cloud Run is not closed
    for name, extra in (("vm500", {"VM_CODE": "500"}), ("cr200", {"CURL_CODE": "200"})):
        p, calls = _run(block, _fresh(tmp_path, name), files=files, extra=extra)
        assert "unfreeze: reopened" in p.stdout and not _verbs(calls, "scheduler jobs resume"), (name, p.stdout)
    # empty list, a service that was not public before, a failure
    p, calls = _run(block, _fresh(tmp_path, "empty"), files={**files, "reopen.txt": ""})
    assert not _verbs(calls, "iam-policy-binding") and not _verbs(calls, "scheduler jobs resume") and "unfreeze: no" in p.stdout and "the VM:" not in p.stdout, "an empty list is a stop, not a pass"
    nofile = {k: v for k, v in files.items() if k != WP}
    p, calls = _run(block, _fresh(tmp_path, "nofile"), files=nofile)
    assert "unfreeze: no" in p.stdout and not _verbs(calls, "iam-policy-binding") and not _verbs(calls, "scheduler jobs resume"), "a window without a record opens nothing"
    p, calls = _run(block, _fresh(tmp_path, "stale"), files={**files, "was-invoker-20250101.tsv": "sprintable-mcp-prod\tallUsers\n", WP: "svc-a\tallUsers\n"})
    assert "no caller was taken off before the freeze: sprintable-mcp-prod" in p.stdout and not _verbs(calls, "add-iam-policy-binding"), "the record of another window is not this window's"
    p, calls = _run(block, _fresh(tmp_path, "private"), files={**files, "reopen.txt": "was-private\n"})
    assert "no caller was taken off before the freeze: was-private" in p.stdout and not _verbs(calls, "add-iam-policy-binding") and "unfreeze: failed" in p.stdout
    p, calls = _run(block, _fresh(tmp_path, "fail"), extra={"FAIL": "add-iam-policy-binding svc-a"}, files={**files, "reopen.txt": "svc-a\nsvc-b\n"})
    assert [c.split()[4] for c in _verbs(calls, "add-iam-policy-binding")] == ["svc-a"] and not _verbs(calls, "scheduler jobs resume") and "unfreeze: failed" in p.stdout


@pytest.mark.skipif(shutil.which("zsh") is None, reason="no zsh on this machine")
def test_the_ladders_run_the_same_under_zsh_and_bash(tmp_path: Path) -> None:
    for shell in ("zsh", "bash"):
        p, calls = _run(_block_with(FREEZE), _fresh(tmp_path, f"f-{shell}"), shell=shell, files={"frozen.txt": "svc-a\nsvc-b\n"})
        assert p.returncode == 0 and "freeze: waited" in p.stdout and len(_verbs(calls, "remove-iam-policy-binding")) == 4, (shell, p.stderr)
        p, calls = _run(_block_with(UNFREEZE), _fresh(tmp_path, f"u-{shell}"), shell=shell, files={"reopen.txt": "svc-a\n", "paused.txt": "job-1\n", WP: "svc-a\tallUsers\n"})
        assert p.returncode == 0 and "unfreeze: resumed" in p.stdout, (shell, p.stderr)
        p, calls = _run(_block_with(JOBS), _fresh(tmp_path, f"j-{shell}"), shell=shell, files={"jobs.txt": "job-a\n"})
        assert "jobs: quiet" in p.stdout, (shell, p.stderr)


def test_the_scheduler_targets_move_by_host_and_come_back_from_the_file_the_move_wrote(tmp_path: Path) -> None:
    move = _block_with(SCH_MOVE)
    back = _block_with(SCH_BACK)
    old = "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app/api/v2/internal/cron/a2a"
    before = f"job-1 {old}\njob-2 https://api.sprintable.ai/api/v2/internal/cron/x\njob-3 https://elsewhere.example/hook\njob-5 https://some-other-service-abc123-du.a.run.app/api/hook\njob-6 https://sprintable-backend-dev-787818285179.asia-northeast3.run.app/x\n"
    root = _fresh(tmp_path, "m")
    p, calls = _run(move, root, files={"scheduler-before.tsv": before})
    updates = _verbs(calls, "scheduler jobs update http")
    assert len(updates) == 1 and "job-1" in updates[0] and '--uri https://api.sprintable.ai/api/v2/internal/cron/a2a' in updates[0], updates
    assert "left alone: job-2" in p.stdout and "left alone: job-3" in p.stdout and "scheduler: moved" in p.stdout
    assert "left alone: job-5" in p.stdout and "left alone: job-6" in p.stdout, "another Cloud Run service (or the dev backend) is not rewritten to the prod API: only the prod backend's own address is moved"
    assert len(updates) == 1
    assert (_w(root) / "scheduler-moved.tsv").read_text().strip() == f"job-1 {old}", "the undo records the old target"
    p, calls = _run(back, root, files={})
    assert [c for c in _verbs(calls, "scheduler jobs update http")][0].endswith(f"--uri {old}") and "scheduler: back" in p.stdout
    p, calls = _run(move, _fresh(tmp_path, "bad"), extra={"FAIL": "update http job-1"}, files={"scheduler-before.tsv": before + f"job-4 {old}\n"})
    assert "scheduler: failed" in p.stdout and not _verbs(calls, "job-4"), "the first failure stops the loop"
    p, calls = _run(move, _fresh(tmp_path, "nofile"))
    assert "scheduler: no" in p.stdout and not calls


def test_the_final_restore_keeps_its_counts_and_a_refused_restore_never_empties_them(tmp_path: Path) -> None:
    block = _block_with("counts-vm-final.tmp")
    assert '[ ! -e counts-vm-final.tsv ]' in block and 'mv counts-vm-final.tmp counts-vm-final.tsv' in block and 'echo "row counts equal"' in block
    counts = tmp_path / "final.counts.tsv"
    counts.write_text("users\t3\n")
    ok, _ = _run(block, _fresh(tmp_path, "ok"), extra={"FINAL_COUNTS": str(counts)})
    assert "row counts equal" in ok.stdout and (_w(tmp_path / "ok") / "counts-vm-final.tsv").read_text() == "users\t3\n" and not (_w(tmp_path / "ok") / "counts-vm-final.tmp").exists()
    # a restore that refuses: the kept file of an earlier success is not touched, and there is none to empty
    root = _fresh(tmp_path, "refused")
    p, _ = _run(block, root, extra={"FINAL_COUNTS": str(counts), "FAILSUDO": "restore.sh"})
    assert not (_w(root) / "counts-vm-final.tsv").exists() and "row counts equal" not in p.stdout, "a refused restore leaves no counts file behind"
    # a second attempt in the same folder refuses to overwrite what is kept
    p2, calls = _run(block, _fresh(tmp_path, "again"), extra={"FINAL_COUNTS": str(counts)}, files={"counts-vm-final.tsv": "users\t99\n"})
    assert (_w(tmp_path / "again") / "counts-vm-final.tsv").read_text() == "users\t99\n" and not any("restore.sh" in c for c in calls), "the kept file is never overwritten and nothing is restored on top of it"
    assert "final restore: no" in p2.stdout and "row counts equal" not in p2.stdout and not any("diff" in c for c in calls), "an earlier file never stands in for this restore: no diff, no pass"
    # the stale file even MATCHES the counts of this dump: still no pass (the restore did not run)
    p3, calls3 = _run(block, _fresh(tmp_path, "stale"), extra={"FINAL_COUNTS": str(counts)}, files={"counts-vm-final.tsv": "users\t3\n"})
    assert "final restore: no" in p3.stdout and "row counts equal" not in p3.stdout and not any("restore.sh" in c for c in calls3), "a stale file that happens to match is refused too"
    assert "final restore: equal" in ok.stdout
    p4, _ = _run(block, _fresh(tmp_path, "nodump"), extra={"FINAL_DUMP": "", "FINAL_COUNTS": ""})
    assert "final restore: no" in p4.stdout, "without the paths of the dump nothing runs"
    way = _section("## 12. The way back", "Two chains")
    assert "rowcounts.sh | diff <(grep -P" in way and "counts-vm-final.tsv" in way and "counts-final.tsv" not in SHEET.replace("counts-vm-final.tsv", "")
    dev = (_ROOT / "deploy/vm/CUTOVER-gateway-dev.md").read_text()
    assert 'grep -P "^\\S+\\t\\d+$"' in dev and 'grep -P "^\\S+\\t\\d+$"' in SHEET


def test_the_way_back_on_the_vm_stops_where_it_fails_and_the_one_on_the_machine_stops_at_the_first_failure(tmp_path: Path) -> None:
    vm = _block_with("sudo docker ps -a --format '{{.Names}}' | grep -qx sprintable-backend-1 && BACK=seen")
    assert "front-door.sh status" not in vm, "after step 6 the temporary front door is stopped and `status` exits 1: the chain must not ask it"
    fake = tmp_path / "vmbin"
    fake.mkdir()
    f = fake / "sudo"
    f.write_text('#!/bin/sh\necho "sudo $*" >> "$CALLS"\n[ -n "$FAILSUDO" ] && case "$*" in *"$FAILSUDO"*) exit 1 ;; esac\ncase "$*" in *"docker ps"*) [ -n "$NOSTACK" ] || echo sprintable-backend-1 ;; esac\nexit 0\n')
    f.chmod(f.stat().st_mode | stat.S_IEXEC)

    def run_vm(name: str, fail: str = "") -> list[str]:
        root = _fresh(tmp_path, name)
        env = _world(root)
        env["PATH"] = f"{fake}:{env['PATH']}"
        env["FAILSUDO"] = fail
        subprocess.run(["bash", "-c", vm], capture_output=True, text=True, timeout=60, env=env, cwd=root)
        return Path(env["CALLS"]).read_text().splitlines()

    calls = run_vm("ok")
    assert "passthrough" in calls[-1] and len([c for c in calls if c.startswith("sudo")]) == 5, "all lines ran, the pass-through last"
    for fail, must_not in (("systemctl disable", "docker stop"), ("docker stop", "passthrough")):
        assert not [c for c in run_vm(fail.replace(" ", "_"), fail) if must_not in c], fail
    nostack_root = _fresh(tmp_path, "nostack")
    env = _world(nostack_root)
    env.update({"PATH": f"{fake}:{env['PATH']}", "NOSTACK": "1", "FAILSUDO": ""})
    subprocess.run(["bash", "-c", vm], capture_output=True, text=True, timeout=60, env=env, cwd=nostack_root)
    assert not [c for c in Path(env["CALLS"]).read_text().splitlines() if "systemctl" in c or "passthrough" in c], "no stack on this machine: nothing is stopped and no pass-through is started"
    machine = _block_with('BACK=no\n[ "$VMBACK" = passing ]')
    p, calls = _run(machine, _fresh(tmp_path, "m"), files={"frozen.txt": "svc-x\nsvc-y\nsvc-a\nsvc-b\n", WP: "svc-a\nsvc-b\n", "paused.txt": "job-1\n"}, extra={"CURL_CODE": "200", "BURL": ""})
    assert any("services describe" in c and "status.url" in c for c in calls), "the Cloud Run address is derived inside the block (a fresh shell has no BURL)"
    assert [c.split()[4] for c in _verbs(calls, "add-iam-policy-binding")] == ["svc-a", "svc-b"], "only what the freeze took the binding off (the record of this window), not every service in frozen.txt"
    assert _verbs(calls, "scheduler jobs resume") and "Cloud Run backend: 200" in p.stdout and "way back: done" in p.stdout
    # a failing binding stops the loop; nothing is resumed
    p, calls = _run(machine, _fresh(tmp_path, "f"), files={WP: "svc-a\nsvc-b\nsvc-c\n", "paused.txt": "job-1\n"}, extra={"FAIL": "add-iam-policy-binding svc-b"})
    assert [c.split()[4] for c in _verbs(calls, "add-iam-policy-binding")] == ["svc-a", "svc-b"], "svc-c is not touched after the failure of svc-b"
    assert not _verbs(calls, "scheduler jobs resume") and "way back: failed" in p.stdout
    # missing, empty or unnamed record, or the VM chain did not end at passing: nothing is opened, nothing resumed, nothing claimed done
    for name, files, extra in (("nofile", {"paused.txt": "job-1\n"}, {}), ("empty", {WP: "", "paused.txt": "job-1\n"}, {}), ("nowindow", {WP: "svc-a\n", "paused.txt": "job-1\n"}, {"WINDOW": ""}),
                               ("vmnot", {WP: "svc-a\n", "paused.txt": "job-1\n"}, {"VMBACK": ""})):
        p, calls = _run(machine, _fresh(tmp_path, name), files=files, extra=extra)
        assert "way back: no" in p.stdout and not _verbs(calls, "iam-policy-binding") and not _verbs(calls, "scheduler jobs resume") and "way back: done" not in p.stdout, name
    # Cloud Run must answer 200 before the schedulers are resumed
    p, calls = _run(machine, _fresh(tmp_path, "cr403"), files={WP: "svc-a\n", "paused.txt": "job-1\n"}, extra={"CURL_CODE": "403"})
    assert "way back: reopened" in p.stdout and not _verbs(calls, "scheduler jobs resume"), "an unproven reopening resumes nothing"


def test_step_eight_says_cloud_run_backend_and_frontend_stay_closed_and_why() -> None:
    eight = _section("## 8. Unfreeze", "## 9. The lap")
    for token in ("**Cloud Run's frontend stays closed, and the real revision of the backend gets no caller and no traffic after 8c: it is the way back.**", "Only the **forwarder** of step 4c is ever opened to the public", "two databases, split writes", "What is put back is `reopen.txt`", "The measurement is a gate", "`unfreeze: resumed` is the pass", "An empty `reopen.txt`, or a window without a `was-invoker` file, is a stop, not a pass", "is never opened by this block"):
        assert token in eight, token
    assert "The hosted MCP" not in eight or "once its `SPRINTABLE_API_URL`" in eight
    five = _section("## 5. Freeze", "## 6–7.")
    for token in ("**The ladder.**", "`freeze: waited` is the pass", "**Cloud Run jobs are writers too.**", "`jobs: quiet` is the pass", "removing a binding that is not there is an error in gcloud", "a policy that cannot be **read**, or an operator account that cannot be read, is a stop", "`was-invoker-${WINDOW}.tsv`", "`WINDOW` to the date of this night"):
        assert token in five, token


def test_the_gates_and_the_checks_that_need_a_person_say_who_writes_what() -> None:
    g = _section("## G. Gates", "## 0. Read-only")
    for token in ("**G1. The repository side of RUNBOOK §12 is done**", "the image cleanup checker fix (its three limits)", "**G3. Nothing can deploy to prod from the start of the window until P3 is merged**", "nothing merges to `main`",
                  "`gcloud builds list --project $PROJECT --ongoing --limit 200", "**G5. Every decision in this sheet is written down**", "the **prod pipeline changes P1, P2, P4 and P5 below**"):
        assert token in g, token
    zero = _section("## 0. Read-only", "## 1. Rehearsal")
    for token in ("**Everything in the project that depends on prod — read the list, do not assume it.**", "**«I do not know» is a stop**", "this sheet deletes nothing of Cloud Run prod", "a **finding to stop on**",
                  "RESEND_API_KEY", "`/api/v2/webhooks/toss`", "`000` is no route"):
        assert token in zero, token


def test_the_pipeline_section_names_three_changes_in_an_order_and_the_repository_premises_hold_today() -> None:
    section = _section("## The prod pipeline: five changes", "## 0. Read-only")
    for token in ("**P1 — before step 4: the one address switch.**", "**P2 — before G2: the prod VM bundle build.**", "**P4 — before step 4: prod's scheduler jobs are defined in the repository**", "**P5 — before G2: the access log of the front**", "**P3 — merged right after step 8, before anything else merges to `main`:", "`cloud_run_app_skip=true`",
                  "Until P3 is merged G3 holds;", "These are **not made by this sheet**"):
        assert token in section, token
    assert "| 8b |" in SHEET and "P3" in _section("## The order", "## G. Gates")
    wf = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    prod_branch = wf.split('if [[ "$REF_NAME" == "main" ]]; then')[1].split("\n          else\n", 1)[0]
    assert 'echo "fastapi_url=https://api.sprintable.ai"' in prod_branch and "sprintable-backend-prod-787818285179" not in prod_branch.split('echo "fastapi_url=')[1].split("\n")[0], "P1 is merged: the prod branch gives clients and services the VM's API name"
    assert prod_branch.count('echo "cloud_run_app_skip=true"') == 1, "P3 is merged (this line said «not yet» until step 8 of the move): the prod branch skips Cloud Run now"
    assert "if: success() && (steps.env.outputs.target == 'dev' || steps.env.outputs.target == 'prod')" in wf and "Submit the VM bundle build (dev and prod" in wf, "P2 is merged: the VM bundle build is submitted for dev and prod"
    state = section.split("**State when this was written")[1].split("- **P1")[0]
    for token in ("*Merged:* P2 (#5328", "P4 (#5324)", "P5 (#5326", "P6 (#5329", "*Open:* P1 (#5327", "P3 (ready locally", "P7 (the pipeline's prod branch"):
        assert token in state, token
    assert "prod" in __import__("json").loads((_ROOT / "infra/cloud-scheduler/jobs.json").read_text())["environments"], "P4 is merged"
    assert "\tlog {" in (_ROOT / "deploy/vm/Caddyfile").read_text(), "P5 is merged"
    cb = (_ROOT / "cloudbuild.yaml").read_text()
    assert cb.count('"${_CLOUD_RUN_APP_SKIP}" = "true"') >= 6, "the switch P3 turns on exists and covers the frontend build, the migration job and both deploy steps"
    assert "--allow-unauthenticated" in cb, "the premise of G3: a prod build would deploy the backend publicly"


def test_every_ladder_refuses_to_run_outside_the_folder_of_the_window(tmp_path: Path) -> None:
    """a later window starts in a folder of its own: the lists of an earlier one (frozen, reopen, paused, scheduler targets, jobs) are not there to be picked up"""
    cases = (
        (_block_with(FREEZE), {"frozen.txt": "svc-a\n"}, "remove-iam-policy-binding", "freeze: no"),
        (_block_with(UNFREEZE), {"reopen.txt": "svc-a\n", WP: "svc-a\n", "paused.txt": "job-1\n"}, "iam-policy-binding", "unfreeze: no"),
        (_block_with(JOBS), {"jobs.txt": "job-a\n"}, "executions list", "jobs: no"),
        (_block_with(SCH_MOVE), {"scheduler-before.tsv": "job-1 https://sprintable-backend-prod-787818285179.asia-northeast3.run.app/x\n"}, "scheduler jobs update", "scheduler: no"),
        (_block_with(SCH_BACK), {"scheduler-moved.tsv": "job-1 https://x/y\n"}, "scheduler jobs update", "scheduler: no"),
        (_block_with('BACK=no\n[ "$VMBACK" = passing ]'), {WP: "svc-a\n", "paused.txt": "job-1\n"}, "iam-policy-binding", "way back: no"),
    )
    for i, (block, files, verb, said) in enumerate(cases):
        # the right folder: it runs (the proof that the files are good); the wrong one (the parent, or another window's folder): nothing
        ok, calls_ok = _run(block, _fresh(tmp_path, f"in{i}"), files=files)
        assert any(verb in c for c in calls_ok), (i, ok.stdout[:200])
        root = _fresh(tmp_path, f"out{i}")
        for name, text in files.items():
            (root / name).write_text(text)
        p, calls = _run(block, root, where="parent")
        assert not any(verb in c for c in calls) and said in p.stdout, (i, p.stdout[:200])
        other = _fresh(tmp_path, f"other{i}")
        (other / "window-20250101").mkdir()
        for name, text in files.items():
            (other / "window-20250101" / name).write_text(text)
        env = _world(other)
        q = subprocess.run(["bash", "-c", block], capture_output=True, text=True, timeout=60, env=env, cwd=other / "window-20250101")
        assert not any(verb in c for c in Path(env["CALLS"]).read_text().splitlines()) and said in q.stdout, (i, "another window's folder")


def test_the_first_blocks_make_and_enter_the_folder_on_the_machine_and_on_the_vm_and_the_sheet_says_to_do_it_in_every_shell() -> None:
    zero = _section("## 0. Read-only", "## 1. Rehearsal")
    assert "**One folder per window.**" in zero and "**from the repository checkout**" in zero and "(`REPO`, which the blocks use for the repository's own scripts)" in zero and "On the VM (no checkout there; the same folder name)" in zero
    machine = _block_with('REPO=$(git rev-parse --show-toplevel)')
    assert machine.strip() == '[ -n "$WINDOW" ] && REPO=$(git rev-parse --show-toplevel) && mkdir -p "$HOME/prod-move/window-${WINDOW}" && cd "$HOME/prod-move/window-${WINDOW}" && pwd'
    vm = _block_with('mkdir -p "$HOME/window-${WINDOW}"')
    assert vm.strip() == '[ -n "$WINDOW" ] && mkdir -p "$HOME/window-${WINDOW}" && cd "$HOME/window-${WINDOW}" && pwd'
    # run for real: the folder is made outside the checkout and REPO points at the checkout
    import subprocess as sp
    home = Path(os.environ.get("TMPDIR", "/tmp")) / "prodsheet-home"
    home.mkdir(exist_ok=True)
    out = sp.run(["bash", "-c", machine.strip() + '; echo "REPO=$REPO"'], capture_output=True, text=True, cwd=_ROOT, env={**os.environ, "WINDOW": "20261102", "HOME": str(home)})
    assert out.returncode == 0 and f"{home}/prod-move/window-20261102" in out.stdout and f"REPO={_ROOT}" in out.stdout, out.stderr


def test_g3_switches_the_workflow_off_and_looks_for_queued_runs_of_main_not_only_for_builds() -> None:
    g3 = next(line for line in SHEET.splitlines() if line.startswith("| **G3."))
    for token in ("`gh workflow disable cloud-build.yml`", "select(.status != \"completed\" and .workflowName == \"Cloud Build (GCP)\")", "prints no line of the branch `main`", "a queued run submits its Cloud Build later; the workflow does not cancel it",
                  "`gh run cancel $RUN_ID`", "`gcloud builds list --project $PROJECT --ongoing --limit 200"):
        assert token in g3, token
    name = next(line for line in (_ROOT / ".github/workflows/cloud-build.yml").read_text().splitlines() if line.startswith("name:"))[len("name:"):].strip()
    assert f'.workflowName == \\"{name}\\"' in g3 or f'.workflowName == "{name}"' in g3.replace('\\"', '"'), "the name the filter uses is the workflow's name"
    assert "cancel-in-progress: false" in (_ROOT / ".github/workflows/cloud-build.yml").read_text(), "the premise: a queued run is not cancelled by a newer one"
    assert "`gh workflow enable cloud-build.yml`) just before P3 is merged" in SHEET


# ── the security lens (Kadir, 2026-10-28): the dependents read, the G2 look, the dump copies, the small four ──

def test_the_dependents_loop_lists_a_service_that_reaches_the_database_by_the_socket_the_secret_or_the_address(tmp_path: Path) -> None:
    block = _block_with("USES CLOUD SQL PROD")
    for i, (extra, listed) in enumerate(((":sprintable-prod", True), ("DATABASE_URL_PROD_PGBOUNCER", True), ("10.110.0.3", True), ("nothing of the kind", False))):
        p, _ = _run(block, _fresh(tmp_path, f"d{i}"), extra={"DESC_EXTRA": extra})
        assert ("USES CLOUD SQL PROD: services sprintable-backend-prod" in p.stdout) is listed, (extra, p.stdout[:200])
        assert "dependents: listed" in p.stdout and "invokers: listed" in p.stdout, "the pass lines"
    assert '-e ":${SQL}" -e "DATABASE_URL_PROD" -e "${SRC_IP}"' in block and "no-such-address" not in block, "no fallback address: an unreadable one is a stop"


def test_the_dependents_and_invokers_ladders_fail_closed(tmp_path: Path) -> None:
    """codex: a failed list or describe, or a source address that could not be read, used to become an empty inventory («nothing depends on prod»)"""
    block = _block_with("USES CLOUD SQL PROD")
    p, _ = _run(block, _fresh(tmp_path, "unreadable"), extra={"DESC_EXTRA": "10.110.0.3", "SRC_IP": ""})
    assert "dependents: no" in p.stdout and "USES CLOUD SQL PROD" not in p.stdout and "dependents: listed" not in p.stdout
    p, _ = _run(block, _fresh(tmp_path, "listfail"), extra={"FAIL": "run services list"})
    assert "dependents: failed" in p.stdout and "dependents: listed" not in p.stdout
    p, _ = _run(block, _fresh(tmp_path, "descfail"), extra={"FAIL": "run services describe sprintable-frontend-prod"})
    assert "dependents: failed" in p.stdout and "USES CLOUD SQL PROD: services sprintable-frontend-prod" not in p.stdout
    p, _ = _run(block, _fresh(tmp_path, "jobfail"), extra={"FAIL": "run jobs describe"})
    assert "dependents: failed" in p.stdout, "the jobs are read the same way"
    p, _ = _run(block, _fresh(tmp_path, "polfail"), extra={"FAIL": "get-iam-policy sprintable-frontend-prod"})
    assert "invokers: failed" in p.stdout and "invokers: listed" not in p.stdout
    p, _ = _run(block, _fresh(tmp_path, "garbage"), extra={"GARBAGE": "sprintable-frontend-prod"})
    assert "invokers: failed" in p.stdout
    p, _ = _run(block, _fresh(tmp_path, "nofolder"), where="parent")
    assert "invokers: no" in p.stdout and "== " not in p.stdout, "outside the folder of the window the invokers are not read"
    p, _ = _run(block, _fresh(tmp_path, "ok"))
    assert "the operator account (it stays an invoker in the freeze): operator@example.com" in p.stdout
    for member in ("allUsers", CALLER, "user:operator@example.com"):
        assert member in p.stdout, member


def test_the_g2_look_prints_what_the_expected_output_says_and_names_an_open_port(tmp_path: Path) -> None:
    block = _block_with("VMSA=$(gcloud compute")
    p, calls = _run(block, _fresh(tmp_path, "ok"))
    assert p.returncode == 0, p.stderr
    for token in ("the VM's account: vm-sa@sprintable-494803.iam.gserviceaccount.com", "sprintable-vm-prod-deploy: enforced", "sprintable-vm-prod-backups: enforced", "closed from outside: 22", "closed from outside: 3389", "closed from outside: 5432",
                  "JWT_SECRET_PROD enabled=1 vm_accessor=1", "DB_PASSWORD_VM_PROD enabled=1 vm_accessor=1"):
        assert token in p.stdout, (token, p.stdout)
    assert _verbs(calls, "firewall-rules list") and not [c for c in calls if c.startswith("gcloud") and any(w in c.split() for w in _WRITES)], "read only"
    p, _ = _run(block, _fresh(tmp_path, "open"), extra={"OPEN_PORT": "5432"})
    assert "OPEN from outside: 5432" in p.stdout and "closed from outside: 22" in p.stdout
    # the two Cloud SQL connection strings are not in the declaration the VM reads: no id of the list is one of them
    from subprocess import run as _r
    ids = _r([__import__("sys").executable, str(_ROOT / "deploy/vm/bin/render_env.py"), "--secret-ids", str(_ROOT / "deploy/vm/env/prod.yaml")], capture_output=True, text=True).stdout.split()
    assert len(ids) == 21 and not [i for i in ids if i.startswith("DATABASE_URL")], ids
    assert "ids in the declaration: 21" in SHEET and "then each of the 21 ids prints" in SHEET


def test_the_lifecycle_rule_of_the_sheet_is_the_one_of_runbook_section_one(tmp_path: Path) -> None:
    import json
    block = _block_with("lifecycle.json <<'EOF'")
    p, calls = _run(block, _fresh(tmp_path, "lc"))
    assert p.returncode == 0, p.stderr
    written = json.loads((_w(tmp_path / "lc") / "lifecycle.json").read_text())
    runbook = json.loads(RUNBOOK_TEXT.split("lifecycle.json <<'EOF'")[1].split("EOF")[0])
    assert written == runbook and {r["condition"]["matchesPrefix"][0]: r["condition"]["age"] for r in written["rule"]} == {"db/": 14, "status/": 7, "import/": 7, "cloudsql-final/": 30}
    assert _verbs(calls, "buckets update") and "--lifecycle-file=lifecycle.json" in "\n".join(calls)
    assert "14 days  db/" in p.stdout and "7 days  status/" in p.stdout and "7 days  import/" in p.stdout and "30 days  cloudsql-final/" in p.stdout, p.stdout


RUNBOOK_TEXT = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()


def test_the_rate_limits_the_sheet_lists_are_the_ones_in_the_code_and_the_acceptance_is_per_route() -> None:
    import ast
    limits: dict[str, int] = {}
    for f in (_ROOT / "backend/app/routers").glob("*.py"):
        tree = ast.parse(f.read_text())
        prefix = ""
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and getattr(node.value.func, "id", "") == "APIRouter":
                prefix = next((k.value.value for k in node.value.keywords if k.arg == "prefix"), "")
        for node in ast.walk(tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                lim = next((d for d in node.decorator_list if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "limit" and getattr(d.func.value, "id", "") == "limiter"), None)
                route = next((d for d in node.decorator_list if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in ("get", "post")), None)
                if lim and route:
                    limits[prefix + route.args[0].value] = lim.args[0].value   # the whole «5/minute» — a unit must not be stripped (60/hour is not 60/minute)
    # the sheet is the HOSTED deployment's: a limit counts only if its route is registered on the app a hosted process builds. A router that is
    # registered conditionally (story 4825's embedded-only `local_auth`: no embedded switch in a hosted environment, so no route — pinned by
    # test_4825_local_bootstrap_realdb.py::test_08) is not on the sheet, and no file name has to be excepted here.
    from app.main import app as _hosted_app
    registered = {getattr(r, "path", None) for r in _hosted_app.routes}
    limits = {path: n for path, n in limits.items() if path in registered}
    assert limits == {"/api/v2/legal/{doc_type}": "120/minute", "/api/v2/auth/register": "5/minute", "/api/v2/auth/token": "20/minute", "/api/v2/auth/refresh": "120/minute", "/api/v2/auth/switch-account": "20/minute",
                      "/api/v2/auth/native-bootstrap": "10/minute", "/api/v2/auth/native-bootstrap/challenges": "10/minute", "/api/v2/auth/device-installations/registration-challenges": "10/minute",
                      "/api/v2/auth/device-installations/register": "10/minute"}, limits
    g5 = SHEET.split("**The two acceptances of G5")[1].split("## G2, the read-only look")[0]
    from app.core.rate_limit import REFRESH_PERSON_LIMIT, _rate_key_client_ip_only, limiter   # the per-person refresh number is read from the code (with its unit), so the sheet cannot drift from it
    count, unit = REFRESH_PERSON_LIMIT.split("/")
    assert unit == "minute" and f"{count} a minute per signed-in person" in g5, REFRESH_PERSON_LIMIT
    from app.core.rate_limit import open_setup_limiter, resend_verification_limiter
    assert limiter._key_func is open_setup_limiter._key_func is resend_verification_limiter._key_func is _rate_key_client_ip_only, "the sheet says every limit counts the user's address (client_ip), not the socket address"
    from app.routers.auth_firebase_internal import _handoff_rate_key
    import inspect
    assert "fold_ip(_client_ip(request))" in inspect.getsource(_handoff_rate_key), "the OAuth hand-off counts the same address unit"
    # the sheet's claim about the way in is checked against the declarations it talks about (parsed, not searched as text): prod forwards the front door's address and does NOT yet declare the edge secret
    import yaml as _yaml

    def _all_strings(o) -> set[str]:
        if isinstance(o, dict):
            return {str(k) for k in o} | {x for v in o.values() for x in _all_strings(v)}
        if isinstance(o, list):
            return {x for v in o for x in _all_strings(v)}
        return {o} if isinstance(o, str) else set()

    prod = _yaml.safe_load((_ROOT / "deploy/vm/env/prod.yaml").read_text())
    assert prod["services"]["backend"]["added"]["TRUST_FORWARDED_FOR"] == "true", "the sheet says prod trusts the forwarded address"
    assert not any("EDGE_CLIENT_IP_SECRET" in x for x in _all_strings(prod)), "the sheet says prod has no edge secret yet (neither service names one) — change both together"
    for token in ("`POST /api/v2/auth/register` 5 a minute", "`/auth/token` 20 a minute", "`/auth/native-bootstrap`, `/auth/native-bootstrap/challenges`, `/auth/device-installations/registration-challenges` and `/auth/device-installations/register` 10 a minute each",
                  "`/auth/refresh` 120 a minute (and, once its token's signature is checked, 60 a minute per signed-in person) and `/auth/switch-account` 20 a minute", "`GET /api/v2/legal/{doc_type}` 120 a minute", "prod's `env/prod.yaml` does not yet",
                  "prod sets `TRUST_FORWARDED_FOR`", "conservative upper bound", "the stricter **60 a minute per signed-in person**", "this is an approximation, not an exact check", "about 55 a minute", "**Accepted** only if the busiest minute of every route is below its limit", "**not accepted** if any is at or above it",
                  "(1) **One account for the VM, in prod too:** prod takes the account model of [RUNBOOK §2](RUNBOOK.md) as it is"):
        assert token in g5, token
    block = _block_with("for route in register token")
    for route in ("register", "token", "refresh", "switch-account", "native-bootstrap", "device-installations/registration-challenges", "device-installations/register"):
        assert route in block.split("for route in ")[1].split("; do")[0].split(), route


def test_the_acceptances_use_neutral_words_because_the_repository_is_public() -> None:
    g5 = SHEET.split("**The two acceptances of G5")[1].split("## G2, the read-only look")[0]
    for word in ("secret id", "service account", "@", "iam.gserviceaccount", "gs://", "roles/"):
        assert word not in g5.split("```")[0], word


def test_the_scheduler_by_the_script_applies_only_after_the_plan_is_exactly_four_updates(tmp_path: Path) -> None:
    block = _block_with("SCHP=no")
    four = "\n".join(f"UPDATE job-{i}-prod [GET x · * * * * *] — uri" for i in range(4)) + "\nUNCHANGED 0\ndry-run — 바꾼 것 없음(--apply로 적용)"
    p, calls = _run(block, _fresh(tmp_path, "ok"), extra={"PLAN_OUT": four})
    pys = [c for c in calls if c.startswith("python3 /repo/infra/apply_cloud_scheduler.py")]
    assert len(pys) == 3 and "--apply" not in pys[0] and "--apply" in pys[1] and "--apply" not in pys[2] and "scheduler (script): verified" in p.stdout, (pys, p.stdout)
    assert all("--env prod --base-url https://api.sprintable.ai" in c for c in pys)
    for name, plan in (("three", four.replace("UPDATE job-3-prod [GET x · * * * * *] — uri\n", "")), ("create", four + "\nCREATE job-9-prod [GET x]"), ("unmanaged", four + "\nUNMANAGED hand-made-prod (정의에 없음)"),
                       ("five", four + "\nUPDATE job-4-prod [GET x] — uri")):
        p, calls = _run(block, _fresh(tmp_path, name), extra={"PLAN_OUT": plan})
        assert len([c for c in calls if c.startswith("python3 /repo/infra")]) == 1 and "scheduler (script): start" in p.stdout, (name, p.stdout[-200:])
    for name, extra in (("norepo", {"REPO": ""}), ("nowindow", {"WINDOW": ""})):
        p, calls = _run(block, _fresh(tmp_path, name), extra={"PLAN_OUT": four, **extra})
        assert not [c for c in calls if c.startswith("python3")] and "scheduler (script): no" in p.stdout, name
    p, calls = _run(block, _fresh(tmp_path, "elsewhere"), where="parent", extra={"PLAN_OUT": four})
    assert not [c for c in calls if c.startswith("python3")] and "scheduler (script): no" in p.stdout, "outside the folder of the window nothing runs"


def test_the_notice_carries_the_freeze_wait_and_the_request_timeout_is_read_before_the_window() -> None:
    assert "**plus the wait of the freeze**" in SHEET and "1810 s if prod's timeout is 1800 s" in SHEET and "**with the freeze wait and step 4b added**" in SHEET
    assert "the notice's window is **1810 s + the rehearsal's measured downtime + the seconds of step 4b**" in SHEET and "(the window of the notice is 1810 s + the rehearsal's downtime + the seconds of 4b)" in SHEET
    block = _block_with("SRC_IP=$(gcloud sql")
    assert "value(spec.template.spec.timeoutSeconds)" in block and "the freeze waits $((TMO + 10)) s" in block


def test_the_positive_control_of_the_build_check_and_what_the_product_owner_measured() -> None:
    g3 = next(line for line in SHEET.splitlines() if line.startswith("| **G3."))
    for token in ("**with a positive control, so the empty answer cannot be vacuous**", "--limit 40", "must print at least one line ending in `prod`", "of the last 40 builds three end in `prod`, the last of 2026-10-27 07:18 UTC"):
        assert token in g3, token


def test_the_day_after_cleans_this_windows_copies_by_name_and_leaves_the_bucket_to_the_rule() -> None:
    day = _section("## 10–11. The day after", "## 12. The way back")
    for token in ("**The copies of the production database are cleaned up.**", "**lifecycle rule for `import/`**", "sudo ls -l /srv/sprintable/import", "`sudo rm -- /srv/sprintable/import/NAME`",
                  "once the removal sheet of Cloud SQL prod has made its own exports", "**of this window's files only and by name**", "Never a pattern", "Write the names deleted and the date in the record of G5"):
        assert token in day, token
    assert "gcloud storage rm" not in day
    code = "\n".join(b for b in re.findall(r"```\n(.*?)```", day, flags=re.S))
    assert "-delete" not in code and "find " not in code and "rm " not in code, "the only command of the block lists the folder; deleting is typed by name, never a pattern (it would take another window's safety copies)"


def test_the_job_of_03_kst_is_named_in_the_freeze_with_what_happens_to_that_night() -> None:
    five = _section("## 5. Freeze", "## 6–7.")
    for token in ("**The daily job inside the window.**", "`assets-grace-hard-delete-prod` runs at **03:00 Asia/Seoul — the first minute of the window**", "`storage-usage-warn-prod` at 09:00 KST, outside", "its run of that night is **skipped**",
                  "Cloud Scheduler does not catch up a run it missed", "gcloud scheduler jobs run assets-grace-hard-delete-prod", "writes the decision down"):
        assert token in five, token


# ── the follow-up of the first merge: scheduler gate, G5 families, G1a, wording ──

def test_the_scheduler_ladder_applies_only_when_all_four_updates_change_nothing_but_the_address(tmp_path: Path) -> None:
    block = _block_with("SCHP=no")
    four = "\n".join(f"UPDATE job-{i}-prod [GET x · * * * * *] — uri" for i in range(4)) + "\nUNCHANGED 0\ndry-run — nothing changed (--apply applies)"
    p, calls = _run(block, _fresh(tmp_path, "ok"), extra={"PLAN_OUT": four})
    assert "scheduler (script): verified" in p.stdout
    for name, post in (("post-update", "UPDATE job-0-prod [GET x] — uri\nUNCHANGED 3"), ("post-create", "UNCHANGED 4\nCREATE job-9-prod [GET x]"), ("post-unmanaged", "UNCHANGED 4\nUNMANAGED hand-made-prod"), ("post-three", "UNCHANGED 3")):
        p, calls = _run(block, _fresh(tmp_path, name), extra={"PLAN_OUT": four, "PLAN_POST": post})
        assert "scheduler (script): applied" in p.stdout and "verified" not in p.stdout, (name, p.stdout[-200:])
    for name, bad in (("schedule", "— schedule, uri"), ("schedule-first", "— uri, schedule"), ("other", "— headers"), ("retry", "— retry")):
        plan = four.replace("UPDATE job-3-prod [GET x · * * * * *] — uri", f"UPDATE job-3-prod [GET x · * * * * *] {bad}")
        p, calls = _run(block, _fresh(tmp_path, name), extra={"PLAN_OUT": plan})
        assert len([c for c in calls if c.startswith("python3 /repo/infra")]) == 1 and "scheduler (script): start" in p.stdout, (name, p.stdout[-160:])
    assert "grep -c '^UPDATE .* — uri$'" in block


def test_the_p5_line_says_no_uri_and_the_g2_secrets_line_counts_its_ids(tmp_path: Path) -> None:
    assert "standard output, no headers, no URI)" in SHEET and "no query string" not in SHEET
    p, _ = _run(_block_with("VMSA=$(gcloud compute"), _fresh(tmp_path, "g2"))
    assert "ids in the declaration: 2" in p.stdout, "the count line is printed after the loop (the fake declaration has two ids; the real one has 21)"
    look = _section("## G2, the read-only look", "## The prod pipeline")
    for token in ("PyYAML", "`0` — that is a stop, not a pass", "and for the rules that name no tag (they apply to every machine of the project)"):
        assert token in look, token


def test_the_second_family_of_limits_is_the_one_in_the_code() -> None:
    import ast
    found: dict[str, int] = {}
    for rel in ("desktop_setup.py", "onboarding.py"):
        tree = ast.parse((_ROOT / "backend/app/routers" / rel).read_text())
        prefix = next(k.value.value for n in tree.body if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and getattr(n.value.func, "id", "") == "APIRouter" for k in n.value.keywords if k.arg == "prefix")
        for node in ast.walk(tree):
            if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                lim = next((d for d in node.decorator_list if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "limit" and getattr(d.func.value, "id", "") == "open_setup_limiter"), None)
                route = next((d for d in node.decorator_list if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "post"), None)
                if lim and route:
                    found[prefix + route.args[0].value] = lim.args[0].value   # the whole «10/minute» — a unit must not be stripped
    assert found == {"/api/v2/desktop/setup-codes": "10/minute", "/api/v2/desktop/setup-codes/exchange": "240/minute", "/api/v2/desktop/device-token-codes": "10/minute", "/api/v2/desktop/device-token-codes/exchange": "240/minute", "/api/v2/onboarding/events": "120/minute"}, found
    handoff = (_ROOT / "backend/app/routers/auth_firebase_internal.py").read_text()
    assert "_OAUTH_HANDOFF_CUSTOM_SCHEME_ISSUE_LIMIT = 5" in handoff and "_OAUTH_HANDOFF_CUSTOM_SCHEME_CONSUME_LIMIT = 10" in handoff
    auth = (_ROOT / "backend/app/routers/auth.py").read_text()
    assert auth.count('@resend_verification_limiter.limit("3/hour")') == 2 and '@router.post("/set-password/request")' in auth and '@router.post("/resend-verification")' in auth
    g5 = SHEET.split("**The two acceptances of G5")[1].split("## G1a")[0]
    for token in ("**A second family has always counted by `client_ip`**", "`POST /api/v2/desktop/setup-codes` and `POST /api/v2/desktop/device-token-codes` 10 a minute each", "their two `…/exchange` routes 240 a minute each",
                  "`POST /api/v2/onboarding/events` 120 a minute", "the OAuth hand-off `issue` (5) and `consume` (10) a minute", "`POST /api/v2/auth/set-password/request` and `POST /api/v2/auth/resend-verification` 3 an hour each",
                  "otherwise as the front end's one address"):
        assert token in g5, token
    block = _block_with("for route in desktop/setup-codes")
    for path in ("desktop/setup-codes", "desktop/setup-codes/exchange", "desktop/device-token-codes", "desktop/device-token-codes/exchange", "onboarding/events", "internal/auth/oauth-handoff/issue", "internal/auth/oauth-handoff/consume"):
        assert path in block.split("for route in ")[1].split("; do")[0].split(), path
    assert 'echo "== GET /api/v2/legal/: busiest minutes of the last 7 days (count minute)"' in block and "/api/v2/legal/" in block and 'requestMethod=\\"GET\\"' in block and "auth/set-password/request auth/resend-verification" in block and "cut -c1-13" in block, "the legal route (GET) and the two hourly routes are measured too"


def test_the_promotion_gate_is_before_g2_and_says_what_it_carries() -> None:
    table = _section("## G. Gates", "**The two acceptances of G5")
    assert table.index("| **G1a.") < table.index("| **G2.") and table.index("| **G1.") < table.index("| **G1a.")
    row = next(line for line in table.splitlines() if line.startswith("| **G1a."))
    for token in ("`develop` is promoted to `main` once, as an ordinary prod deploy, **before** the window", "one day of real use", "the window carries the infrastructure move and no code change", "The promotion carries **no migration** (measured by the product owner, 2026-10-28", "`revisions to run: 0`", "the lines under it are read for the time two revisions run side by side"):
        assert token in row, token
    sec = _section("## G1a, the migrations of the promotion", "## G2, the read-only look")
    assert "**Expected: the promotion carries no migration.**" in sec and "Only if the number is **not 0** does the rest of this section apply" in sec
    for token in ("runs the migration job **before** it deploys the backend", "previous revision of the code serves against the new schema", "Read every line it prints", "A stop — the promotion waits for a compatible plan", "blocks writes to its table while it scans it", "0467 to 0469"):
        assert token in sec, token


def test_the_migration_reading_block_lists_what_a_running_old_revision_could_not_live_with(tmp_path: Path) -> None:
    block = _block_with("promotion-history.txt")
    assert "CUR=${CUR:?" in block and "alembic history -r" in block and "--sql" not in block, "files and the history only: no offline SQL (it cannot run the data-reading revisions) and no database"
    # unset: the block stops at its first line
    p, _ = _run(block, _fresh(tmp_path, "unset"), extra={"REPO": str(_ROOT)})
    assert p.returncode != 0 and "CUR is not set" in p.stderr
    # the three newest revisions of develop at the time of writing: only the two index builds show
    root = _fresh(tmp_path, "new")
    p, _ = _run(block, root, extra={"REPO": str(_ROOT), "CUR": "0466"})
    assert p.returncode == 0, p.stderr
    newer = [f for f in (_ROOT / "backend/alembic/versions").glob("0*.py") if int(re.match(r"0(\d{3})", f.name).group(1)) > 466]
    assert len(newer) >= 3 and f"revisions to run: {len(newer)}" in p.stdout  # the revisions after 0466 — counted from the files, so a new migration does not move this (story 4826)
    hits = [line for line in p.stdout.splitlines() if re.match(r"^0\d{3}[a-z]?_\S+\.py:\d+: ", line)]
    # story #4846: 0471 alters a column and a foreign key — exactly what the block exists to list. Every OTHER revision after 0466 is still only an index build.
    mine = [h for h in hits if h.startswith("0471_")]
    assert any("alter_column" in h for h in mine) and any("drop_constraint" in h for h in mine), mine
    # story #4846: 0472 swaps the foreign key of `events` (written in upgrade() itself, so the reading lists it)
    swap = [h for h in hits if h.startswith("0472_")]
    assert any("DROP CONSTRAINT" in h for h in swap) and any("ON DELETE SET NULL NOT VALID" in h for h in swap) and not any("VALIDATE" in h for h in swap), swap
    # story #4888: 0473 is a data-only `UPDATE` of one text column of `workflow_trigger_types` (the system «kickoff» description, «에픽» → «목표»), written in upgrade() itself so the reading lists it:
    # one line, an UPDATE restricted to system rows with exactly the old text — no DDL, no table swap, nothing an old release could not live with.
    words = [h for h in hits if h.startswith("0473_")]
    assert len(words) == 1 and "UPDATE workflow_trigger_types SET description" in words[0] and "is_system = true" in words[0] and not any(k in words[0] for k in ("DROP", "ALTER", "VALIDATE")), words
    # story 4920: 0474 is a data-only `UPDATE` of the platform «preset.steer.instruct» row of `event_definitions` (the work item stops being required; the card's «대상» line becomes optional), written in upgrade() itself so the reading lists it:
    # one line, restricted to the platform row (`org_id IS NULL`) by key — no DDL, no table swap, nothing an old release could not live with (the old release's composer still sends a work item, which the schema still allows).
    steer = [h for h in hits if h.startswith("0474_")]
    assert len(steer) == 1 and "UPDATE event_definitions SET payload_schema" in steer[0] and "org_id IS NULL" in steer[0] and not any(k in steer[0] for k in ("DROP", "ALTER", "VALIDATE")), steer
    # story 4921: 0475 is the same kind of line — a data-only `UPDATE` of the platform «preset.steer.instruct» row (its card template only), written in upgrade() itself so the reading lists it; the key and `org_id IS NULL` bound the rows.
    card = [h for h in hits if h.startswith("0475_")]
    assert len(card) == 1 and "UPDATE event_definitions SET block_template" in card[0] and "org_id IS NULL" in card[0] and not any(k in card[0] for k in ("DROP", "ALTER", "VALIDATE")), card
    # story #4951: 0477 puts one more word into the command-kind CHECK (`read_changes`: the CHECK is dropped and made again — an old revision never writes the new word, every value it does write still passes), makes two new tables with
    # their indexes and one partial index on `desktop_commands`; nothing existing is altered, backfilled or locked for long. The reading lists exactly those lines (upgrade and downgrade): the CHECK swap and index builds, nothing else.
    kinds = [h for h in hits if h.startswith("0477_")]
    assert any("drop_constraint" in h and "ck_desktop_commands_kind" in h for h in kinds) and any("create_check_constraint" in h and "ck_desktop_commands_kind" in h for h in kinds), kinds
    assert all("create_index" in h or "ck_desktop_commands_kind" in h for h in kinds), kinds
    # story 4972: 0479 is what the reading lists as FOUR lines of upgrade(): the column `sealed` (NOT NULL with a constant default — Postgres stores that without rewriting the table, and an old revision that never names it
    # gets false), the old CHECK of `agent_permission_requests` dropped, the new one added NOT VALID (a brief lock, no scan) and then VALIDATEd (a scan that does not block writers). Why a running old revision lives with it:
    # it never writes `sealed` or `envelope` (the other new column — nullable, so not listed), and every row it writes (text tool + summary, a hash, no envelope, sealed false; or a terminal-only row with no hash) satisfies the new rule
    # as it satisfied the old; nothing existing is renamed, dropped, backfilled or rewritten. The downgrade() is not read (it keeps the sealed rows as terminal-only cards, then restores the old CHECK).
    sealed = [h for h in hits if h.startswith("0479_")]
    assert len(sealed) == 4, sealed
    assert any("add_column" in h and '"sealed"' in h and "nullable=False" in h and "server_default" in h for h in sealed), sealed
    assert any("drop_constraint" in h and "_CHECK" in h for h in sealed) and any("NOT VALID" in h for h in sealed) and any("VALIDATE CONSTRAINT" in h for h in sealed), sealed
    assert not any(k in h for h in sealed for k in ("DROP COLUMN", "drop_column", "alter_column", "rename_", "UPDATE", "DELETE")), "no data written, no column dropped or retyped"
    # story 4972: 0480 is THREE lines of upgrade(): the CHECK of 0479 dropped, the new one added NOT VALID (a brief lock, no scan) and then VALIDATEd (a scan; the lock is held to the commit). Why a running old revision lives with it: the rule
    # only gets LOOSER where it changes anything (the terminal-only branch no longer says `NOT sealed`) and the one new coupling (a request holds its envelope exactly while pending) is what the code of 0479 already does, so every row an old revision writes still passes; no column is added, dropped, retyped or rewritten, and no row is written. Every migration of a run shares one transaction, so the lock is held through the VALIDATE scan: writes to this table wait that long (a small table). The downgrade() is not read.
    loosened = [h for h in hits if h.startswith("0480_")]
    assert len(loosened) == 3, loosened
    assert any("drop_constraint" in h and "_CHECK" in h for h in loosened) and any("NOT VALID" in h for h in loosened) and any("VALIDATE CONSTRAINT" in h for h in loosened), loosened
    assert not any(k in h for h in loosened for k in ("add_column", "DROP COLUMN", "drop_column", "alter_column", "rename_", "UPDATE", "DELETE")), "no column, no data touched"
    # story 4972 (4a): 0482 is THREE lines of upgrade() the reading lists: the CHECKs on the two columns it adds to `remote_device_pairing_sessions` (the `add_column` lines of two NULLABLE columns are not listed — they are not rewrites).
    # Why a running old revision lives with it: it never writes either column, so every row it writes has both NULL and every one of the three CHECKs passes for NULLs (both-or-neither · only-after-a-reveal · size); the table is tiny
    # (an offer lives five minutes, rows older than an hour are deleted when the next QR is made), so the validating scan under the CHECK's brief lock is nothing; nothing existing is altered, dropped, renamed, backfilled or rewritten.
    receipt = [h for h in hits if h.startswith("0482_")]
    assert len(receipt) == 3 and all("create_check_constraint" in h and "ck_pairing_sessions_confirm_" in h for h in receipt), receipt
    assert not any(k in h for h in receipt for k in ("drop_", "DROP", "alter_column", "rename_", "UPDATE", "DELETE", "add_column")), "no column dropped or retyped, no data touched"
    # story 4972 (AC3 ①): 0483 is THREE lines of upgrade() the reading lists: the trigger FUNCTION (`CREATE OR REPLACE FUNCTION desktop_setups_sealed_cards_one_way` — a new function; nothing existing is touched), `DROP TRIGGER IF EXISTS` (nothing is
    # there yet) and the `CREATE TRIGGER` on `desktop_setups`. The column it adds (`sealed_cards_at`, nullable, no default) is an `add_column` line the reading does not list (no rewrite). Why a running old revision lives with it: it never writes the column,
    # so every UPDATE it makes to a `desktop_setups` row leaves it NULL (`OLD.sealed_cards_at IS NOT NULL` is false → the function raises nothing and returns the row); the check is one comparison per updated row; nothing existing is altered,
    # dropped, renamed, backfilled or rewritten, and no data is written by the migration.
    mark = [h for h in hits if h.startswith("0483_")]
    assert len(mark) == 3, mark
    assert any("DROP TRIGGER IF EXISTS trg_desktop_setups_sealed_cards_one_way ON desktop_setups" in h for h in mark), mark
    assert not any(k in h for h in mark for k in ("add_column", "DROP COLUMN", "drop_column", "alter_column", "rename_", "UPDATE", "DELETE")), "no column dropped or retyped, no data touched"
    # (codex: the reading sees only the `op.execute(` line of a multi-line SQL string — so the SQL INSIDE the three calls is read here, from the file itself: nothing in upgrade() writes data, drops, renames or retypes)
    up0483 = (_ROOT / "backend/alembic/versions/0483_desktop_setups_sealed_cards.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|DROP\s+COLUMN|RENAME|ALTER\s+COLUMN|ALTER\s+TABLE)\b|\bUPDATE\s+\w+\s+SET\b|drop_column|alter_column|rename_", up0483), "0483's upgrade() adds a column, a function and a trigger — no data written, nothing dropped or retyped"
    # story 5025 (B1): 0499 is the same shape as 0483, THREE lines of upgrade() the reading lists: the trigger FUNCTION (`CREATE OR REPLACE FUNCTION desktop_setups_seal_to_v1_one_way` — a new function), `DROP TRIGGER IF EXISTS` (nothing is there yet) and the
    # `CREATE TRIGGER` on `desktop_setups`; the column (`seal_to_v1_at`, nullable, no default) is an `add_column` line the reading does not list (no rewrite). Why a running old revision lives with it: it never writes the column, so every UPDATE it makes to a
    # `desktop_setups` row leaves it NULL (`OLD.seal_to_v1_at IS NOT NULL` is false → nothing raised, the row returned); one comparison per updated row; nothing existing is altered, dropped, renamed, backfilled or rewritten; no data is written by the migration.
    seal_v1 = [h for h in hits if h.startswith("0499_")]
    assert len(seal_v1) == 3, seal_v1
    assert any("op.execute(" in h for h in seal_v1) and not any(k in h for h in seal_v1 for k in ("add_column", "DROP COLUMN", "drop_column", "alter_column", "rename_", "UPDATE", "DELETE")), seal_v1
    up0499 = (_ROOT / "backend/alembic/versions/0499_desktop_setups_seal_to_v1.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|DROP\s+COLUMN|RENAME|ALTER\s+COLUMN|ALTER\s+TABLE)\b|\bUPDATE\s+\w+\s+SET\b|drop_column|alter_column|rename_", up0499), "0499's upgrade() adds a column, a function and a trigger — no data written, nothing dropped or retyped"
    # story 5025 (C1): 0500 is the same shape as 0495's first half — the `drop_constraint` of `ck_desktop_commands_kind` (made again at once with ONE word more: every word a running old revision writes still passes — the new CHECK is the old one
    # PLUS `capability_set`); three columns on `desktop_setups` (`add_column`: `capability_serial` NOT NULL with the constant default 0 — the reading lists that one: a constant default is metadata only, no rewrite · `capability_hash` · `capability_pushed_at` nullable) and one new table (`create_table`). Why a running old
    # revision lives with it: it never names a new column, the new table or the new word; nothing existing is altered, renamed, backfilled, deleted or retyped by upgrade(); the downgrade (not run in a cutover) deletes the new word's rows.
    cap = [h for h in hits if h.startswith("0500_")]
    assert len(cap) == 3 and any("drop_constraint" in h and "ck_desktop_commands_kind" in h for h in cap) and any("create_check_constraint" in h and "ck_desktop_commands_kind" in h for h in cap) and any("add_column" in h and "capability_serial" in h and 'nullable=False' in h and 'server_default="0"' in h for h in cap), cap  # the second: a NOT NULL column with a CONSTANT default — metadata only on this Postgres (no rewrite), an old revision's INSERT into `desktop_setups` simply gets 0
    up0500 = (_ROOT / "backend/alembic/versions/0500_capability_set.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|DROP\s+COLUMN|RENAME|ALTER\s+COLUMN)\b|\bUPDATE\s+\w+\s+SET\b|drop_column|alter_column|rename_|drop_table|create_index", up0500), "0500's upgrade() swaps one CHECK, adds three columns and one table — nothing written, dropped or retyped"
    assert up0500.count("op.drop_constraint(") == 1 and up0500.count("op.create_check_constraint(") == 1 and up0500.count("op.add_column(") == 3 and up0500.count("op.create_table(") == 1
    # story 5030 (C0): 0501 is ONE line the reading lists — the `op.execute(` of a multi-line SQL string, so the SQL INSIDE is read here, from the file itself: ONE `DELETE FROM notification_preferences` of the row agent creation SEEDED (`global · sse · all`, owner an agent,
    # `updated_at = created_at`, made within 5 seconds of the agent) and nothing else — no column, table or constraint is touched, no row is written. Why a running old revision lives with it: with the switch the old release runs under (`agent_group_default_mentions` off) a
    # preference row of `all` and NO row mean the same (`all`), so an agent that loses its seeded row is delivered exactly the words it was. (An agent created by the OLD code meanwhile still gets the seed; that row is the same no-op for the old release and is taken by a later run of the rule.)
    # Row locks only; the downgrade does nothing (nothing to put back — the same sentence).
    seeded = [h for h in hits if h.startswith("0501_")]
    assert len(seeded) == 1 and "op.execute(" in seeded[0], seeded
    up0501 = (_ROOT / "backend/alembic/versions/0501_drop_seeded_agent_global_all.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert up0501.count("DELETE FROM notification_preferences") == 1 and "m.type = 'agent'" in up0501 and "p.updated_at = p.created_at" in up0501 and "p.channel = 'sse'" in up0501 and "p.level = 'all'" in up0501, "only the proven seed"
    assert not re.search(r"\b(TRUNCATE|INSERT|DROP|RENAME|ALTER|UPDATE)\b|add_column|drop_column|alter_column|rename_|create_index|create_table", up0501), "0501 deletes rows only: no column, table or constraint touched"
    # story 4972: 0484 is FIVE lines of upgrade(): the CHECK of 0480 dropped, the new one added NOT VALID (a brief lock, no scan), the two data statements (`_END_PENDING`: a PENDING row whose window passed and that still holds words ends as `expired` — what the
    # minute job does for it from now on; `_CLEAR_ENDED`: every other ended row loses `tool · summary · workdir`, the network question's fixed words kept) and the VALIDATE. Why a running old revision lives with it: the new CHECK is only LOOSER (an ended plain
    # row may lack its words; a pending one may not — every row the old code writes is pending with its words); the old code reads `tool · summary · workdir` as nullable columns (a sealed row has had none since 0479, a terminal-only one may lack them) so a row without
    # them is a shape it already serves; open cards are not touched; nothing is renamed, dropped or added. The data change is irreversible by design (the downgrade keeps the rows as terminal-only history). The lock is held to the commit — the table keeps
    # recent requests only (ended ones are deleted after about 30 days), so the scans are small, as 0480's were.
    cleared = [h for h in hits if h.startswith("0484_")]
    assert len(cleared) == 5, cleared
    assert any("drop_constraint" in h and "_CHECK" in h for h in cleared) and any("NOT VALID" in h for h in cleared) and any("VALIDATE CONSTRAINT" in h for h in cleared), cleared
    assert any("_END_PENDING" in h for h in cleared) and any("_CLEAR_ENDED" in h for h in cleared), cleared
    assert not any(k in h for h in cleared for k in ("add_column", "DROP COLUMN", "drop_column", "alter_column", "rename_", "DELETE")), "no column added, dropped or retyped, no row deleted"
    # story 4976: 0486 is ONE statement of upgrade(): an UPDATE of `desktop_commands` — a `send_prompt` command that is over (done · failed · rejected) keeps {session_key, conversation_id} and loses the words, the plain signature (a sha256 of the words) and the
    # envelope. Why a running old revision lives with it: it only drops words from rows that are OVER (the old code never reads the payload of a finished command again — a result is stored on the row, the conversation line was written when it went `done`), no schema
    # change (no CHECK on `payload`), open commands are not touched, nothing is renamed, dropped or added. Irreversible by design (the downgrade is a no-op). Row locks only, a few rows in dev (9, measured by the PO) and a table of recent commands in prod.
    cmds = [h for h in hits if h.startswith("0486_")]
    # …and the two partial INDEXES of the minute sweep (Kadir lens 5850): `create_index` lines on `desktop_commands` only — an index build is a brief write lock on a table of recent commands, nothing rewritten or altered
    assert len(cmds) == 3 and sum("op.execute(" in h for h in cmds) == 1 and sum("create_index" in h for h in cmds) == 2, cmds
    up0486 = (_ROOT / "backend/alembic/versions/0486_desktop_prompt_ended_payload.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert "UPDATE desktop_commands" in up0486 and "kind = 'send_prompt'" in up0486 and "state IN ('done', 'failed', 'rejected')" in up0486, "only the finished instruction rows"
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|DROP|RENAME|ALTER)\b|add_column|drop_column|alter_column|rename_", up0486), "0486 changes rows only: no column or table altered, no row deleted"
    assert up0486.count("op.create_index(") == 2 and up0486.count('"desktop_commands"') == 2 and "postgresql_where" in up0486, "the two partial indexes, on `desktop_commands` only"
    # story 4983: 0488 is the same shape as 0477 — one more word in the command-kind CHECK (`file_list`: dropped and made again; an old revision never writes the new word, every value it does write still passes), one new table with its
    # two indexes and one partial index on `desktop_commands`; nothing existing is altered, backfilled or locked for long. The reading lists exactly those lines: the CHECK swap and index builds, nothing else.
    files = [h for h in hits if h.startswith("0488_")]
    assert any("drop_constraint" in h and "ck_desktop_commands_kind" in h for h in files) and any("create_check_constraint" in h and "ck_desktop_commands_kind" in h for h in files), files
    assert all("create_index" in h or "ck_desktop_commands_kind" in h for h in files), files
    # story 4983 (P6): 0491 is 0488's shape again — one more word in the command-kind CHECK (`file_read`: dropped and made again; an old revision never writes the new word, every value it does write still passes) and the one partial index
    # of the person's ask pause swapped for the same index over both kinds (the old revision never names it: it asks no files question at all). The reading lists exactly those four lines — the CHECK swap, the index dropped, the index built — nothing else.
    file_read = [h for h in hits if h.startswith("0491_")]
    assert len(file_read) == 4, file_read
    assert any("drop_constraint" in h and "ck_desktop_commands_kind" in h for h in file_read) and any("create_check_constraint" in h and "ck_desktop_commands_kind" in h for h in file_read), file_read
    assert sum("drop_index" in h and "ix_desktop_commands_file_list_by" in h for h in file_read) == 1 and sum("create_index" in h and "ix_desktop_commands_file_by" in h for h in file_read) == 1, file_read
    up0491 = (_ROOT / "backend/alembic/versions/0491_desktop_file_read_kind.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|ALTER)\b|add_column|drop_column|alter_column|rename_|drop_table", up0491), "0491's upgrade() changes no row, no column and no table"
    # story 4988 (P8): 0492 is 0491's shape once more — one more word in the command-kind CHECK (`file_download`: dropped and made again; an old revision never writes the new word) and the person's ask-pause index made again over the three
    # file words (the old revision never names it) — plus what a download needs: TWO counters on `desktop_file_reads` (`chunks_written`, `chunks_read`: NOT NULL with a CONSTANT default 0 — no table rewrite, and a running old revision never names them,
    # so every row it writes has 0 and 0), ONE CHECK over them (`chunks_read >= 0 AND chunks_read <= chunks_written AND chunks_written <= 57`: the table holds a few rows of the last ten minutes, so the scan under the CHECK's brief lock is
    # nothing, and 0 ≤ 0 ≤ 0 passes) and a NEW table `desktop_file_chunks` (hanging from the request's row by a cascading foreign key — nothing existing is altered). The reading lists exactly these seven lines. No row is changed, nothing is dropped or renamed.
    file_download = [h for h in hits if h.startswith("0492_")]
    assert len(file_download) == 7, file_download
    assert any("drop_constraint" in h and "ck_desktop_commands_kind" in h for h in file_download) and any("create_check_constraint" in h and "ck_desktop_commands_kind" in h for h in file_download), file_download
    assert sum("drop_index" in h and "ix_desktop_commands_file_by" in h for h in file_download) == 1 and sum("create_index" in h and "ix_desktop_commands_file_by" in h for h in file_download) == 1, file_download
    assert sum("add_column" in h and "nullable=False" in h and 'server_default="0"' in h and '"desktop_file_reads"' in h for h in file_download) == 2, "the two counters: NOT NULL with a constant default, on the short-lived table"
    assert sum("create_check_constraint" in h and "ck_desktop_file_reads_chunks" in h for h in file_download) == 1, file_download
    up0492 = (_ROOT / "backend/alembic/versions/0492_desktop_file_download.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|ALTER)\b|drop_column|alter_column|rename_|drop_table", up0492), "0492's upgrade() changes no row, drops nothing and renames nothing"
    assert up0492.count("op.create_table(") == 1 and '"desktop_file_chunks"' in up0492 and 'ondelete="CASCADE"' in up0492, "the one new table, hanging from the request's row"
    # story 4978 (C2): 0494 is ONE NEW table and nothing else — `desktop_record_handoffs` (a sealed record-key handoff in flight between two paired devices; hanging from the computer and the phone by two cascading foreign keys), its CHECK pair and its UNIQUE (inside
    # the `create_table`) and its three indexes. The reading lists exactly the three `create_index` lines. Why a running old revision lives with it: it never names the table; no existing table, column, constraint or row is altered, backfilled, locked or rewritten.
    # The downgrade() is not read (it drops the table nothing else refers to).
    record_handoffs = [h for h in hits if h.startswith("0494_")]
    assert len(record_handoffs) == 3 and all("create_index" in h and "desktop_record_handoffs" in h for h in record_handoffs), record_handoffs
    up0494 = (_ROOT / "backend/alembic/versions/0494_desktop_record_handoffs.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|ALTER)\b|add_column|drop_column|alter_column|rename_|drop_table|drop_constraint|drop_index|create_check_constraint", up0494), "0494's upgrade() changes no row, no column and no existing table"
    assert up0494.count("op.create_table(") == 1 and '"desktop_record_handoffs"' in up0494 and up0494.count('ondelete="CASCADE"') == 2, "the one new table, hanging from the computer and the phone"
    # story 4993 (P3): 0495 is 0491's shape plus ONE NEW table — one more word in the command-kind CHECK (`direct_open`: dropped and made again; the new CHECK is the old one plus exactly ONE word, so an old revision that never writes the word
    # still passes it with every value it does write — it lives with the new schema), one partial index over `desktop_commands` that only the new word's rows ever enter (the old revision never names it), and the new table `desktop_direct_asks`
    # (a short-lived sealed answer slot, 60 seconds; hanging from the command and the computer by two cascading foreign keys; its CHECK is inside the `create_table`, on a table that is new and empty) with its two indexes. The reading lists exactly
    # these five lines — the CHECK swap and the three index builds — nothing else. No row is changed, nothing is dropped or renamed besides the CHECK made again; the downgrade() is not read.
    direct_open = [h for h in hits if h.startswith("0495_")]
    assert len(direct_open) == 5, direct_open
    assert sum("drop_constraint" in h and "ck_desktop_commands_kind" in h for h in direct_open) == 1 and sum("create_check_constraint" in h and "ck_desktop_commands_kind" in h for h in direct_open) == 1, direct_open
    assert sum("create_index" in h for h in direct_open) == 3, direct_open
    up0495 = (_ROOT / "backend/alembic/versions/0495_desktop_direct_open.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|ALTER)\b|add_column|drop_column|alter_column|rename_|drop_table|drop_index", up0495), "0495's upgrade() changes no row, no column and no existing table"
    assert up0495.count("op.create_table(") == 1 and '"desktop_direct_asks"' in up0495 and up0495.count('ondelete="CASCADE"') == 2, "the one new table, hanging from the command and the computer"
    assert "_NEW = _OLD + (" in (_ROOT / "backend/alembic/versions/0495_desktop_direct_open.py").read_text(), "the new CHECK is the old words plus ONE — an old revision lives with it"
    # story 4976 (A5): 0489 is FOUR lines of upgrade() the reading lists: ONE data `UPDATE` (the backfill: a computer whose capabilities already hold `sealed_prompt` gets `sealed_prompts_at = now()`; restricted by `capabilities @>` to those rows, row locks only —
    # a few computers), the trigger FUNCTION (`CREATE OR REPLACE FUNCTION desktop_setups_sealed_prompts_one_way` — a new function), `DROP TRIGGER IF EXISTS` (nothing is there yet) and the `CREATE TRIGGER` on `desktop_setups`. The column it adds
    # (`sealed_prompts_at`, nullable, no default) is an `add_column` line the reading does not list (no rewrite). Why a running old revision lives with it: it never names the column, so every UPDATE it makes to a `desktop_setups` row leaves the value as it was
    # (`NEW.sealed_prompts_at IS DISTINCT FROM OLD.sealed_prompts_at` is false → the function raises nothing and returns the row); the check is one comparison per updated row; nothing existing is altered, dropped or renamed.
    sealed_prompts = [h for h in hits if h.startswith("0489_")]
    assert len(sealed_prompts) == 4, sealed_prompts
    assert sum("UPDATE desktop_setups SET sealed_prompts_at = now() WHERE capabilities @>" in h for h in sealed_prompts) == 1, sealed_prompts
    assert any("DROP TRIGGER IF EXISTS trg_desktop_setups_sealed_prompts_one_way ON desktop_setups" in h for h in sealed_prompts), sealed_prompts
    assert not any(k in h for h in sealed_prompts for k in ("add_column", "DROP COLUMN", "drop_column", "alter_column", "rename_", "DELETE")), "no column dropped or retyped, nothing deleted"
    up0489 = (_ROOT / "backend/alembic/versions/0489_desktop_setups_sealed_prompts.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|DROP\s+COLUMN|RENAME|ALTER\s+COLUMN|ALTER\s+TABLE)\b|drop_column|alter_column|rename_", up0489), "0489's upgrade() adds a column, one bounded UPDATE, a function and a trigger — nothing dropped or retyped"
    assert len(re.findall(r"\bUPDATE\s+\w+\s+SET\b", up0489)) == 1 and "capabilities @>" in up0489, "the one data statement is the bounded backfill"
    # story 4986: 0490 is ONE line of upgrade() the reading lists: the CHECK on the NULLABLE column it adds to `desktop_usage` (the `add_column` of a nullable column is not listed — it is no rewrite). Why a running old revision lives with it: it never
    # names `label`, so every row it writes has NULL and the CHECK (`label IS NULL OR char_length(label) BETWEEN 1 AND 40`) passes for NULL; the table holds at most eight rows per computer, so the scan under the CHECK's brief lock is nothing; nothing
    # existing is altered, dropped, renamed, backfilled or rewritten, and no data is written by the migration. The downgrade() is not read.
    named = [h for h in hits if h.startswith("0490_")]
    assert len(named) == 1 and "create_check_constraint" in named[0] and "ck_desktop_usage_label" in named[0], named
    assert not any(k in h for h in named for k in ("drop_", "DROP", "alter_column", "rename_", "UPDATE", "DELETE", "add_column")), "no column dropped or retyped, no data touched"
    up0490 = (_ROOT / "backend/alembic/versions/0490_desktop_usage_label.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert up0490.count("op.add_column(") == 1 and "nullable=True" in up0490 and not re.search(r"drop_column|alter_column|rename_|\bUPDATE\b|\bDELETE\b|TRUNCATE|INSERT", up0490), "0490's upgrade() adds one nullable column and its CHECK — nothing else"
    # story 5008 (A1): 0497 is the 0477 shape on THREE CHECKs — the runtime-name CHECK of `desktop_sessions`, `agent_permission_requests` and `desktop_usage` dropped and made again with the registry's five names instead of `claude · codex` (the new CHECK is the old
    # set PLUS three words, so every value a running old revision writes — `claude` · `codex` — still passes; an old revision never writes the new words). The reading lists the drop and the create of the loop in upgrade() (and the downgrade's pair, the
    # same two calls); nothing is added, altered, renamed, backfilled or deleted, and no index is built. The three tables hold a computer's sessions, the open permission cards and a few usage rows per computer, so the scan under each CHECK's brief lock is small.
    # The downgrade() STOPS (raises, changes nothing) when a row already names a new runtime — it never deletes a person's rows.
    runtime_names = [h for h in hits if h.startswith("0497_")]
    assert runtime_names and all(("drop_constraint" in h or "create_check_constraint" in h) for h in runtime_names), runtime_names
    assert any("drop_constraint" in h for h in runtime_names) and any("create_check_constraint" in h for h in runtime_names), runtime_names
    up0497 = (_ROOT / "backend/alembic/versions/0497_desktop_runtime_names.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|ALTER)\b|add_column|drop_column|alter_column|rename_|drop_table|create_index|drop_index", up0497), "0497's upgrade() only swaps three CHECKs"
    assert up0497.count("op.drop_constraint(") == 1 and up0497.count("op.create_check_constraint(") == 1 and "for table, name in _CHECKS" in up0497, "the one loop over the three runtime CHECKs"
    assert "_NEW" in (_ROOT / "backend/alembic/versions/0497_desktop_runtime_names.py").read_text() and 'raise RuntimeError(' in (_ROOT / "backend/alembic/versions/0497_desktop_runtime_names.py").read_text(), "the downgrade stops instead of deleting rows"
    # story 5032 (C2): 0502 is TWO `op.execute` lines of upgrade() the reading lists — the column (`ADD COLUMN IF NOT EXISTS is_project_channel boolean NOT NULL DEFAULT false`: a CONSTANT default is metadata only on this Postgres, no rewrite; a running old revision
    # never names it, so every row it writes gets false) and the partial UNIQUE index (`CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_project_channel … WHERE is_project_channel AND project_id IS NOT NULL`: every existing row is false, so it indexes nothing and
    # an old revision's inserts (false) never enter it; the build scans `conversations` once and blocks WRITES to it for that scan — the plain build of the repository's convention, with the by-hand `CONCURRENTLY` pre-step in the file's header for a large table).
    # Nothing is dropped, renamed, retyped, backfilled or deleted. The downgrade() is not read.
    channel = [h for h in hits if h.startswith("0502_")]
    assert len(channel) == 2 and "ADD COLUMN IF NOT EXISTS is_project_channel boolean NOT NULL DEFAULT false" in channel[0] and "op.execute(" in channel[1], channel
    up0502 = (_ROOT / "backend/alembic/versions/0502_conversations_is_project_channel.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_project_channel ON conversations (project_id)" in up0502 and "WHERE is_project_channel AND project_id IS NOT NULL" in up0502
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|DROP)\b|drop_column|alter_column|rename_|CONCURRENTLY", up0502), "0502's upgrade() adds one defaulted column and one partial unique index — nothing written, dropped or retyped"
    # story 5049 (C2 follow-up 1): 0503 is THREE `op.execute` lines of upgrade() the reading lists — the CHECK of `permission_audit_logs.action` made again with ONE word more (`bridge.inbound_skipped`): DROP CONSTRAINT IF EXISTS, ADD CONSTRAINT … NOT VALID,
    # VALIDATE CONSTRAINT. A running old revision writes only the three role-change words, every one of them is in the wider list (and in the window between the drop and the add the column is merely unchecked) — so nothing it does can fail.
    # Nothing is deleted, retyped, backfilled or renamed (the downgrade() deletes the new action's rows and is not read).
    audit = [h for h in hits if h.startswith("0503_")]
    assert len(audit) == 3 and all("op.execute(" in h and "permission_audit_logs" in h for h in audit), audit
    assert "DROP CONSTRAINT IF EXISTS permission_audit_logs_action_check" in audit[0] and "ADD CONSTRAINT permission_audit_logs_action_check CHECK" in audit[1] and "NOT VALID" in audit[1] and "VALIDATE CONSTRAINT permission_audit_logs_action_check" in audit[2], audit
    up0503 = (_ROOT / "backend/alembic/versions/0503_audit_action_bridge_skipped.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME)\b|drop_column|alter_column|rename_|add_column|create_index", up0503), "0503's upgrade() only swaps one CHECK for a wider list"
    assert "'member_added', 'member_removed', 'role_changed', 'bridge.inbound_skipped'" in (_ROOT / "backend/alembic/versions/0503_audit_action_bridge_skipped.py").read_text(), "the old three words stay in the new list"
    # story 5053: 0506 is the room-lift trigger and its backfill — FOUR `op.execute` calls of upgrade() the reading lists: the trigger FUNCTION (`CREATE OR REPLACE FUNCTION conversation_messages_bump_room` — a new function that raises
    # a room's `updated_at` to a new message's time and ONLY when the room is older), `DROP TRIGGER IF EXISTS` (nothing is there yet), the `CREATE TRIGGER … AFTER INSERT ON conversation_messages`, and ONE data `UPDATE` (the backfill: a
    # room whose last word is later than its `updated_at` gets that time — one statement, row locks on those rooms only; it runs AFTER the trigger exists, so no message slips between). A running old revision lives with it: it never names
    # the trigger; the room update it does itself on some roads is the same row at the same or an earlier time (the trigger writes nothing then); nothing is dropped, renamed, retyped or deleted. The downgrade() is not read.
    room_lift = [h for h in hits if h.startswith("0506_")]
    assert len(room_lift) == 4, room_lift
    assert any("op.execute(" in h for h in room_lift) and any("DROP TRIGGER IF EXISTS trg_conversation_messages_bump_room ON conversation_messages" in h for h in room_lift) and any("CREATE TRIGGER trg_conversation_messages_bump_room AFTER INSERT ON conversation_messages" in h for h in room_lift), room_lift
    up0506 = (_ROOT / "backend/alembic/versions/0506_conversation_messages_bump_room.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert up0506.count("UPDATE conversations c SET updated_at = LEAST(m.last_at, now())") == 1 and "AND updated_at < LEAST(NEW.created_at, now())" in up0506 and up0506.index("CREATE TRIGGER") < up0506.index("UPDATE conversations c SET"), "the trigger exists before the backfill runs"
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT\s+INTO|RENAME|DROP\s+(COLUMN|TABLE))\b|drop_column|alter_column|rename_|add_column|create_index", up0506), "0506 touches no column, index or row besides the room times"  # `AFTER INSERT` is the trigger's event, not a write
    # story 5041 (C0b): 0505 is TWO `op.execute` lines of upgrade() the reading lists — a NULLABLE column with no default on `reward_ledger` (`ADD COLUMN IF NOT EXISTS agent_action_request_id uuid`: no rewrite, no lock beyond the
    # catalogue change; a running old revision never names it, so every row it writes has NULL) and the partial UNIQUE index over it (`… WHERE agent_action_request_id IS NOT NULL`: every existing row is NULL and an old
    # revision's inserts are NULL, so none ever enters the index — it is empty when built; the plain build of the repository's convention). Nothing is dropped, renamed, retyped, backfilled or deleted. The downgrade() is not read.
    reward = [h for h in hits if h.startswith("0505_")]
    assert len(reward) == 2 and "ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS agent_action_request_id uuid" in reward[0] and "op.execute(" in reward[1], reward  # the second statement spans lines (the reading prints its first line, as for 0502's index)
    up0505 = (_ROOT / "backend/alembic/versions/0505_reward_ledger_agent_action_request.py").read_text().split("def upgrade()")[1].split("def downgrade()")[0]
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_reward_ledger_agent_action_request ON reward_ledger (agent_action_request_id) WHERE agent_action_request_id IS NOT NULL" in up0505
    assert not re.search(r"\b(DELETE|TRUNCATE|INSERT|UPDATE|RENAME|DROP|NOT NULL DEFAULT)\b|drop_column|alter_column|rename_|CONCURRENTLY|SET NOT NULL", up0505.replace("WHERE agent_action_request_id IS NOT NULL", "")), "0505's upgrade() adds one nullable column and one partial unique index — nothing more"
    hits = [h for h in hits if not h.startswith(("0471_", "0505_", "0506_", "0472_", "0473_", "0474_", "0475_", "0477_", "0479_", "0480_", "0482_", "0483_", "0484_", "0485_", "0486_", "0488_", "0489_", "0490_", "0491_", "0492_", "0494_", "0495_", "0497_", "0499_", "0500_", "0501_", "0502_", "0503_"))]
    assert len(hits) >= 2 and all("create_index" in line for line in hits), hits
    assert not any("0466_" in h for h in hits), "the version prod is at is not one of the revisions to run"
    assert any(h.startswith("0467_desktop_session_limit_cleared_at.py:") and "create_index" in h for h in hits) and any(h.startswith("0468_refresh_tokens_family_id.py:") and "create_index" in h for h in hits)
    assert not any("drop_index" in h for h in hits), "the downgrade() of 0467 and 0468 is not read"
    assert not any("drop_" in h or "alter_column" in h or "rename_" in h for h in hits), hits
    # an older start shows the table that was dropped: the stop the block exists for
    p, _ = _run(block, _fresh(tmp_path, "old"), extra={"REPO": str(_ROOT), "CUR": "0292"})
    assert p.returncode == 0, p.stderr
    assert any(line.startswith("0293_drop_inbox_items.py:") and 'op.drop_table("inbox_items")' in line for line in p.stdout.splitlines()), p.stdout[-600:]
    assert any(line.startswith("0293_drop_inbox_items.py:") and "op.rename_table(" in line for line in p.stdout.splitlines()), "the rename is listed too"
    assert not (_w(tmp_path / "new") / "x").exists()


def test_the_lifecycle_update_keeps_the_previous_configuration_and_runs_only_after_it_was_read(tmp_path: Path) -> None:
    """codex: `--lifecycle-file` replaces the whole configuration; the previous one is saved first, shown, and the update does not run when it could not be read"""
    block = _block_with("lifecycle.json <<'EOF'")
    p, calls = _run(block, _fresh(tmp_path, "ok"))
    assert p.returncode == 0, p.stderr
    order = [i for i, c in enumerate(calls) if "buckets describe" in c] + [i for i, c in enumerate(calls) if "buckets update" in c]
    assert len(order) == 3 and order[0] < order[2], "the previous configuration is read before the update"
    assert (_w(tmp_path / "ok") / "lifecycle-before.json").read_text().strip().startswith("{") and "before: 14 days  db/" in p.stdout and "before: 7 days  status/" in p.stdout
    p, calls = _run(block, _fresh(tmp_path, "unread"), extra={"FAIL": "buckets describe"})
    assert not _verbs(calls, "buckets update"), "nothing is replaced when the previous configuration could not be saved"
    look = _section("## G2, the read-only look", "## The prod pipeline")
    for token in ("`--lifecycle-file` replaces the whole configuration", "**Undo:**", "lifecycle-undo.json"):
        assert token in look, token


def test_the_scheduler_targets_saved_in_step_zero_are_never_overwritten_by_a_second_run(tmp_path: Path) -> None:
    block = _block_with("> scheduler-before.tsv.tmp")
    root = _fresh(tmp_path, "first")
    p, calls = _run(block, root)
    assert "scheduler-before.tsv written" in p.stdout and (_w(root) / "scheduler-before.tsv").is_file() and not (_w(root) / "scheduler-before.tsv.tmp").exists()
    p, calls = _run(block, _fresh(tmp_path, "second"), files={"scheduler-before.tsv": "the-first-run\thttps://old\n"})
    assert "scheduler-before.tsv exists: kept as it is" in p.stdout
    assert (_w(tmp_path / "second") / "scheduler-before.tsv").read_text() == "the-first-run\thttps://old\n", "the way back of the targets is the first run's, not a later look"
    assert not [c for c in calls if "scheduler jobs list" in c and "value(name.basename()" in c]


@pytest.mark.skipif(shutil.which("zsh") is None, reason="no zsh on this machine")
def test_a_failed_removal_stops_both_loops_at_once_under_zsh_and_bash(tmp_path: Path) -> None:
    for shell in ("zsh", "bash"):
        p, calls = _run(_block_with(FREEZE), _fresh(tmp_path, f"x-{shell}"), shell=shell, extra={"FAIL": "remove-iam-policy-binding svc-b"}, files={"frozen.txt": "svc-a\nsvc-b\nsvc-c\n"})
        touched = [c.split()[4] for c in _verbs(calls, "remove-iam-policy-binding")]
        assert touched == ["svc-a", "svc-a", "svc-b"] and "freeze: failed" in p.stdout, (shell, touched, p.stdout)
        assert not [c for c in calls if "svc-c" in c], (shell, "nothing after the failure is touched")


def test_the_freeze_text_says_every_caller_goes_but_the_operators_and_the_way_back_restores_the_same_members() -> None:
    five = _section("## 5. Freeze", "## 6–7.")
    for token in ("takes **every** invoker member off each service in `frozen.txt`", "**but the operator account**", "it reads each policy again and stops if any other member is left", "`was-invoker-${WINDOW}.tsv` (service, member)",
                  "a caller that was not there before the move is never added by it"):
        assert token in five, token
    back = _section("## 12. The way back", "## Questions for the owner")
    assert "the `was-invoker` file of this window" in back and '--member="$m"' in back and "allUsers" not in back.split("```")[3]


def test_a_removal_that_gcloud_accepts_but_that_leaves_a_caller_is_a_stop_and_so_is_an_unreadable_operator(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    p, calls = _run(block, _fresh(tmp_path, "sticky"), extra={"STICKY": CALLER}, files={"frozen.txt": "svc-a\nsvc-b\n"})
    assert "still callers on svc-a: 1" in p.stdout and "freeze: failed" in p.stdout and not any(c.startswith(("sleep", "curl")) for c in calls), "the policy is read again: a caller that is still there ends the ladder before the proof and the wait"
    for name, op in (("empty", ""), ("unset", "(unset)")):
        p, calls = _run(block, _fresh(tmp_path, name), extra={"OPERATOR": op}, files={"frozen.txt": "svc-a\n"})
        assert "freeze: no" in p.stdout and not _verbs(calls, "remove-iam-policy-binding"), (name, "without a readable operator account nothing is taken off (it could be the operator's own access)")
    p, calls = _run(block, _fresh(tmp_path, "sa"), extra={"OPERATOR": "ops@p.iam.gserviceaccount.com"}, files={"frozen.txt": "svc-a\n"})
    members = [c.split("--member=")[1].split()[0] for c in _verbs(calls, "remove-iam-policy-binding")]
    assert "serviceAccount:ops@p.iam.gserviceaccount.com" not in members and "user:operator@example.com" in members, "a service-account operator is kept as serviceAccount:, a person as user:"


def test_the_record_is_written_before_a_member_is_taken_off_and_a_failed_write_stops_before_the_removal(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    root = _fresh(tmp_path, "intent")
    p, calls = _run(block, root, extra={"FAIL": "remove-iam-policy-binding svc-b"}, files={"frozen.txt": "svc-a\nsvc-b\n"})
    assert "freeze: failed" in p.stdout
    lines = (_w(root) / WP).read_text().splitlines()
    assert f"svc-b\tallUsers" in lines, "the member whose removal failed is in the record already (the way back puts back a member that is still there: harmless; a missing line would cost a caller)"
    # the record cannot be written (a directory stands in its place): the removal is not attempted
    root2 = _fresh(tmp_path, "nowrite")
    _w(root2).mkdir()
    (_w(root2) / WP).mkdir()
    p, calls = _run(block, root2, files={"frozen.txt": "svc-a\n"})
    assert "freeze: failed" in p.stdout and not _verbs(calls, "remove-iam-policy-binding"), "no record, no removal"


def test_a_second_read_that_fails_after_a_parseable_answer_is_a_stop(tmp_path: Path) -> None:
    """codex: `gcloud ... | jq` without pipefail let a failed gcloud that printed something count as `left=0`"""
    p, calls = _run(_block_with(FREEZE), _fresh(tmp_path, "late"), extra={"LATEFAIL": "1"}, files={"frozen.txt": "svc-a\n"})
    assert "freeze: failed" in p.stdout and "freeze: waited" not in p.stdout and not any(c.startswith(("sleep", "curl")) for c in calls)


def test_the_operator_may_reach_the_services_through_a_group_and_keep_says_so(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    files = {"frozen.txt": "svc-a\n"}
    p, calls = _run(block, _fresh(tmp_path, "nokeep"), extra={"EXTRA_MEMBER": "group:ops@example.com"}, files=files)
    assert "group:ops@example.com" in [c.split("--member=")[1].split()[0] for c in _verbs(calls, "remove-iam-policy-binding")], "without KEEP a group is a caller like any other"
    p, calls = _run(block, _fresh(tmp_path, "keep"), extra={"EXTRA_MEMBER": "group:ops@example.com", "KEEP": "user:operator@example.com group:ops@example.com"}, files=files)
    removed = [c.split("--member=")[1].split()[0] for c in _verbs(calls, "remove-iam-policy-binding")]
    assert removed == ["allUsers", CALLER] and "freeze: waited" in p.stdout, removed
    assert "`KEEP`" in _section("## 5. Freeze", "## 6–7.")


def test_the_invokers_ladder_stops_when_the_operator_account_cannot_be_read(tmp_path: Path) -> None:
    block = _block_with("USES CLOUD SQL PROD")
    for name, op in (("empty", ""), ("unset", "(unset)")):
        p, _ = _run(block, _fresh(tmp_path, name), extra={"OPERATOR": op})
        assert "invokers: failed" in p.stdout and "invokers: listed" not in p.stdout, name


def test_the_freeze_text_names_who_it_does_not_reach_and_what_proves_them() -> None:
    five = _section("## 5. Freeze", "## 6–7.")
    for token in ("**Who the freeze does not reach.**", "inherited by the service and is not in its policy", "the proof is the request log, not the policy", "whether any service account with a project-wide role has a reason to call the backend",
                  "the services may be partly frozen, some callers off and others still on, and that is not a frozen state"):
        assert token in five, token


def test_the_migration_reading_block_also_prints_data_writes_and_bulk_inserts(tmp_path: Path) -> None:
    block = _block_with("promotion-history.txt")
    p, _ = _run(block, _fresh(tmp_path, "data"), extra={"REPO": str(_ROOT), "CUR": "0262"})
    assert p.returncode == 0, p.stderr
    hits = [line for line in p.stdout.splitlines() if re.match(r"^0\d{3}[a-z]?_\S+\.py:\d+: ", line)]
    assert any(h.startswith("0264_loop_measure_due.py:") and "bulk_insert" in h for h in hits), "a direct bulk_insert is a data write"
    assert any(".execute(" in h for h in hits), "so is a statement run on the connection"


DRY = "dry run, nothing written"
PLAN4 = "".join(f"http://old{i} -> https://api.sprintable.ai: 0 link(s) would be rewritten ({DRY})\n" for i in range(4))


def _plan_files(root: Path, plan: str = PLAN4) -> dict[str, str]:
    """the report first, the plan after it: the order block A makes them in (the apply block wants the plan newer than the report)"""
    return {"links-report.txt": "https://x\t1\n", "links-plan.txt": plan}


def _run_b(block: str, root: Path, extra: dict[str, str] | None = None, plan: str = PLAN4, newer: bool = True, report: bool = True):
    w = _w(root)
    w.mkdir(exist_ok=True)
    (w / "links-plan.txt").write_text(plan)
    if report:
        (w / "links-report.txt").write_text("https://x\t1\n")
        os.utime(w / "links-report.txt", (1000, 1000 if newer else 3000))
        os.utime(w / "links-plan.txt", (2000, 2000))
    return _run(block, root, extra=extra)


def test_the_stored_links_of_prod_are_rewritten_on_the_vm_inside_the_freeze_with_a_backup_first(tmp_path: Path) -> None:
    a = _block_with("LINKS=start")
    b = _block_with("links-plan.txt -nt links-report.txt")
    # the report and the plan: read only, in the backend container of the VM, with the four prod origins and the API address
    p, calls = _run(a, _fresh(tmp_path, "plan"))
    sudo = [c for c in calls if c.startswith("sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links")]
    assert len(sudo) == 2 and "--apply" not in " ".join(sudo) and "links: planned" in p.stdout, (sudo, p.stdout)
    assert [c for c in calls if c.startswith("sudo")][0] == "sudo docker stop sprintable-caddy-1", "the public door of the VM is closed before anything is read or written"
    for origin in ("http://sprintable-backend-prod-787818285179.asia-northeast3.run.app", "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app",
                   "http://sprintable-backend-prod-57iommnikq-du.a.run.app", "https://sprintable-backend-prod-57iommnikq-du.a.run.app"):
        assert f"--old-origin {origin}" in sudo[1], origin
    assert "--new-origin https://api.sprintable.ai" in sudo[1] and "--old-origin https://sprintable-backend-dev" not in sudo[1]
    assert (_w(tmp_path / "plan") / "links-plan.txt").exists() and (_w(tmp_path / "plan") / "links-report.txt").exists()
    # the apply: needs a plan of this window (report, then a newer plan with the four dry-run lines); the backup comes before the rewrite; the pass is a report with no run.app, in any letter case
    root = _fresh(tmp_path, "apply")
    p, calls = _run_b(b, root)
    order = [c for c in calls if c.startswith("sudo")]
    assert order[0] == "sudo systemctl start sprintable-backup.service" and "--apply" in order[1] and "--apply" not in order[2], order
    assert "links: clean" in p.stdout
    for name, kw in (("noplan", {"plan": ""}), ("noreport", {"report": False}), ("stale", {"newer": False}), ("three", {"plan": "".join(PLAN4.splitlines(True)[:3])}), ("arbitrary", {"plan": "something else\n" * 4})):
        p, calls = _run_b(b, _fresh(tmp_path, name), **kw)
        assert "links: no" in p.stdout and not [c for c in calls if c.startswith("sudo")], (name, "no valid plan of this window, nothing runs (not even the backup)")
    p, calls = _run_b(b, _fresh(tmp_path, "outside"), plan=PLAN4)
    p, calls = _run(b, _fresh(tmp_path, "outside2"), where="parent")
    assert "links: no" in p.stdout and not [c for c in calls if c.startswith("sudo")]
    p, calls = _run_b(b, _fresh(tmp_path, "nobackup"), extra={"FAILSUDO": "systemctl start sprintable-backup"})
    assert "links: planned" in p.stdout and not [c for c in calls if "--apply" in c], "no backup, no rewrite"
    p, calls = _run_b(b, _fresh(tmp_path, "emptyreport"), extra={"SUDO_REPORT": "-"})
    assert "links: applied" in p.stdout and "links: clean" not in p.stdout, "an empty report after the rewrite is not a pass"
    for name, leftover in (("left", "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app\t2"), ("upper", "https://sprintable-backend-prod-787818285179.asia-northeast3.RUN.APP\t1")):
        p, calls = _run_b(b, _fresh(tmp_path, name), extra={"SUDO_REPORT": leftover})
        assert "links: applied" in p.stdout and "links: clean" not in p.stdout, (name, "a run.app origin still listed after the rewrite, in any letter case, is not a pass")
    assert '{ grep -qi \'run\\.app\' links-after.txt; [ "$?" = 1 ]; }' in b, "clean means grep found nothing (exit 1), not that grep failed (exit 2)"
    p, calls = _run_b(b, _fresh(tmp_path, "drain"))
    assert "sleep 30" in calls and calls.index("sleep 30") < next(i for i, c in enumerate(calls) if c == "sudo systemctl start sprintable-backup.service"), "the drain wait comes before the backup"


def test_the_public_door_of_the_vm_is_closed_for_4b_and_opened_by_a_block_of_its_own(tmp_path: Path) -> None:
    c = _block_with("sudo docker start sprintable-caddy-1")
    p, calls = _run(c, _fresh(tmp_path, "open"))
    assert [x for x in calls if x.startswith("sudo")][0] == "sudo docker start sprintable-caddy-1"
    six = _section("## 6–7. The data and the takeover", "## 8. Unfreeze")
    for token in ("**The public door of the VM is closed for the whole of 4b**", "`sudo docker stop sprintable-caddy-1`", "**Open the door again — last, and only after the decision above**", "Do not run it while a restore is still possible", "nothing was written after it, because the door was closed", "`sudo docker stop sprintable-backend-1 sprintable-frontend-1`",
                  "**commits before it checks**", "so a non-zero exit does not mean that nothing was written", "block C is then not needed", "block B waits 30 s"):
        assert token in six, token
    assert six.index("**4b.") < six.index("**If 4b fails**") < six.index("sudo docker start sprintable-caddy-1"), "the door opens after the decision, not before it"


def test_step_six_seven_says_where_the_rewrite_runs_and_what_it_replaces() -> None:
    six = _section("## 6–7. The data and the takeover", "## 8. Unfreeze")
    for token in ("**4b. The stored links (RUNBOOK §12 item 4) — inside the freeze, on the VM.**", "Prod has no Cloud Run job for this", "none is made for it", "after the final restore and before the unfreeze", "with a backup first",
                  "**every origin it lists must be one of the four the plan names**", "`links: clean` is the pass"):
        assert token in six, token
    assert six.index("4. Checks from inside") < six.index("**4b.") < six.index("5. Enable the deploy, backup and restore-check timers")


def test_with_prod_at_the_head_the_block_says_no_revision_is_to_run_and_prints_nothing_else(tmp_path: Path) -> None:
    import sys
    head = subprocess.run([sys.executable, "-m", "alembic", "heads"], capture_output=True, text=True, cwd=_ROOT / "backend", env={**os.environ, "DATABASE_URL": "postgresql+asyncpg://offline:offline@localhost/offline"}).stdout.split()[0]
    assert re.fullmatch(r"\d{4}[a-z]?", head), head
    p, _ = _run(_block_with("promotion-history.txt"), _fresh(tmp_path, "head"), extra={"REPO": str(_ROOT), "CUR": head})
    assert p.returncode == 0, p.stderr
    assert p.stdout.strip() == "revisions to run: 0", p.stdout


def test_the_migration_block_stops_when_the_history_cannot_be_read_and_never_calls_it_zero(tmp_path: Path) -> None:
    block = _block_with("promotion-history.txt")
    p, _ = _run(block, _fresh(tmp_path, "nohist"), extra={"REPO": str(tmp_path / "no-such-checkout"), "CUR": "0469"})
    assert "history: stop" in p.stdout and "revisions to run" not in p.stdout, "an unreadable history is a stop, not «0 revisions»"
    p, _ = _run(block, _fresh(tmp_path, "badcur"), extra={"REPO": str(_ROOT), "CUR": "no-such-revision"})
    assert "history: stop" in p.stdout and "revisions to run" not in p.stdout


def test_the_window_carries_the_seconds_of_the_link_rewrite_and_a_failed_rewrite_does_not_stop_the_move() -> None:
    one = _section("## 1. Rehearsal", "## 2. The notice")
    for token in ("**plus step 4b**", "about the seconds of the rehearsal's dump", "the module's seconds as the product owner measured them on dev, written in the record of G5", "took **46 s**", "6.8 s of CPU", "the module's report **1.6 s** and its plan **1.3 s**", "it printed `rewritten 6`", "the rehearsal's dump seconds are the better estimate for prod"):
        assert token in one, token
    six = _section("## 6–7. The data and the takeover", "## 8. Unfreeze")
    for token in ("**If 4b fails**", "**the move does not stop and the window goes on.**", "the backup taken just before goes back", "RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh",
                  "ls -t /var/backups/sprintable/db-prod-*.dump", "**the next day with the same module**", "answers 403 until the forwarder is opened in step 8c", "`links-report.txt`"):
        assert token in six, token
    assert "/var/backups/sprintable" in (_ROOT / "deploy/vm/bin/backup.sh").read_text() and 'dump_prefix' in (_ROOT / "deploy/vm/bin/backup.sh").read_text(), "the folder and the name the sheet restores from are the backup unit's"


def test_a_keep_that_forgets_the_operator_cannot_lock_the_operator_out(tmp_path: Path) -> None:
    block = _block_with(FREEZE)
    p, calls = _run(block, _fresh(tmp_path, "forgets"), extra={"KEEP": "group:other@example.com", "EXTRA_MEMBER": "group:other@example.com"}, files={"frozen.txt": "svc-a\n"})
    removed = [c.split("--member=")[1].split()[0] for c in _verbs(calls, "remove-iam-policy-binding")]
    assert "user:operator@example.com" not in removed and "group:other@example.com" not in removed and "freeze: waited" in p.stdout, removed
    assert 'KEEP="$OPM ${KEEP:-}"' in block


def test_the_writers_check_after_the_freeze_is_a_gate_that_reads_the_log_of_the_backend(tmp_path: Path) -> None:
    block = _block_with("writers after the freeze")
    p, calls = _run(block, _fresh(tmp_path, "none"))
    assert "writers after the freeze: none" in p.stdout
    ask = next(c for c in calls if "logging read" in c)
    assert "requestMethod" not in ask, "no method is excluded: the cron endpoints are GET requests and write"
    assert "httpRequest.status>=200" in ask and "httpRequest.status<400" in ask and "--freshness=5m" in ask and "sprintable-backend-prod" in ask
    assert 'NOT httpRequest.requestUrl=~"^https://[^/?]+/api/v2/(health|ping)$"' in ask, "only the health checks, by their exact path"
    import re as _re
    rx = _re.compile(r"^https://[^/?]+/api/v2/(health|ping)$")
    assert rx.match("https://api.sprintable.ai/api/v2/health") and rx.match("https://x.run.app/api/v2/ping")
    assert not rx.match("https://api.sprintable.ai/api/v2/auth/token?next=/api/v2/health") and not rx.match("https://api.sprintable.ai/api/v2/health?x=1") and not rx.match("https://api.sprintable.ai/api/v2/healthz/../x"), "a write that mentions the path in its query is not a health check"
    p, _ = _run(block, _fresh(tmp_path, "some"), extra={"WRITE_ROWS": "2026-11-02T18:31:12Z\n"})
    assert "writers after the freeze: read" in p.stdout and "writers after the freeze: none" not in p.stdout
    p, calls = _run(block, _fresh(tmp_path, "asked-not"), where="parent")
    assert "writers after the freeze: no" in p.stdout and not [c for c in calls if "logging read" in c]
    p, _ = _run(block, _fresh(tmp_path, "failed"), extra={"FAIL": "logging read"})
    assert "writers after the freeze: asking" in p.stdout and "none" not in p.stdout.split("writers after the freeze:")[1], "a question that failed is not an answer"
    five = _section("## 5. Freeze", "## 6–7.")
    for token in ("**The proof that no writer is left, from the log — run it last in this step, after the scheduler jobs are paused and the jobs check says `quiet`.**", "`writers after the freeze: none` is the pass and a **gate for step 6**", "does not say that nothing with an identity can still reach the backend"):
        assert token in five, token
    assert five.index("jobs: quiet") < five.index("writers after the freeze: $QUIET"), "the gate is asked after the schedulers are paused and the jobs are quiet"


def test_the_version_of_prod_comes_from_the_database_and_is_checked_against_the_migration_job() -> None:
    block = _block_with("promotion-history.txt")
    for token in ("from the database of prod (select version_num from alembic_version)", "never from `alembic heads` or the repository", "checks that it is the same as the last line of the migration job's log of the promotion's deploy"):
        assert token in block, token


def test_the_fresh_report_after_a_failed_4b_is_a_command_that_needs_no_state() -> None:
    six = _section("## 6–7. The data and the takeover", "## 8. Unfreeze")
    fail = six[six.index("**If 4b fails**"):]
    assert "`sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links` (it needs no state from the blocks)" in fail


def test_the_known_limits_are_written_down() -> None:
    lim = _section("## Known limits (not blockers; read before the window)", "## Questions for the owner")
    for token in ("does not compare the four origins with those of the apply command", "covered by the 30 s wait and the reading of the plan, not by a measurement of idle connections", "reads the log of the Cloud Run backend", "outside the freeze by design"):
        assert token in lim, token


# ── zsh is the default shell of the machine that runs these blocks ──

ZSH_SPECIAL = {"path", "fpath", "cdpath", "manpath", "module_path", "status", "pipestatus", "argv", "prompt", "signals", "options", "commands", "functions", "aliases", "parameters", "history", "histchars", "words", "reply", "match", "mbegin", "mend", "nameref"}


def test_no_block_loops_over_an_unquoted_variable_or_on_a_name_zsh_ties_to_something() -> None:
    """zsh does not split `$var` on whitespace (a loop over `$names` runs once, with the whole list) and ties some names to its own state (`path` is PATH: the loop made gcloud vanish)"""
    for block in _blocks():
        for line in block.splitlines():
            for name, words in re.findall(r"\bfor (\w+) in ([^;]+);", line):
                assert name not in ZSH_SPECIAL, (name, line[:120])
                assert not re.fullmatch(r"\$\{?\w+\}?", words.strip()), ("zsh does not split this", line[:120])


@pytest.mark.skipif(shutil.which("zsh") is None, reason="no zsh on this machine")
def test_the_step_zero_ladders_list_every_service_under_zsh_as_under_bash(tmp_path: Path) -> None:
    block = _block_with("USES CLOUD SQL PROD")
    for shell in ("bash", "zsh"):
        p, calls = _run(block, _fresh(tmp_path, shell), shell=shell, extra={"DESC_EXTRA": ":sprintable-prod"})
        assert "dependents: listed" in p.stdout and "invokers: listed" in p.stdout, (shell, p.stdout, p.stderr[:200])
        assert "USES CLOUD SQL PROD: services sprintable-backend-prod" in p.stdout and "USES CLOUD SQL PROD: services sprintable-frontend-prod" in p.stdout, (shell, "both services, one name each")
        assert "== sprintable-backend-prod" in p.stdout and "== sprintable-frontend-prod" in p.stdout, shell


@pytest.mark.skipif(shutil.which("zsh") is None, reason="no zsh on this machine")
def test_the_measure_loops_keep_gcloud_reachable_under_zsh(tmp_path: Path) -> None:
    for marker in ("for route in register token", "for route in desktop/setup-codes"):
        p, calls = _run(_block_with(marker), _fresh(tmp_path, marker.split()[-1].replace("/", "_")), shell="zsh")
        assert p.returncode == 0, (marker, p.stderr[:300])
        assert len([c for c in calls if c.startswith("gcloud ") and "logging read" in c]) >= 7, (marker, "a loop variable that shadows PATH ends the loop after the first round")


def test_the_positive_control_of_the_writers_gate_is_measured_and_repeatable(tmp_path: Path) -> None:
    five = _section("## 5. Freeze", "## 6–7.")
    for token in ("**Positive control — measured by the product owner on 2026-10-28 with the live account (`양성 대조 실측됨`).**", "20 lines over `--freshness=1d` and 20 over five minutes", "matched 5 requests of `/api/v2/health`",
                  "the one place where this gate could pass falsely", "write the number of lines in the record of G5", "A 0 here means the filter matches nothing"):
        assert token in five, token
    block = _block_with("--freshness=1d --limit=20")
    p, calls = _run(block, _fresh(tmp_path, "pos"), extra={"WRITE_ROWS": "2026-11-02T18:00:00Z\n2026-11-02T18:00:01Z\n"})
    assert p.stdout.strip() == "2", p.stdout
    ask = next(c for c in calls if "logging read" in c)
    assert 'NOT httpRequest.requestUrl=~"^https://[^/?]+/api/v2/(health|ping)$"' in ask and "--freshness=1d" in ask, "the same filter as the gate"
