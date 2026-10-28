# Cutover sheet — the support gateway's database from Cloud SQL to the VM (dev) — story 4796, step D2

The gateway **stays on Cloud Run** (its own service account, no key, nothing of the VM's identity). Only its **database** moves: from the database `support_gateway` inside the Cloud SQL instance `sprintable-dev` to the
VM's own second Postgres, `gateway-db` ([RUNBOOK §13](RUNBOOK.md), merged as D1). This sheet is the order in which the PO does it, with the command, the way back and what each step interrupts. The agent has no
gcloud and no ssh: every command here is run by the PO's own account, from the PO's machine unless it says «on the VM».

```
export PROJECT=sprintable-494803 REGION=asia-northeast3 ZONE=asia-northeast3-a ENV=dev
export VM=sprintable-vm-$ENV BACKUPS_BUCKET=sprintable-vm-$ENV-backups
export GW=support-gateway-$ENV GWJOB=sprintable-support-gateway-migrate-$ENV GWSA=support-gateway-dev@$PROJECT.iam.gserviceaccount.com
export VMIP=$(gcloud compute instances describe $VM --zone $ZONE --project $PROJECT --format='value(networkInterfaces[0].networkIP)'); echo "$VMIP"
```

## What is true before the sheet starts (gates)

| Gate | What must be true | How to check |
|---|---|---|
| **G1. The VM side is live, in the right order** | D1 is merged and promoted. Of the order in [RUNBOOK §13](RUNBOOK.md): steps 2–4 are done, the **negative firewall control (step 2a below) is measured, and only then step 5 (`desired.json`) — in the same window as this sheet, not earlier**. **Step 5 deploys a candidate built after D2 (the change that carries this sheet) was merged**: only that one has the deployer's start gate on the metadata rule and the firewall script that keeps the rule first, so a candidate from before it is not put in `desired.json`. Until the restore in step 6 below `gateway-db` holds 0 tables: the nightly backup's gateway part fails with «lists no table data — refusing» (the main dump is uploaded first — only the unit fails) and the weekly restore check finds no gateway dump. **That is expected and loses nothing**: the refusal is the safety that keeps an empty dump from passing as a backup, and it is not loosened for these hours. Both stop failing after step 6. | the checks after step 5 in RUNBOOK §13 |
| **G2. The pipeline switch is merged, off** | `cloudbuild.yaml` has `_SUPPORT_GATEWAY_DB_ON_VM` and `cloud-build.yml` states `support_gateway_db_on_vm=false` for dev. Off, the dev build is exactly what it was. | `grep -n support_gateway_db_on_vm .github/workflows/cloud-build.yml` |
| **G3. The firewall holds in both directions — before any data moves** | Step 2: the probe on the default subnet times out (2a, before RUNBOOK step 5) and the probe on the gateway's own subnet reaches `gateway-db`'s port (2b, after it). | step 2 |
| **G4. No dev build can start between step 4 and step 11** | A dev build — even an old, queued one, or one started by hand from an old ref — deploys the gateway with the old flags and puts the Cloud SQL socket back (`--add-cloudsql-instances`), while the secret already names the VM. So the workflow is switched off for the window and nothing may be running or waiting: `gh workflow disable cloud-build.yml`, then `gh run list --limit 200 --json databaseId,status,workflowName,headBranch --jq '.[] | select(.status != "completed" and .workflowName == "Cloud Build (GCP)") | "\(.databaseId) \(.headBranch)"'` prints no line of a branch other than main (it asks for every run that is not completed — queued, waiting, pending and in progress alike — of the workflow by its name, because the list by file name leaves a disabled workflow out; cancel what it lists with `gh run cancel <id>`). A line of the branch `main` is a PROD run of the same workflow: it is not cancelled but waited for, and nothing is merged to `main` while the workflow is off (the PO's chain holds that too). A build that was already SUBMITTED keeps running when its GitHub run is cancelled (the workflow submits it with `gcloud builds submit`), so the build list is looked at too: `gcloud builds list --project $PROJECT --ongoing --limit 200 --format='value(id,substitutions._DEPLOY_ENV)'` prints no line ending in dev (wait for it, or `gcloud builds cancel $BUILD_ID --project $PROJECT`). The PO's chain also holds the merge queue of `develop`. It is switched on again at step 11, right before the flip PR is merged. | the run list and the build list |

**Connection budget (PO 2026-10-28): 겹침 최악 16 / 27** — while a revision is replaced the old revision's idle pool (2 × 3) and the new one's (2 × 5) coexist: 16 of the 27 connections `gateway-db` allows
(`max_connections=30`, 3 kept for the superuser); the application role's own limit is 24 (RUNBOOK §13).

**The range, the subnet and the firewall (PO 2026-10-28, option A).** The gateway runs on its own subnet `support-gateway-<env>` (created in RUNBOOK §13 step 3; on dev it exists). Its range is written **once**, as `support_gateway.allow_from`
in `env/dev.yaml`: it is what the firewall's allow rule (priority 800, the deny at 900 stays) names and what the server's access rules let the application role in from. A network tag cannot be the source of an ingress rule for Direct VPC
egress (Google's list of limits), so the rule names the subnet; the default subnet is not allowed, because it also holds other Cloud Run services. **Nothing but the gateway service, its migrate job and the probe jobs may sit on the
gateway's subnet** — anything else deployed there reaches the database's port; steps 1, 8 and 11 check it with `deploy/vm/bin/subnet-residents.py` (read only, names only). **The tool does not look at Cloud Run worker pools** (the installed `gcloud` may not list them): at step 1 the PO also opens Cloud Run → Worker pools in the console and sees that none uses the project's network, and the tool says so on every run.

## The order, and what each step interrupts

| # | Step | Interrupts? | Way back |
|---|---|---|---|
| 1 | read-only checks | nothing | — |
| 2 | the firewall probes (throw-away jobs): 2a on the default subnet, before RUNBOOK step 5 · 2b on the gateway's subnet, after it | nothing (jobs that live a minute and open one connection each) | delete the jobs |
| 3 | rehearsal: dump of `support_gateway` from Cloud SQL → restore into `gateway-db` → row-count diff → one manual backup | nothing for users (a dump reads; the restore writes only `gateway-db`) | `DROP DATABASE` of the rehearsal copy, step 6 |
| 4 | **freeze** — the gateway stops accepting requests (the public `run.invoker` binding is taken off) and in-flight requests are waited out | **the widget is unavailable from here to step 9** (the freeze window, measured below) | step 9's command |
| 5 | final dump of `support_gateway` from Cloud SQL | inside the freeze | — |
| 6 | restore into `gateway-db` (`RESTORE_WIPE=yes`) → row-count diff must print nothing | inside the freeze | the rehearsal copy is kept beside it (see step 6) |
| 7 | a new version of `SUPPORT_GATEWAY_DATABASE_URL_dev` (the VM's private address, the application role) | inside the freeze | step 12 |
| 8 | the gateway service on the VM's database (`gcloud run services update`: no Cloud SQL socket, the gateway's own subnet, the pool 3 + 2), then **a database-backed check** from a throw-away job with the new secret | inside the freeze | step 12 |
| 9 | **unfreeze** (the public `run.invoker` binding is put back) | ends the freeze | — |
| 10 | the round trip: a widget session, a message, an escalation reaching the backend, a real Vertex call; the server sees the gateway's connections; a manual backup that does not refuse | nothing | step 12 |
| 11 | the workflow on again, the flip PR (one word in `cloud-build.yml`) → green dev build → the migrate job on the VM's database | the build re-applies the same flags (a new revision of the same config) | revert the PR |
| 12 | the way back, while Cloud SQL still holds the database | the same freeze again | — |

**The freeze window is not measured yet — «미측정».** Take `date -u +%FT%TZ` at the end of step 4 and at the start of step 9; the difference is the number to report. The parts that make it up are measured by the
rehearsal in step 3 (dump seconds, restore seconds) and by the request timeout read in step 4 — the dump and restore of the main database took 45 s and under 4 minutes for 252 tables / 295 MB; the gateway's database is a few tables.

## 1. Read-only checks

```
# the revision serving now, and the URL secret's current version (both are the way back)
REV_BEFORE=$(gcloud run services describe $GW --project $PROJECT --region $REGION --format='value(status.latestReadyRevisionName)'); echo "$REV_BEFORE"
OLD_VER=$(gcloud secrets versions list SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT --filter='state=ENABLED' --sort-by=~createTime --limit=1 --format='value(name.basename())'); echo "$OLD_VER"
# the Cloud SQL instance's private address
SRC_IP=$(gcloud sql instances describe sprintable-$ENV --project $PROJECT --format=json | jq -r '.ipAddresses[] | select(.type=="PRIVATE") | .ipAddress'); echo "$SRC_IP"
# what the current URL looks like — scheme, role, database and whether it names a socket or an address; the password is never printed
# who sits on the gateway's own subnet (read only, names only; exit 0 = nobody but the allowed, 1 = somebody else is named, 2 = it could not look — never read a 2 as fine). Now: nobody.
python3 -I deploy/vm/bin/subnet-residents.py $PROJECT $REGION support-gateway-$ENV --allow-service $GW --allow-job $GWJOB --allow-job gwdb-probe-
gcloud secrets versions access latest --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT | python3 -c 'import sys; from urllib.parse import urlsplit, unquote; u = urlsplit(sys.stdin.read().strip()); print(u.scheme, unquote(u.username or ""), u.path.lstrip("/"), "socket" if not u.hostname else "address", "password-present" if u.password else "NO PASSWORD")'
```
Expect `VERDICT: OK` with «none» on the subnet, and `postgresql+asyncpg support_gw support_gateway socket password-present` (or `address` if it already names one). On the VM, the checks after step 5 of RUNBOOK §13 (`gateway-db` healthy, one listener on the private address, the role is not a superuser).

## 2. The firewall, proven in both directions (before any data moves)

Throw-away Cloud Run jobs, one on the default subnet and one on the gateway's own subnet, each opening ONE TCP connection to `gateway-db`'s port. They run as a service account that holds **no role at all**
(created here, deleted at the end), carry no secret, and every name has a per-run stamp: **nothing that exists is reused, and only what this run made is deleted** (`SA_MADE` / `JOB_MADE` are checked before each use and each
delete). The program prints one line `result <errno> <word>` and exits **0 REACHED**, **4 REFUSED** (nothing listens, or nothing denies), **3 TIMEOUT** (the packets were dropped), **5 OTHER** (any other error — for example no
route at all: the job's network failed, which proves nothing about the firewall). The same text, for the negative control, is step 3b of [RUNBOOK §13](RUNBOOK.md).

```
GWIMG=$(gcloud run services describe $GW --project $PROJECT --region $REGION --format='value(spec.template.spec.containers[0].image)')
STAMP=$(date -u +%m%d%H%M%S)$RANDOM
PROBESA_ID=gwdb-probe-$STAMP; PROBESA=$PROBESA_ID@$PROJECT.iam.gserviceaccount.com; PJU=gwdb-probe-untagged-$STAMP; PJG=gwdb-probe-gwsubnet-$STAMP
PROBE='^@^-c@import errno, socket, sys; s = socket.socket(); s.settimeout(5); r = s.connect_ex((sys.argv[1], 5432)); kind = "REACHED" if r == 0 else "REFUSED" if r == errno.ECONNREFUSED else "TIMEOUT" if r in (errno.EAGAIN, errno.ETIMEDOUT) else "OTHER"; print("result", r, kind); sys.exit({"REACHED": 0, "REFUSED": 4, "TIMEOUT": 3}.get(kind, 5))@'"$VMIP"
[ -n "$VMIP" ] || echo "STOP: no address to probe (VMIP is empty) - nothing is made below"
```
**2a. Negative — now, BEFORE step 5 of RUNBOOK §13 (it is the hard condition of that step).** With no listener yet, a deny rule makes the packets disappear and a missing deny rule answers «refused»:
```
[ -n "$VMIP" ] && gcloud iam service-accounts create $PROBESA_ID --project $PROJECT --display-name "gateway db firewall probe (no roles)" && SA_MADE=$PROBESA_ID
[ "$SA_MADE" = "$PROBESA_ID" ] && gcloud run jobs create "$PJU" --project $PROJECT --region $REGION --image "$GWIMG" --service-account $PROBESA --network default --subnet default --vpc-egress private-ranges-only --max-retries 0 --task-timeout 60 --command python --args "$PROBE" && JOB_MADE=$PJU
[ "$JOB_MADE" = "$PJU" ] && gcloud run jobs execute "$PJU" --project $PROJECT --region $REGION --wait || true   # failing IS the expected answer; the next lines still run (also under set -e)
[ "$JOB_MADE" = "$PJU" ] && for n in 1 2 3 4 5 6; do gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="'"$PJU"'"' --project $PROJECT --freshness 15m --limit 20 --format='value(textPayload)' | grep '^result' && break; sleep 10; done
[ "$JOB_MADE" = "$PJU" ] && gcloud run jobs delete "$PJU" --project $PROJECT --region $REGION --quiet
```
**Pass: the log line is `result <n> TIMEOUT`.** `gcloud`'s own status after `--wait` only says «failed» (it is not the container's exit code), so the log line is what is read. **`REFUSED`: the deny rule is missing — stop**, and check the rules of
RUNBOOK §13 step 3 (`gcloud compute firewall-rules list --project $PROJECT --filter='name~gateway-db'`). **`REACHED`: the port is open to a workload outside the gateway's subnet — stop. `OTHER`: nothing is proven — find out why the job had
no route.** Only now RUNBOOK §13 step 5 (`desired.json`) is taken.

**2b. Positive — after step 5, before the freeze.** The listener exists now. The job on the gateway's subnet must reach it; one on the default subnet must still be dropped (a listener must not change the answer of the firewall):
```
[ "$SA_MADE" = "$PROBESA_ID" ] && gcloud run jobs create "$PJG" --project $PROJECT --region $REGION --image "$GWIMG" --service-account $PROBESA --network default --subnet support-gateway-$ENV --vpc-egress private-ranges-only --max-retries 0 --task-timeout 60 --command python --args "$PROBE" && JOB_G_MADE=$PJG
[ "$JOB_G_MADE" = "$PJG" ] && gcloud run jobs execute "$PJG" --project $PROJECT --region $REGION --wait; echo "on the gateway subnet: gcloud status $?"
[ "$JOB_G_MADE" = "$PJG" ] && for n in 1 2 3 4 5 6; do gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="'"$PJG"'"' --project $PROJECT --freshness 15m --limit 20 --format='value(textPayload)' | grep '^result' && break; sleep 10; done
[ "$JOB_G_MADE" = "$PJG" ] && gcloud run jobs delete "$PJG" --project $PROJECT --region $REGION --quiet
PJU2=gwdb-probe-untagged2-$STAMP
[ "$SA_MADE" = "$PROBESA_ID" ] && gcloud run jobs create "$PJU2" --project $PROJECT --region $REGION --image "$GWIMG" --service-account $PROBESA --network default --subnet default --vpc-egress private-ranges-only --max-retries 0 --task-timeout 60 --command python --args "$PROBE" && JOB_U2_MADE=$PJU2
[ "$JOB_U2_MADE" = "$PJU2" ] && gcloud run jobs execute "$PJU2" --project $PROJECT --region $REGION --wait || true
[ "$JOB_U2_MADE" = "$PJU2" ] && for n in 1 2 3 4 5 6; do gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="'"$PJU2"'"' --project $PROJECT --freshness 15m --limit 20 --format='value(textPayload)' | grep '^result' && break; sleep 10; done
[ "$JOB_U2_MADE" = "$PJU2" ] && gcloud run jobs delete "$PJU2" --project $PROJECT --region $REGION --quiet
[ "$SA_MADE" = "$PROBESA_ID" ] && gcloud iam service-accounts delete $PROBESA --project $PROJECT --quiet
```
**Pass: the line of the job on the gateway's subnet is `result 0 REACHED` and the one on the default subnet is `result <n> TIMEOUT` again.** If the gateway-subnet job is not `REACHED`, the rule does not match the subnet — compare the allow rule's
`--source-ranges` with `support_gateway.allow_from` and with `gcloud compute networks subnets describe support-gateway-$ENV --region $REGION --project $PROJECT --format='value(ipCidrRange)'`; it is not a tag problem (no tag is used).

## 3. Rehearsal (the freeze window's parts, measured without a freeze)

The connection URL goes from the PO's machine to the VM on **standard input** of one ssh command and lives in the memory of `dump-source.sh` only (RUNBOOK §7). The secret holds a socket URL (Cloud SQL's socket), which
the VM cannot use: the one-line program below keeps the role, the password and the database and puts the private address `$SRC_IP` in place of the socket. Nothing is printed. (If the program fails, the ssh command receives an
empty input and `dump-source.sh` stops with «no connection URL on standard input» — nothing is dumped.)

```
gcloud secrets versions access latest --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT | python3 -c 'import sys; from urllib.parse import quote, unquote, urlsplit; u = urlsplit(sys.stdin.read().strip()); q = "?sslmode=" + sys.argv[2] if len(sys.argv) > 2 else ""; print("postgresql://%s:%s@%s:5432/%s%s" % (quote(unquote(u.username), safe=""), quote(unquote(u.password), safe=""), sys.argv[1], u.path.lstrip("/"), q), end="")' "$SRC_IP" | gcloud compute ssh $VM --project $PROJECT --zone $ZONE --tunnel-through-iap --ssh-flag=-T --command "sudo /opt/sprintable/bin/dump-source.sh --host $SRC_IP --label gateway-rehearsal --upload"
```
If the server answers that SSL is required, add `require` after `"$SRC_IP"` (the program appends `?sslmode=require`). The command prints `dump:` and `counts:` paths. **On the VM**, restore into the gateway's server and diff:
```
sudo env DB_SERVICE=gateway-db /opt/sprintable/bin/restore.sh /srv/sprintable/import/<the dump: path>.dump > counts-vm.tsv
sudo bash -c 'diff /srv/sprintable/import/<the counts: path>.counts.tsv <(grep -P "^\S+\t\d+$" counts-vm.tsv)' && echo "row counts equal"
sudo systemctl start sprintable-backup.service; sudo journalctl -u sprintable-backup.service -n 20 --no-pager
```
`row counts equal` and the backup journal without «refusing» are the pass. `gcloud storage ls -l gs://$BACKUPS_BUCKET/db/ | grep db-gateway | tail -2` shows the new gateway dump with a size. Write down the seconds that
`dump-source.sh` and `restore.sh` print («dump done in … s», «restore done in … s»).

## 4. Freeze

```
gcloud run services remove-iam-policy-binding $GW --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker
GWURL=$(gcloud run services describe $GW --project $PROJECT --region $REGION --format='value(status.url)'); curl -s -o /dev/null -w '%{http_code}\n' "$GWURL/openapi.json"
TMO=$(gcloud run services describe $GW --project $PROJECT --region $REGION --format='value(spec.template.spec.timeoutSeconds)'); echo "request timeout: $TMO s"
```
The `curl` prints **403** (the platform refuses a request that carries no identity); before the freeze it prints 200 with `application/json`. **The freeze is the IAM binding, not the ingress setting**: `--ingress internal` lets in the requests of the same project's VPC, and the VM is in it, so it would not stop the backend on the VM (the first run of this sheet found that: the gate caught it and the freeze was undone within seconds). Without the public `run.invoker` binding nobody who is not named gets in, from outside or from the VM. It is measured from the VM too, not assumed: `ssh`/IAP to the VM and the same `curl` there also prints **403** (a **200** there means the backend still reaches the gateway: stop, put the binding back and do not restore). The path is `/openapi.json`, not `/healthz`: Cloud Run reserves the paths that end in a `z` and answers them itself with a Google HTML 404, before and after the freeze, so `/healthz` cannot tell the two states apart. **Wait `TMO` + 10 seconds** (`sleep $((TMO + 10))`): a message request flushes its rows before the model call and commits after it, so a request that
began before the freeze can still commit up to the request timeout later — only after that wait is the database quiet. Write down the time: `date -u +%FT%TZ` — this is T0 (taken after the wait; the wait itself is part of
the window, so also write down when the freeze command ran). Both `curl`s have printed 404; then, in the same shell (`TMO` is set there), the wait and T0 as commands:

```
[ -n "$TMO" ] && sleep $((TMO + 10)) && date -u +%FT%TZ   # T0: printed only after the whole wait
```
 The backend's calls to the gateway (operator replies, escalation resolution) fail during the window and the gateway's own calls to the backend are not made.

## 5. Final dump

The same command as step 3 with `--label gateway`. It prints `dump:` and `counts:` paths: use these from here on.

## 6. Restore into `gateway-db`

```
sudo env DB_SERVICE=gateway-db RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh /srv/sprintable/import/<the dump: path>.dump > counts-vm.tsv
sudo bash -c 'diff /srv/sprintable/import/<the counts: path>.counts.tsv <(grep -P "^\S+\t\d+$" counts-vm.tsv)' && echo "row counts equal"
```
`restore.sh` on the gateway's server shuts the door (the role may no longer connect), refuses while a session is open on the database, loads the dump into a database **beside** the rehearsal copy, swaps the names only when
the load succeeded and then opens the door. The rehearsal copy stays as `support_gateway_before_restore_<time>`: drop it once the cutover has proven itself —
`sudo docker exec sprintable-gateway-db-1 psql -U gw_admin -d postgres -c 'DROP DATABASE "support_gateway_before_restore_<time>"'` (the exact name is in the line `restore.sh` printed). **Pass: `row counts equal`.**
Anything else: do not go on — unfreeze (step 9's command) and stay on Cloud SQL.

## 7. The new version of the URL secret

The URL keeps the scheme, the role and the database of the current secret and takes the VM's private address and the application role's password (its own secret, `SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV`, RUNBOOK §3). The
password is in this shell's environment for one command and nowhere else. **Nothing is created unless every part worked**: the URL is built into a variable first, and the new version is added only if the variable is not empty
(a pipe would run `gcloud secrets versions add` on an empty input and create an empty version).
```
GWPW=$(gcloud secrets versions access latest --secret=SUPPORT_GATEWAY_DB_PASSWORD_VM_DEV --project $PROJECT) && [ -n "$GWPW" ] && export GWPW || echo "STOP: the password could not be read"
NEWURL=$(gcloud secrets versions access "$OLD_VER" --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT | python3 -c 'import os, sys; from urllib.parse import quote, unquote, urlsplit; u = urlsplit(sys.stdin.read().strip()); user, db = unquote(u.username or ""), u.path.lstrip("/"); assert user == "support_gw" and db == "support_gateway", "the current URL names another role or database"; assert os.environ.get("GWPW"), "no password"; assert len(sys.argv) > 1 and sys.argv[1], "no address"; print("%s://%s:%s@%s:5432/%s" % (u.scheme, user, quote(os.environ["GWPW"], safe=""), sys.argv[1], db), end="")' "$VMIP") && [ -n "$NEWURL" ] && printf %s "$NEWURL" | gcloud secrets versions add SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT --data-file=- || echo "STOP: no version was added"
unset GWPW NEWURL
gcloud secrets versions list SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT --format='table(name.basename(),state,createTime)' | head -4
```
Both `STOP` lines mean: nothing was added, go back to step 4's unfreeze (step 9's command). A running instance keeps the value it started with, so nothing changes until step 8's new revision starts. Write down the new version number:
`NEW_VER` (the first line of the table).

## 8. The gateway service on the VM's database

```
gcloud run services update $GW --project $PROJECT --region $REGION --clear-cloudsql-instances --network default --subnet support-gateway-$ENV --update-env-vars SUPPORT_GATEWAY_DB_POOL_SIZE=3,SUPPORT_GATEWAY_DB_MAX_OVERFLOW=2
gcloud run services describe $GW --project $PROJECT --region $REGION --format='value(status.latestReadyRevisionName)'
gcloud run services describe $GW --project $PROJECT --region $REGION --format=json | python3 -c 'import json, sys; a = json.load(sys.stdin)["spec"]["template"]["metadata"].get("annotations", {}); print(len(a.get("run.googleapis.com/cloudsql-instances", "")))'
python3 -I deploy/vm/bin/subnet-residents.py $PROJECT $REGION support-gateway-$ENV --allow-service $GW --allow-job $GWJOB --allow-job gwdb-probe-
```
The new revision is ready and serves; the first command prints **0** (the length of the Cloud SQL instance list the service still carries: gcloud leaves the annotation in place with an empty value, so counting the lines that mention it would print 1), the residents check ends with `VERDICT: OK` and names the gateway service as the one thing on the subnet (the template and every revision that still serves traffic). `--clear-cloudsql-instances`, not «leave it out»: gcloud keeps an instance that is only
not mentioned. Without a freeze this step would send traffic to a revision whose database is not checked yet — that is why it is inside the freeze.

**The database-backed check — before the unfreeze.** The gateway's own health path answers 200 without touching the database, so it proves nothing here. A throw-away job with the gateway's own image, service account, subnet and the
NEW secret opens a real connection to `gateway-db` the way the application does (URL, password, firewall, access rules). It is the one job here that needs the gateway's own account (it reads that secret); its name is new for the same reason as above (`GWIMG` and `STAMP` come from step 2; define them again if this is a new shell):
```
CHECK='^@^-c@import asyncio, asyncpg, os; u = os.environ["SUPPORT_GATEWAY_DATABASE_URL"].replace("+asyncpg", ""); c = asyncio.run(asyncpg.connect(u, timeout=10)); print("connected")'
CHK=gwdb-check-$STAMP
gcloud run jobs create "$CHK" --project $PROJECT --region $REGION --image "$GWIMG" --service-account $GWSA --network default --subnet support-gateway-$ENV --vpc-egress private-ranges-only --set-secrets SUPPORT_GATEWAY_DATABASE_URL=SUPPORT_GATEWAY_DATABASE_URL_dev:latest --max-retries 0 --task-timeout 60 --command python --args "$CHECK" && CHK_MADE=$CHK
[ "$CHK_MADE" = "$CHK" ] && gcloud run jobs execute "$CHK" --project $PROJECT --region $REGION --wait; echo "database check: exit $?"
[ "$CHK_MADE" = "$CHK" ] && gcloud run jobs delete "$CHK" --project $PROJECT --region $REGION --quiet && CHK_GONE=$CHK
[ "$CHK_GONE" = "$CHK" ] && echo "check job deleted" || echo "STOP: the check job is still there with the gateway's account and the VM's secret on the database subnet: remove it with the command above before step 9"
```
**Pass: `database check: exit 0` and `check job deleted`.** The first not 0: do not unfreeze into the new setup — step 12 (the way back). The second missing: run the last command again until it succeeds, then go on; the residents check of step 11 would name it too.

## 9. Unfreeze

```
gcloud run services add-iam-policy-binding $GW --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker
curl -s -o /dev/null -w '%{http_code}\n' "$GWURL/openapi.json"
```
The second command prints **200** (and the dev build of step 11 puts the same binding back by itself: it deploys with `--allow-unauthenticated`). Write down the time: T1. **The freeze window is T1 − T0**, plus the wait of step 4 — report both in the story as numbers.

## 10. The round trip (these are the checks gate 0 of [`REMOVALS-dev.md`](REMOVALS-dev.md) reads)

1. **A widget session opened** and **a message sent** from the dev app's support widget (the person's own browser), and the answer arrives.
2. **An escalation reaching the backend**: ask the widget for a human; the escalation shows in the backend (the support inbox of the dev app).
3. **A real Vertex call**: the answer in 1 came from the model, not from an error text; `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="'$GW'" AND severity>=ERROR' --project $PROJECT --freshness 15m --limit 10 --format='value(timestamp,textPayload)'` prints no database or Vertex error.
4. **The server sees the gateway**: on the VM `sudo docker exec sprintable-gateway-db-1 psql -U gw_admin -d support_gateway -Atc "select usename, count(*) from pg_stat_activity where datname = 'support_gateway' and usename = 'support_gw' group by 1"` prints `support_gw|` and a number of at least 1, and `select count(*) from <the table the message went into>` is one more than before (`rowcounts.sh` shows it: `sudo env DB_SERVICE=gateway-db /opt/sprintable/bin/rowcounts.sh`).
5. **The backup no longer refuses**: `sudo systemctl start sprintable-backup.service; sudo journalctl -u sprintable-backup.service -n 20 --no-pager` has no «refusing», and `gcloud storage ls -l gs://$BACKUPS_BUCKET/db/ | grep db-gateway | tail -2` lists a **new** gateway dump with a size. The weekly restore check passes from the next Sunday on (or `sudo systemctl start sprintable-restore-check.service` now).
6. **Memory**: `free -m` on the VM; the PO measured 1.8 of 3.9 GB before `gateway-db`, and the server is expected to add about 100 MB — unmeasured until now.

Any failure in 1–4: step 12 (the way back).

## 11. The workflow on again, the flip PR, then the pipeline

```
gh workflow enable cloud-build.yml
```
The agent opens a pull request that changes **one word** in `.github/workflows/cloud-build.yml`: `support_gateway_db_on_vm=false` → `support_gateway_db_on_vm=true` (the dev branch only). The PO's chain merges it right after
the workflow is on (nothing else is merged to `develop` before it — gate G4). **Merging does not start a build** (the workflow runs on a push to `main` or by hand; since story 3297 the PO starts the dev deploy by hand), so right after the merge the PO starts it: `gh workflow run cloud-build.yml --ref develop`, and waits until `gh run list --workflow cloud-build.yml --branch develop --event workflow_dispatch --limit 1 --json databaseId,status,conclusion` shows `completed` and `success` — until then the gateway's migrate job is the old one (Cloud SQL socket, default subnet) while the secret already names the VM. That dev build then deploys the gateway service with the same flags step 8 gave it (`--clear-cloudsql-instances`, the gateway's own subnet, the pool 3 + 2) and provisions the
gateway's migrate job without a Cloud SQL socket and on the gateway's subnet, then runs it against the VM's database. From here on, a run of the workflow from a ref that does **not** contain the flip (an old branch started by hand) would
put the Cloud SQL socket back: do not start one.
```
gcloud run jobs describe $GWJOB --project $PROJECT --region $REGION --format=json | python3 -c 'import json, sys; a = json.load(sys.stdin)["spec"]["template"]["metadata"].get("annotations", {}); print(len(a.get("run.googleapis.com/cloudsql-instances", "")))'
python3 -I deploy/vm/bin/subnet-residents.py $PROJECT $REGION support-gateway-$ENV --allow-service $GW --allow-job $GWJOB --allow-job gwdb-probe-
gcloud run jobs execute $GWJOB --project $PROJECT --region $REGION --wait; echo "migrate job: exit $?"
```
The first prints **0** (the length of the instance list, not a count of lines), the residents check ends with `VERDICT: OK` and names exactly the gateway service and its migrate job, and the migrate job exits **0** (the schema is already at the head: nothing to migrate). Without the PR the next dev deploy would put the Cloud SQL socket back — so the PR is part of the
cutover, not a clean-up after it.

## 12. The way back (while the database still exists in Cloud SQL)

**What the way back costs.** Cloud SQL's `support_gateway` is **not touched** by anything above, so going back is possible — but it is **lossless only if nothing was written to `gateway-db` since step 9**. Whatever was written after
that is in the VM's database and in its backups and is **not copied back** to Cloud SQL (no replay is provided: the two databases are not merged). Find out first, on the VM:
`sudo env DB_SERVICE=gateway-db /opt/sprintable/bin/rowcounts.sh | diff <(grep -P "^\S+\t\d+$" counts-vm.tsv) -` — **no difference = nothing was written since the restore, going back loses nothing**. A difference = real writes: then
prefer fixing forward on the VM, and go back only if the loss is accepted (it is dev; `sudo systemctl start sprintable-backup.service` first keeps those rows in a `db-gateway-…` dump).
```
BACK=no
gcloud run services remove-iam-policy-binding $GW --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker && BACK=frozen
[ "$BACK" = frozen ] && { TMO=$(gcloud run services describe $GW --project $PROJECT --region $REGION --format='value(spec.template.spec.timeoutSeconds)'); echo "request timeout: $TMO s"; [ -n "$TMO" ] && sleep $((TMO + 10)) && BACK=waited; }   # a request that began before the freeze can still commit to the database on the VM up to the request timeout later
[ "$BACK" = waited ] && { OLDURL=$(gcloud secrets versions access "$OLD_VER" --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT) && [ -n "$OLDURL" ] && printf %s "$OLDURL" | gcloud secrets versions add SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT --data-file=- && BACK=secret || echo "STOP: the old value was not copied"; }
unset OLDURL
[ "$BACK" = secret ] && gcloud run services update $GW --project $PROJECT --region $REGION --add-cloudsql-instances ${PROJECT}:${REGION}:sprintable-${ENV} --network default --subnet default --remove-env-vars SUPPORT_GATEWAY_DB_POOL_SIZE,SUPPORT_GATEWAY_DB_MAX_OVERFLOW && BACK=repointed
[ "$BACK" = repointed ] && gcloud run services add-iam-policy-binding $GW --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker
```
Every line runs only when the one before it succeeded (`BACK` says how far it got): a line that fails leaves the service **frozen** (the public binding is off), which is the safe state — fix the cause and run the block again from the top; putting the binding back is the last line and runs only after the service points at Cloud SQL again. The first line is the same setting that step 4 measured (the VM-side `curl` printed 403 there), so that measurement holds here; if it printed anything else in step 4 the cutover did not start. The wait after the first line is the one of step 4: without it a request still in flight would commit to `gateway-db` after the service already points at Cloud SQL, and the writes would be split between the two. The old value is **added as a new version** (the newest one), so the new revision reads the old URL whatever `latest` means for a disabled version — `latest` is the most recently created version, and a disabled version cannot be read.
The version the cutover made may then be disabled (`gcloud secrets versions disable $NEW_VER --secret=SUPPORT_GATEWAY_DATABASE_URL_dev --project $PROJECT`). If the flip PR was merged, **revert it first** and keep the workflow
off until the revert is merged (otherwise the next dev build puts the cutover flags back). Check with the round trip of step 10 against Cloud SQL. **The pipeline does not take the two pool variables off again** (with the switch off it leaves them as they are): they stay at 3 + 2 on Cloud SQL unless the command above — which removes them — was run.

## After it

The cutover proves gate 0 of `REMOVALS-dev.md` only together with its soak: the removals sheet's R5 (Cloud SQL) still waits for the soak of the new path and the other gates. Record in the story: the freeze window
(T1 − T0) and the wait of step 4, the dump and restore seconds, the row-count diff (empty), the exits of the probes and of the database check, the round trip's six results and the memory numbers.
