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
| **B. Pipeline** | The dev pipeline no longer builds and deploys the Cloud Run backend/frontend and no longer runs the Cloud SQL migrate job. Until then **the next dev push re-creates the services this sheet deletes** (`deploy-backend`, `deploy-frontend` in `cloudbuild.yaml`), and after Cloud SQL is gone `run-migrate-job` would fail every dev build before the VM bundle is even considered. | The AC3 pipeline PR (its own story step, listed in the 4796 report) is merged and one dev build ran green without those steps. Rows R1, R2, R3 and R5 may not run before this gate; R4 is read-only. |
| **C. Final dump** | A dump taken after the last writer left Cloud SQL and after the soak. | `sudo systemctl start sprintable-backup.service` on the VM, then `gcloud storage ls -l gs://$BACKUPS_BUCKET/db/ | tail -3` shows it with a size (the daily backup keeps 14 days; the exports of R5 go to a prefix with no expiry). |
| **0. support-gateway on the VM** (only for R5, Cloud SQL) | The `support_gateway` database no longer lives only in Cloud SQL: the gateway runs on the VM against its own database there, and the cutover sheet's checks passed (a widget session opened, a message sent, an escalation reaching the backend, a real Vertex call). | The cutover sheet of that step. **Until it is done the Cloud SQL row does not run**: deleting the instance deletes the `support_gateway` database with it (provision script header, 2026-08-31: the gateway's database and user live inside `sprintable-dev`). |

The order of the rows below is the order to run them: Cloud Run first (nothing calls it), then the helpers that only Cloud Run used (Redis, pgbouncer), then Cloud SQL last.

## R1. Cloud Run dev backend and frontend

Names come from the pipeline: `sprintable-backend-dev`, `sprintable-frontend-dev`. **Not in this row** (they stay): `sprintable-mcp-dev` (the hosted MCP, calls `dev-api`), `office-converter-dev`, `support-gateway-dev` (until gate 0, then its own removal in the cutover sheet).

1. Before (read only):
   - `gcloud run services list --project $PROJECT --region $REGION --format='table(metadata.name,status.url)'` — both names are there.
   - Nothing still calls them: the scheduler jobs target `dev-api` (`gcloud scheduler jobs list --project $PROJECT --location $REGION --format='value(name,httpTarget.uri)'` prints no `run.app`); the hosted MCP's backend address is `dev-api` (`gcloud run services describe sprintable-mcp-dev --project $PROJECT --region $REGION --format=json | grep -n 'SPRINTABLE_API_URL' -A1` shows `https://dev-api.sprintable.ai`, not a `run.app` address).
2. Capture (what the undo needs):
   ```
   for s in sprintable-backend-dev sprintable-frontend-dev; do
     gcloud run services describe $s --project $PROJECT --region $REGION --format=export > $s.yaml
     gcloud run services get-iam-policy $s --project $PROJECT --region $REGION --format=json > $s.iam.json
   done
   gcloud run services describe sprintable-backend-dev --project $PROJECT --region $REGION --format='value(spec.template.spec.containers[0].image)' | tee backend-dev.image
   ```
   The exported definition carries the **image by digest**; the image must still exist in Artifact Registry for the undo (the registry's cleanup policy keeps images in use — after the delete they are no longer «in use», so do the undo within the soak-of-the-removal days, not weeks).
3. Delete:
   ```
   gcloud run services delete sprintable-backend-dev sprintable-frontend-dev --project "${PROJECT:?}" --region "${REGION:?}" --quiet
   ```
4. Check: `gcloud run services list --project $PROJECT --region $REGION --format='value(metadata.name)'` no longer lists them; `curl -s -o /dev/null -w '%{http_code}\n' https://dev-api.sprintable.ai/api/v2/health` still `200` and the dev app loads.
5. **Undo:** `for s in sprintable-backend-dev sprintable-frontend-dev; do gcloud run services replace $s.yaml --project $PROJECT --region $REGION && gcloud run services set-iam-policy $s $s.iam.json --project $PROJECT --region $REGION; done` — the services come back on the old image and settings with the same addresses (a Cloud Run address derives from the service name and the project) and the public door open again. They serve nothing until the pass-through or DNS points at them (RUNBOOK §7c undo), and the database they would use is the one behind them in R5 — so this undo is only meaningful while Cloud SQL still exists.

Jobs that belong with these two and with Cloud SQL (R5): `sprintable-migrate-dev` and `sprintable-verify-oneoff` (the one-off job used for the stored-link rewrite). Both reach Cloud SQL; they are deleted in R5 after Cloud SQL's dependents check, not here.

## R2. Redis dev

1. Find it (read only): `gcloud redis instances list --project $PROJECT --region $REGION --format='table(name,tier,memorySizeGb,host,state)' --filter='name~dev'` → one line; `REDIS=<its short name>`.
2. Nothing uses it: the VM states no Redis (`deploy/vm/env/dev.yaml`: `REDIS_URL` is declared absent, every `*_REDIS_*` switch is `false`), the dev pipeline passes no `REDIS_URL` (`_REDIS_URL: ''`). Check the leftovers: the host printed in step 1 must not appear in any dev Cloud Run service or job — `H=$(gcloud redis instances describe "${REDIS:?}" --project $PROJECT --region $REGION --format='value(host)'); : "${H:?no host}"; for r in services jobs; do for n in $(gcloud run $r list --project $PROJECT --region $REGION --format='value(metadata.name)'); do if gcloud run $r describe $n --project $PROJECT --region $REGION --format=json | grep -q "$H"; then echo "STILL USED: $r $n"; fi; done; done` prints nothing. (Secret values are not read by this check; a secret that holds the address is a leftover, not a user.)
3. Capture: `gcloud redis instances describe "$REDIS" --project $PROJECT --region $REGION --format=json > redis-dev.json` (tier, size, version, network, auth flag).
4. Delete: `gcloud redis instances delete "${REDIS:?}" --project "${PROJECT:?}" --region "${REGION:?}" --quiet`.
5. **Undo (a cache only — its content is not restored):** `gcloud redis instances create $REDIS --project $PROJECT --region $REGION --tier $(jq -r .tier redis-dev.json) --size $(jq -r .memorySizeGb redis-dev.json) --redis-version $(jq -r .redisVersion redis-dev.json | tr 'A-Z' 'a-z') --network $(jq -r .authorizedNetwork redis-dev.json)` (add `--enable-auth` if `redis-dev.json` has `"authEnabled": true`); the new instance has a new address.

## R3. pgbouncer dev VM

1. Find it (read only): `gcloud compute instances list --project $PROJECT --filter='name~pgbouncer AND name~dev' --format='table(name,zone.basename(),machineType.basename(),networkInterfaces[0].networkIP,status)'` → one line (the dev pooler; the repo's pooler script for prod is a different, idle set named `pgbouncer-prod-*` and is not in this filter). `PGB=<name>`, `PGB_ZONE=<zone>`.
2. Nothing uses it: the only consumer was the Cloud Run backend (secret `DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE`), deleted in R1; the VM states `DB_PGBOUNCER: "false"` and talks to its own database. Check: no running dev Cloud Run service or job still has the VM's address (`gcloud compute instances describe "$PGB" --zone "$PGB_ZONE" --project $PROJECT --format='value(networkInterfaces[0].networkIP)'` → `A`; the loop of R2 step 2 with `A` in place of `H` prints nothing).
3. Capture: `gcloud compute instances describe "$PGB" --zone "$PGB_ZONE" --project $PROJECT --format=json > pgbouncer-dev.json` and a snapshot of its boot disk: `gcloud compute disks snapshot "$PGB" --zone "$PGB_ZONE" --project $PROJECT --snapshot-names "$PGB-removal"` (add `--storage-location $REGION`).
4. Delete: `gcloud compute instances delete "${PGB:?}" --zone "${PGB_ZONE:?}" --project "${PROJECT:?}" --quiet`.
5. **Undo:** `gcloud compute disks create $PGB --source-snapshot $PGB-removal --zone $PGB_ZONE --project $PROJECT` then `gcloud compute instances create $PGB --zone $PGB_ZONE --project $PROJECT --machine-type $(jq -r .machineType pgbouncer-dev.json | xargs basename) --disk name=$PGB,boot=yes --subnet <the subnet in pgbouncer-dev.json> --private-network-ip <the networkIP in pgbouncer-dev.json> --service-account <the one in pgbouncer-dev.json> --scopes cloud-platform --tags <the tags in pgbouncer-dev.json>` — same private address as before, so the old connection string would work again. Delete the snapshot (`gcloud compute snapshots delete $PGB-removal`) only when this sheet is finished.

**Left in place on purpose:** the NAT router `pgbouncer-nat-router` and its NAT `pgbouncer-nat` (the prod pooler script reuses them — «region shared»), and the dev firewall rules for the pooler. The firewall rules cost nothing; the NAT's remaining cost is the PO's to read off the bill before deciding (unmeasured here).

## R4. realtime-gateway dev — read only, nothing is deleted here

The story lists it, but it was already taken down by hand on 2026-10-26 (story 4786: the MIG, load balancer, address and DNS were removed; `deploy-realtime` and `deploy-realtime-gce` in the pipeline never deploy any more). This row only proves it is gone, so that AC3 can be closed:

```
gcloud run services list --project $PROJECT --region $REGION --filter='metadata.name~realtime' --format='value(metadata.name)'
gcloud compute instance-groups managed list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute instance-templates list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute forwarding-rules list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute backend-services list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute health-checks list --project $PROJECT --filter='name~realtime' --format='value(name)'
gcloud compute addresses list --project $PROJECT --filter='name~realtime' --format='value(name,address)'
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
   INSTANCE=<the name gcloud sql instances list prints for the dev instance: sprintable-dev>
   gcloud sql backups create --instance "${INSTANCE:?}" --project $PROJECT
   for db in postgres sprintable support_gateway; do
     gcloud sql export sql "$INSTANCE" "gs://${BACKUPS_BUCKET:?}/cloudsql-final/$db.sql.gz" --database "$db" --project $PROJECT
   done
   gcloud storage ls -l "gs://$BACKUPS_BUCKET/cloudsql-final/"
   ```
   (The instance's own service account needs write on the bucket; `gcloud sql instances describe "$INSTANCE" --project $PROJECT --format='value(serviceAccountEmailAddress)'` is the account to grant.) Save the definition: `gcloud sql instances describe "$INSTANCE" --project $PROJECT --format=json > sql-dev.json`.
3. Deletion protection, if the instance has it (`jq .settings.deletionProtectionEnabled sql-dev.json` prints `true`): `gcloud sql instances patch "$INSTANCE" --project $PROJECT --no-deletion-protection` (undo: `--deletion-protection`).
4. Delete the two jobs, then the instance:
   ```
   gcloud run jobs delete sprintable-migrate-dev sprintable-verify-oneoff --project "${PROJECT:?}" --region "${REGION:?}" --quiet
   gcloud sql instances delete "${INSTANCE:?}" --project "${PROJECT:?}" --quiet
   ```
   (Capture the two jobs first like R1: `gcloud run jobs describe <job> --project $PROJECT --region $REGION --format=export > <job>.yaml`.)
5. **Undo:** a new instance from `sql-dev.json` (tier, version, network, flags — the dev database is small: 252 tables, 295 MB at the last dump) and `gcloud sql import sql <new-instance> gs://$BACKUPS_BUCKET/cloudsql-final/<db>.sql.gz --database <db> --project $PROJECT` per database; the jobs come back with `gcloud run jobs replace <job>.yaml`. The private address of the new instance differs, so the connection secrets would need new values — which is why the real way back for the `sprintable` data is the VM's own dump/restore (RUNBOOK §7), not this one.

## After the sheet

- Every row done: tell the PO the line numbers; tick AC3 only with the lists above as the evidence (the R1 list, R2 and R3 lists, the R4 empty lists, the R5 delete's result).
- Costs: re-price from the bill after a full billing day, not from this sheet (unmeasured).
- The dev secrets, the Artifact Registry images and the scheduler jobs are not removed here.
