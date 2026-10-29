# Prod removals — what runs after the move to the VM, one line of undo each (story 4796)

Scope: the prod resources that the VM replaced. Run by the PO's hands (`gcloud` is the PO's; this sheet gives the exact lines, the checks before, and the way back). It is the prod twin of [`REMOVALS-dev.md`](REMOVALS-dev.md) and follows the same rules: a resource is **found with a read-only list command first**, its definition is **saved to a file**, and only then is the delete line run, guarded so an empty variable aborts (`: "${VAR:?}"`). Every delete line is followed by its undo line. Save the capture files in one folder (`mkdir -p removals-prod && cd removals-prod`) and keep it until the sheet is finished.

**Decision (PO, 2026-10-29, on the instruction of the product owner): prod is removed today, not a day later.** The prod move finished on 2026-10-29 (unfreeze 11:23Z, forwarder proven 11:23Z) and there are no real customers on prod. Two things in [`CUTOVER-prod.md`](CUTOVER-prod.md) were written for «a day later» and are handled below instead of being dropped silently: the soak (gate A) and the old address (gate F).

```
export PROJECT=sprintable-494803 REGION=asia-northeast3 ZONE=asia-northeast3-a ENV=prod
export VM=sprintable-vm-$ENV BACKUPS_BUCKET=sprintable-vm-$ENV-backups
export BACKEND=sprintable-backend-prod FRONTEND=sprintable-frontend-prod MCP=sprintable-mcp-prod SQL=sprintable-prod
```
(the same names as the block at the top of the cutover sheet; the cells marked **MEASURE** are read from the account on the day, never filled from this sheet)

**Stays on Cloud Run, never in a delete line of this sheet:** `sprintable-mcp-prod` (the hosted MCP, story 4804: it calls `api.sprintable.ai`; its own cost decision is in [`MCP-IN-VM.md`](MCP-IN-VM.md)), the scheduler jobs (their targets moved to `api.sprintable.ai` in step 4 of the cutover), the secrets, the Artifact Registry images, the VPC connector and the NAT/router (their cost is read off the bill, not guessed here). The forwarder of the old address is part of `sprintable-backend-prod`: it goes only through gate F and R6.

## 0. Gates — all must be true before any delete line

| Gate | What must be true | How to check |
|---|---|---|
| **A. The VM carries prod** | The VM serves prod on its own database: deployer status `deployed` with no rollback since the unfreeze (2026-10-29 11:23Z), a fresh backup of the **new** database, a passed restore check. The **duration** of the soak is the PO's decision (2026-10-29: today, no real customers); the checks are not waived — they are the only evidence that the way forward works before the way back is cut. | `gcloud storage ls -l gs://$BACKUPS_BUCKET/status/$ENV/ \| tail -n1` shows `deployed` (RUNBOOK §11); `gcloud storage ls -l gs://$BACKUPS_BUCKET/db/ \| tail -3` shows a backup taken **after** the unfreeze, with a size; `journalctl -u sprintable-restore-check` on the VM shows a passed check. `curl -s https://api.sprintable.ai/api/v2/health` answers `ok` with the VM's `commit_sha`. **MEASURE:** the three timestamps. |
| **B. Pipeline** | The seventh promotion (the prod pipeline without Cloud Run, P3) is on `main` and **one prod run ran green**: the six Cloud Run steps ended 0 without calling a tool, the serving-reality guard passed, no new revision of `sprintable-backend-prod` appeared and its traffic is still 100 % on the forwarder revision **by name**. Without it the next push to `main` re-creates the services this sheet deletes. | The run's step list (`gh run view`), then `gcloud run services describe $BACKEND --project $PROJECT --region $REGION --format='value(status.traffic[0].revisionName,status.traffic[0].percent)'` — the forwarder revision, 100. Rows R1, R2, R3 and R5 may not run before this gate; R4 is read-only. |
| **C. The final dump outlives its 7 days** | The dump of the cutover is the way back of the **whole** move, and the bucket's `import/` rule deletes whatever is under it after 7 days. The dump helper names its files `<env>-<label>-<stamp>-<pid>.dump` (+ `.sha256`, `.counts.tsv`), so the cutover's `prod-final-20261029T111058Z` is a **prefix**, not a whole name. Copy everything under that prefix to a prefix with no expiry and compare name and size of every object; `COPY-OK` is a condition of R5's delete line. | See the block under the table (`COPY-OK`). |
| **D. Dependents are read, not assumed** | Every Cloud Run service and job that holds prod's Cloud SQL, Redis or pooler was listed by step 0 of the cutover (`jobs.txt`) and **decided by the PO** (not used / used / unknown). The dev run expected two jobs and found a service and seven more. | `jobs.txt` and the PO's decisions from the window folder; the loops of R2 and R5 print the same facts again right before each delete. |
| **E. Realtime leftovers** | R4's lists printed nothing (run R4 first — it only reads). A realtime gateway left over could still hold a Redis connection or a load-balancer rule, so nothing in R2 or R3 runs before this. | R4 |
| **F. The old address** | The cutover sheet (step 11, question 5) keeps the old address alive as a forwarder until its request log is empty for **7 days in a row**; the service is then removed as a whole. Removing `sprintable-backend-prod` earlier breaks any client that still names the old `run.app` address — the forwarder is the answer for it, and its cost is close to nothing (R6). | R6 runs only when the list of the cutover sheet's step 11 is empty for 7 days in a row. Shortening that is the PO's change of question 5 in the cutover sheet, in writing, not a cell of this sheet. Rows R1–R5 do **not** touch `sprintable-backend-prod`, so they can run today. |
| **G. The way back through Cloud Run ends here (written by the PO)** | Cutover step 12's way back is the closed **real revision** of `sprintable-backend-prod` on Cloud Run. It reads Redis (`REDIS_URL_PROD`), the pooler (`DATABASE_URL_PROD_PGBOUNCER`) and Cloud SQL; R2, R3 and R5 each cut part of it. The PO accepts in writing, before R2, that from there the way back is the exports and the final dump (R5's undo) and that anything written on the VM after the unfreeze (2026-10-29 11:23Z) is not in them. | The PO's line in the window folder (`way-back-accepted.txt`: date and one sentence). **MEASURE:** the file exists. |

**Gate C — the copy (run it once, by the PO's hand):**

```
unset COPY_OK; P=prod-final-20261029T111058Z
gcloud storage ls -l "gs://$BACKUPS_BUCKET/import/$P-*" | grep -v '^TOTAL' > final-src.txt
[ -s final-src.txt ] && gcloud storage cp "gs://$BACKUPS_BUCKET/import/$P-*" "gs://$BACKUPS_BUCKET/cloudsql-final/$P/"
gcloud storage ls -l "gs://$BACKUPS_BUCKET/cloudsql-final/$P/*" | grep -v '^TOTAL' > final-dst.txt
sizes() { awk 'NF>=3 {n=split($3,a,"/"); print $1, a[n]}' "$1" | sort; }
[ -s final-src.txt ] && grep -q '[.]dump$' final-src.txt && [ "$(sizes final-src.txt)" = "$(sizes final-dst.txt)" ] && COPY_OK=1 && echo COPY-OK
```
**MEASURE:** `final-src.txt` and `final-dst.txt`. (These objects are whole copies of the production database — the PO sets the day they are deleted; they are not removed by this sheet.) |

The order of the rows below is the order to run them: the closed frontend first (nothing calls it), then the helpers that only Cloud Run used (Redis, pooler), then Cloud SQL last; R6, the backend service with the forwarder, is last and has its own gate.

## R1. Cloud Run prod frontend

Name from the pipeline: `sprintable-frontend-prod`. It has been closed since the freeze (cutover step 5; the app host is on the VM). **Not in this row:** `sprintable-backend-prod` (R6) and `sprintable-mcp-prod` (stays).

1. Before (read only): `gcloud run services list --project $PROJECT --region $REGION --format='table(metadata.name,status.url)'` lists it. Nothing calls it: its request log of the last 24 h shows only the refused calls of the freeze (**MEASURE:** `gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$FRONTEND\" AND httpRequest.status<400" --project $PROJECT --freshness=1d --limit=50 --format='value(timestamp,httpRequest.requestUrl)'` prints nothing), and `https://app.sprintable.ai` answers from the VM.
2. Capture (what the undo needs):
   ```
   unset R1_OK; OK=1
   gcloud run services describe $FRONTEND --project $PROJECT --region $REGION --format=export > $FRONTEND.yaml || OK=0
   gcloud run services get-iam-policy $FRONTEND --project $PROJECT --region $REGION --format=json > $FRONTEND.iam.json || OK=0
   [ -s $FRONTEND.yaml ] && [ -s $FRONTEND.iam.json ] || OK=0
   [ "$OK" = 1 ] && R1_OK=1 && echo CAPTURE-OK
   ```
   The exported definition carries the **image by digest**; the image must still exist in Artifact Registry for the undo.
3. Delete — only after `CAPTURE-OK`: `[ "${R1_OK:-0}" = 1 ] && gcloud run services delete "${FRONTEND:?}" --project "${PROJECT:?}" --region "${REGION:?}" --quiet`.
4. Check: `gcloud run services list --project $PROJECT --region $REGION --format='value(metadata.name)'` no longer lists it; `https://app.sprintable.ai` still loads and `curl -s -o /dev/null -w '%{http_code}\n' https://api.sprintable.ai/api/v2/health` is `200`.
5. **Undo:** `gcloud run services replace $FRONTEND.yaml --project $PROJECT --region $REGION && gcloud run services set-iam-policy $FRONTEND $FRONTEND.iam.json --project $PROJECT --region $REGION` — the service comes back on the old image with the same address and **with the public door as it was**; if the freeze had closed it, close it again as the cutover's step 12 block 1 does. It serves nothing the VM does not.

## R2. Redis prod

Name from the pipeline: `sprintable-redis-prod` (AUTH on). The Cloud Run backend reached it through the secret binding `REDIS_URL` ← `REDIS_URL_PROD` (the prod workflow writes no plain `redis_url`; `deploy-backend` does not put `REDIS_URL` into the environment for prod). The VM has none (`deploy/vm/env/prod.yaml`: `REDIS_URL` is declared absent, every `*_REDIS_*` switch is `false`).

1. Find it (read only), and stop unless it is exactly one: `unset REDIS; R=$(gcloud redis instances list --project $PROJECT --region $REGION --filter='name~redis-prod' --format='value(name.basename())'); [ "$(printf '%s\n' "$R" | grep -c .)" = 1 ] && REDIS=$R; echo "REDIS=${REDIS:?not exactly one match}"`.
2. **Gates B, E and G first.** What still holds it: no Cloud Run service or job of prod may carry its host or the secret `REDIS_URL_PROD` — `H=$(gcloud redis instances describe "${REDIS:?}" --project $PROJECT --region $REGION --format='value(host)'); : "${H:?no host}"; for r in services jobs; do for n in $(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)'); do if gcloud run $r describe $n --project $PROJECT --region $REGION --format=json | grep -q -e "$H" -e 'REDIS_URL_PROD'; then echo "STILL USED: $r $n"; fi; done; done`. **Expected:** nothing — the forwarder carries no secret and no setting of the application, and the loop reads each service's **current template** only. The closed real revision of `sprintable-backend-prod` still has the binding; it serves nothing (no traffic, no caller), and it goes in R6. Anything else printed: stop and report the name.
3. Capture — it prints `CAPTURE-OK` only if the file holds a definition: `unset REDIS_OK; gcloud redis instances describe "${REDIS:?}" --project $PROJECT --region $REGION --format=json > redis-prod.json && jq -e .tier redis-prod.json > /dev/null && REDIS_OK=1 && echo CAPTURE-OK`.
4. Delete — only after `CAPTURE-OK`: `[ "${REDIS_OK:-0}" = 1 ] && gcloud redis instances delete "${REDIS:?}" --project "${PROJECT:?}" --region "${REGION:?}" --quiet`.
5. **Undo (a cache and event bus only — its content is not restored):** `gcloud redis instances create $REDIS --project $PROJECT --region $REGION --tier $(jq -r .tier redis-prod.json) --size $(jq -r .memorySizeGb redis-prod.json) --redis-version $(jq -r .redisVersion redis-prod.json | tr 'A-Z' 'a-z') --network $(jq -r .authorizedNetwork redis-prod.json) --enable-auth`. The new instance gets a new address and a new AUTH string: the secret `REDIS_URL_PROD` then needs a new version, added by the PO with the PO's own account (`… | gcloud secrets versions add REDIS_URL_PROD --data-file=-`, the URL on standard input — never written into a file or this sheet). Only whole together with the undo of R6 (the real revision is the only reader).

## R3. pgbouncer prod (the high-availability set behind the old backend)

The prod pooler is not one VM: `infra/pgbouncer/deploy_prod.sh` builds a regional managed instance group `pgbouncer-prod-mig` from the template `pgbouncer-prod-tmpl`, a health check `pgbouncer-prod-hc`, a backend service `pgbouncer-prod-bes` and an internal forwarding rule `pgbouncer-prod-fr`. **It was in use on Cloud Run:** the prod workflow sets `backend_db_pgbouncer=true` (the comment there names the internal address `10.178.0.111:6432`) and `deploy-backend` binds `DATABASE_URL` ← `DATABASE_URL_PROD_PGBOUNCER` for prod. The VM does not use it (`DB_PGBOUNCER: 'false'` in `deploy/vm/env/prod.yaml`). The closed real revision still points at it, which is why gate G comes first. This row **first finds out what exists** and removes it only if nothing in a current template uses it.

1. Find it (read only; every name is the script's, none is guessed):
   ```
   gcloud compute forwarding-rules list --project $PROJECT --regions $REGION --filter='name=pgbouncer-prod-fr' --format='value(name,IPAddress)'
   gcloud compute backend-services list --project $PROJECT --regions $REGION --filter='name=pgbouncer-prod-bes' --format='value(name)'
   gcloud compute instance-groups managed list --project $PROJECT --filter='name=pgbouncer-prod-mig' --format='value(name,region.basename(),targetSize)'
   gcloud compute health-checks list --project $PROJECT --regions $REGION --filter='name=pgbouncer-prod-hc' --format='value(name)'
   gcloud compute instance-templates list --project $PROJECT --filter='name=pgbouncer-prod-tmpl' --format='value(name)'
   ```
   **All empty = done** (write «none found» with the date; nothing below runs). Anything printed: continue, and stop if a name that is not in the script shows up in a similar filter (`--filter='name~pgbouncer'`): report it.
2. **Gates E and G first.** Nothing current uses it: the forwarding rule's address (step 1) and the secret name `DATABASE_URL_PROD_PGBOUNCER` appear in no prod Cloud Run service or job — the loop of R2 with `grep -q -e "$ADDR" -e DATABASE_URL_PROD_PGBOUNCER` over the current template of each service and job prints nothing (the closed real revision is not in it, and gate G is its acceptance) — and `DB_PGBOUNCER: 'false'` in `deploy/vm/env/prod.yaml`.
3. Capture — the definition of each piece, then check each file holds one:
   ```
   unset PGB_OK; OK=1
   gcloud compute forwarding-rules describe pgbouncer-prod-fr --region $REGION --project $PROJECT --format=json > pgbouncer-prod-fr.json || OK=0
   gcloud compute backend-services describe pgbouncer-prod-bes --region $REGION --project $PROJECT --format=json > pgbouncer-prod-bes.json || OK=0
   gcloud compute instance-groups managed describe pgbouncer-prod-mig --region $REGION --project $PROJECT --format=json > pgbouncer-prod-mig.json || OK=0
   gcloud compute health-checks describe pgbouncer-prod-hc --region $REGION --project $PROJECT --format=json > pgbouncer-prod-hc.json || OK=0
   gcloud compute instance-templates describe pgbouncer-prod-tmpl --project $PROJECT --format=json > pgbouncer-prod-tmpl.json || OK=0
   for f in pgbouncer-prod-fr pgbouncer-prod-bes pgbouncer-prod-mig pgbouncer-prod-hc pgbouncer-prod-tmpl; do jq -e .name $f.json > /dev/null || OK=0; done
   [ "$OK" = 1 ] && PGB_OK=1 && echo CAPTURE-OK
   ```
   (The pooler VMs are made from the template by the group at boot and hold nothing: the startup script is in the template's metadata, saved above, and reads the secret `DATABASE_URL_PROD` at boot — no secret value is in it.)
4. Delete — in the order the pieces depend on each other (rule → backend service → group → health check → template), one chain that starts only after `CAPTURE-OK`:
   ```
   [ "${PGB_OK:-0}" = 1 ] && gcloud compute forwarding-rules delete pgbouncer-prod-fr --region "${REGION:?}" --project "${PROJECT:?}" --quiet && gcloud compute backend-services delete pgbouncer-prod-bes --region "${REGION:?}" --project "${PROJECT:?}" --quiet && gcloud compute instance-groups managed delete pgbouncer-prod-mig --region "${REGION:?}" --project "${PROJECT:?}" --quiet && gcloud compute health-checks delete pgbouncer-prod-hc --region "${REGION:?}" --project "${PROJECT:?}" --quiet && gcloud compute instance-templates delete pgbouncer-prod-tmpl --project "${PROJECT:?}" --quiet
   ```
5. **Undo:** run `infra/pgbouncer/deploy_prod.sh` again — it is the recipe that made the set, describes before it creates, and makes idle infrastructure (no prod traffic is pointed at it). The new forwarding rule may get another address; nothing points at the old one (step 2).

**Left in place on purpose:** the service account `pgbouncer-prod-sa` and its accessor binding on `DATABASE_URL_PROD` (an IAM line, harmless; the PO may remove it with the secret's clean-up), the firewall rules `allow-hc-pgbouncer-prod` and `allow-pgbouncer-prod` (no cost), and the NAT router `pgbouncer-nat-router` with its NAT `pgbouncer-nat` («region shared» with dev). The NAT's remaining cost is the PO's to read off the bill (unmeasured here).

## R4. realtime prod — read only, nothing is deleted here

The pipeline's `deploy-realtime` and `deploy-realtime-gce` retired themselves (story 4786) and `REALTIME_URL` is empty in `env/prod.yaml`, but the prod realtime pieces (the GCE group behind `sprintable-realtime-prod`, its load balancer, its Redis consumer) were set up by hand and were not read in the cutover with a name. This row only reads, so that gate E can be closed:

```
gcloud run services list --project $PROJECT --region $REGION --filter='metadata.name~realtime' --format='value(metadata.name)'
gcloud compute instance-groups managed list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute instance-templates list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute forwarding-rules list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute target-https-proxies list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute target-http-proxies list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute url-maps list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute backend-services list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute health-checks list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute addresses list --project $PROJECT --filter='name~realtime' --format='value(name,address)'
gcloud compute firewall-rules list --project $PROJECT --filter='name~realtime' --format='value(name)'
```

All empty = done. **If a line prints something, do not delete it from this sheet:** report the name. A prod realtime piece that is still up may be the Redis consumer of R2; it is removed (forwarding rule → target proxy → URL map → backend service → health check → instance group → template → address, each captured first) by its own line from the PO, and R2 waits. **Never delete the VM's own address** (read its name from `gcloud compute instances describe $VM --zone $ZONE --project $PROJECT --format='value(networkInterfaces[0].accessConfigs[0].natIP)'` and `gcloud compute addresses list`) if the `~realtime` filter matches it because someone renamed it.

## R5. Cloud SQL `sprintable-prod` — last, and only after gates A to E and G

**It is the only row with no way back except the exports below and the final dump of gate C** — an on-demand backup is deleted together with its instance, and the instance name can not be reused for some days after the delete. Prod's Cloud SQL has no `support_gateway` database (the support gateway is not in the prod move); the **databases to export are read from the instance**, not assumed.

1. Dependents — **a gate, not a report**: the block prints `DEPENDENTS-CLEAR` only if every service and job whose definition carries the instance (`:$SQL`), the direct-URL secret (`DATABASE_URL_PROD`, which also matches the pooler secret) or the instance's private address is one of the two jobs this sheet deletes itself (a read of each current template; a failed read is not clear):
   ```
   unset DEP_OK; OK=1; SRC_IP=$(gcloud sql instances describe "${SQL:?}" --project $PROJECT --format=json | jq -r '.ipAddresses[]? | select(.type=="PRIVATE") | .ipAddress' | head -n1) && [ -n "$SRC_IP" ] || { echo "NO PRIVATE ADDRESS READ"; OK=0; }
   for r in services jobs; do names=$(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)') || { OK=0; continue; }; for n in $names; do d=$(gcloud run $r describe $n --project $PROJECT --region $REGION --format=json) || { echo "UNREADABLE: $r $n"; OK=0; continue; }; if printf '%s\n' "$d" | grep -q -e ":$SQL" -e "DATABASE_URL_PROD" -e "$SRC_IP"; then case "$r/$n" in jobs/sprintable-migrate-prod|jobs/sprintable-readonly-prod) ;; *) echo "USES CLOUD SQL PROD: $r $n"; OK=0 ;; esac; fi; done; done
   gcloud run revisions list --service $BACKEND --project $PROJECT --region $REGION --format='table(metadata.name,status.conditions[0].status,metadata.annotations."run.googleapis.com/cloudsql-instances")'
   [ "$OK" = 1 ] && DEP_OK=1 && echo DEPENDENTS-CLEAR
   ```
   **Read the list, do not assume it.** The dev run expected two jobs and found a service and seven more. Every line that prints is stopped on first: the PO decides each (retire it with its own captured definition, or do not delete the instance). The service `$BACKEND` itself does not print (its current template is the forwarder, which mounts nothing); **the revisions list shows the closed real revision still mounting the instance — gate G is its acceptance.** The two jobs are the ones named in step 2 and step 4. **What the first run printed (2026-10-29, PO):** four more — the service behind the admin console (`internal-api`) and three jobs (`seed-loadtest`, `audit-apikey`, `backfill`); each had no use in the last 30 days and nothing running. The PO saved each definition (`gcloud run services describe … --format=export`, `gcloud run jobs describe … --format=export`, into the window folder) and deleted them, then ran the block again: `DEPENDENTS-CLEAR`. Do the same for any line that prints; the names above are what the list showed in the PO's report, read the exact ones from the window folder.
2. Capture — what the undo needs: **an on-demand backup and one export per database**, then check each object has a size:
   ```
   unset EXPORTS_OK; STAMP=$(date -u +%Y%m%dT%H%M%SZ); echo "$STAMP"   # a fresh path per attempt: an older object can not pass for this one
   OK=1; gcloud sql instances list --project $PROJECT --format='value(name)' | grep -qx "${SQL:?}" || { echo "NO SUCH INSTANCE: $SQL"; OK=0; }
   gcloud sql instances describe "$SQL" --project $PROJECT --format=json > sql-prod.json && jq -e '.settings.tier' sql-prod.json > /dev/null || OK=0
   gcloud sql databases list --instance "$SQL" --project $PROJECT --format='value(name)' > dbs.txt && [ -s dbs.txt ] || OK=0
   cat dbs.txt
   for j in sprintable-migrate-prod sprintable-readonly-prod; do gcloud run jobs describe "$j" --project $PROJECT --region $REGION --format=export > "$j.yaml" || OK=0; done
   gcloud sql backups create --instance "$SQL" --project $PROJECT || OK=0
   while read -r db; do gcloud sql export sql "$SQL" "gs://${BACKUPS_BUCKET:?}/cloudsql-final/$STAMP/$db.sql.gz" --database "$db" --project $PROJECT || OK=0; [ "$(gcloud storage ls -l "gs://$BACKUPS_BUCKET/cloudsql-final/$STAMP/$db.sql.gz" | awk 'NR==1{print $1}')" -gt 0 ] || OK=0; done < dbs.txt
   [ "$OK" = 1 ] && EXPORTS_OK=1 && echo EXPORTS-OK
   ```
   **Go on only if `EXPORTS-OK` was printed** — it means: the instance is in the list, its definition and the two jobs' definitions are saved, the backup succeeded, and every database the instance holds was exported to its own object under the fresh path with a size above zero. Look at the printed list of databases: it must be what the cutover sheet's step 0 read (`postgres` and `sprintable`); another name is a stop. (The instance's own service account has no role on the bucket, and the first export on 2026-10-29 failed with 412 until it was given one. Give it a role **before** the capture block and take it away right after — the grant is the PO's, with the PO's own account:
   ```
   SQL_SA=$(gcloud sql instances describe "${SQL:?}" --project $PROJECT --format='value(serviceAccountEmailAddress)'); : "${SQL_SA:?}"
   gcloud storage buckets add-iam-policy-binding "gs://${BACKUPS_BUCKET:?}" --member "serviceAccount:$SQL_SA" --role roles/storage.objectAdmin
   # ... the capture block above ...
   gcloud storage buckets remove-iam-policy-binding "gs://$BACKUPS_BUCKET" --member "serviceAccount:$SQL_SA" --role roles/storage.objectAdmin
   ```
   Take the role away even if an export failed. The `cloudsql-final/` prefix has no expiry rule.)
3. Deletion protection, if the instance has it (`jq .settings.deletionProtectionEnabled sql-prod.json` prints `true`): `gcloud sql instances patch "$SQL" --project $PROJECT --no-deletion-protection` (undo: `--deletion-protection`).
4. Delete the two jobs, then the instance — **one chained line that starts only after `EXPORTS-OK`, `DEPENDENTS-CLEAR` and `COPY-OK` (gate C) were all printed in this shell, so a missing proof, a failed export or a failed job delete stops it before the instance is touched**:
   ```
   : "${SQL:?}" && [ "${EXPORTS_OK:-0}" = 1 ] && [ "${DEP_OK:-0}" = 1 ] && [ "${COPY_OK:-0}" = 1 ] && gcloud run jobs delete sprintable-migrate-prod --project "${PROJECT:?}" --region "${REGION:?}" --quiet && gcloud run jobs delete sprintable-readonly-prod --project "${PROJECT:?}" --region "${REGION:?}" --quiet && gcloud sql instances delete "${SQL:?}" --project "${PROJECT:?}" --quiet
   ```
5. **Undo** — a new instance from `sql-prod.json`, the databases and the user, then the exports (the same chain as the dev sheet's R5: one chain, a failing step stops the rest, `RESTORE-OK` only if all ran):
   ```
   gcloud sql instances create "$SQL" --project $PROJECT --region "$(jq -r .region sql-prod.json)" --database-version "$(jq -r .databaseVersion sql-prod.json)" --tier "$(jq -r .settings.tier sql-prod.json)" --network "$(jq -r .settings.ipConfiguration.privateNetwork sql-prod.json)" --no-assign-ip &&
   gcloud sql databases create sprintable --instance "$SQL" --project $PROJECT &&
   gcloud sql users create sprintable --instance "$SQL" --project $PROJECT --password "${APP_PASSWORD:?set by the PO from the secret behind DATABASE_URL_PROD, with the PO's own account — never written into a file or this sheet}" &&
   gcloud sql import sql "$SQL" "gs://$BACKUPS_BUCKET/cloudsql-final/${STAMP:?the stamp of the export}/postgres.sql.gz" --database postgres --project $PROJECT &&
   gcloud sql import sql "$SQL" "gs://$BACKUPS_BUCKET/cloudsql-final/$STAMP/sprintable.sql.gz" --database sprintable --project $PROJECT && echo RESTORE-OK
   ```
   (`backend/scripts/provision_cloud_sql.sh` is the original recipe for the instance, the database and the user. Add `--database-flags` from `settings.databaseFlags` of `sql-prod.json` — `max_connections` is 200 on prod.) **Cloud SQL does not give a deleted instance's name back for some days:** if the create refuses the name, use another, and every connection value that holds the old private address changes with it — the secret `DATABASE_URL_PROD` (and `ALEMBIC_DATABASE_URL_PROD`, the migrate job's, if the job still reads it) get a new version added by the PO with the PO's own account, never through this sheet.
   - The jobs: `gcloud run jobs replace sprintable-migrate-prod.yaml --project $PROJECT --region $REGION && gcloud run jobs replace sprintable-readonly-prod.yaml --project $PROJECT --region $REGION && echo JOBS-OK`; if the instance has another name now, `gcloud run jobs update "$j" --project $PROJECT --region $REGION --set-cloudsql-instances "$PROJECT:$REGION:<the new name>"` for each.
   - **This undo restores the data as of the final dump.** Anything written on the VM after the unfreeze (2026-10-29 11:23Z) is **not** in it: coming back to Cloud SQL after R5 means losing those writes, or dumping the VM's database first (the cutover's step 12 explains the two ways). R5 therefore turns the cutover's way back from «seconds» into «a restore plus a loss window» — that is the price of removing it today, accepted in writing in gate G.

## R6. `sprintable-backend-prod` — the forwarder and the closed real revision (gate F)

**Why it is not removed today (PO, 2026-10-29).** The forwarder revision's settings, measured by the PO: minimum instances 0, CPU throttling on (billed per request), 1 CPU, 256 Mi, maximum 2 instances. With no caller it costs close to nothing, so it does not touch the server-cost goal, and there is no reason to cut off a client that still names the old address. The cost of waiting is therefore the requests of those clients only (**MEASURE** on the bill after a full billing day; unmeasured here). Revisit when the 7-day list is empty.

Runs only through gate F. It removes the service as a whole: the **forwarder revision** (the old address) and the **real revision** (the old backend). After it, a client still naming the old `run.app` address gets nothing.

1. Before (read only): the traffic is the forwarder by name, 100 % (gate B), the real revision has none: `gcloud run services describe $BACKEND --project $PROJECT --region $REGION --format='value(status.traffic)'`. **MEASURE:** who still reaches the forwarder in the last 24 h, by user agent — `gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$BACKEND\" AND NOT httpRequest.status=401" --project $PROJECT --freshness=1d --limit=1000 --format='value(httpRequest.userAgent)' | sort | uniq -c | sort -rn | head -20` — it is the 7-day list of the cutover sheet (gate F); the day it is empty for the seventh day in a row is the day this row may run.
2. Capture (the service with **all its revisions' templates**, the IAM policy, the image digests of both revisions):
   ```
   unset R6_OK; OK=1
   gcloud run services describe $BACKEND --project $PROJECT --region $REGION --format=export > $BACKEND.yaml || OK=0
   gcloud run services get-iam-policy $BACKEND --project $PROJECT --region $REGION --format=json > $BACKEND.iam.json || OK=0
   gcloud run revisions list --service $BACKEND --project $PROJECT --region $REGION --format=json > $BACKEND.revisions.json || OK=0
   [ -s $BACKEND.yaml ] && [ -s $BACKEND.iam.json ] && jq -e 'length > 0' $BACKEND.revisions.json > /dev/null || OK=0
   [ "$OK" = 1 ] && R6_OK=1 && echo CAPTURE-OK
   ```
   Also keep the cutover window's `real-revision-<window>.txt` (it names the real revision and its image) next to these files; the image of both revisions must still be in the registry for the undo.
3. Delete — only after `CAPTURE-OK`: `[ "${R6_OK:-0}" = 1 ] && gcloud run services delete "${BACKEND:?}" --project "${PROJECT:?}" --region "${REGION:?}" --quiet`. **Then, in the same change that removes the declaration,** the line `sprintable-backend-prod` in `infra/serving-reality-allowlist.yml` (`declared_pins`) is removed, so the serving-reality guard has nothing declared for a service that is gone (it expires on 2026-11-27 in any case) — a one-line PR, not part of this sheet's lines.
4. Check: the service is not listed; the old address answers 404 (`curl -s -o /dev/null -w '%{http_code}\n' https://sprintable-backend-prod-57iommnikq-du.a.run.app/api/v2/health`); `https://api.sprintable.ai/api/v2/health` is still `200`.
5. **Undo:** `gcloud run services replace $BACKEND.yaml --project $PROJECT --region $REGION && gcloud run services set-iam-policy $BACKEND $BACKEND.iam.json --project $PROJECT --region $REGION` brings back the service **as it was at capture — the forwarder revision**, with the same address; set its traffic by name (`--to-revisions`) as step 8c does and open it for callers only after the forwarder's own proof (403 closed → healthy as the VM → `allUsers`). The real revision comes back only if its image is still in the registry and Cloud SQL exists again (R5's undo) — until then it is not a way back.

## Run record (2026-10-29, the PO's hands)

R1 `sprintable-frontend-prod`, R2 the Redis instance (`redis-prod-basic`), R3 the five pooler pieces (the group had used the template `tmpl-r3`; the templates `tmpl-r2` and `tmpl-r3` cost nothing and were left), R5 Cloud SQL `sprintable-prod` — done between 13:29Z and 13:44Z; the instance was deleted at 13:44:04Z. Exports: `sprintable` 220 MB, `postgres` 453 B. Gate C `COPY-OK` (dump 219,075,936 bytes, `.sha256` and counts the same size in both places). R4 (eleven reads) printed nothing. **R6 has not run:** it waits for the seven empty days of gate F.

## After the sheet

- Every row done: tell the PO the line numbers; tick the acceptance only with the lists above as the evidence (the R1 and R6 lists, R2 and R3, the R4 empty lists, R5's delete result).
- The copies of the production database: the final dump copy of gate C and the exports of R5 are **whole copies of prod with personal data**. The PO sets the day they go (a `gcloud storage rm` of exactly the two paths, listed first); until then they are the only way back.
- Costs: re-price from the bill after a full billing day, not from this sheet (**unmeasured**). The VPC connector, the NAT, the secrets and the registry are read off the same bill and decided afterwards.
- The post-window clean-up change (`PUBLIC_API_URL` in `live-names.prod.txt`, `prod.yaml` `added` → `overrides`, the two old sentences of RUNBOOK §9, the old `run.app` comment) is separate from this sheet.
