# Dev removals — what runs right after the soak, one line of undo each (story 4796, AC3)

Scope: the dev resources that the VM replaced. Run by the PO's hands (`gcloud` is the PO's; this sheet gives the exact lines, the checks before, and the way back). Prod has its own sheet when its move is decided (RUNBOOK §12).

Nothing here is a guess at a name. A resource is **found with a read-only list command first**, its definition is **saved to a file**, and only then is the delete line run, guarded so an empty variable aborts (`: "${VAR:?}"`). Every delete line is followed by its undo line. Save the capture files in one folder (`mkdir -p removals-dev && cd removals-dev`) and keep it until the sheet is finished.

```
export PROJECT=sprintable-494803 REGION=asia-northeast3 ZONE=asia-northeast3-a ENV=dev
export VM=sprintable-vm-$ENV DEPLOY_BUCKET=sprintable-vm-$ENV-deploy BACKUPS_BUCKET=sprintable-vm-$ENV-backups
```
(the same names as the block at the top of the RUNBOOK)

## 0. Gates — all must be true before any delete line

| Gate | What must be true | How to check |
|---|---|---|
| **A. Soak** | The VM has served dev for a full day: deployer status `deployed` with no rollback for ≥ 24 h after the data move (RUNBOOK §7c Phase 3 finished 2026-10-27 ~18:25Z, so not before 2026-10-28 ~18:25Z), a fresh backup and a passed restore check, and nothing but health checks reaches the old Cloud Run backend. | `gcloud storage ls gs://$BACKUPS_BUCKET/status/dev/ | tail -n1` shows `deployed` (RUNBOOK §11; compare the object's time with the move) and `journalctl -u sprintable-restore-check` on the VM shows a passed check. From the PO's machine, Cloud Run request log of `sprintable-backend-dev` for the last 24 h, grouped by path: only `/api/v2/health`. Anything else = a client still on `run.app` (RUNBOOK §9): **stop**, move that client first. |
| **B. Pipeline** | The dev pipeline no longer builds and deploys the Cloud Run backend/frontend and no longer runs the Cloud SQL migrate job. Until then **the next dev push re-creates the services this sheet deletes** (`deploy-backend`, `deploy-frontend` in `cloudbuild.yaml`), and after Cloud SQL is gone `run-migrate-job` would fail every dev build before the VM bundle is even considered. | The AC3 pipeline PR (its own story step, listed in the 4796 report) is merged and one dev build ran green without those steps. **The support gateway's steps count too** — `update-support-gateway-migrate-job`, `run-support-gateway-migrate-job` and `deploy-support-gateway` run when `_SUPPORT_GATEWAY_DEPLOY_ENABLED` is true (the dev workflow sets it) and reach Cloud SQL (`--add-cloudsql-instances`, the gateway's migrate job): they are retired or retargeted by the gateway-move change (gate 0), and until then R5 may not run. Rows R1, R2, R3 and R5 may not run before this gate; R4 is read-only. |
| **C. Final dump** | A dump taken after the last writer left Cloud SQL and after the soak. | `sudo systemctl start sprintable-backup.service` on the VM, then `gcloud storage ls -l gs://$BACKUPS_BUCKET/db/ | tail -3` shows it with a size (the daily backup keeps 14 days; the exports of R5 go to a prefix with no expiry). |
| **0. support-gateway on the VM** (only for R5, Cloud SQL) | The `support_gateway` database no longer lives only in Cloud SQL: the gateway runs on the VM against its own database there, and the cutover sheet's checks passed (a widget session opened, a message sent, an escalation reaching the backend, a real Vertex call). | The cutover sheet of that step. **Until it is done the Cloud SQL row does not run**: deleting the instance deletes the `support_gateway` database with it (provision script header, 2026-08-31: the gateway's database and user live inside `sprintable-dev`). |

| **D. Realtime leftovers** | R4's lists below printed nothing (run R4 first — it only reads). A realtime gateway left over from 4786 could still hold a Redis connection or a load-balancer rule, so nothing in R2 or R3 runs before this. | R4 |

The order of the rows below is the order to run them: Cloud Run first (nothing calls it), then the helpers that only Cloud Run used (Redis, pgbouncer), then Cloud SQL last.

## R1. Cloud Run dev backend and frontend

Names come from the pipeline: `sprintable-backend-dev`, `sprintable-frontend-dev`. **Not in this row** (they stay): `sprintable-mcp-dev` (the hosted MCP, calls `dev-api`), `office-converter-dev`, `support-gateway-dev` (until gate 0, then its own removal in the cutover sheet).

1. Before (read only):
   - `gcloud run services list --project $PROJECT --region $REGION --format='table(metadata.name,status.url)'` — both names are there.
   - Nothing still calls them: the scheduler jobs target `dev-api` (`gcloud scheduler jobs list --project $PROJECT --location $REGION --format='value(name,httpTarget.uri)'` prints no `run.app`); the hosted MCP's backend address is `dev-api` (`gcloud run services describe sprintable-mcp-dev --project $PROJECT --region $REGION --format=json | grep -n 'SPRINTABLE_API_URL' -A1` shows `https://dev-api.sprintable.ai`, not a `run.app` address).
2. Capture (what the undo needs):
   ```
   unset R1_OK; OK=1
   for s in sprintable-backend-dev sprintable-frontend-dev; do
     gcloud run services describe $s --project $PROJECT --region $REGION --format=export > $s.yaml || OK=0
     gcloud run services get-iam-policy $s --project $PROJECT --region $REGION --format=json > $s.iam.json || OK=0
     [ -s $s.yaml ] && [ -s $s.iam.json ] || OK=0
   done
   gcloud run services describe sprintable-backend-dev --project $PROJECT --region $REGION --format='value(spec.template.spec.containers[0].image)' | tee backend-dev.image | grep -q . || OK=0
   [ "$OK" = 1 ] && R1_OK=1 && echo CAPTURE-OK
   ```
   The exported definition carries the **image by digest**; the image must still exist in Artifact Registry for the undo (the registry's cleanup policy keeps images in use — after the delete they are no longer «in use», so do the undo within the soak-of-the-removal days, not weeks).
3. Delete — one chained line that starts only after `CAPTURE-OK` (each command takes one service, and the second is not run if the first failed):
   ```
   [ "${R1_OK:-0}" = 1 ] && gcloud run services delete sprintable-backend-dev --project "${PROJECT:?}" --region "${REGION:?}" --quiet && gcloud run services delete sprintable-frontend-dev --project "${PROJECT:?}" --region "${REGION:?}" --quiet
   ```
4. Check: `gcloud run services list --project $PROJECT --region $REGION --format='value(metadata.name)'` no longer lists them; `curl -s -o /dev/null -w '%{http_code}\n' https://dev-api.sprintable.ai/api/v2/health` still `200` and the dev app loads.
5. **Undo:** `gcloud run services replace sprintable-backend-dev.yaml --project $PROJECT --region $REGION && gcloud run services set-iam-policy sprintable-backend-dev sprintable-backend-dev.iam.json --project $PROJECT --region $REGION && gcloud run services replace sprintable-frontend-dev.yaml --project $PROJECT --region $REGION && gcloud run services set-iam-policy sprintable-frontend-dev sprintable-frontend-dev.iam.json --project $PROJECT --region $REGION` — the services come back on the old image and settings with the same addresses (a Cloud Run address derives from the service name and the project) and the public door open again. They serve nothing until the pass-through or DNS points at them (RUNBOOK §7c undo), and the database they would use is the one behind them in R5 — so this undo is only meaningful while Cloud SQL still exists.

Jobs that belong with these two and with Cloud SQL (R5): `sprintable-migrate-dev` and `sprintable-verify-oneoff` (the one-off job used for the stored-link rewrite). Both reach Cloud SQL; they are deleted in R5 after Cloud SQL's dependents check, not here.

## R2. Redis dev

1. Find it (read only): `gcloud redis instances list --project $PROJECT --region $REGION --format='table(name,tier,memorySizeGb,host,state)' --filter='name~dev'` → exactly one line, then take its name — and stop if it is not exactly one: `unset REDIS; R=$(gcloud redis instances list --project $PROJECT --region $REGION --filter='name~dev' --format='value(name.basename())'); [ "$(printf '%s\n' "$R" | grep -c .)" = 1 ] && REDIS=$R; echo "REDIS=${REDIS:?not exactly one match}"`.
2. **Gate D first** (R4's lists are empty). What uses it. Not the VM (`deploy/vm/env/dev.yaml`: `REDIS_URL` is declared absent, every `*_REDIS_*` switch is `false`). **The Cloud Run backend did:** the dev workflow writes `redis_url=redis://10.164.120.243:6379` (`.github/workflows/cloud-build.yml`, dev branch) and the `deploy-backend` step passes `REDIS_URL` and `RATE_LIMIT_BACKEND=redis` to it for every non-prod deploy. So this row follows R1 **and** gate B — a dev deploy that still ran `deploy-backend` would bring the service back pointed at a deleted address. Check the leftovers: the host printed in step 1 must not appear in any dev Cloud Run service or job — `H=$(gcloud redis instances describe "${REDIS:?}" --project $PROJECT --region $REGION --format='value(host)'); : "${H:?no host}"; for r in services jobs; do for n in $(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)'); do if gcloud run $r describe $n --project $PROJECT --region $REGION --format=json | grep -q "$H"; then echo "STILL USED: $r $n"; fi; done; done` prints nothing. (Secret values are not read by this check; a secret that holds the address is a leftover, not a user.)
3. Capture (tier, size, version, network, auth flag) — it prints `CAPTURE-OK` only if the file holds a definition: `unset REDIS_OK; gcloud redis instances describe "${REDIS:?}" --project $PROJECT --region $REGION --format=json > redis-dev.json && jq -e .tier redis-dev.json > /dev/null && REDIS_OK=1 && echo CAPTURE-OK`.
4. Delete — only after `CAPTURE-OK`: `[ "${REDIS_OK:-0}" = 1 ] && gcloud redis instances delete "${REDIS:?}" --project "${PROJECT:?}" --region "${REGION:?}" --quiet`.
5. **Undo (a cache only — its content is not restored):** `gcloud redis instances create $REDIS --project $PROJECT --region $REGION --tier $(jq -r .tier redis-dev.json) --size $(jq -r .memorySizeGb redis-dev.json) --redis-version $(jq -r .redisVersion redis-dev.json | tr 'A-Z' 'a-z') --network $(jq -r .authorizedNetwork redis-dev.json)` (add `--enable-auth` if `redis-dev.json` has `"authEnabled": true`). **The new instance gets a new address** unless the old one is free and reserved — the old one is `redis://10.164.120.243:6379` in the workflow line above, so the undo is only whole together with R1's undo **and** two updates to the new `host`: that workflow line (a code change), and the restored service's own variable right now — `gcloud run services update sprintable-backend-dev --project $PROJECT --region $REGION --update-env-vars "REDIS_URL=redis://$(gcloud redis instances describe $REDIS --project $PROJECT --region $REGION --format='value(host)'):6379"`.

## R3. pgbouncer dev VM

1. Find it (read only): `gcloud compute instances list --project $PROJECT --filter='name~pgbouncer AND name~dev' --format='table(name,zone.basename(),machineType.basename(),networkInterfaces[0].networkIP,status)'` → one line (the dev pooler; the repo's pooler script for prod is a different, idle set named `pgbouncer-prod-*` and is not in this filter). Take the name and zone the same way and stop unless exactly one: `unset PGB PGB_ZONE; L=$(gcloud compute instances list --project $PROJECT --filter='name~pgbouncer AND name~dev' --format='value(name,zone.basename())'); [ "$(printf '%s\n' "$L" | grep -c .)" = 1 ] && PGB=$(printf '%s\n' "$L" | cut -f1) && PGB_ZONE=$(printf '%s\n' "$L" | cut -f2); echo "PGB=${PGB:?not exactly one match} PGB_ZONE=${PGB_ZONE:?}"`.
2. **Gate D first** (R4's lists are empty). Nothing uses it: the only consumer was the Cloud Run backend (secret `DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE`), deleted in R1; the VM states `DB_PGBOUNCER: "false"` and talks to its own database. Check: no running dev Cloud Run service or job still has the VM's address (`gcloud compute instances describe "$PGB" --zone "$PGB_ZONE" --project $PROJECT --format='value(networkInterfaces[0].networkIP)'` → `A`; the loop of R2 step 2 with `A` in place of `H` prints nothing).
3. Capture — the definition, the startup script(s) from the metadata (the pooler reads its secret at boot; no secret value is in them), and a snapshot of the **boot disk found in the definition** (its name is not necessarily the VM's):
   ```
   gcloud compute instances describe "$PGB" --zone "$PGB_ZONE" --project $PROJECT --format=json > pgbouncer-dev.json
   for k in $(jq -r '.metadata.items[]?.key' pgbouncer-dev.json); do jq -r --arg k "$k" '.metadata.items[] | select(.key==$k) | .value' pgbouncer-dev.json > "md-$k"; done
   EXTRA=$(jq '[.disks[] | select(.boot | not)] | length' pgbouncer-dev.json); BOOT=$(jq -r '.disks[] | select(.boot) | .source | split("/") | last' pgbouncer-dev.json)
   unset SNAP_OK; [ "$EXTRA" = 0 ] && [ -n "$BOOT" ] && gcloud compute disks snapshot "$BOOT" --zone "$PGB_ZONE" --project $PROJECT --snapshot-names "$PGB-removal" --storage-location $REGION && SNAP_OK=1 && echo SNAPSHOT-OK || echo "SNAPSHOT NOT TAKEN: a second disk, no boot disk in the definition, or the snapshot failed — this undo restores the boot disk only; snapshot every disk first"
   ```
4. Delete — only after `SNAPSHOT-OK`: `[ "${SNAP_OK:-0}" = 1 ] && gcloud compute instances delete "${PGB:?}" --zone "${PGB_ZONE:?}" --project "${PROJECT:?}" --quiet`.
5. **Undo** — every value comes from the captured definition; the same private address comes back, so the old connection string would work again; `--no-address` is added exactly when the original had no external address:
   ```
   gcloud compute disks create "$PGB" --source-snapshot "$PGB-removal" --zone "$PGB_ZONE" --project $PROJECT
   gcloud compute instances create "$PGB" --zone "$PGB_ZONE" --project $PROJECT \
     --machine-type "$(jq -r '.machineType | split("/") | last' pgbouncer-dev.json)" --disk "name=$PGB,boot=yes,auto-delete=yes" \
     --subnet "$(jq -r '.networkInterfaces[0].subnetwork' pgbouncer-dev.json)" --private-network-ip "$(jq -r '.networkInterfaces[0].networkIP' pgbouncer-dev.json)" \
     --service-account "$(jq -r '.serviceAccounts[0].email' pgbouncer-dev.json)" --scopes cloud-platform --tags "$(jq -r '.tags.items // [] | join(",")' pgbouncer-dev.json)" \
     --metadata-from-file "$(ls md-* | sed 's/^md-//' | while read k; do printf '%s=md-%s,' "$k" "$k"; done | sed 's/,$//')" \
     $([ "$(jq '.networkInterfaces[0].accessConfigs // [] | length' pgbouncer-dev.json)" = 0 ] && echo --no-address)
   ```
   (If the definition has no tags, drop `--tags`; if it has no metadata, drop `--metadata-from-file`.) Delete the snapshot (`gcloud compute snapshots delete "${PGB:?}-removal" --project "${PROJECT:?}" --quiet`) only when this sheet is finished.

**Left in place on purpose:** the NAT router `pgbouncer-nat-router` and its NAT `pgbouncer-nat` (the prod pooler script reuses them — «region shared»), and the dev firewall rules for the pooler. The firewall rules cost nothing; the NAT's remaining cost is the PO's to read off the bill before deciding (unmeasured here).

## R4. realtime-gateway dev — read only, nothing is deleted here

The story lists it, but it was already taken down by hand on 2026-10-26 (story 4786: the MIG, load balancer, address and DNS were removed; `deploy-realtime` and `deploy-realtime-gce` in the pipeline never deploy any more). This row only proves it is gone, so that AC3 can be closed:

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

All empty = done. **If a line prints something, do not delete it from this sheet:** report the name; it is a leftover of 4786 and is removed in the order forwarding rule → target proxy → URL map → backend service → health check → instance group → template → address, each captured first like the rows above. **Never delete `sprintable-vm-dev-ip`** (the VM's own address, matched by `~realtime` only if someone renamed it) and **do not touch the `dev-realtime` DNS record** the PO pointed at the VM.

## R5. Cloud SQL `sprintable-dev` — last, and only after gate 0

The instance holds three databases: `postgres`, `sprintable` (now on the VM, restored on 2026-10-27, row diff 0) and `support_gateway` (the widget gateway's; moved to the VM by gate 0). **It is the only row with no way back except the exports below** — an on-demand backup is deleted together with its instance, and the instance name can not be reused for some days after the delete.

1. Dependents (read only) — every line must be gone or retired before the delete:
   ```
   for r in services jobs; do for n in $(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)'); do if gcloud run $r describe $n --project $PROJECT --region $REGION --format=json | grep -q ':sprintable-dev'; then echo "USES CLOUD SQL: $r $n"; fi; done; done
   ```
   Expected before the delete: only `jobs sprintable-migrate-dev`, `jobs sprintable-verify-oneoff` (and, if gate 0 has not retired it, `services support-gateway-dev` and `jobs sprintable-support-gateway-migrate-dev` — then gate 0 is not done: stop). The two jobs are deleted below, after the exports.
2. Capture — what the undo needs: **an on-demand backup and one export per database**, then check each object has a size:
   ```
   INSTANCE=sprintable-dev          # the pipeline's name: sprintable-${_DEPLOY_ENV} (cloudbuild.yaml, deploy-support-gateway)
   unset EXPORTS_OK; STAMP=$(date -u +%Y%m%dT%H%M%SZ); echo "$STAMP"   # a fresh path per attempt: an older object can not pass for this one
   OK=1; gcloud sql instances list --project $PROJECT --format='value(name)' | grep -qx "${INSTANCE:?}" || { echo "NO SUCH INSTANCE: $INSTANCE"; OK=0; }
   gcloud sql instances describe "$INSTANCE" --project $PROJECT --format=json > sql-dev.json && jq -e '.settings.tier' sql-dev.json > /dev/null || OK=0
   for j in sprintable-migrate-dev sprintable-verify-oneoff; do gcloud run jobs describe "$j" --project $PROJECT --region $REGION --format=export > "$j.yaml" || OK=0; done
   gcloud sql backups create --instance "$INSTANCE" --project $PROJECT || OK=0
   for db in postgres sprintable support_gateway; do gcloud sql export sql "$INSTANCE" "gs://${BACKUPS_BUCKET:?}/cloudsql-final/$STAMP/$db.sql.gz" --database "$db" --project $PROJECT || OK=0; [ "$(gcloud storage ls -l "gs://$BACKUPS_BUCKET/cloudsql-final/$STAMP/$db.sql.gz" | awk 'NR==1{print $1}')" -gt 0 ] || OK=0; done
   [ "$OK" = 1 ] && EXPORTS_OK=1 && echo EXPORTS-OK
   ```
   **Go on only if `EXPORTS-OK` was printed** — it means: the instance is in the list, its definition and the two jobs' definitions are saved, the backup succeeded, and each of `postgres`, `sprintable` and `support_gateway` was exported to its own object under the fresh path with a size above zero. (The backup create has no «ok» of its own: `gcloud sql backups list --instance "$INSTANCE" --project $PROJECT --limit 1` shows it `SUCCESSFUL`.)
   (The instance's own service account needs write on the bucket; `gcloud sql instances describe "$INSTANCE" --project $PROJECT --format='value(serviceAccountEmailAddress)'` is the account to grant.)
3. Deletion protection, if the instance has it (`jq .settings.deletionProtectionEnabled sql-dev.json` prints `true`): `gcloud sql instances patch "$INSTANCE" --project $PROJECT --no-deletion-protection` (undo: `--deletion-protection`).
4. Delete the two jobs, then the instance — **one chained line that starts only after `EXPORTS-OK`, so a failed export or job delete stops it before the instance is touched** (these commands take one resource each):
   ```
   [ "${EXPORTS_OK:-0}" = 1 ] && gcloud run jobs delete sprintable-migrate-dev --project "${PROJECT:?}" --region "${REGION:?}" --quiet && gcloud run jobs delete sprintable-verify-oneoff --project "${PROJECT:?}" --region "${REGION:?}" --quiet && gcloud sql instances delete "${INSTANCE:?}" --project "${PROJECT:?}" --quiet
   ```
5. **Undo** — a new instance from `sql-dev.json`, the databases and the two roles, then the exports. Cloud SQL does not give a deleted instance's name back for some days: if the create refuses the name, use another and every connection value that holds the old private address (the secrets `SUPPORT_GATEWAY_DATABASE_URL_dev` and the backend's source URL) changes with it — which is why the real way back for the `sprintable` data is the VM's own dump/restore (RUNBOOK §7), not this one.
   ```
   gcloud sql instances create "$INSTANCE" --project $PROJECT --region "$(jq -r .region sql-dev.json)" --database-version "$(jq -r .databaseVersion sql-dev.json)" --tier "$(jq -r .settings.tier sql-dev.json)" --network "$(jq -r .settings.ipConfiguration.privateNetwork sql-dev.json)" --no-assign-ip &&
   gcloud sql databases create sprintable --instance "$INSTANCE" --project $PROJECT &&
   gcloud sql databases create support_gateway --instance "$INSTANCE" --project $PROJECT &&
   gcloud sql users create sprintable --instance "$INSTANCE" --project $PROJECT --password "${APP_PASSWORD:?set by the PO from the secret behind DATABASE_URL_DIRECT_DEV_SPRINTABLE, with the PO's own account — never written into a file or this sheet}" &&
   gcloud sql users create support_gw --instance "$INSTANCE" --project $PROJECT --password "${GW_PASSWORD:?set by the PO from the secret behind SUPPORT_GATEWAY_DATABASE_URL_dev, with the PO's own account — never written into a file or this sheet}" &&
   gcloud sql import sql "$INSTANCE" "gs://$BACKUPS_BUCKET/cloudsql-final/${STAMP:?the stamp of the export}/postgres.sql.gz" --database postgres --project $PROJECT &&
   gcloud sql import sql "$INSTANCE" "gs://$BACKUPS_BUCKET/cloudsql-final/$STAMP/sprintable.sql.gz" --database sprintable --project $PROJECT &&
   gcloud sql import sql "$INSTANCE" "gs://$BACKUPS_BUCKET/cloudsql-final/$STAMP/support_gateway.sql.gz" --database support_gateway --project $PROJECT && echo RESTORE-OK
   ```
   One chain: a step that fails stops the rest, and `RESTORE-OK` is printed only if all eight ran. (`backend/scripts/provision_cloud_sql.sh` is the original recipe for the instance, the `sprintable` database and the `sprintable` user — the gateway's database and user are described in the header of `support-gateway/scripts/provision_migrate_job.sh`, not scripted.) Add `--database-flags` from `settings.databaseFlags` of `sql-dev.json` if it lists any. Run the next steps only after `RESTORE-OK`.
   - The jobs: `gcloud run jobs replace sprintable-migrate-dev.yaml --project $PROJECT --region $REGION && gcloud run jobs replace sprintable-verify-oneoff.yaml --project $PROJECT --region $REGION && echo JOBS-OK`. **If the instance has another name now:** the saved definitions name the old one, so for each job `gcloud run jobs update "$j" --project $PROJECT --region $REGION --set-cloudsql-instances "$PROJECT:$REGION:$INSTANCE"`.
   - The services that connected to the old private address need the new one: a new version of each secret that holds a connection URL to this instance — `SUPPORT_GATEWAY_DATABASE_URL_dev`, `DATABASE_URL_DIRECT_DEV_SPRINTABLE`, `DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE`, `ALEMBIC_DATABASE_URL_DEV` (the migrate job's) — added by the PO (`… | gcloud secrets versions add <name> --data-file=-`, the URL on standard input), then the dependent services redeployed. Without that the restored instance exists but nothing finds it.

## After the sheet

- Every row done: tell the PO the line numbers; tick AC3 only with the lists above as the evidence (the R1 list, R2 and R3 lists, the R4 empty lists, the R5 delete's result).
- Costs: re-price from the bill after a full billing day, not from this sheet (unmeasured).
- The dev secrets, the Artifact Registry images and the scheduler jobs are not removed here.
