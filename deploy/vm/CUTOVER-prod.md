# Prod cutover sheet — Cloud Run + Cloud SQL → one VM (story 4796 AC4)

The order in which the product owner moves **prod** onto its VM, with the command, the way back and what each step interrupts. It is the dev move ([RUNBOOK §7–§9](RUNBOOK.md): front door first, guests one at a time, then the data) with prod's names and **what the dev run taught**: the dev cutover sheet's first real run found three defects in the sheet itself and the dev removals sheet a fourth, and each is applied here before the first run instead of after it.

**Not in this move:** the support gateway (prod's declaration has no `support_gateway` block; if it is wanted, it is its own change — [RUNBOOK §13](RUNBOOK.md) and the TLS item of §12 come first). Cloud SQL prod is **not deleted** here: it stays untouched for a day after the move (the way back), and its removal is a sheet of its own in the shape of [`REMOVALS-dev.md`](REMOVALS-dev.md) R5.

The agent has no cloud access: it writes the lines, the product owner runs them and writes the numbers into the places marked **MEASURE**. A number nobody has measured is written «unmeasured», never guessed.

## What dev taught, applied here

1. **The freeze is the IAM binding, not the ingress setting.** `--ingress internal` lets in the requests of the same project's VPC, and the VM is in it. The freeze takes the public `roles/run.invoker` binding off each service that can write (outside callers and the VM both get 403), the unfreeze puts it back.
2. **The measurement path is `/openapi.json`** (open = 200 `application/json`, frozen = 403). Cloud Run reserves the paths that end in a `z` and answers them itself, so a health path cannot tell the two states apart.
3. **The list of what depends on prod is read, not assumed.** The dev removals sheet expected two jobs and found a service and seven more (the first run stopped there). Step 0 reads the list; every line is decided by the product owner: not used (written down) → definition saved → then and only then touched. **«I do not know» is a stop, not a yes.**
4. **A line runs only when the one before it succeeded** (`STEP` says how far a block got), and a failed line leaves the service **frozen** — the safe state — and says so.
5. **The Cloud SQL check reads the value of `cloudsql-instances`, not the key** (gcloud leaves the annotation with an empty value).
6. **The backup refuses an empty dump on purpose** («lists no table data — refusing»); on a database that has just been restored it does not happen, but the timers are enabled only after the restore ([RUNBOOK §7 step 6](RUNBOOK.md)).
7. **A sheet's first real run always finds something.** The rehearsal (step 1) is run on the sheet's own lines, not on memory of the dev run.

## Names (prod)

```
PROJECT=sprintable-494803; REGION=asia-northeast3; ZONE=asia-northeast3-a; ENV=prod
VM=sprintable-vm-prod; SQL=sprintable-prod
DEPLOY_BUCKET=sprintable-vm-prod-deploy; BACKUPS_BUCKET=sprintable-vm-prod-backups
BACKEND=sprintable-backend-prod; FRONTEND=sprintable-frontend-prod; MCP=sprintable-mcp-prod
API_HOST=api.sprintable.ai; APP_HOST=app.sprintable.ai
```

`sprintable-backend-prod`, `sprintable-frontend-prod` and `sprintable-mcp-prod` are the services the repository's pipeline and declaration name; the VM's name follows dev's (`sprintable-vm-dev`) and the buckets' names come from `env/prod.yaml` — confirm the VM with `gcloud compute instances list --project $PROJECT`. The prod admin consoles, jobs and scheduler jobs are **not named in the repository**: step 0 reads them from the account. The direct database URL secret is `DATABASE_URL_PROD` (the pooler's is `DATABASE_URL_PROD_PGBOUNCER`; the dump uses the direct one).

## Decisions already made (product owner, 2026-10-28)

- **The window is in the Korean small hours.** The product owner's 7-day Monitoring series of `sprintable-backend-prod` requests (hourly mean): about 3,000–3,300 per hour in every Korean hour — that floor is machine traffic (agent streams, polling) — plus people on top in 09:00–18:00 KST (peak about 4,150). So the window is **03:00–05:00 KST (18:00–20:00 UTC of the day before)**. Machine traffic does not go away at night: it has to reconnect (the lap in step 9 has a cell for it).
- **The announcement is a notice, not a request for approval** — the product owner sends it, with the measured numbers of step 1 and, if step 0 finds payments or mail in real use, the span of that use in the sentence.
- **Rollback loses what the VM wrote after the cutover** (it is not copied back to Cloud SQL): accepted. **Fix forward first**; going back is only for the short window right after the cutover (step 12).
- **No prod support gateway in this move.**
- **4789** (backend start about 31 s, the reason the Cloud Run minimum could not be lowered) **closes with this move**, by its own rule («when 4796 is done for prod it closes as no longer needed»): the instance start and the minimum-instances problem are Cloud Run's, and Cloud Run prod is gone. What remains on the VM is a **deploy gap** (a swap of the stack: the product owner measured 68 s for dev) — a separate cell in step 9, not 4789.

## The order

| Step | What | Interrupts | Way back |
|---|---|---|---|
| G | gates (below) | — | — |
| 0 | **read-only**: facts of prod (size, users, payments, mail, webhooks, scheduler, every Cloud Run thing that depends on prod) | nothing | — |
| 1 | rehearsal: dump of prod → restore on the VM → counts and seconds; the window is computed from them | nothing for users (a dump reads) | clean up the rehearsal files |
| 2 | the notice | — | — |
| 3 | front door: `api.sprintable.ai` → the VM, which hands everything on to Cloud Run (data still in Cloud SQL) | seconds (DNS + certificate) | stop the front door, put the records back |
| 4 | guests move to `api.sprintable.ai`, one at a time (apps, GitHub, Toss, scheduler, MCP, connectors) | nothing | each one back |
| 5 | **freeze** (IAM) | **the service is unavailable from here to step 8** | step 8 |
| 6 | final dump → restore → row counts equal | inside the freeze | — |
| 7 | the stack on the VM takes over (`deployer --force`), DNS of the app host | inside the freeze | step 12 |
| 8 | **unfreeze** (only the MCP), the proof, the scheduler | ends the freeze | step 12 |
| 8b | **the prod pipeline stops deploying Cloud Run** (P3 below) — merged right after step 8, before anything else merges to `main` | nothing | revert P3 |
| 9 | the lap: login, stream, **lanes · desktop · MCP reconnect**, mail, payments, scheduler | nothing | step 12 |
| 10 | the day after: soak, backup, restore check | — | step 12 |
| 11 | what is read after a day (the sheet for removing Cloud SQL prod is a separate one) | — | — |
| 12 | the way back | — | — |

## G. Gates

| Gate | What has to be true | How to see it |
|---|---|---|
| **G1. The repository side of RUNBOOK §12 is done** | its items 1–5: `REALTIME_URL` empty in `env/prod.yaml` and its test, `PUBLIC_API_URL`, the pool, the stored-link job against prod's Cloud SQL (run **before** the final dump), the Phase 1/2 shape; plus the image cleanup checker fix (its three limits) so that the keep-in-use policy can be put back for the VM's digests; plus the **prod pipeline changes P1 and P2 below** (P3 is made ready and merged after step 8) | the merged PRs |
| **G2. The VM and the candidate** | the prod VM and its address, firewall, disk (§4); bootstrap (§6); `DB_PASSWORD_VM_PROD` and the other secrets of `env/prod.yaml`; the private plain file **made from the live prod services after the latest prod deploy**; a prod candidate built after the last change to `deploy/vm/` | `gcloud storage ls gs://${DEPLOY_BUCKET}/candidates/` |
| **G3. Nothing can deploy to prod from the start of the window until P3 is merged** | nothing merges to `main` (the prod pipeline runs on a push to `main` and today deploys Cloud Run prod and runs its migration job against **Cloud SQL**: after the move that would reopen Cloud Run with `--allow-unauthenticated` and write to the old database); no build of prod is queued or working | the workflow is switched off for the window (`gh workflow disable cloud-build.yml`) **and** nothing is left in it: `gh run list --limit 200 --json databaseId,status,workflowName,headBranch --jq '.[] | select(.status != "completed" and .workflowName == "Cloud Build (GCP)") | "\(.databaseId) \(.headBranch)"'` prints no line of the branch `main` (a queued run submits its Cloud Build later; the workflow does not cancel it — wait for it or `gh run cancel $RUN_ID`), and `gcloud builds list --project $PROJECT --ongoing --limit 200 --format='value(id,substitutions._DEPLOY_ENV)'` prints no line ending in prod |
| **G4. The window** | 03:00–05:00 KST; the product owner and the security domain reachable; the previous 24 hours of the request log show no unexplained caller of `run.app` (step 4) | step 0 and 4 |
| **G5. Every decision in this sheet is written down** | the answers of step 0 (not used / used / unknown), the notice sent | the product owner's record |

## The prod pipeline: three changes, each its own PR with its test (the order matters)

The dev move needed the pipeline to follow it (`cloud_run_app_skip`, the VM bundle build, the one address switch). Prod's pipeline (`.github/workflows/cloud-build.yml`, the `main` branch of its first `if`) does none of that today, so a prod push after the move would deploy the old thing on top of the new one. These are **not made by this sheet**; they are named here so that none is forgotten, and G1 and G3 hold the order:

- **P1 — before step 4: the one address switch.** The `fastapi_url` line of the prod branch names the Cloud Run backend's `run.app` address; it becomes `https://api.sprintable.ai` (the addresses the hosted MCP and the clients are given follow it, [RUNBOOK §9](RUNBOOK.md)). It merges to `main` as an ordinary prod deploy while Cloud Run still serves.
- **P2 — before G2: the prod VM bundle build.** The step «Submit the dev VM bundle build» runs for `target == 'dev'` only; prod needs the same step (or a bundle built by hand, [RUNBOOK §7 step 1](RUNBOOK.md)) so that a prod candidate with its digests exists, built after the last change to `deploy/vm/`.
- **P3 — merged right after step 8, before anything else merges to `main`: Cloud Run prod is no longer deployed.** One line in the prod branch, `cloud_run_app_skip=true` ([RUNBOOK §10](RUNBOOK.md), «The dev build without Cloud Run»): the Cloud Run frontend build, its migration job and both deploy steps end 0 without calling a tool, while the backend image is still built and pushed (the VM bundle reads it by digest). Until P3 is merged G3 holds; the workflow is switched on again (`gh workflow enable cloud-build.yml`) just before P3 is merged, so that P3's own push is the first prod build after the move, and it skips Cloud Run. Undo: revert P3 (the next prod build deploys Cloud Run again, which serves nothing until the pass-through points at it).

## 0. Read-only: the facts of prod (nothing here changes anything)

**One folder per window.** Every file this sheet writes or reads (`frozen.txt`, `reopen.txt`, `paused.txt`, `jobs.txt`, `scheduler-before.tsv`, `scheduler-moved.tsv`, `counts-vm-final.tsv` on the VM, the `was-public` record) lives in a folder named for the night, and every ladder below refuses to run anywhere else: a later window starts in a folder of its own and cannot pick up the lists of an earlier one. Set `WINDOW` (the date of the night, for example `WINDOW=20261102`) and go into the folder in **every new shell**, on the product owner's machine and on the VM:

```
[ -n "$WINDOW" ] && mkdir -p "window-${WINDOW}" && cd "window-${WINDOW}" && pwd
```

```
gcloud sql instances describe ${SQL} --project $PROJECT --format='value(settings.tier,settings.dataDiskSizeGb,databaseVersion,settings.availabilityType)'
VMIP=$(gcloud compute instances describe ${VM} --project $PROJECT --zone $ZONE --format='value(networkInterfaces[0].accessConfigs[0].natIP)'); echo "the VM's public address: $VMIP"
SRC_IP=$(gcloud sql instances describe ${SQL} --project $PROJECT --format=json | jq -r '.ipAddresses[] | select(.type=="PRIVATE") | .ipAddress'); echo "$SRC_IP"
```

**MEASURE:** the instance is `db-g1-small`, 20 GB disk, PG15 (the product owner, 2026-10-28); the **real data size and the row counts** come from the rehearsal in step 1 (`.counts.tsv`), not from the disk size.

**Everything in the project that depends on prod — read the list, do not assume it.** The first line prints the Cloud Run services and jobs that mount prod's Cloud SQL; the second prints who may call each service (an `allUsers` line means public: that service is frozen in step 5, a service without it needs another freeze, which is the product owner's decision here, written down):

```
for r in services jobs; do for n in $(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)'); do if gcloud run $r describe $n --project $PROJECT --region $REGION --format=json | grep -q ":${SQL}"; then echo "USES CLOUD SQL PROD: $r $n"; fi; done; done
for n in $(gcloud run services list --project $PROJECT --region $REGION --format='value(metadata.name)'); do echo "== $n"; gcloud run services get-iam-policy $n --project $PROJECT --region $REGION --format=json | jq -r '.bindings[]? | select(.role=="roles/run.invoker") | .members[]'; done
gcloud scheduler jobs list --project $PROJECT --location $REGION --format='table(name,schedule,state,httpTarget.uri)'
gcloud scheduler jobs list --project $PROJECT --location $REGION --format='value(name.basename(),httpTarget.uri)' > scheduler-before.tsv
gcloud run jobs list --project $PROJECT --region $REGION --format='value(metadata.name)' > jobs.txt
```

Write the list down (the names of services, jobs, scheduler jobs), and write `frozen.txt` — the services that can write, one name per line (step 5 freezes exactly these; step 8 opens only the ones the product owner marks in `reopen.txt` — the hosted MCP and nothing that writes to the old database — and the way back opens the ones the freeze really took the binding off, `was-public-${WINDOW}.txt`). `scheduler-before.tsv` is every scheduler job with its target (it is the undo of step 4) and `jobs.txt` every Cloud Run job (step 5 proves none of them is running). Every line that is **not** `sprintable-backend-prod`, `sprintable-frontend-prod`, `sprintable-mcp-prod` (and the scheduler jobs whose target is the prod backend) is decided before anything is moved: (a) the product owner states what it is and whether it is used — the last execution of a job (`gcloud run jobs executions list --job $NAME --project $PROJECT --region $REGION --limit 1`), the requests of a service in the last days — and writes the answer down; **«I do not know» is a stop**; (b) a thing that is used gets its own line in the order above (a guest to move in step 4, a service to freeze in step 5); (c) a thing that is not used stays where it is: this sheet deletes nothing of Cloud Run prod.

**Payments, webhooks, scheduler and mail, as the request log and the database say it (the numbers are MEASURE cells):**

```
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.requestUrl:\"/api/v2/webhooks/toss\"" --project $PROJECT --freshness=30d --limit=1000 --format='value(timestamp)' | wc -l
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.requestUrl:\"github-webhook\"" --project $PROJECT --freshness=30d --limit=1000 --format='value(timestamp)' | wc -l
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.userAgent:\"Google-Cloud-Scheduler\"" --project $PROJECT --freshness=24h --limit=1000 --format='value(timestamp)' | wc -l
gcloud secrets list --project $PROJECT --filter='name~RESEND OR name~EMAIL_FROM OR name~TOSS OR name~POLAR' --format='value(name)'
```

A count of 1000 means «at least»: read the same query with a shorter `--freshness`. The Toss line is the payment webhook (`/api/v2/webhooks/toss`); `env/prod.yaml` says this release has no payments secrets, so a non-zero count (or `billing_orders` rows in step 1) is a **finding to stop on**, not a surprise to meet during the freeze. Mail goes out through `RESEND_API_KEY` / `EMAIL_FROM` (both in the declaration): the VM must reach the mail API, which is read from the VM:

```
gcloud compute ssh ${VM} --project $PROJECT --zone $ZONE --tunnel-through-iap --command "curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://api.resend.com/"
```

It must print an HTTP code (any code; `000` is no route). **By hand, in the consoles (write the old values down — they are the undo):** the GitHub App's webhook and callback URL, the Toss webhook URL, the Google and Apple sign-in redirect URIs, the Cloudflare records and routes of `api`, `app`, `mcp`, `realtime` (the realtime gateway has been off since 2026-10-26).

## 1. Rehearsal: the dump, the restore, the seconds

[RUNBOOK §7a](RUNBOOK.md) with prod's names: put the candidate's `desired.json` in place and start the database only (`sudo python3 /opt/sprintable/bin/deployer.py --db-only`, the timers off), then take the dump **on the VM** with the URL on standard input only:

```
gcloud secrets versions access latest --secret=DATABASE_URL_PROD --project $PROJECT | gcloud compute ssh ${VM} --project $PROJECT --zone $ZONE --tunnel-through-iap --ssh-flag=-T --command "sudo /opt/sprintable/bin/dump-source.sh --host ${SRC_IP} --label rehearsal --upload"
```

It prints seconds per step, the size, and the paths of the dump, its checksum and its row counts. Restore it (`restore.sh`, [RUNBOOK §7 step 5](RUNBOOK.md)), compare the counts (on a live database the tables written meanwhile differ — expected; the real run must be empty), then clean up the rehearsal files (§7a).

**MEASURE, and read the findings:** the size, the seconds of dump and restore, and from the counts file the rows of `users`, `organizations`, `team_members` and `billing_orders` (`grep -E '^(users|organizations|team_members|billing_orders)\s' counts.tsv`). **The window is computed, not promised:** the product owner measured dev as dump 45 s for 252 tables and 295 MB, and 4 min 44 s from the start of the dump to `dev-api` answering 200 (restore and bring-up included), and a swap of the stack in 68 s. Prod's downtime is that 4 min 44 s scaled by prod's size ratio, plus the DNS and certificate minutes of step 7; the number goes into the notice only after the rehearsal has produced it. If it does not fit in 03:00–05:00 KST with margin, the window is not used.

## 2. The notice

The product owner sends the notice to the owner (a notice, not a request): the window, the measured downtime of step 1, what is unavailable (the app, the API, the agents' streams, the phones), when it is back, and — only if step 0 found payments or mail in real use — the span in which they do not work. The undo of a notice is a second notice.

## 3. Phase 1 — the front door: `api.sprintable.ai` to the VM, data still in Cloud SQL

[RUNBOOK §7c Phase 1](RUNBOOK.md), with `api.sprintable.ai`. Cloudflare, in this order, after writing the old values down (`dns-before-cutover.json`): (a) delete the route of the API host; (b) change the record `api` to **A → the VM address, DNS only, TTL 60**; (c) wait until two public resolvers agree (`dig +short api.sprintable.ai @1.1.1.1` and `@8.8.8.8` print only the VM address). Then on the VM, at once:

```
sudo /opt/sprintable/bin/front-door.sh passthrough --host api.sprintable.ai --upstream https://sprintable-backend-prod-787818285179.asia-northeast3.run.app
sudo /opt/sprintable/bin/front-door.sh status
```

**MEASURE:** the seconds until the first 200 (`while :; do date +%T; curl -sS -o /dev/null -w '%{http_code}\n' https://api.sprintable.ai/api/v2/health; sleep 1; done`); the streams for ten minutes (lifetime, first byte, gap); the «which address does the backend count» test through the front door ([RUNBOOK §8](RUNBOOK.md): a shared bucket for everyone must be ruled out). **Undo:** `sudo /opt/sprintable/bin/front-door.sh stop`; put the saved route and record back. For prod this is the first time the front door runs against real users: keep the old values at hand for the whole phase.

## 4. Phase 2 — the guests move to `api.sprintable.ai`, one at a time

Each one is its own line, each undoable, and the end is **zero**: Cloud Run's request log shows what still arrives at `run.app` directly. The set, as step 0 found it: P1 (the pipeline's one address switch) and the Electron app's stored address (the server's `FASTAPI_URL`) and the lanes · the GitHub App's webhook and callback · the Toss webhook · the Google and Apple redirects · the scheduler targets (**by hand, the block below**: the repository's scheduler manifest `infra/cloud-scheduler/jobs.json` defines `dev` only, so `apply_cloud_scheduler.py --env prod` stops with a `KeyError` before it changes anything; putting `prod` into the manifest is a follow-up, not part of this move) · the hosted MCP's `SPRINTABLE_API_URL` (`gcloud run services update ${MCP} --project $PROJECT --region $REGION --update-env-vars SPRINTABLE_API_URL=https://api.sprintable.ai`) · the connectors (the repository's defaults; the Pi, OpenCode and OpenClaw entry points resolve their own, [RUNBOOK §9](RUNBOOK.md)) · whatever else step 0 listed as used.

The scheduler jobs whose target is a `run.app` address are given the same path on `api.sprintable.ai` (their schedules, headers and the secret in them are not touched; **only a target on the prod backend's own address is moved** — a job that points anywhere else, another Cloud Run service included, is printed and left alone for the product owner to decide). The block stops at the first failure and writes every job it moved into `scheduler-moved.tsv`; its undo is the second block:

```
SCH=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s scheduler-before.tsv ] && SCH=listed
[ "$SCH" = listed ] && while read -r job uri; do case "$uri" in https://sprintable-backend-prod-787818285179.asia-northeast3.run.app/*) new="https://api.sprintable.ai/${uri#https://*/}"; gcloud scheduler jobs update http "$job" --project $PROJECT --location $REGION --uri "$new" && echo "$job $uri" >> scheduler-moved.tsv || { SCH=failed; break; } ;; *) echo "left alone: $job $uri" ;; esac; done < scheduler-before.tsv
[ "$SCH" = listed ] && SCH=moved
echo "scheduler: $SCH"
```

```
SCH=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s scheduler-moved.tsv ] && SCH=listed
[ "$SCH" = listed ] && while read -r job uri; do gcloud scheduler jobs update http "$job" --project $PROJECT --location $REGION --uri "$uri" || { SCH=failed; break; }; done < scheduler-moved.tsv
[ "$SCH" = listed ] && SCH=back
echo "scheduler: $SCH"
```

The end condition, read by caller: requests whose `httpRequest.remoteIp` is **not** the VM's address are the ones that bypass the front door, and what is left in that set is explained (health checks, a client not yet refreshed) before step 5:

```
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND NOT httpRequest.remoteIp=\"${VMIP}\"" --project $PROJECT --freshness=1h --limit=1000 --format='value(httpRequest.remoteIp,httpRequest.requestUrl)' | sort | uniq -c | sort -rn | head -40
```

## 5. Freeze (the IAM binding)

Preconditions: steps 1–4 done, the window open, the notice sent, G3. Write down the invoker members of every service that can write (step 0) so that the way back puts back exactly them.

**The ladder.** A line runs only when the one before it succeeded; a failing line **leaves the services frozen** (the safe state) and the block can be run again from the top (a service that is already frozen is skipped: removing a binding that is not there is an error in gcloud; a policy that cannot be **read** is a stop, never taken for «already frozen»). Every service the block really froze is written to `was-public-${WINDOW}.txt`: that file, not `frozen.txt`, is what the way back opens again, so a service that was private before the move does not become public by it. It takes the public binding off every service in `frozen.txt` (the backend, the frontend, the hosted MCP and every other service step 0 marked as writing), then **proves** the freeze from outside — the `curl` must print **403** (before the freeze it prints 200 `application/json`) — and only then waits out the longest request (the backend's request timeout + 10 s). `FROZEN` is set to yes by the product owner after reading `frozen.txt`, and `WINDOW` to the date of this night (for example `WINDOW=20261102`): every file the block writes carries it, so a retry in the same window continues the same record and a later window never inherits the services of an earlier one.

```
STEP=no
[ -n "$FROZEN" ] && [ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s frozen.txt ] && STEP=listed
[ "$STEP" = listed ] && while read -r svc; do pol=$(gcloud run services get-iam-policy "$svc" --project $PROJECT --region $REGION --format=json) || { STEP=failed; break; }; has=$(printf '%s\n' "$pol" | jq -r '[.bindings[]? | select(.role=="roles/run.invoker") | .members[] | select(.=="allUsers")] | length') || { STEP=failed; break; }; if [ "$has" != 0 ]; then gcloud run services remove-iam-policy-binding "$svc" --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker || { STEP=failed; break; }; echo "$svc" >> "was-public-${WINDOW}.txt"; fi; done < frozen.txt
[ "$STEP" = listed ] && STEP=frozen
[ "$STEP" = frozen ] && BURL=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(status.url)') && [ -n "$BURL" ] && CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "outside: $CODE" && [ "$CODE" = 403 ] && STEP=proven
[ "$STEP" = proven ] && TMO=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(spec.template.spec.timeoutSeconds)') && [ -n "$TMO" ] && echo "request timeout: $TMO s" && sleep $((TMO + 10)) && STEP=waited && date -u +%FT%TZ
echo "freeze: $STEP"
```

`freeze: waited` is the pass, and the date printed after it is **T0**. Anything else: the services that could be frozen are frozen; fix the cause and run the block again, or go to step 8 (it opens only what `reopen.txt` names; the way back of step 12 opens everything). From the VM the same `curl` (ssh, IAP) must also print **403** — a 200 there means the backend still reaches the service: put the binding back and do not go on.

**Cloud Run jobs are writers too.** A job that mounts prod's Cloud SQL (step 0) can run during the dump: pause the scheduler jobs that call the backend, each noted in `paused.txt` (`gcloud scheduler jobs pause $JOB --project $PROJECT --location $REGION && echo "$JOB" >> paused.txt`), and prove that no execution of any job is running (a running one is waited for or cancelled with `gcloud run jobs executions cancel`, by the product owner's decision, written down):

```
RUN=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s jobs.txt ] && RUN=listed
[ "$RUN" = listed ] && while read -r job; do out=$(gcloud run jobs executions list --job "$job" --project $PROJECT --region $REGION --filter='status.runningCount>0' --format='value(metadata.name)') || { RUN=failed; break; }; n=$(printf '%s\n' "$out" | grep -c . || true); echo "$job running executions: $n"; [ "$n" = 0 ] || RUN=busy; done < jobs.txt
[ "$RUN" = listed ] && RUN=quiet
echo "jobs: $RUN"
```

`jobs: quiet` is the pass; `busy` or `failed` stops the sheet. Show in the request log that no request other than the health check arrived in the last minutes (the cron endpoints are GET requests and write: «no POST» proves nothing).

## 6–7. The data and the takeover (inside the freeze)

1. Stop the front door — the only way `api.sprintable.ai` clients reach Cloud Run: `sudo /opt/sprintable/bin/front-door.sh stop`; then `sudo docker stop sprintable-backend-1 sprintable-frontend-1` (restore refuses with a running backend).
2. Final dump (the command of step 1 with `--label final`, which prints the paths of the dump `FINAL_DUMP` and of its counts `FINAL_COUNTS`) and restore, [RUNBOOK §7 steps 3 and 5](RUNBOOK.md). The restore's output is **kept** (`counts-vm-final.tsv`: the way back of step 12 compares the live database with it), and the diff of the counts must be **empty** (writers are stopped). **MEASURE:** both seconds.

```
sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh "$FINAL_DUMP" > counts-vm-final.tsv
sudo bash -c 'diff "$0" <(grep -P "^\S+\t\d+$" counts-vm-final.tsv)' "$FINAL_COUNTS" && echo "row counts equal"
```

3. `sudo python3 /opt/sprintable/bin/deployer.py --force` (the stack's Caddy starts on the same certificate folder as the front door: no new certificate for the API host).
4. Checks from inside, then from outside (`/api/v2/health`, a login, a stream). `app.sprintable.ai`: delete its route and point the record at the VM (A, proxied; Cloudflare SSL mode **Full (strict)**).
5. Enable the deploy, backup and restore-check timers ([RUNBOOK §7 step 6](RUNBOOK.md)); the backup of an empty database would refuse, which is why this is after the restore.

## 8. Unfreeze (only what is meant to be open)

**Cloud Run's backend and frontend stay closed**: they are the way back, and an open Cloud Run backend would write to Cloud SQL while the VM writes to its own database (two databases, split writes). What is put back is `reopen.txt` — the hosted MCP once its `SPRINTABLE_API_URL` names `https://api.sprintable.ai` (step 4), and nothing that writes to the old database. Resume the paused scheduler jobs (`paused.txt`; their targets are the VM's since step 4). Then the measurement is of **the VM's front**, not of Cloud Run: `https://api.sprintable.ai/openapi.json` must print **200** with `application/json`, and the Cloud Run backend's own address must still print **403**. T1 is the time of that 200; the freeze window is **T1 − T0** plus the wait of step 5 — both are written down as numbers.

```
STEP=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s reopen.txt ] && [ -s "was-public-${WINDOW}.txt" ] && STEP=listed
[ "$STEP" = listed ] && while read -r svc; do grep -qxF "$svc" "was-public-${WINDOW}.txt" || { echo "was not public before the freeze: $svc"; STEP=failed; break; }; gcloud run services add-iam-policy-binding "$svc" --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker || { STEP=failed; break; }; done < reopen.txt
[ "$STEP" = listed ] && STEP=reopened
[ "$STEP" = reopened ] && VMC=$(curl -s -o /dev/null -w '%{http_code}' https://${API_HOST}/openapi.json) && CRC=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "the VM: $VMC · Cloud Run backend: $CRC" && [ "$VMC" = 200 ] && [ "$CRC" = 403 ] && STEP=proven
[ "$STEP" = proven ] && [ -s paused.txt ] && while read -r job; do gcloud scheduler jobs resume "$job" --project $PROJECT --location $REGION || { STEP=failed; break; }; done < paused.txt
[ "$STEP" = proven ] && STEP=resumed
echo "unfreeze: $STEP"
```

The measurement is a gate: the schedulers are resumed only when the line with the two codes reads `the VM: 200 · Cloud Run backend: 403` (`unfreeze: resumed` is the pass; `reopened` means the MCP is open but the codes were not right: look before anything else is resumed). An empty `reopen.txt`, or a window without a `was-public` file, is a stop, not a pass: nothing is reopened and nothing is claimed; a service that was not public before the freeze is never opened by this block.

## 9. The lap (what has to work, and what is only measured)

1. **Login and a conversation** in the app; **a stream** open for ten minutes.
2. **Lanes · desktop · MCP reconnect — the machine traffic.** Prod's floor of about 3,000–3,300 requests an hour is machine traffic (agent streams and polling); in the dev move the question was whether it comes back by itself. Check, in this order, and write the minutes each took: (a) every lane Mac's agent shows online in the app (the count before the freeze, written down in step 5, equals the count now); (b) one desktop-app instruction round trip; (c) one tool call through `sprintable-mcp-prod`. **Open item (a number without a source):** the 7-day figure came from Cloud Run's Monitoring, which stops with the move, and `deploy/vm/Caddyfile` writes no access log, so the VM has no requests-per-hour series today. Either one `log` directive is added to the Caddyfile in the prod candidate (a change with its test), or this cell stays «unmeasured»; the product owner chooses before G2.
3. **Mail:** one real mail from the app (a verification mail to the product owner's own address). **Payments:** only if step 0 found them in use — the webhook of the payment provider reaches the VM (its delivery log shows 200).
4. **The scheduler:** each job's last run after the resume shows success (`gcloud scheduler jobs describe $JOB --project $PROJECT --location $REGION --format='value(status.code,lastAttemptTime)'`).
5. **Memory and connections:** `free -m` on the VM and the `QueuePool limit` count in the backend's log (the pool is 20 + 10 inside 57 usable connections, [RUNBOOK §12 item 3](RUNBOOK.md)); read `pg_stat_activity` once.
6. **The deploy gap, separately from 4789:** a deploy of the stack swaps backend and frontend in about 68 s (dev, measured); the lap writes down prod's number the first time a prod deploy runs.

Any failure in 1–3: step 12.

## 10–11. The day after

The newest status object under `gs://${BACKUPS_BUCKET}/status/prod/` says `deployed`; the backup of the night wrote a dump of a restored (not empty) database, and the weekly restore check finds it. Cloud Run prod (`${BACKEND}`, `${FRONTEND}`) stays **closed** (the binding off) and Cloud SQL prod stays untouched for the day: they are the way back. After the day, the removal is a sheet of its own.

## 12. The way back (fix forward first)

**Fix forward first.** Going back is only for the short window right after the cutover; whatever the VM wrote since is in the VM's database and its backups and is **not copied back** to Cloud SQL (accepted by the product owner). Find out first, on the VM: `sudo /opt/sprintable/bin/rowcounts.sh | diff <(grep -P "^\S+\t\d+$" counts-vm-final.tsv) -` (`counts-vm-final.tsv` is what step 6 kept) — no difference means nothing was written since the restore and going back loses nothing; a difference is real writes: prefer fixing forward, and take a backup first (`sudo systemctl start sprintable-backup.service`) if going back.

Two chains, each gated line by line; a failing line leaves the services frozen (the binding off), which is the safe state — fix the cause and run the chain again from the top. **On the VM** (over ssh), first (the temporary front door was stopped in step 6: the chain does not ask whether it runs, it asks that the stack is there and starts the pass-through):

```
BACK=no
sudo docker ps -a --format '{{.Names}}' | grep -qx sprintable-backend-1 && BACK=seen
[ "$BACK" = seen ] && sudo systemctl disable --now sprintable-deploy.timer && sudo systemctl stop sprintable-deploy.service && BACK=timers
[ "$BACK" = timers ] && sudo docker stop sprintable-caddy-1 sprintable-backend-1 sprintable-frontend-1 && BACK=stopped
[ "$BACK" = stopped ] && sudo /opt/sprintable/bin/front-door.sh passthrough --host api.sprintable.ai --upstream https://sprintable-backend-prod-787818285179.asia-northeast3.run.app && BACK=passing
echo "vm way back: $BACK"
```

Then **from the product owner's machine**, only when the VM chain ended at `passing` (it opens the services the freeze took the binding off — the `was-public` file of this window — and no others):

```
BACK=no
[ "$VMBACK" = passing ] && [ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s "was-public-${WINDOW}.txt" ] && BACK=passing
[ "$BACK" = passing ] && while read -r svc; do gcloud run services add-iam-policy-binding "$svc" --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker || { BACK=failed; break; }; done < "was-public-${WINDOW}.txt"
[ "$BACK" = passing ] && BACK=reopened
[ "$BACK" = reopened ] && CRC=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "Cloud Run backend: $CRC" && [ "$CRC" = 200 ] && BACK=proven
[ "$BACK" = proven ] && [ -s paused.txt ] && while read -r job; do gcloud scheduler jobs resume "$job" --project $PROJECT --location $REGION || { BACK=failed; break; }; done < paused.txt
[ "$BACK" = proven ] && BACK=done
echo "way back: $BACK"
```

`VMBACK` is set to `passing` by the product owner only after the VM chain above printed its last line (`BACK=passing`); `way back: done` is the pass. A missing or empty `was-public` file for this window, an unset `WINDOW` or an answer of Cloud Run other than 200 is a stop: nothing is resumed on top of it, and the services stay as they are until the cause is found.

The scheduler targets go back with the second block of step 4 (`scheduler-moved.tsv`). Then the records of `app` back to what they were (step 0, written down), and the guests of step 4 that were moved to `api.sprintable.ai` keep working through the pass-through. After a successful way back the next move is a new sheet run from step 1, not a repetition of this one.

## Questions for the owner (one line each)

1. The window (03:00–05:00 KST on which night) and the notice — the product owner sends it.
2. Going back after real use loses the VM's writes: accepted (fix forward first).
3. A prod support gateway is not in this move.
4. If step 0 finds payments or mail in real use, their span goes into the notice.
