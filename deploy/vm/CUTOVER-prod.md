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
FWD_SA=sprintable-forwarder-prod; FWD_TAG=fwd   # the forwarder of the old address (step 4c)
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
| 4c | **the forwarder of the old address**: image built, a revision with no traffic and a tag made and tested, the real revision written down | nothing (a revision with no traffic) | remove the tag, delete the revision |
| 5 | **freeze** (IAM) | **the service is unavailable from here to step 8** | step 8 |
| 6 | final dump → restore → row counts equal | inside the freeze | — |
| 7 | the stack on the VM takes over (`deployer --force`), DNS of the app host | inside the freeze | step 12 |
| 8 | **unfreeze** (the MCP), the proof, the scheduler; then **the forwarder takes the old address** (8c) | ends the freeze | step 12 |
| 8b | **the prod pipeline stops deploying Cloud Run** (P3 below) — merged right after step 8, before anything else merges to `main` | nothing | revert P3 |
| 9 | the lap: login, stream, **lanes · desktop · MCP reconnect**, mail, payments, scheduler | nothing | step 12 |
| 10 | the day after: soak, backup, restore check | — | step 12 |
| 11 | what is read after a day (the sheet for removing Cloud SQL prod is a separate one) | — | — |
| 12 | the way back | — | — |

## G. Gates

| Gate | What has to be true | How to see it |
|---|---|---|
| **G1. The repository side of RUNBOOK §12 is done** | its items 1–5: `REALTIME_URL` empty in `env/prod.yaml` and its test, `PUBLIC_API_URL`, the pool, the stored-link job against prod's Cloud SQL (run **before** the final dump), the Phase 1/2 shape; plus the image cleanup checker fix (its three limits) so that the keep-in-use policy can be put back for the VM's digests; plus the **prod pipeline changes P1, P2, P4 and P5 below** (P3 is made ready and merged after step 8) and the **forwarder files** (`deploy/vm/forwarder/`, step 4c) | the merged PRs |
| **G1a. The promotion (`develop` → `main`) is done and one day old, before G2** | `develop` is promoted to `main` once, as an ordinary prod deploy, **before** the window (Cloud Run prod gets today's code, the migrations of the promotion run against Cloud SQL, P2 builds the prod candidate of the same sha); the window starts only after one day of real use. Then the candidate of G2 is the sha that Cloud Run runs, and the schema is the one the candidate expects — the window carries the infrastructure move and no code change. The promotion carries **no migration** (measured by the product owner, 2026-10-28: the three revisions of the payment axis, 0282, 0288 and 0291, stay out of it), which the first line of the block under «G1a» below shows as `revisions to run: 0`; if it shows more, the lines under it are read for the time two revisions run side by side | the promotion's merge; the block below |
| **G2. The VM and the candidate** | the prod VM and its address, firewall, disk (§4); bootstrap (§6); `DB_PASSWORD_VM_PROD` and the other secrets of `env/prod.yaml`; the private plain file **made from the live prod services after the latest prod deploy**; a prod candidate built after the last change to `deploy/vm/`; **and the read-only look at the VM, its buckets and its secrets (the block below) with the expected output** | `gcloud storage ls gs://${DEPLOY_BUCKET}/candidates/`, and the look below |
| **G3. Nothing can deploy to prod from the start of the window until P3 is merged** | nothing merges to `main` (the prod pipeline runs on a push to `main` and today deploys Cloud Run prod and runs its migration job against **Cloud SQL**: after the move that would reopen Cloud Run with `--allow-unauthenticated` and write to the old database); no build of prod is queued or working | the workflow is switched off for the window (`gh workflow disable cloud-build.yml`) **and** nothing is left in it: `gh run list --limit 200 --json databaseId,status,workflowName,headBranch --jq '.[] | select(.status != "completed" and .workflowName == "Cloud Build (GCP)") | "\(.databaseId) \(.headBranch)"'` prints no line of the branch `main` (a queued run submits its Cloud Build later; the workflow does not cancel it — wait for it or `gh run cancel $RUN_ID`), and `gcloud builds list --project $PROJECT --ongoing --limit 200 --format='value(id,substitutions._DEPLOY_ENV)'` prints no line ending in prod — **with a positive control, so the empty answer cannot be vacuous**: `gcloud builds list --project $PROJECT --limit 40 --format='value(id,substitutions._DEPLOY_ENV)'` (finished builds included) must print at least one line ending in `prod` (measured by the product owner on the real account, 2026-10-28: of the last 40 builds three end in `prod`, the last of 2026-10-27 07:18 UTC, so the empty answer of the first command is not vacuous) |
| **G4. The window** | 03:00–05:00 KST; the product owner and the security domain reachable; **the old address is not a gate**: what still calls `run.app` is not asked to change, it is forwarded to the VM from step 8 (step 4c) and counted afterwards (steps 10–11) | step 4c and 8c |
| **G5. Every decision in this sheet is written down** | the answers of step 0 (not used / used / unknown), the notice sent, `forwarder: ready` (4c) and the seconds of T0 to T2 (8c), the clean-up of the dump copies on the list of the day after (steps 10–11), and the two acceptances below | the product owner's record |

**The two acceptances of G5 (product owner, 2026-10-28).** (1) **One account for the VM, in prod too:** prod takes the account model of [RUNBOOK §2](RUNBOOK.md) as it is. (2) **During step 3 the callers are counted as one address** (the VM's) by the backend's per-address limits. That is accepted only with numbers, not because it is night. The limits that count by the socket address (the shared limiter, `backend/app/core/rate_limit.py`; an API key counts by itself) are: `POST /api/v2/auth/register` 5 a minute; `/auth/token`, `/auth/native-bootstrap`, `/auth/native-bootstrap/challenges`, `/auth/device-installations/registration-challenges` and `/auth/device-installations/register` 10 a minute each; `/auth/refresh` and `/auth/switch-account` 20 a minute each; `GET /api/v2/legal/{doc_type}` 60 a minute. **A second family counts by `client_ip`** (the address behind the proxy headers, `backend/app/core/client_ip.py`): `POST /api/v2/desktop/setup-codes` and `POST /api/v2/desktop/device-token-codes` 10 a minute each, their two `…/exchange` routes 240 a minute each, `POST /api/v2/onboarding/events` 120 a minute, the OAuth hand-off `issue` (5) and `consume` (10) a minute in the custom-scheme mode (`/api/v2/internal/auth/oauth-handoff/…`), and `POST /api/v2/auth/set-password/request` and `POST /api/v2/auth/resend-verification` 3 an hour each. A request that comes through the web front door carries the user's own address, so these count by the user; **a request sent to the API name directly arrives with the front door's address — the VM's one address for every caller — so for those callers these limits too are counted as one address.** The dawn total of all requests is about 55 a minute (3,000–3,300 an hour), but these routes are a few of them, so the question is asked per route: the block below (read-only) prints the busiest minutes of each in the last 7 days. **Accepted** only if the busiest minute of every route is below its limit; **not accepted** if any is at or above it — then step 3 does not run until the proxy's address is trusted for that phase (the product owner is told which route and how many).

```
for route in register token refresh switch-account native-bootstrap device-installations/registration-challenges device-installations/register; do
  echo "== POST /api/v2/auth/$route: busiest minutes of the last 7 days (count minute)"
  gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl:\"/api/v2/auth/$route\"" --project $PROJECT --freshness=7d --limit=5000 --format='value(timestamp)' | cut -c1-16 | sort | uniq -c | sort -rn | head -3
done
```

The `client_ip` family and the one `GET` route, the same way (the two mail routes by the hour: `cut -c1-13`):

```
for route in desktop/setup-codes desktop/setup-codes/exchange desktop/device-token-codes desktop/device-token-codes/exchange onboarding/events internal/auth/oauth-handoff/issue internal/auth/oauth-handoff/consume; do
  echo "== POST /api/v2/$route: busiest minutes of the last 7 days (count minute)"
  gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl:\"/api/v2/$route\"" --project $PROJECT --freshness=7d --limit=5000 --format='value(timestamp)' | cut -c1-16 | sort | uniq -c | sort -rn | head -3
done
echo "== GET /api/v2/legal/: busiest minutes of the last 7 days (count minute)"
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.requestMethod=\"GET\" AND httpRequest.requestUrl:\"/api/v2/legal/\"" --project $PROJECT --freshness=7d --limit=5000 --format='value(timestamp)' | cut -c1-16 | sort | uniq -c | sort -rn | head -3
for route in auth/set-password/request auth/resend-verification; do
  echo "== POST /api/v2/$route: busiest hours of the last 7 days (count hour)"
  gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl:\"/api/v2/$route\"" --project $PROJECT --freshness=7d --limit=5000 --format='value(timestamp)' | cut -c1-13 | sort | uniq -c | sort -rn | head -3
done
```

A count of 5000 lines means «at least» (read a shorter `--freshness`). **MEASURE:** the busiest minute (hour) of each route, next to its limit. The product owner measured these on 2026-10-28 over 7 days (record of G5): every route's busiest minute (hour) was far below its limit; the lines above are the way to repeat it on the day.

## G1a, the migrations of the promotion (read-only, offline: the files, not the database)

**Expected: the promotion carries no migration.** The product owner measured it on 2026-10-28 (the three revisions of the payment axis, 0282, 0288 and 0291, are not part of this promotion either). The block below repeats the measurement from the files on the day: it reads the version prod is at and prints `revisions to run: 0`. Only if the number is **not 0** does the rest of this section apply. The pipeline runs the migration job **before** it deploys the backend, so during the roll the **previous revision of the code serves against the new schema**. The question is whether it can: an added table or a nullable column it never reads is harmless; a dropped or renamed column or table, a column that became `NOT NULL` without a default, a changed type, a constraint that its writes can violate, or a data statement are not. The block lists, from the revision files, the statements to read (it prints a line per hit, with the file name and line; it changes nothing and needs no database):

```
# the product owner reads the version from the database of prod (select version_num from alembic_version) — never from `alembic heads` or the repository, which would make the answer 0 for any prod — checks that it is the same as the last line of the migration job's log of the promotion's deploy, and sets CUR to it first; unset, the next line stops
CUR=${CUR:?CUR is not set: the version_num of the prod alembic_version table}
[ -n "$CUR" ] && HIST=$( cd "$REPO/backend" && DATABASE_URL=postgresql+asyncpg://offline:offline@localhost/offline python3 -m alembic history -r "${CUR}:head" ) && printf '%s\n' "$HIST" | { grep -v -- "^[^ ]* -> ${CUR} " || true; } > promotion-history.txt && echo "revisions to run: $(grep -cE '^[^ ]+ -> ' promotion-history.txt)" || echo "history: stop"
grep -E '^[^ ]+ -> ' promotion-history.txt | sed -E 's/^[^ ]+ -> ([^ ,]+).*/\1/' | while read -r id; do for f in "$REPO"/backend/alembic/versions/${id}_*.py; do awk -v F="${f##*/}" '/^def upgrade/{u=1} /^def downgrade/{u=0} u && /op\.(drop_|rename_|alter_column|batch_alter_table|create_unique_constraint|create_check_constraint|create_foreign_key|create_index|bulk_insert)|\.execute\(|add_column.*nullable=False/ {print F ":" FNR ": " substr($0,1,200)}' "$f"; done; done
```

**Read every line it prints and write the verdict next to it in the record of G1a.** *Safe with the old revision serving*: the old code does not use the object, or the object accepts what the old code writes (a check on a column that has a default; an index on a nullable column it never sets). *A stop — the promotion waits for a compatible plan*: anything the old code's reads or writes can fail on. An index built without `CONCURRENTLY` blocks writes to its table while it scans it: read the row count of that table in step 0 and write it next to the line (sub-second for tens of thousands of rows; a larger table is a stop). The block reads only the `upgrade()` function of each file; a revision that does its work in a helper outside it is read whole by hand.

If the number is not 0, the three newest revisions of `develop` at the time of writing (0467 to 0469) are an example of what is easy to judge: each adds one nullable column or new tables and their indexes, and the two index builds are the lines to weigh against the row counts.

## G2, the read-only look (names, numbers, booleans — nothing changes)

For a move of real data the gate carries a look at what is exposed, not only a list of what exists. Run it from the window folder of step 0 (so that `REPO` and `VMIP` are set; `VMIP` is read in step 0) once the VM is bootstrapped; the stack-dependent line is run again at step 3 and in the lap. The expected output is written next to each line; anything else is a stop, written down.

```
VMSA=$(gcloud compute instances describe ${VM} --project $PROJECT --zone $ZONE --format='value(serviceAccounts[0].email)'); echo "the VM's account: $VMSA"
for b in ${DEPLOY_BUCKET} ${BACKUPS_BUCKET}; do echo "$b: $(gcloud storage buckets describe gs://$b --format='value(public_access_prevention,uniform_bucket_level_access)')"; done
gcloud compute firewall-rules list --project $PROJECT --filter='direction=INGRESS' --format='table(name,priority,sourceRanges.list():label=FROM,targetTags.list():label=TARGET,allowed[].map().firewall_rule().list():label=ALLOW,denied[].map().firewall_rule().list():label=DENY)'
for port in 22 3389 5432; do if nc -z -w 3 "$VMIP" "$port"; then echo "OPEN from outside: $port"; else echo "closed from outside: $port"; fi; done
gcloud sql instances describe ${SQL} --project $PROJECT --format='value(settings.ipConfiguration.ipv4Enabled,settings.ipConfiguration.privateNetwork,settings.ipConfiguration.authorizedNetworks)'
python3 "$REPO/deploy/vm/bin/render_env.py" --secret-ids "$REPO/deploy/vm/env/prod.yaml" | while read -r id; do n=$(gcloud secrets versions list "$id" --project $PROJECT --filter='state=ENABLED' --format='value(name)' | grep -c . || true); has=$(gcloud secrets get-iam-policy "$id" --project $PROJECT --format=json | jq -r --arg sa "serviceAccount:${VMSA}" '[.bindings[]? | select(.role=="roles/secretmanager.secretAccessor") | .members[] | select(.==$sa)] | length'); echo "$id enabled=$n vm_accessor=$has"; done
echo "ids in the declaration: $(python3 "$REPO/deploy/vm/bin/render_env.py" --secret-ids "$REPO/deploy/vm/env/prod.yaml" | grep -c .)"
```

The backups bucket carries the lifecycle rule for `import/` ([RUNBOOK §1](RUNBOOK.md): the dumps of this move are whole copies of the database and go after 7 days). Put it there and read it back (this is the one line of the look that changes something — the product owner runs it once, before the rehearsal writes the first dump):

```
gcloud storage buckets describe gs://${BACKUPS_BUCKET} --format=json > lifecycle-before.json && jq -r '.lifecycle_config.rule[]? | "before: \(.condition.age) days  \(.condition.matchesPrefix[0])"' lifecycle-before.json
cat > lifecycle.json <<'EOF'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":14,"matchesPrefix":["db/"]}},{"action":{"type":"Delete"},"condition":{"age":7,"matchesPrefix":["status/"]}},{"action":{"type":"Delete"},"condition":{"age":7,"matchesPrefix":["import/"]}}]}
EOF
[ -s lifecycle-before.json ] && gcloud storage buckets update gs://${BACKUPS_BUCKET} --lifecycle-file=lifecycle.json
gcloud storage buckets describe gs://${BACKUPS_BUCKET} --format=json | jq -r '.lifecycle_config.rule[] | "\(.condition.age) days  \(.condition.matchesPrefix[0])"'
```

**Expected:** the `before:` lines are exactly `14 days  db/` and `7 days  status/` (RUNBOOK §1) — anything else is a stop: a rule the bucket has that this file lacks would be removed by the update (`--lifecycle-file` replaces the whole configuration), so fold it into `lifecycle.json` first. The last lines print `14 days  db/`, `7 days  status/` and `7 days  import/`. **Undo:** `jq '{rule: .lifecycle_config.rule}' lifecycle-before.json > lifecycle-undo.json && gcloud storage buckets update gs://${BACKUPS_BUCKET} --lifecycle-file=lifecycle-undo.json`. For the two buckets and the rest of the look, **expected:** both buckets print `enforced	True` (public access prevention enforced, uniform bucket-level access); the firewall table shows, for the VM's tag **and for the rules that name no tag (they apply to every machine of the project)**, only the web rule (80 and 443 from anywhere), the IAP rule (22 from `35.235.240.0/20`) and the deny of 22 and 3389 from anywhere — no rule that opens 5432, and no source of `0.0.0.0/0` on any port but 80 and 443; the three ports print `closed from outside` (run from a machine outside Google); the instance prints `False` for the public address, its private network and **no** authorized network; and the line `ids in the declaration: 21` is printed, then each of the 21 ids prints `enabled=1` or more and `vm_accessor=1` (the secret lines need the `python3` of the machine to have PyYAML: with a `python3` without it the loop prints nothing and the count prints `0` — that is a stop, not a pass) — **none** of them is a Cloud SQL connection string (`DATABASE_URL_PROD`, `DATABASE_URL_PROD_PGBOUNCER` are not in the list and the VM has no access to them). On the VM, with the stack up (step 3 and the lap): `sudo ss -ltn` lists 80 and 443 on the public side and 22, and **no** 5432, 8000 or 3000 published.

## The prod pipeline: five changes, each its own PR with its test (the order matters)

The dev move needed the pipeline to follow it (`cloud_run_app_skip`, the VM bundle build, the one address switch, the scheduler's definitions, a way to count requests). Prod's pipeline (`.github/workflows/cloud-build.yml`, the `main` branch of its first `if`) does none of that today, so a prod push after the move would deploy the old thing on top of the new one. These are **not made by this sheet** (each is its own PR with its test, made by the story's owner); they are named here so that none is forgotten, and G1 and G3 hold the order:

**State when this was written (2026-10-28, evening).** *Merged:* P2 (#5328: the VM bundle build runs for prod, into its own deploy bucket), P4 (#5324), P5 (#5326, and the same filter on Caddy's default log) and P6 (#5329: the prod declaration — `REALTIME_URL` empty, `PUBLIC_API_URL` = `https://api.sprintable.ai`; it is read by the VM only). *Open:* P1 (#5327, a draft until `api.sprintable.ai` answers with the prod backend, step 3), P3 (ready locally, pushed on the product owner's signal right after step 8) and P7 (the pipeline's prod branch drops its `--remove-env-vars` of `PUBLIC_API_URL`; a draft like P1, not yet made).

- **P1 — before step 4: the one address switch.** The `fastapi_url` line of the prod branch names the Cloud Run backend's `run.app` address; it becomes `https://api.sprintable.ai` (the addresses the hosted MCP and the clients are given follow it, [RUNBOOK §9](RUNBOOK.md)). It merges to `main` as an ordinary prod deploy while Cloud Run still serves.
- **P2 — before G2: the prod VM bundle build.** The step «Submit the dev VM bundle build» runs for `target == 'dev'` only; prod needs the same step (or a bundle built by hand, [RUNBOOK §7 step 1](RUNBOOK.md)) so that a prod candidate with its digests exists, built after the last change to `deploy/vm/`.
- **P4 — before step 4: prod's scheduler jobs are defined in the repository** (`infra/cloud-scheduler/jobs.json`: `environments.prod` with the four jobs prod has, and the two schedules that differ from dev's), so that step 4 moves their target with the repository's own script and not by hand. Until it is merged `apply_cloud_scheduler.py --env prod` stops with a `KeyError`.
- **P5 — before G2: the access log of the front** (`log` in `deploy/vm/Caddyfile`, standard output, no headers, no URI) — the VM's only source of a requests-per-hour figure (the lap, step 9).
- **P3 — merged right after step 8, before anything else merges to `main`: Cloud Run prod is no longer deployed.** One line in the prod branch, `cloud_run_app_skip=true` ([RUNBOOK §10](RUNBOOK.md), «The dev build without Cloud Run»): the Cloud Run frontend build, its migration job and both deploy steps end 0 without calling a tool, while the backend image is still built and pushed (the VM bundle reads it by digest). Until P3 is merged G3 holds; the workflow is switched on again (`gh workflow enable cloud-build.yml`) just before P3 is merged, so that P3's own push is the first prod build after the move, and it skips Cloud Run. Undo: revert P3 (the next prod build deploys Cloud Run again, which serves nothing until the pass-through points at it). **P3 is also what keeps the forwarder in place:** the only pipeline step that touches the service `${BACKEND}` is `deploy-backend`, and with `_CLOUD_RUN_APP_SKIP=true` it ends 0 on its first line without calling gcloud (`cloudbuild.yaml`); without P3 the next prod push would make a new real revision and send 100% of the traffic to it, over the forwarder — which is why G3 holds until P3 is merged.

## 0. Read-only: the facts of prod (nothing here changes anything)

**One folder per window.** Every file this sheet writes or reads (`frozen.txt`, `reopen.txt`, `paused.txt`, `jobs.txt`, `scheduler-before.tsv`, `scheduler-moved.tsv`, `counts-vm-final.tsv` on the VM, the `was-invoker` record) lives in a folder named for the night, and every ladder below refuses to run anywhere else: a later window starts in a folder of its own and cannot pick up the lists of an earlier one. Set `WINDOW` (the date of the night, for example `WINDOW=20261102`) and go into the folder in **every new shell**. On the product owner's machine the folder is outside the checkout (the lists are not for the repository), so the line is run once **from the repository checkout**: it remembers where the checkout is (`REPO`, which the blocks use for the repository's own scripts) and then goes into the folder:

```
[ -n "$WINDOW" ] && REPO=$(git rev-parse --show-toplevel) && mkdir -p "$HOME/prod-move/window-${WINDOW}" && cd "$HOME/prod-move/window-${WINDOW}" && pwd
```

On the VM (no checkout there; the same folder name):

```
[ -n "$WINDOW" ] && mkdir -p "$HOME/window-${WINDOW}" && cd "$HOME/window-${WINDOW}" && pwd
```

```
gcloud sql instances describe ${SQL} --project $PROJECT --format='value(settings.tier,settings.dataDiskSizeGb,databaseVersion,settings.availabilityType)'
TMO=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(spec.template.spec.timeoutSeconds)'); echo "the backend's request timeout: $TMO s -> the freeze waits $((TMO + 10)) s"
VMIP=$(gcloud compute instances describe ${VM} --project $PROJECT --zone $ZONE --format='value(networkInterfaces[0].accessConfigs[0].natIP)'); echo "the VM's public address: $VMIP"
SRC_IP=$(gcloud sql instances describe ${SQL} --project $PROJECT --format=json | jq -r '.ipAddresses[] | select(.type=="PRIVATE") | .ipAddress'); echo "$SRC_IP"
```

**MEASURE:** the request timeout (the product owner read 1800 s: the freeze then waits **1810 s**, step 5; the rehearsal's number does not contain it, so the notice's window is **1810 s + the rehearsal's measured downtime + the seconds of step 4b**); the instance is `db-g1-small`, 20 GB disk, PG15 (the product owner, 2026-10-28); the **real data size and the row counts** come from the rehearsal in step 1 (`.counts.tsv`), not from the disk size.

**Everything in the project that depends on prod — read the list, do not assume it.** The first ladder prints the Cloud Run services and jobs that **mount** prod's Cloud SQL socket, **name the direct-URL secret** (`DATABASE_URL_PROD`, which also matches the pooler's) or **hold the instance's private address** (a service can reach the database by the secret or the address without mounting the socket; the first version of the loop looked at the socket only); the second prints **every** member that may call each service, not only the public one. Both end with a line that is the pass: `dependents: listed` and `invokers: listed` — a list or a describe that failed, an unreadable source address or a folder outside the window ends with `failed` or `no` and **an empty answer is never read as «nothing depends on prod»** (the first version of the loop read it so). The freeze (step 5) takes **every** invoker member off the services in `frozen.txt` but the operator account printed above, and records each one, so that the way back puts back exactly those:

```
DEP=no
[ -n "$SRC_IP" ] && [ -n "$SQL" ] && DEP=listing
[ "$DEP" = listing ] && for r in services jobs; do names=$(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)') || { DEP=failed; break; }; for n in $(printf '%s\n' "$names"); do d=$(gcloud run $r describe $n --project $PROJECT --region $REGION --format=json) || { DEP=failed; break 2; }; if printf '%s\n' "$d" | grep -q -e ":${SQL}" -e "DATABASE_URL_PROD" -e "${SRC_IP}"; then echo "USES CLOUD SQL PROD: $r $n"; fi; done; done
[ "$DEP" = listing ] && DEP=listed
echo "dependents: $DEP"
INV=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && INV=listing
[ "$INV" = listing ] && { OPR=$(gcloud config get-value account) && [ -n "$OPR" ] && [ "$OPR" != "(unset)" ] && echo "the operator account (it stays an invoker in the freeze): $OPR" || INV=failed; }
[ "$INV" = listing ] && { svcs=$(gcloud run services list --project $PROJECT --region $REGION --format='value(metadata.name)') || INV=failed; }
[ "$INV" = listing ] && for n in $(printf '%s\n' "$svcs"); do pol=$(gcloud run services get-iam-policy $n --project $PROJECT --region $REGION --format=json) || { INV=failed; break; }; echo "== $n"; printf '%s\n' "$pol" | jq -r '.bindings[]? | select(.role=="roles/run.invoker") | .members[]' || { INV=failed; break; }; done
[ "$INV" = listing ] && INV=listed
echo "invokers: $INV"
gcloud scheduler jobs list --project $PROJECT --location $REGION --format='table(name,schedule,state,httpTarget.uri)'
if [ -e scheduler-before.tsv ]; then echo "scheduler-before.tsv exists: kept as it is (it is the way back of the targets; move it aside by hand only if this folder is a new window)"; else gcloud scheduler jobs list --project $PROJECT --location $REGION --format='value(name.basename(),httpTarget.uri)' > scheduler-before.tsv.tmp && mv scheduler-before.tsv.tmp scheduler-before.tsv && echo "scheduler-before.tsv written: $(grep -c . scheduler-before.tsv) jobs"; fi
gcloud run jobs list --project $PROJECT --region $REGION --format='value(metadata.name)' > jobs.txt
```

Write the list down (the names of services, jobs, scheduler jobs), and write `frozen.txt` — the services that can write, one name per line (step 5 freezes exactly these; step 8 opens only the ones the product owner marks in `reopen.txt` — the hosted MCP and nothing that writes to the old database — and the way back opens the ones the freeze really took the binding off, `was-invoker-${WINDOW}.tsv`). `scheduler-before.tsv` is every scheduler job with its target (it is the undo of step 4) and `jobs.txt` every Cloud Run job (step 5 proves none of them is running). Every line that is **not** `sprintable-backend-prod`, `sprintable-frontend-prod`, `sprintable-mcp-prod` (and the scheduler jobs whose target is the prod backend) is decided before anything is moved: (a) the product owner states what it is and whether it is used — the last execution of a job (`gcloud run jobs executions list --job $NAME --project $PROJECT --region $REGION --limit 1`), the requests of a service in the last days — and writes the answer down; **«I do not know» is a stop**; (b) a thing that is used gets its own line in the order above (a guest to move in step 4, a service to freeze in step 5); (c) a thing that is not used stays where it is: this sheet deletes nothing of Cloud Run prod.

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

**MEASURE, and read the findings:** the size, the seconds of dump and restore, and from the counts file the rows of `users`, `organizations`, `team_members` and `billing_orders` (`grep -E '^(users|organizations|team_members|billing_orders)\s' counts.tsv`). **The window is computed, not promised:** the product owner measured dev as dump 45 s for 252 tables and 295 MB, and 4 min 44 s from the start of the dump to `dev-api` answering 200 (restore and bring-up included), and a swap of the stack in 68 s. Prod's downtime is that 4 min 44 s scaled by prod's size ratio, plus the DNS and certificate minutes of step 7, **plus the wait of the freeze** (the backend's request timeout + 10 s, read in step 5 — 1810 s if prod's timeout is 1800 s; the rehearsal does not contain it and the freeze window of step 8 does), **plus step 4b** (the backup of the VM database that 4b takes before it rewrites — about the seconds of the rehearsal's dump — and the rewrite itself: the module's seconds as the product owner measured them on dev, written in the record of G5). **Dev, measured by the product owner:** the backup that 4b starts took **46 s** (2026-10-27, 21:20:12Z to 21:20:58Z by the unit's journal; 6.8 s of CPU), the module's report **1.6 s** and its plan **1.3 s** (read-only, in the same container, 6 stored links), and the apply is one transaction of the same shape (it printed `rewritten 6`, and the report after it listed no `run.app`). So the cell of 4b in the window is **the backup, which follows the size of the database (the rehearsal's dump seconds are the better estimate for prod), plus a few seconds of module**; the number of links hardly moves it; the number goes into the notice only after the rehearsal has produced it. If it does not fit in 03:00–05:00 KST with margin, the window is not used.

## 2. The notice

The product owner sends the notice to the owner (a notice, not a request): the window, the measured downtime of step 1 **with the freeze wait and step 4b added** (the window of the notice is 1810 s + the rehearsal's downtime + the seconds of 4b), what is unavailable (the app, the API, the agents' streams, the phones), when it is back, and — only if step 0 found payments or mail in real use — the span in which they do not work. The undo of a notice is a second notice.

## 3. Phase 1 — the front door: `api.sprintable.ai` to the VM, data still in Cloud SQL

[RUNBOOK §7c Phase 1](RUNBOOK.md), with `api.sprintable.ai`. Cloudflare, in this order, after writing the old values down (`dns-before-cutover.json`): (a) delete the route of the API host; (b) change the record `api` to **A → the VM address, DNS only, TTL 60**; (c) wait until two public resolvers agree (`dig +short api.sprintable.ai @1.1.1.1` and `@8.8.8.8` print only the VM address). Then on the VM, at once:

```
sudo /opt/sprintable/bin/front-door.sh passthrough --host api.sprintable.ai --upstream https://sprintable-backend-prod-787818285179.asia-northeast3.run.app
sudo /opt/sprintable/bin/front-door.sh status
```

**MEASURE:** the seconds until the first 200 (`while :; do date +%T; curl -sS -o /dev/null -w '%{http_code}\n' https://api.sprintable.ai/api/v2/health; sleep 1; done`); the streams for ten minutes (lifetime, first byte, gap); the «which address does the backend count» test through the front door ([RUNBOOK §8](RUNBOOK.md): a shared bucket for everyone must be ruled out). **Undo:** `sudo /opt/sprintable/bin/front-door.sh stop`; put the saved route and record back. For prod this is the first time the front door runs against real users: keep the old values at hand for the whole phase.

## 4. Phase 2 — the guests move to `api.sprintable.ai`, one at a time

Each one is its own line, each undoable, and the end is **zero**: Cloud Run's request log shows what still arrives at `run.app` directly (what does is not a gate: from step 8 the forwarder of step 4c hands it to the VM, and steps 10–11 count it). The set, as step 0 found it: P1 (the pipeline's one address switch) and the Electron app's stored address (the server's `FASTAPI_URL`) and the lanes · the GitHub App's webhook and callback · the Toss webhook · the Google and Apple redirects · the scheduler targets (**the repository's script, after P4** — the block below; the hand move after it is the reserve for a script that stops) · the hosted MCP's `SPRINTABLE_API_URL` (`gcloud run services update ${MCP} --project $PROJECT --region $REGION --update-env-vars SPRINTABLE_API_URL=https://api.sprintable.ai`) · the connectors (the repository's defaults; the Pi, OpenCode and OpenClaw entry points resolve their own, [RUNBOOK §9](RUNBOOK.md)) · whatever else step 0 listed as used.

**The scheduler, by the script (P4 merged).** The plan is read before anything is applied: it must be **four `UPDATE` lines (each only the `uri`), no `CREATE`, no `UNMANAGED`** — the four jobs prod runs, pointed at `https://api.sprintable.ai` — and only then is it applied. The script reads the Authorization value from the prod backend (still on Cloud Run) and prints no secret.

```
SCHP=no
[ -n "$WINDOW" ] && [ -n "$REPO" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && SCHP=start
[ "$SCHP" = start ] && PLAN=$(CLOUDSDK_CORE_PROJECT=$PROJECT python3 "$REPO/infra/apply_cloud_scheduler.py" --env prod --base-url https://api.sprintable.ai) && printf '%s\n' "$PLAN" | tail -n 12 && [ "$(printf '%s\n' "$PLAN" | grep -c '^UPDATE ')" = 4 ] && [ "$(printf '%s\n' "$PLAN" | grep -c '^UPDATE .* — uri$')" = 4 ] && ! printf '%s\n' "$PLAN" | grep -qE '^(CREATE|UNMANAGED)' && SCHP=planned
[ "$SCHP" = planned ] && CLOUDSDK_CORE_PROJECT=$PROJECT python3 "$REPO/infra/apply_cloud_scheduler.py" --env prod --base-url https://api.sprintable.ai --apply && SCHP=applied
[ "$SCHP" = applied ] && POST=$(CLOUDSDK_CORE_PROJECT=$PROJECT python3 "$REPO/infra/apply_cloud_scheduler.py" --env prod --base-url https://api.sprintable.ai) && printf '%s\n' "$POST" | tail -n 6 && printf '%s\n' "$POST" | grep -q '^UNCHANGED 4' && ! printf '%s\n' "$POST" | grep -qE '^(UPDATE|CREATE|UNMANAGED)' && SCHP=verified
echo "scheduler (script): $SCHP"
```

`scheduler (script): verified` is the pass (`applied` means the script ran but a second look did not read `UNCHANGED 4` with nothing else: the live jobs may differ from what the dry-run showed, so look before going on). The undo is the same script without the address (`CLOUDSDK_CORE_PROJECT=$PROJECT python3 "$REPO/infra/apply_cloud_scheduler.py" --env prod --apply`: the jobs go back to the Cloud Run service's own address). **The reserve, by hand** (only when the script stops and the product owner decides to go on): the jobs whose target is on the prod backend's own address — either of its two forms, `sprintable-backend-prod-787818285179.asia-northeast3.run.app` or the older `sprintable-backend-prod-57iommnikq-du.a.run.app` that the live jobs carry — are given the same path on `api.sprintable.ai` (schedules, headers and the secret in them are not touched; a job that points anywhere else, another Cloud Run service included, is printed and left alone). The block stops at the first failure and writes every job it moved into `scheduler-moved.tsv`; its undo is the second block:

```
SCH=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s scheduler-before.tsv ] && SCH=listed
[ "$SCH" = listed ] && while read -r job uri; do case "$uri" in https://sprintable-backend-prod-787818285179.asia-northeast3.run.app/*|https://sprintable-backend-prod-57iommnikq-du.a.run.app/*) new="https://api.sprintable.ai/${uri#https://*/}"; gcloud scheduler jobs update http "$job" --project $PROJECT --location $REGION --uri "$new" && echo "$job $uri" >> scheduler-moved.tsv || { SCH=failed; break; } ;; *) echo "left alone: $job $uri" ;; esac; done < scheduler-before.tsv
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

## 4c. The forwarder of the old address (before the window; users notice nothing)

**The decision (product owner, 2026-10-29).** A client that still names the old address (`run.app`) is not asked to change anything. After the move that address is a **thin forwarder**: one more revision of the same service `${BACKEND}` (so the address stays), a Caddy ([`deploy/vm/forwarder/`](forwarder/Caddyfile)) that hands every request to `https://api.sprintable.ai` and holds nothing — no database, no secret, no setting of the application, no Cloud SQL, no VPC — and runs as an account with **no role**. The real revision stays as it is, with no traffic and no caller: it is the way back. The forwarder is built and tested **before the window** as a revision with no traffic and a tag; in the window it only takes the traffic (step 8c).

**The mark against a loop.** The forwarder adds a header (`X-Sprintable-Forwarded`) to what it hands on and answers 508 to a request that arrives with it: if the two addresses are ever made to point at each other (an order of the way back that was not followed, a pass-through left running), the request is refused after one turn instead of going round. The order of step 12 is still the rule; the mark is what makes a mistake cheap.

**Rehearsal first.** The blocks below are run once, as written, on a throwaway service of the same shape before the window (Appendix A): the prod backend uses a Direct VPC attachment, which the deploy line has to clear too.

**Why a Caddyfile and not one command:** the file fixes three things in one place — every chunk is sent as it arrives (`flush_interval -1`: the streams), the `Host` header is the API name (without it the VM's front sees the old name and answers no site), and the error log carries the same filter as the stack's Caddy (no URI, no header). The pass-through of step 3 does the same for the other direction. The image is built by Cloud Build in the project's own registry (the Caddyfile has to be baked into it); the revision is small — one CPU, 256 MiB, **minimum 0 instances**, at most 2, billed by request — so what it costs is the share of the clients that are left.

**4c-A. The image and the account (from the checkout; nothing in prod changes).** The image goes next to the backend's in the same registry (`FWD_AR`, taken from the backend's image unless you set it before — the rehearsal in the Appendix does); the service account is created with no role.

```
FWDOK=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -f "$REPO/deploy/vm/forwarder/Caddyfile" ] && FWDOK=start
[ "$FWDOK" = start ] && IMG=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(spec.template.spec.containers[0].image)') && [ -n "$IMG" ] && FWD_AR="${FWD_AR:-${IMG%/*}}" && FWD_BUILD="${FWD_AR}/sprintable-forwarder:${WINDOW}" && FWDOK=named
[ "$FWDOK" = named ] && gcloud builds submit "$REPO/deploy/vm/forwarder" --project $PROJECT --region $REGION --tag "$FWD_BUILD" && FWDOK=built
[ "$FWDOK" = built ] && FWD_IMAGE=$(gcloud artifacts docker images describe "$FWD_BUILD" --project $PROJECT --format='value(image_summary.fully_qualified_digest)') && [ -n "$FWD_IMAGE" ] && printf '%s\n' "$FWD_IMAGE" > forwarder-image.txt && FWDOK=pinned
[ "$FWDOK" = pinned ] && { gcloud iam service-accounts describe "${FWD_SA}@${PROJECT}.iam.gserviceaccount.com" --project $PROJECT > /dev/null 2>&1 || gcloud iam service-accounts create ${FWD_SA} --project $PROJECT --display-name "forwarder of the old address (no roles)"; } && FWDOK=account
echo "forwarder image: $FWDOK"
```

`forwarder image: account` is the pass; the image is pinned by its digest in `forwarder-image.txt` (the revision uses that, never a tag). Built in Cloud Build on purpose: a build on a Mac would make an arm image that Cloud Run cannot start.

**4c-B. The real revision is written down, then the forwarder revision is made — with no traffic.** The record `real-revision-${WINDOW}.txt` (the name of the revision that has 100% of the traffic now, its image, and the name the forwarder revision gets) is what step 8c and the way back of step 12 read, like `was-invoker`. A second run keeps it only if it still names the same real revision. `--no-traffic` pins the traffic that was on «latest» to the real revision before the deploy, so the real revision keeps its 100%; every setting the forwarder must not inherit is cleared in the same command (environment, secrets, volumes and their mounts, Cloud SQL instances, the VPC connector **and the Direct VPC attachment (`--clear-network`; the prod backend uses that kind, and `--clear-vpc-connector` does not clear it — gcloud takes `--clear-network` alone: it refuses it together with `--clear-network-tags`, which belongs to the group that sets a network, so what becomes of the tags is read by the proof and measured by the rehearsal)**, the command and arguments of the backend), and the port, size, ingress and execution environment are stated, not left to what the backend had.

```
FWD=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s forwarder-image.txt ] && FWD=start
[ "$FWD" = start ] && SVC=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format=json) && REAL=$(printf '%s\n' "$SVC" | jq -r '[.status.traffic[] | select((.percent // 0) > 0)] | if length == 1 and .[0].percent == 100 then .[0].revisionName // empty else empty end') && [ -n "$REAL" ] && FWD=read
[ "$FWD" = read ] && { [ ! -e "real-revision-${WINDOW}.txt" ] || [ "$(awk -F'\t' '$1=="real" {print $2}' "real-revision-${WINDOW}.txt")" = "$REAL" ]; } && RIMG=$(gcloud run revisions describe "$REAL" --project $PROJECT --region $REGION --format='value(spec.containers[0].image)') && [ -n "$RIMG" ] && FWD=recordable
[ "$FWD" = recordable ] && printf 'real\t%s\nreal-image\t%s\nforwarder\t%s\n' "$REAL" "$RIMG" "${BACKEND}-fwd-${WINDOW}" > real-revision.tmp && mv real-revision.tmp "real-revision-${WINDOW}.txt" && FWD=recorded
[ "$FWD" = recorded ] && FWD_IMAGE=$(cat forwarder-image.txt) && [ -n "$FWD_IMAGE" ] && gcloud run deploy ${BACKEND} --project $PROJECT --region $REGION --image "$FWD_IMAGE" --service-account "${FWD_SA}@${PROJECT}.iam.gserviceaccount.com" --revision-suffix "fwd-${WINDOW}" --no-traffic --tag ${FWD_TAG} --clear-env-vars --clear-secrets --clear-volumes --clear-volume-mounts --clear-cloudsql-instances --clear-vpc-connector --clear-network --command "" --args "" --port 8080 --cpu 1 --memory 256Mi --execution-environment gen1 --cpu-throttling --min-instances 0 --max-instances 2 --concurrency 250 --ingress all && FWD=deployed
echo "forwarder revision: $FWD"
```

**4c-C. The proof — it holds nothing, it has no traffic, and through its tag it reaches the real revision once (no loop).** All of it is read; nothing is changed. The tag answers with the application's health, and the `revision` in that answer is the **real** revision: the request went tag → forwarder → `api.sprintable.ai` (the pass-through of step 3) → the service's main address → the real revision. If it were the forwarder's own name, or the call hung, the two addresses would be pointing at each other: stop.

```
FWDP=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s "real-revision-${WINDOW}.txt" ] && [ -s forwarder-image.txt ] && REAL=$(awk -F'\t' '$1=="real" {print $2}' "real-revision-${WINDOW}.txt") && FWDREV=$(awk -F'\t' '$1=="forwarder" {print $2}' "real-revision-${WINDOW}.txt") && [ -n "$REAL" ] && [ -n "$FWDREV" ] && FWDP=read
[ "$FWDP" = read ] && SVC=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format=json) && printf '%s\n' "$SVC" | jq -e --arg r "$REAL" '[.status.traffic[] | select((.percent // 0) > 0)] | length == 1 and .[0].revisionName == $r and .[0].percent == 100' > /dev/null && FWDP=untouched
[ "$FWDP" = untouched ] && REV=$(gcloud run revisions describe "$FWDREV" --project $PROJECT --region $REGION --format=json) && printf '%s\n' "$REV" | jq -e --arg sa "${FWD_SA}@${PROJECT}.iam.gserviceaccount.com" --arg d "$(sed 's/.*@//' forwarder-image.txt)" '(.spec.serviceAccountName == $sa) and ((.spec.containers | length) == 1) and ((.spec.containers[0].env // []) | length == 0) and ((.spec.containers[0].volumeMounts // []) | length == 0) and ((.spec.volumes // []) | length == 0) and ((.metadata.annotations["run.googleapis.com/cloudsql-instances"] // "") == "") and ((.metadata.annotations["run.googleapis.com/vpc-access-connector"] // "") == "") and ((.metadata.annotations["run.googleapis.com/network-interfaces"] // "") == "") and ((.spec.containers[0].image // "") | endswith($d)) and ((.status.imageDigest // "") | endswith($d))' > /dev/null && FWDP=empty
[ "$FWDP" = empty ] && ROLES=$(gcloud projects get-iam-policy $PROJECT --flatten='bindings[].members' --filter="bindings.members:serviceAccount:${FWD_SA}@${PROJECT}.iam.gserviceaccount.com" --format='value(bindings.role)') && [ -z "$ROLES" ] && FWDP=noroles
[ "$FWDP" = noroles ] && printf '%s\n' "$SVC" | jq -e --arg t ${FWD_TAG} --arg f "$FWDREV" '[.status.traffic[] | select(.tag == $t)] | length == 1 and .[0].revisionName == $f and ((.[0].percent // 0) == 0)' > /dev/null && TAGURL=$(printf '%s\n' "$SVC" | jq -r --arg t ${FWD_TAG} '[.status.traffic[] | select(.tag == $t)] | .[0].url // empty') && [ -n "$TAGURL" ] && H=$(curl -s --max-time 20 "$TAGURL/api/v2/health") && printf '%s\n' "$H" | jq -e --arg r "$REAL" '(.status == "ok") and (.revision == $r)' > /dev/null && FWDP=ready
echo "forwarder: $FWDP"
```

`forwarder: ready` is the pass, and **step 5 does not start without it**. The proof says, in order: the real revision still has 100% and nothing else has any; the forwarder revision has the service account and the pinned image (the digest the registry gave, in the revision's spec **and** in the digest Cloud Run resolved), **no environment, no volume or secret, no Cloud SQL, no VPC**; that account has no role in the project; and the tag points at the forwarder revision, has no traffic, and reaches the real revision exactly once. Anything else is a stop with nothing changed for users. **Undo of the whole step:** `gcloud run services update-traffic ${BACKEND} --project $PROJECT --region $REGION --remove-tags ${FWD_TAG}` and `gcloud run revisions delete "$FWDREV" --project $PROJECT --region $REGION --quiet` (a revision with no traffic can be deleted); the image and the account are harmless where they are.

## 5. Freeze (the IAM binding)

Preconditions: steps 1–4 and **4c** done (`forwarder: ready`, and `real-revision-${WINDOW}.txt` exists), the window open, the notice sent, G3. Write down the invoker members of every service that can write (step 0) so that the way back puts back exactly them.

**The ladder.** A line runs only when the one before it succeeded; a failing line **stops the ladder where it is: the services may be partly frozen, some callers off and others still on, and that is not a frozen state — do not read it as one** (nothing is waited for and no clock starts); the record holds every member the block had reached, and the block can be run again from the top (a member that is already off is not in the policy any more, so a second run only removes what is left: removing a binding that is not there is an error in gcloud; a policy that cannot be **read**, or an operator account that cannot be read, is a stop, never taken for «already frozen»). Every invoker member the block really took off is written to `was-invoker-${WINDOW}.tsv` (service, member): that file, not `frozen.txt`, is what the unfreeze and the way back put back, so a caller that was not there before the move is never added by it. It takes **every** invoker member off each service in `frozen.txt` (the backend, the frontend, the hosted MCP and every other service step 0 marked as writing) **but the operator account** (`KEEP` is the operator's own account **plus** whatever you put in `KEEP` before the block — the operator is always kept, so a `KEEP` that forgets it cannot lock the operator out; if the operator reaches the services through a group or a domain, set `KEEP` to those members, separated by spaces, for example `KEEP="group:ops@example.com"` — the invokers list of step 0 shows what exists), so that not only the public caller but any other identity that could still reach a database writer is stopped; each member is written to the record **before** it is taken off (a removal that fails after its line was written costs nothing: putting a member back that is still there is harmless, losing a line would cost a caller); it reads each policy again and stops if any other member is left; then it **proves** the freeze from outside — the `curl` must print **403** (before the freeze it prints 200 `application/json`) — and only then waits out the longest request (the backend's request timeout + 10 s). `FROZEN` is set to yes by the product owner after reading `frozen.txt`, and `WINDOW` to the date of this night (for example `WINDOW=20261102`): every file the block writes carries it, so a retry in the same window continues the same record and a later window never inherits the services of an earlier one.

```
STEP=no
OP=$(gcloud config get-value account); case "$OP" in *.gserviceaccount.com) OPM="serviceAccount:$OP" ;; ?*@*) OPM="user:$OP" ;; *) OPM="" ;; esac
KEEP="$OPM ${KEEP:-}"
[ -n "$OPM" ] && [ -n "$KEEP" ] && [ -n "$FROZEN" ] && [ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s frozen.txt ] && STEP=listed
[ "$STEP" = listed ] && while read -r svc; do pol=$(gcloud run services get-iam-policy "$svc" --project $PROJECT --region $REGION --format=json) || { STEP=failed; break; }; printf '%s\n' "$pol" | jq -r '.bindings[]? | select(.role=="roles/run.invoker") | .members[]' > "members-${svc}.tmp" || { STEP=failed; break; }; while read -r m; do case " $KEEP " in *" $m "*) continue ;; esac; printf '%s\t%s\n' "$svc" "$m" >> "was-invoker-${WINDOW}.tsv" || { STEP=failed; break 2; }; gcloud run services remove-iam-policy-binding "$svc" --project $PROJECT --region $REGION --member="$m" --role=roles/run.invoker || { STEP=failed; break 2; }; done < "members-${svc}.tmp"; done < frozen.txt
[ "$STEP" = listed ] && while read -r svc; do pol=$(gcloud run services get-iam-policy "$svc" --project $PROJECT --region $REGION --format=json) || { STEP=failed; break; }; left=$(printf '%s\n' "$pol" | jq -r --arg keep "$KEEP" '($keep | split(" ")) as $k | [.bindings[]? | select(.role=="roles/run.invoker") | .members[] | select(. as $x | $k | index($x) | not)] | length') || { STEP=failed; break; }; [ "$left" = 0 ] || { echo "still callers on $svc: $left"; STEP=failed; break; }; done < frozen.txt
[ "$STEP" = listed ] && STEP=frozen
[ "$STEP" = frozen ] && BURL=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(status.url)') && [ -n "$BURL" ] && CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "outside: $CODE" && [ "$CODE" = 403 ] && STEP=proven
[ "$STEP" = proven ] && TMO=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(spec.template.spec.timeoutSeconds)') && [ -n "$TMO" ] && echo "request timeout: $TMO s" && sleep $((TMO + 10)) && STEP=waited && date -u +%FT%TZ
echo "freeze: $STEP"
```

`freeze: waited` is the pass, and the date printed after it is **T0**. Anything else: the services that could be frozen are frozen; fix the cause and run the block again, or go to step 8 (it opens only what `reopen.txt` names; the way back of step 12 opens everything). From the VM the same `curl` (ssh, IAP) must also print **403** — a 200 there means the backend still reaches the service: put the binding back and do not go on.

**Who the freeze does not reach.** It removes the members of each service's own policy. A caller that reaches the service through a role of the **project** (owners, editors, Cloud Run administrators, and the service accounts that hold such a role) is inherited by the service and is not in its policy, so it is neither listed nor removed. For these the proof is the request log, not the policy: the block at the end of this step (`writers after the freeze: none`), and the product owner says in the record of G5 whether any service account with a project-wide role has a reason to call the backend.

**Cloud Run jobs are writers too.** A job that mounts prod's Cloud SQL (step 0) can run during the dump: pause the scheduler jobs that call the backend, each noted in `paused.txt` (`gcloud scheduler jobs pause $JOB --project $PROJECT --location $REGION && echo "$JOB" >> paused.txt`), and prove that no execution of any job is running (a running one is waited for or cancelled with `gcloud run jobs executions cancel`, by the product owner's decision, written down):

```
RUN=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s jobs.txt ] && RUN=listed
[ "$RUN" = listed ] && while read -r job; do out=$(gcloud run jobs executions list --job "$job" --project $PROJECT --region $REGION --filter='status.runningCount>0' --format='value(metadata.name)') || { RUN=failed; break; }; n=$(printf '%s\n' "$out" | grep -c . || true); echo "$job running executions: $n"; [ "$n" = 0 ] || RUN=busy; done < jobs.txt
[ "$RUN" = listed ] && RUN=quiet
echo "jobs: $RUN"
```

`jobs: quiet` is the pass; `busy` or `failed` stops the sheet.

**The daily job inside the window.** `assets-grace-hard-delete-prod` runs at **03:00 Asia/Seoul — the first minute of the window** (the other three: `publication-commands-prod` every minute and `a2a-task-deadline-sweep-prod` every ten minutes, both UTC; `storage-usage-warn-prod` at 09:00 KST, outside). It is paused with the others for that night (the pause and the resume of step 8 are its pair), so its run of that night is **skipped** — Cloud Scheduler does not catch up a run it missed — and it runs again at 03:00 the next night; the product owner decides whether to run it once after the unfreeze (`gcloud scheduler jobs run assets-grace-hard-delete-prod --project $PROJECT --location $REGION`) and writes the decision down. Show in the request log that no request other than the health check arrived in the last minutes (the cron endpoints are GET requests and write: «no POST» proves nothing).

**The proof that no writer is left, from the log — run it last in this step, after the scheduler jobs are paused and the jobs check says `quiet`.** `freeze: waited` says the policies hold only the members you chose to keep and that an anonymous call gets 403; it does not say that nothing with an identity can still reach the backend (the cron endpoints are `GET` requests and write, so no method is excluded). Ask the log of the backend for any request answered 200–399 in the last five minutes that is not a health check (the health checks are matched by their exact path, with nothing after it, so a write that merely mentions `/health` in its query is still counted; the wait of the freeze is longer than five minutes, so every minute asked about is after the freeze):

```
QUIET=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && QUIET=asking
[ "$QUIET" = asking ] && W=$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.status>=200 AND httpRequest.status<400 AND NOT httpRequest.requestUrl=~\"^https://[^/?]+/api/v2/(health|ping)$\"" --project $PROJECT --freshness=5m --limit=20 --format='value(timestamp)') && QUIET=read
[ "$QUIET" = read ] && [ -z "$W" ] && QUIET=none
echo "writers after the freeze: $QUIET"
```

`writers after the freeze: none` is the pass and a **gate for step 6**: `read` means a request got through (find who, and do not go on), `no` or `asking` means it was not answered. The scheduler jobs of step 4 now call `api.sprintable.ai`, which is the pass-through to the frozen Cloud Run (a 403 there), and they are paused as well.

**Positive control — measured by the product owner on 2026-10-28 with the live account (`양성 대조 실측됨`).** The same filter printed 20 lines over `--freshness=1d` and 20 over five minutes (the limit of the question), and the exact-path pattern for the health checks matched 5 requests of `/api/v2/health` (with the `NOT` taken out). So `none` is the answer of a filter that sees real traffic, not of one that matches nothing — the one place where this gate could pass falsely. Repeat it on the day before the window, with the live account, and write the number of lines in the record of G5:

```
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND httpRequest.status>=200 AND httpRequest.status<400 AND NOT httpRequest.requestUrl=~\"^https://[^/?]+/api/v2/(health|ping)$\"" --project $PROJECT --freshness=1d --limit=20 --format='value(timestamp)' | grep -c .
```

**Expected:** a number above 0 (20 is the limit). A 0 here means the filter matches nothing and `none` proves nothing: stop and look at the filter before the freeze.


## 6–7. The data and the takeover (inside the freeze)

1. Stop the front door — the only way `api.sprintable.ai` clients reach Cloud Run: `sudo /opt/sprintable/bin/front-door.sh stop`; then `sudo docker stop sprintable-backend-1 sprintable-frontend-1` (restore refuses with a running backend).
2. Final dump (the command of step 1 with `--label final`, which prints the paths of the dump `FINAL_DUMP` and of its counts `FINAL_COUNTS`) and restore, [RUNBOOK §7 steps 3 and 5](RUNBOOK.md). The restore's output is **kept** (`counts-vm-final.tsv`: the way back of step 12 compares the live database with it) and is never emptied by a restore that refuses: it is written to a temporary name and renamed only when the restore succeeded, and a second attempt in the same folder **stops before the restore and before the diff** (`final restore: no`: a file from an earlier attempt must never stand in for this restore's counts; move it aside by hand if a restore really has to be repeated), and the diff of the counts must be **empty** (writers are stopped): `final restore: equal` is the pass. **MEASURE:** both seconds.

```
FIN=no
[ ! -e counts-vm-final.tsv ] && [ -n "$FINAL_DUMP" ] && [ -n "$FINAL_COUNTS" ] && FIN=restoring
[ "$FIN" = restoring ] && sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh "$FINAL_DUMP" > counts-vm-final.tmp && mv counts-vm-final.tmp counts-vm-final.tsv && FIN=restored
[ "$FIN" = restored ] && sudo bash -c 'diff "$0" <(grep -P "^\S+\t\d+$" counts-vm-final.tsv)' "$FINAL_COUNTS" && echo "row counts equal" && FIN=equal
echo "final restore: $FIN"
```

3. `sudo python3 /opt/sprintable/bin/deployer.py --force` (the stack's Caddy starts on the same certificate folder as the front door: no new certificate for the API host).
4. Checks from inside, then from outside (`/api/v2/health`, a login, a stream). `app.sprintable.ai`: delete its route and point the record at the VM (A, proxied; Cloudflare SSL mode **Full (strict)**).

**4b. The stored links (RUNBOOK §12 item 4) — inside the freeze, on the VM.** A hosted-site post published before the move carries a `run.app` link in the database; it answers 404 once Cloud Run is gone. Prod has no Cloud Run job for this (the only one-off job that exists is dev's) and none is made for it: the job's module runs **in the backend container on the VM, after the final restore and before the unfreeze**, with a backup first — nobody reads a link during the freeze, and the database that goes live already carries the rewritten ones. **The public door of the VM is closed for the whole of 4b** (`sudo docker stop sprintable-caddy-1`, the first line of block A: 80 and 443 are the Caddy container's, so the backend is not reachable from outside while it is stopped): nothing new can be written between the backup and the rewrite, which is what makes the way back below safe. A request that was already inside the backend when the door closed finishes in seconds; block B waits 30 s and the plan was read by a person before it, so the backup starts well after the last of them. First the report and the plan (both read-only; origins and counts, never a full link):

```
LINKS=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && LINKS=start
[ "$LINKS" = start ] && sudo docker stop sprintable-caddy-1 && LINKS=closed
[ "$LINKS" = closed ] && sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links > links-report.txt && cat links-report.txt && LINKS=reported
[ "$LINKS" = reported ] && sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links --old-origin http://sprintable-backend-prod-787818285179.asia-northeast3.run.app --old-origin https://sprintable-backend-prod-787818285179.asia-northeast3.run.app --old-origin http://sprintable-backend-prod-57iommnikq-du.a.run.app --old-origin https://sprintable-backend-prod-57iommnikq-du.a.run.app --new-origin https://api.sprintable.ai > links-plan.txt && cat links-plan.txt && LINKS=planned
echo "links: $LINKS"
```

Read `links-report.txt`: **every origin it lists must be one of the four the plan names** (the two Cloud Run forms of the prod backend, each with `http` and `https`: behind the pass-through the request's scheme was `http`); any other `run.app` origin is a stop, and the plan is made again with it. Then, only after the plan has been read:

```
LINKS=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s links-report.txt ] && [ links-plan.txt -nt links-report.txt ] && [ "$(grep -c 'would be rewritten (dry run, nothing written)' links-plan.txt)" = 4 ] && LINKS=planned
[ "$LINKS" = planned ] && sleep 30 && sudo systemctl start sprintable-backup.service && LINKS=backed
[ "$LINKS" = backed ] && sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links --old-origin http://sprintable-backend-prod-787818285179.asia-northeast3.run.app --old-origin https://sprintable-backend-prod-787818285179.asia-northeast3.run.app --old-origin http://sprintable-backend-prod-57iommnikq-du.a.run.app --old-origin https://sprintable-backend-prod-57iommnikq-du.a.run.app --new-origin https://api.sprintable.ai --apply && LINKS=applied
[ "$LINKS" = applied ] && sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links > links-after.txt && [ -s links-after.txt ] && cat links-after.txt && { grep -qi 'run\.app' links-after.txt; [ "$?" = 1 ]; } && LINKS=clean
echo "links: $LINKS"
```

`links: clean` is the pass (the report after the rewrite is not empty and lists no origin containing `run.app`, in any letter case; a `grep` that failed is not «nothing found»). Block B applies only to a plan made by block A of this window: the report exists, the plan is newer than it, and the plan has the four lines of a dry run. The undo is the backup taken just before (RUNBOOK §10, «Undo of the rewrite»: the job with the origins swapped puts back only what was stored with `https`; the backup is the way back for the `http` ones).

**If 4b fails** (a line of block B ends anywhere but `links: clean`): **the move does not stop and the window goes on.** The module writes in one transaction and **commits before it checks**, so a non-zero exit does not mean that nothing was written. Run the report again — `sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links` (it needs no state from the blocks) — and read what is stored now. If it lists `api.sprintable.ai` with the count the plan gave and no origin that should not have changed, the rewrite stands: leave it and rewrite what is left the next day. If it shows something wrong (a count that does not fit the plan, an origin changed that was not in it), the backup taken just before goes back — nothing was written after it, because the door was closed: with the backend and the frontend stopped (`sudo docker stop sprintable-backend-1 sprintable-frontend-1`; restore refuses a running backend), `sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh "$(sudo sh -c 'ls -t /var/backups/sprintable/db-prod-*.dump | head -n 1')" > counts-vm-links-undo.tmp && mv counts-vm-links-undo.tmp counts-vm-links-undo.tsv`, then `sudo python3 /opt/sprintable/bin/deployer.py --force` (it brings the whole stack, the door included, back; block C is then not needed), and on with step 8. The links are rewritten **the next day with the same module** (blocks A and B again). Until then a stored link that still names `run.app` answers 403 until the forwarder is opened in step 8c, and by the VM, through the forwarder, after it; **how many** is the number in `links-report.txt`, the first step of the module — written in the record of G5 so that nobody has to guess.

**Open the door again — last, and only after the decision above** (block C; without it the VM stays closed. Do not run it while a restore is still possible: whatever is written after the door opens would be overwritten by that restore):

```
sudo docker start sprintable-caddy-1 && sudo docker ps --filter name=sprintable-caddy-1 --format '{{.Names}} {{.Status}}'
```


5. Enable the deploy, backup and restore-check timers ([RUNBOOK §7 step 6](RUNBOOK.md)); the backup of an empty database would refuse, which is why this is after the restore.

## 8. Unfreeze (only what is meant to be open)

**Cloud Run's frontend stays closed, and the real revision of the backend gets no caller and no traffic after 8c: it is the way back.** An open real backend would write to Cloud SQL while the VM writes to its own database (two databases, split writes). Only the **forwarder** of step 4c is ever opened to the public (8c), and it holds nothing. What is put back is `reopen.txt` — the hosted MCP once its `SPRINTABLE_API_URL` names `https://api.sprintable.ai` (step 4), and nothing that writes to the old database. Resume the paused scheduler jobs (`paused.txt`; their targets are the VM's since step 4). Then the measurement is of **the VM's front**, not of Cloud Run: `https://api.sprintable.ai/openapi.json` must print **200** with `application/json`, and the Cloud Run backend's own address must still print **403**. T1 is the time of that 200; the freeze window is **T1 − T0** plus the wait of step 5 — both are written down as numbers.

```
STEP=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s reopen.txt ] && [ -s "was-invoker-${WINDOW}.tsv" ] && STEP=listed
[ "$STEP" = listed ] && while read -r svc; do awk -F'\t' -v s="$svc" '$1==s {print $2}' "was-invoker-${WINDOW}.tsv" > "members-${svc}.tmp"; [ -s "members-${svc}.tmp" ] || { echo "no caller was taken off before the freeze: $svc"; STEP=failed; break; }; while read -r m; do gcloud run services add-iam-policy-binding "$svc" --project $PROJECT --region $REGION --member="$m" --role=roles/run.invoker || { STEP=failed; break 2; }; done < "members-${svc}.tmp"; done < reopen.txt
[ "$STEP" = listed ] && STEP=reopened
[ "$STEP" = reopened ] && BURL=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(status.url)') && [ -n "$BURL" ] && VMC=$(curl -s -o /dev/null -w '%{http_code}' https://${API_HOST}/openapi.json) && CRC=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "the VM: $VMC · Cloud Run backend: $CRC" && [ "$VMC" = 200 ] && [ "$CRC" = 403 ] && STEP=proven
[ "$STEP" = proven ] && [ -s paused.txt ] && while read -r job; do gcloud scheduler jobs resume "$job" --project $PROJECT --location $REGION || { STEP=failed; break; }; done < paused.txt
[ "$STEP" = proven ] && STEP=resumed
echo "unfreeze: $STEP"
```

The measurement is a gate: the schedulers are resumed only when the line with the two codes reads `the VM: 200 · Cloud Run backend: 403` (`unfreeze: resumed` is the pass; `reopened` means the MCP is open but the codes were not right: look before anything else is resumed). An empty `reopen.txt`, or a window without a `was-invoker` file, is a stop, not a pass: nothing is reopened and nothing is claimed; a service the freeze took no caller off is never opened by this block, and a service gets back exactly the members the freeze recorded for it.

**8c. The forwarder takes the old address (run it right after the block above says `unfreeze: resumed`).** Until this block the old address answers 403 — that is the time the old-address clients are away, T0 to **T2**, written down as a number next to T1. The block moves the traffic of `${BACKEND}` to the forwarder revision **while the service is still closed**, shows from outside that it is still closed (403), shows with the operator's own identity (the Google identity token goes in `X-Serverless-Authorization`, which Cloud Run reads and the forwarder removes before it hands the request on (whatever Cloud Run itself does with it); the rehearsal in the Appendix measures it — **there is no fallback to `Authorization`: that header would be passed on to the VM, and an identity token that is not meant for it would leave Cloud Run; if the header is refused, 8c is not run and the author is told**) that the forwarder answers **as a healthy VM** (`status` and `db` both `ok`, the same `commit_sha` as `https://api.sprintable.ai/api/v2/health`, which is known, and a `revision` that is not the real revision's), and only then puts `allUsers` back — the public binding the freeze recorded for the backend, and no other member (a caller with an identity is not forwarded). It refuses to run when the freeze did not record `allUsers` for the backend (it was not public before: nothing is opened that was not), when the service **answers anything but 403 from outside before the traffic moves** (the freeze did not hold, or a binding was put back: the traffic must not move while it is public), or when the traffic is on neither the real revision nor the forwarder (somebody moved it). A failing line leaves the service closed; a run that stopped before `opened` can be run again from the top (moving traffic that is already there changes nothing).

```
FWD=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s "real-revision-${WINDOW}.txt" ] && [ -s "was-invoker-${WINDOW}.tsv" ] && FWD=listed
[ "$FWD" = listed ] && REAL=$(awk -F'\t' '$1=="real" {print $2}' "real-revision-${WINDOW}.txt") && FWDREV=$(awk -F'\t' '$1=="forwarder" {print $2}' "real-revision-${WINDOW}.txt") && [ -n "$REAL" ] && [ -n "$FWDREV" ] && awk -F'\t' -v s="${BACKEND}" '$1==s && $2=="allUsers" {f=1} END {exit f ? 0 : 1}' "was-invoker-${WINDOW}.tsv" && FWD=named
[ "$FWD" = named ] && SVC=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format=json) && BURL=$(printf '%s\n' "$SVC" | jq -r '.status.url // empty') && [ -n "$BURL" ] && printf '%s\n' "$SVC" | jq -e --arg r "$REAL" --arg f "$FWDREV" '[.status.traffic[] | select((.percent // 0) > 0)] | length == 1 and (.[0].revisionName == $r or .[0].revisionName == $f) and .[0].percent == 100' > /dev/null && CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "closed before: $CODE" && [ "$CODE" = 403 ] && FWD=addressed
[ "$FWD" = addressed ] && gcloud run services update-traffic ${BACKEND} --project $PROJECT --region $REGION --to-revisions "${FWDREV}=100" && FWD=switched
[ "$FWD" = switched ] && CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "still closed: $CODE" && [ "$CODE" = 403 ] && FWD=closed
[ "$FWD" = closed ] && TOK=$(gcloud auth print-identity-token) && [ -n "$TOK" ] && A=$(curl -s --max-time 20 -H "X-Serverless-Authorization: Bearer $TOK" "$BURL/api/v2/health") && B=$(curl -s --max-time 20 https://${API_HOST}/api/v2/health) && SHA_A=$(printf '%s\n' "$A" | jq -r '.commit_sha // empty') && SHA_B=$(printf '%s\n' "$B" | jq -r '.commit_sha // empty') && REV_A=$(printf '%s\n' "$A" | jq -r '.revision // empty') && echo "forwarder: $SHA_A · VM: $SHA_B · revision: $REV_A" && printf '%s\n' "$A" | jq -e '.status == "ok" and .db == "ok"' > /dev/null && printf '%s\n' "$B" | jq -e '.status == "ok" and .db == "ok"' > /dev/null && [ -n "$SHA_A" ] && [ "$SHA_A" != unknown ] && [ "$SHA_A" = "$SHA_B" ] && [ -n "$REV_A" ] && [ "$REV_A" != "$REAL" ] && FWD=answers
[ "$FWD" = answers ] && gcloud run services add-iam-policy-binding ${BACKEND} --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker && FWD=opened
[ "$FWD" = opened ] && CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && P=$(curl -s --max-time 20 "$BURL/api/v2/health") && echo "old address: $CODE" && [ "$CODE" = 200 ] && printf '%s\n' "$P" | jq -e --arg s "$SHA_B" '.status == "ok" and .db == "ok" and .commit_sha == $s' > /dev/null && FWD=proven && date -u +%FT%TZ
echo "forwarder: $FWD"
```

`forwarder: proven` is the pass, and the date printed after it is **T2**. `answers` or `opened` mean the service is where the line says and the next line did not hold: look before anything else is changed (**in `answers` nothing is public yet; in `opened` the public binding is on**); the undo is the first block of step 12. A VM whose health reads `commit_sha` `unknown` stops the block at `closed` on purpose: the proof is that the two answers are the same build, so a build that cannot say what it is proves nothing (the product owner reads `build_time` of both and decides). The Cloud Run **frontend** is not touched: it stays closed, because browsers come to the app host.

## 9. The lap (what has to work, and what is only measured)

1. **Login and a conversation** in the app; **a stream** open for ten minutes.
2. **Lanes · desktop · MCP reconnect — the machine traffic.** Prod's floor of about 3,000–3,300 requests an hour is machine traffic (agent streams and polling); in the dev move the question was whether it comes back by itself. Check, in this order, and write the minutes each took: (a) every lane Mac's agent shows online in the app (the count before the freeze, written down in step 5, equals the count now); (b) one desktop-app instruction round trip; (c) one tool call through `sprintable-mcp-prod`. **The figure, from the VM (P5):** the 7-day series came from Cloud Run's Monitoring, which stops with the move; the front now writes an access log ([RUNBOOK §11](RUNBOOK.md)). Count five-minute slices for the API name, every five minutes for half an hour, and write the numbers down: `sudo docker logs --since 5m sprintable-caddy-1 2>&1 | grep -F '"msg":"handled request"' | grep -cF '"host":"api.sprintable.ai"'` — times 12 is an hourly figure, to be compared with the floor of about 3,000–3,300 an hour (that is about 250–275 in five minutes). The machine traffic has come back when the slices stay in that neighbourhood; a floor that does not return in half an hour is a finding for the product owner, not a pass. 3. **Mail:** one real mail from the app (a verification mail to the product owner's own address). **Payments:** only if step 0 found them in use — the webhook of the payment provider reaches the VM (its delivery log shows 200).
4. **The scheduler:** each job's last run after the resume shows success (`gcloud scheduler jobs describe $JOB --project $PROJECT --location $REGION --format='value(status.code,lastAttemptTime)'`).
5. **Memory and connections:** `free -m` on the VM and the `QueuePool limit` count in the backend's log (the pool is 20 + 10 inside 57 usable connections, [RUNBOOK §12 item 3](RUNBOOK.md)); read `pg_stat_activity` once.
6. **The deploy gap, separately from 4789:** a deploy of the stack swaps backend and frontend in about 68 s (dev, measured); the lap writes down prod's number the first time a prod deploy runs.
7. **The old address (the forwarder of 4c):** `curl -s $BURL/api/v2/health` answers `ok` with the VM's `commit_sha`; a client that still names `run.app` (one that step 4 left, or a `curl` with a key of the product owner's own) makes a call that the VM answers; and for ten minutes the forwarder's own request log shows requests and **no 5xx** — read with a control, so that «no 5xx» is not a filter that sees nothing (the first number must be above 0, the second must be 0):

```
FWDREV=$(awk -F'\t' '$1=="forwarder" {print $2}' "real-revision-${WINDOW}.txt")
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND resource.labels.revision_name=\"${FWDREV}\"" --project $PROJECT --freshness=10m --limit=1000 --format='value(timestamp)' | grep -c . || true
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND resource.labels.revision_name=\"${FWDREV}\" AND httpRequest.status>=500" --project $PROJECT --freshness=10m --limit=1000 --format='value(timestamp)' | grep -c . || true
```

A stream through the forwarder ends at the service's request timeout, as it did before; the client reconnects.

Any failure in 1–3: step 12.

## 10–11. The day after

The newest status object under `gs://${BACKUPS_BUCKET}/status/prod/` says `deployed`; the backup of the night wrote a dump of a restored (not empty) database, and the weekly restore check finds it. The Cloud Run frontend (`${FRONTEND}`) stays **closed** (the binding off); the backend service (`${BACKEND}`) is now the forwarder, and its real revision stays with no traffic and no caller; Cloud SQL prod stays untouched for the day: they are the way back. After the day, the removal is a sheet of its own.

**The old address, counted — the criterion for removing it.** Everything that reaches `run.app` after step 8 is the forwarder's. The count that matters is the requests that are **not** a 401 (a key that is dead and retried asks nothing of the move). Read it every day for as long as the forwarder stands, with the control that the unfiltered count is above 0, and the user agents that are left (who to ask to change their setting); write the numbers in the record of G5:

```
FWDREV=$(awk -F'\t' '$1=="forwarder" {print $2}' "real-revision-${WINDOW}.txt")
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND resource.labels.revision_name=\"${FWDREV}\"" --project $PROJECT --freshness=1d --limit=1000 --format='value(timestamp)' | grep -c . || true
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND}\" AND resource.labels.revision_name=\"${FWDREV}\" AND NOT httpRequest.status=401" --project $PROJECT --freshness=1d --limit=1000 --format='value(httpRequest.userAgent)' | sort | uniq -c | sort -rn | head -20
```

When the second list is empty for **7 days in a row** (the product owner, question 5; counted from the day after the soak, while the real revision is still the way back), the service is removed as a whole — the forwarder and the closed real revision with it — in the removals sheet of prod, a day after the removal of Cloud SQL prod is decided. Until then the cost is the requests of the clients that are left (minimum instances 0). **The registry:** when the keep-in-use rule of the Artifact Registry is put back after the move (the cleanup checker, G1), the digest of the forwarder (`forwarder-image.txt`) and that of the real revision (`real-image` in `real-revision-${WINDOW}.txt`) are in it; the real revision's image is the way back and stays until that removal.

**The copies of the production database are cleaned up.** The rehearsal and final dumps are whole copies of prod. In the backups bucket they go by the **lifecycle rule for `import/`** (7 days, put there in G2). On the VM's data disk they stay until someone deletes them, so deleting them is a line of this day, **of this window's files only and by name**: the rehearsal files as in [RUNBOOK §7a](RUNBOOK.md), and the **final** files once the removal sheet of Cloud SQL prod has made its own exports (until then they are the safety copy; `gcloud storage ls gs://${BACKUPS_BUCKET}/db/ | tail -3` shows that the backups of the new database exist). First list the folder:

```
sudo ls -l /srv/sprintable/import
```

then delete each file of this window — the names printed above that carry this window's date — one by one, with its name typed out: `sudo rm -- /srv/sprintable/import/NAME`. Never a pattern: a `find ... -delete` or a `*` would also take the copies of another window (they are the safety copies of that one), and a `*` is expanded by your own shell, which cannot read the root-only folder. Write the names deleted and the date in the record of G5.

## 12. The way back (fix forward first)

**Fix forward first.** Going back is only for the short window right after the cutover; whatever the VM wrote since is in the VM's database and its backups and is **not copied back** to Cloud SQL (accepted by the product owner). Find out first, on the VM: `sudo /opt/sprintable/bin/rowcounts.sh | diff <(grep -P "^\S+\t\d+$" counts-vm-final.tsv) -` (`counts-vm-final.tsv` is what step 6 kept) — no difference means nothing was written since the restore and going back loses nothing; a difference is real writes: prefer fixing forward, and take a backup first (`sudo systemctl start sprintable-backup.service`) if going back.

Three blocks, in this order, each gated line by line; a failing line leaves the services closed (the binding off), which is the safe state — fix the cause and run the block again from the top. **The order is the point:** while the forwarder has the traffic of `${BACKEND}`, `api.sprintable.ai` must never be made to point at `run.app` (the pass-through of the VM chain does exactly that): the two would hand the request to each other for ever. So the forwarder is closed and the real revision gets the traffic back **first**, from the product owner's machine; only then the VM chain; and the callers are put back last.

**1. From the product owner's machine — close the forwarder, give the traffic back to the real revision.** It works from any state of the move: if the forwarder was never opened (`allUsers` is not on the service) it only checks that the real revision has the traffic. A policy answer that is not a JSON object (empty, or an error) is a stop at `listed`: it is never read as «no `allUsers`».

```
BACK=no
[ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s "real-revision-${WINDOW}.txt" ] && REAL=$(awk -F'\t' '$1=="real" {print $2}' "real-revision-${WINDOW}.txt") && [ -n "$REAL" ] && BACK=listed
[ "$BACK" = listed ] && POL=$(gcloud run services get-iam-policy ${BACKEND} --project $PROJECT --region $REGION --format=json) && printf '%s\n' "$POL" | jq -e 'type == "object"' > /dev/null && BACK=read
[ "$BACK" = read ] && { if printf '%s\n' "$POL" | jq -e '[.bindings[]? | select(.role=="roles/run.invoker") | .members[]] | index("allUsers")' > /dev/null; then gcloud run services remove-iam-policy-binding ${BACKEND} --project $PROJECT --region $REGION --member=allUsers --role=roles/run.invoker; else true; fi; } && BACK=closed
[ "$BACK" = closed ] && gcloud run services update-traffic ${BACKEND} --project $PROJECT --region $REGION --to-revisions "${REAL}=100" && BACK=real
[ "$BACK" = real ] && SVC=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format=json) && BURL=$(printf '%s\n' "$SVC" | jq -r '.status.url // empty') && [ -n "$BURL" ] && printf '%s\n' "$SVC" | jq -e --arg r "$REAL" '[.status.traffic[] | select((.percent // 0) > 0)] | length == 1 and .[0].revisionName == $r and .[0].percent == 100' > /dev/null && CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "outside: $CODE" && [ "$CODE" = 403 ] && BACK=proven
echo "forwarder way back: $BACK"
```

`forwarder way back: proven` is the pass (the real revision has 100% and the service answers 403 from outside); the product owner sets `REALBACK=proven` only after reading it.

**2. On the VM** (over ssh), only after block 1 — type `REALBACK=proven` in the ssh shell after reading block 1's pass, the chain does not start without it (the pass-through it starts names the Cloud Run address, which would loop while the forwarder has the traffic) (the temporary front door was stopped in step 6: the chain does not ask whether it runs, it asks that the stack is there and starts the pass-through):

```
BACK=no
[ "$REALBACK" = proven ] && sudo docker ps -a --format '{{.Names}}' | grep -qx sprintable-backend-1 && BACK=seen
[ "$BACK" = seen ] && sudo systemctl disable --now sprintable-deploy.timer && sudo systemctl stop sprintable-deploy.service && BACK=timers
[ "$BACK" = timers ] && sudo docker stop sprintable-caddy-1 sprintable-backend-1 sprintable-frontend-1 && BACK=stopped
[ "$BACK" = stopped ] && sudo /opt/sprintable/bin/front-door.sh passthrough --host api.sprintable.ai --upstream https://sprintable-backend-prod-787818285179.asia-northeast3.run.app && BACK=passing
echo "vm way back: $BACK"
```

**3. From the product owner's machine again**, only when the VM chain ended at `passing` and block 1 at `proven` (it puts back the callers the freeze took off — the `was-invoker` file of this window — and no others):

```
BACK=no
[ "$VMBACK" = passing ] && [ "$REALBACK" = proven ] && [ -n "$WINDOW" ] && [ "${PWD##*/}" = "window-${WINDOW}" ] && [ -s "was-invoker-${WINDOW}.tsv" ] && BACK=passing
[ "$BACK" = passing ] && while IFS="$(printf '\t')" read -r svc m; do gcloud run services add-iam-policy-binding "$svc" --project $PROJECT --region $REGION --member="$m" --role=roles/run.invoker || { BACK=failed; break; }; done < "was-invoker-${WINDOW}.tsv"
[ "$BACK" = passing ] && BACK=reopened
[ "$BACK" = reopened ] && BURL=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format='value(status.url)') && [ -n "$BURL" ] && CRC=$(curl -s -o /dev/null -w '%{http_code}' "$BURL/openapi.json") && echo "Cloud Run backend: $CRC" && [ "$CRC" = 200 ] && BACK=proven
[ "$BACK" = proven ] && [ -s paused.txt ] && while read -r job; do gcloud scheduler jobs resume "$job" --project $PROJECT --location $REGION || { BACK=failed; break; }; done < paused.txt
[ "$BACK" = proven ] && BACK=done
echo "way back: $BACK"
```

`VMBACK` is set to `passing` by the product owner only after the VM chain above printed its last line (`BACK=passing`), and `REALBACK` to `proven` only after block 1 printed `forwarder way back: proven`; `way back: done` is the pass. A missing or empty `was-invoker` file for this window, an unset `WINDOW` or an answer of Cloud Run other than 200 is a stop: nothing is resumed on top of it, and the services stay as they are until the cause is found.

The scheduler targets go back with the second block of step 4 (`scheduler-moved.tsv`). Then the records of `app` back to what they were (step 0, written down), and the guests of step 4 that were moved to `api.sprintable.ai` keep working through the pass-through. After a successful way back the next move is a new sheet run from step 1, not a repetition of this one.

## Known limits (not blockers; read before the window)

- The plan check of 4b (block B) proves that block A ran in this window and that the plan has four dry-run lines; it does not compare the four origins with those of the apply command. Block B passes its own `--old-origin` list to the module, so a wrong plan file cannot change what is rewritten.
- A request already inside the VM's backend when the door closes is covered by the 30 s wait and the reading of the plan, not by a measurement of idle connections.
- The writers gate reads the log of the Cloud Run backend; a caller that reaches the VM's own stack during the freeze is not in it (the VM's door is the pass-through to the frozen Cloud Run until step 6, and closed during 4b).
- `KEEP` and the project-level roles are outside the freeze by design (`Who the freeze does not reach`); the request log is their only proof.
- **A forwarded caller is one address to the VM.** The forwarder hands the request on from Cloud Run, and Caddy does not trust a forwarded-for header it is not told to trust, so the backend's per-address limits (the two families of G5) count every old-address caller as the forwarder's address, not as its own. The routes that count by API key are not affected; the routes of the two families are the logins and the desktop app, which come by the app host. If the request log of step 0 shows an old-address caller on one of those routes, it is a finding (question 6).
- The rehearsal of Appendix A checks, then acts: gcloud has no «create only if absent» or «delete only if it still is this one», so another hand that makes or replaces a service of that name between the check and the act is not stopped by it. It is one throwaway service made and deleted by one person within minutes; nothing in prod is named by A1/A4 except as a read, and the id in the label is a time stamp of the second, not a lock.
- Cloud Run's default egress is not one fixed address, so «one address» to the VM can be a few; the forwarder is capped at 2 instances × 250 requests, and a stream holds its slot for its whole life.
- The forwarder's loop mark (`X-Sprintable-Forwarded`) makes a mistake in the order cheap (508 at the second visit); the order of step 12 is still the rule.
- The image is built `FROM caddy:2.8.4-alpine` by tag (the stack's Compose file does the same); the built image is pinned by digest. The tests that run the real Caddy are skipped on a machine without the binary (CI has none): they were run with Caddy 2.8.4 by the author and by the security domain.
- The forwarder is one more hop: the first request after a quiet time pays the start of an instance (minimum 0), and a stream ends at the service's request timeout as before. The tag URL of 4c keeps answering like the old address (it forwards, nothing else); remove it with the line of the undo of 4c if it is not wanted.
- The writers gate of step 5 reads the log of the Cloud Run backend; after 8c the same log holds the forwarder's requests, so the gate is for the freeze only, when the forwarder has no traffic.
- The forwarder proof (4c-C) says the revision holds no environment, volume, secret, Cloud SQL or VPC and that its account has no role in the project; it does not read a role the account might hold on a single resource (a bucket, a secret). The account was created for this and nothing grants it anything.

## Questions for the owner (one line each)

1. The window (03:00–05:00 KST on which night) and the notice — the product owner sends it.
2. Going back after real use loses the VM's writes: accepted (fix forward first).
3. A prod support gateway is not in this move.
4. If step 0 finds payments or mail in real use, their span goes into the notice.
5. **How many days** with no request but dead keys (a 401) at the old address before the service is removed (steps 10–11)? *Answered (product owner, 2026-10-29): 7 days in a row, counted after the day of soak.*
6. Callers of the old address count as one address to the VM's per-address limits (known limits): accepted, as G5's acceptance 2 was for step 3? *Answered (product owner, 2026-10-29): accepted, with the numbers of acceptance 2 — the busiest minute of the whole old-address traffic in 7 days stayed below every route's limit (the largest: `refresh`, 15 of 20), and what reaches the forwarder after the move is a subset of that; limits that count by API key are not affected. Written in the record of G5.*

## Appendix A. Rehearsal of step 4c on a throwaway service (the product owner, before the window)

The prod backend uses a Direct VPC attachment, not a connector, and a deploy line that clears the connector only leaves it in the forwarder's revision (the proof of 4c-C then ends at `forwarder: untouched`, so step 5 cannot start). The rehearsal runs the blocks of 4c **as written** on a service that has prod's shape and is deleted afterwards, so that `4c` is not met for the first time in the night before the window. It also measures the two things nobody has measured: that Cloud Run takes the identity token in `X-Serverless-Authorization`, and which annotations the revision keeps after the clears.

**A1. The throwaway service, with the network shape read from prod's backend** (read-only on prod; the new service is closed to everyone but the operator and runs a public sample image):

```
REH=sprintable-rehearsal-forwarder
NI=$(gcloud run services describe ${BACKEND} --project $PROJECT --region $REGION --format=json | jq -r '.spec.template.metadata.annotations["run.googleapis.com/network-interfaces"] // empty')
NET=$(printf '%s\n' "$NI" | jq -r '.[0].network // empty'); SUBNET=$(printf '%s\n' "$NI" | jq -r '.[0].subnetwork // empty'); TAGS=$(printf '%s\n' "$NI" | jq -r '(.[0].tags // []) | join(",")')
echo "network: $NET · subnet: $SUBNET · tags: $TAGS"
SEEN=$(gcloud run services describe $REH --project $PROJECT --region $REGION 2>&1); SEENRC=$?
if [ "$SEENRC" = 0 ]; then echo "$REH exists already: not touched"; elif printf '%s\n' "$SEEN" | grep -q "Cannot find service"; then [ -n "$NET" ] && [ -n "$SUBNET" ] && [ -n "$TAGS" ] && REHID="r$(date -u +%Y%m%d%H%M%S)" && printf '%s\n' "$REHID" > rehearsal-id.txt && gcloud run deploy $REH --project $PROJECT --region $REGION --labels rehearsal=$REHID --image us-docker.pkg.dev/cloudrun/container/hello --network "$NET" --subnet "$SUBNET" --network-tags "$TAGS" --vpc-egress private-ranges-only --set-env-vars REHEARSAL=1 --add-volume name=scratch,type=in-memory,size-limit=16Mi --add-volume-mount volume=scratch,mount-path=/scratch --no-allow-unauthenticated --min-instances 0 --max-instances 1; else echo "could not tell whether $REH exists: not touched"; fi
```

The line makes the service **only if gcloud says «Cannot find service»** for that name: a service that exists is left alone, and so is any other answer (an error, a permission, a timeout — «could not tell»); delete an old one by hand, by name, after looking at it. The service gets a label `rehearsal=<id>` where the id is new and is written to `rehearsal-id.txt` **in the folder where A1 was run** (run A1 and A4 in the same folder): a label that a service of the same name might already carry is not a proof that it is this one.

**A2. The blocks of 4c, as written, on that service.** In a folder `window-rehearsal` (`WINDOW=rehearsal`), with `BACKEND=$REH` and `FWD_AR` set by hand to the registry path of the prod backend's image (the throwaway runs a public image, so `FWD_AR` cannot be taken from it): 4c-A, 4c-B, 4c-C. The pass is `forwarder image: account`, `forwarder revision: deployed`, and for 4c-C **`forwarder: noroles`** — every proof except the last line passes (the tag of a throwaway service reaches a sample page, not the application's health, so the last line cannot say `ready` here). Anything earlier than `noroles` is the defect the rehearsal is for: send the stage and the revision's annotations to the author. Then set `BACKEND` back to `sprintable-backend-prod` (and `WINDOW` to the night's date, in its own folder) before anything else is run.

**A3. What is measured.**

```
TOK=$(gcloud auth print-identity-token)
RURL=$(gcloud run services describe $REH --project $PROJECT --region $REGION --format='value(status.url)')
echo "without the token: $(curl -s -o /dev/null -w '%{http_code}' "$RURL/") · with it in X-Serverless-Authorization: $(curl -s -o /dev/null -w '%{http_code}' -H "X-Serverless-Authorization: Bearer $TOK" "$RURL/")"
gcloud run revisions describe "${REH}-fwd-rehearsal" --project $PROJECT --region $REGION --format=json | jq -r '.metadata.annotations | keys[]'
```

**Expected:** `without the token: 403 · with it in X-Serverless-Authorization: 200`, and a list of annotations in which none of `run.googleapis.com/network-interfaces`, `run.googleapis.com/vpc-access-connector`, `run.googleapis.com/cloudsql-instances` appears (the egress setting `run.googleapis.com/vpc-access-egress`, if it stays, is a note, not a defect: without an attachment it connects nothing). A `403` with the token is a **stop**: 8c is not run with the token in `Authorization` (it would be passed on to the VM); send the numbers to the author and leave the proof of 8c to another way (for example the operator's own `curl` from the VM through the forwarder's tag URL with the service still closed to everyone else).

**A4. Delete the throwaway service** (the name **and the id A1 wrote in this folder and put on the service** are checked, so neither a wrong `REH` nor an older service of that name, whatever label it carries, can be deleted by it):

```
case "$REH" in sprintable-rehearsal-forwarder) REHID=$(cat rehearsal-id.txt 2>/dev/null); if [ -n "$REHID" ] && [ "$(gcloud run services describe "$REH" --project $PROJECT --region $REGION --format='value(metadata.labels.rehearsal)')" = "$REHID" ]; then gcloud run services delete "$REH" --project $PROJECT --region $REGION --quiet; else echo "refused: $REH is not the rehearsal service this folder made"; fi ;; *) echo "refused: $REH is not the rehearsal service" ;; esac
```
