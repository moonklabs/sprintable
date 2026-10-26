# RUNBOOK — dev on one VM (story 4796)

Who does what: **gcloud, DNS and anything that changes a running service is the PO's hand** (this runbook gives the exact command and one line to undo it). The agent writes code, runs
tests and reads results. Disruptive steps (§8 DNS switch, §7 database move) are announced to 선생님 by the PO before they are run.

Names used below (dev). Prod is the same with `prod` for `dev` — see §12.

```bash
export PROJECT=sprintable-494803 REGION=asia-northeast3 ZONE=asia-northeast3-a ENV=dev
export VM=sprintable-vm-$ENV DISK=sprintable-data-$ENV IP=sprintable-vm-$ENV-ip SA=sprintable-vm-$ENV
export DEPLOY_BUCKET=sprintable-vm-$ENV-deploy BACKUPS_BUCKET=sprintable-vm-$ENV-backups
```

## 1. Buckets (deploy input, backups)

```bash
gcloud storage buckets create gs://$DEPLOY_BUCKET  --project $PROJECT --location $REGION --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets create gs://$BACKUPS_BUCKET --project $PROJECT --location $REGION --uniform-bucket-level-access --public-access-prevention
cat > /tmp/lifecycle.json <<'EOF'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":14,"matchesPrefix":["db/"]}},{"action":{"type":"Delete"},"condition":{"age":7,"matchesPrefix":["status/"]}}]}
EOF
gcloud storage buckets update gs://$BACKUPS_BUCKET --lifecycle-file=/tmp/lifecycle.json
```
Undo: `gcloud storage rm -r gs://$DEPLOY_BUCKET gs://$BACKUPS_BUCKET` (only while they hold nothing you need).

## 2. VM identity and its access (the part most likely to be forgotten)

The VM's service account stands in for the Cloud Run backend's. **Copy what the backend's service account has** instead of guessing:

```bash
BACKEND_SA=$(gcloud run services describe sprintable-backend-$ENV --region $REGION --format='value(spec.template.spec.serviceAccountName)')
gcloud projects get-iam-policy $PROJECT --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$BACKEND_SA" --format='table(bindings.role)'
gcloud storage buckets list --format='value(name)' | while read b; do gcloud storage buckets get-iam-policy gs://$b --format=json 2>/dev/null | grep -q "$BACKEND_SA" && echo "bucket: $b"; done
```
Send that output to the agent: it is the parity list (Secret Manager accessor **per secret**, Artifact Registry reader, the GCS buckets named in `GCS_*_BUCKET`, Vertex AI/Gemini, Firebase, logging). Secrets are granted one by one (the dev runtime account lost its project-wide accessor in story 4798); the prod list is taken from the prod account's own output, not copied from dev.

```bash
gcloud iam service-accounts create $SA --project $PROJECT --display-name "Sprintable $ENV VM"
SAE=$SA@$PROJECT.iam.gserviceaccount.com
# always:
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/logging.logWriter
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/monitoring.metricWriter
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/artifactregistry.reader
gcloud storage buckets add-iam-policy-binding gs://$DEPLOY_BUCKET  --member serviceAccount:$SAE --role roles/storage.objectViewer   # read only: the VM cannot change what it will run
gcloud storage buckets add-iam-policy-binding gs://$BACKUPS_BUCKET --member serviceAccount:$SAE --role roles/storage.objectCreator  # backups + status files: it can ADD objects, never replace or delete them
gcloud storage buckets add-iam-policy-binding gs://$BACKUPS_BUCKET --member serviceAccount:$SAE --role roles/storage.objectViewer   # … and read them back (restore, restore-check)
# per secret the declaration reads (ids such as cron-secret or SUPPORT_GATEWAY_TOKEN_SECRET_dev included) plus the new database password — never project-wide.
# Secrets the VM does not read (the Cloud SQL / pgbouncer connection strings) get no grant:
for S in $(python3 deploy/vm/bin/render_env.py --secret-ids deploy/vm/env/$ENV.yaml); do   # exactly the ids the VM reads (incl. the new DB password), nothing project-wide
  gcloud secrets add-iam-policy-binding $S --project $PROJECT --member serviceAccount:$SAE --role roles/secretmanager.secretAccessor
done
# then the rest of the parity list (PO's output of 2026-10-26, runtime account cloudrun-runtime-dev):
#   project roles: roles/aiplatform.user (dev only — prod has none) · roles/artifactregistry.reader (already above)
#   cloudsql.client is NOT copied: the VM has no Cloud SQL
#   buckets, roles/storage.objectAdmin on each: sprintable-avatars-dev · sprintable-channel-media-dev · sprintable-memo-attachments-dev
#   (the attachments bucket is dev-only — not the bucket dev and prod used to share; story 5269 creates it, so grant after it exists)
for B in sprintable-avatars-dev sprintable-channel-media-dev sprintable-memo-attachments-dev; do
  gcloud storage buckets add-iam-policy-binding gs://$B --member serviceAccount:$SAE --role roles/storage.objectAdmin
done
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/aiplatform.user
```
Undo: `gcloud iam service-accounts delete $SAE` (removes its bindings with it).

**Accepted limit — one identity on the VM.** The containers can reach the metadata server, because the backend needs it for Vertex AI, Cloud Storage and Firebase exactly as it does on Cloud Run. So an SSRF/RCE in the backend could use the VM service account, which also holds the deploy-time grants (database password secret, read of the backups bucket, create-only write there). Mitigations in place: per-secret grants only, backups bucket create-only (no overwrite/delete), deploy bucket read-only. Splitting the identities would need a second VM and is not part of this story.
Cloud Build's service account additionally needs `roles/storage.objectAdmin` on `gs://$DEPLOY_BUCKET` (it writes the bundle and `desired.json`).

## 3. Database password (new, VM only)

```bash
openssl rand -hex 24 | gcloud secrets create DB_PASSWORD_VM_DEV --project $PROJECT --data-file=-
```
Hex only: the password is placed inside a connection URL and the tooling refuses anything else. The value is used the first time the database folder is created;
after that, changing the secret does **not** change the database (rotate with `ALTER ROLE` first, then the secret).
Undo: `gcloud secrets delete DB_PASSWORD_VM_DEV`.

## 4. Address, firewall, disk, VM

```bash
gcloud compute addresses create $IP --project $PROJECT --region $REGION
gcloud compute firewall-rules create $VM-web --project $PROJECT --network default --direction INGRESS --allow tcp:80,tcp:443 --target-tags $VM --source-ranges 0.0.0.0/0
# 22 / 3389: allow only Google's IAP range (priority 800 beats the deny at 900), and deny everyone else for THIS VM — the project-wide default-allow rules are cleaned up separately by the PO
gcloud compute firewall-rules create $VM-iap-ssh --project $PROJECT --network default --direction INGRESS --priority 800 --allow tcp:22 --target-tags $VM --source-ranges 35.235.240.0/20
gcloud compute firewall-rules create $VM-deny-admin --project $PROJECT --network default --direction INGRESS --priority 900 --action DENY --rules tcp:22,tcp:3389 --target-tags $VM --source-ranges 0.0.0.0/0
gcloud compute disks create $DISK --project $PROJECT --zone $ZONE --size 30GB --type pd-balanced
gcloud compute resource-policies create snapshot-schedule $VM-daily --project $PROJECT --region $REGION --daily-schedule --start-time 18:00 --max-retention-days 7
gcloud compute disks add-resource-policies $DISK --project $PROJECT --zone $ZONE --resource-policies $VM-daily
gcloud compute instances create $VM --project $PROJECT --zone $ZONE --machine-type e2-medium \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB --boot-disk-type pd-balanced \
  --disk name=$DISK,device-name=sprintable-data,mode=rw,auto-delete=no \
  --address $IP --tags $VM --service-account $SAE --scopes cloud-platform \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring --metadata enable-oslogin=TRUE
```
Open ports are exactly **80 and 443 (everyone)** and **22 from Google's IAP range only** (3389 is not open; the priority-900 deny makes that true for this VM whatever the project-wide default rules say). The database port is not published by compose and has no firewall rule.
Images that are not ours (`pgvector/pgvector:pg15`, `caddy:2.8.4-alpine`) are pinned by tag only; after the first pull, record their digests (`docker image inspect --format '{{index .RepoDigests 0}}' <image>`) and commit them into `compose.yml` so a rollback is byte-identical (follow-up).
The extra disk and the snapshot schedule are what survive a lost boot disk (RPO ≤ 24 h by snapshot, ≤ 24 h by dump).
Undo: `gcloud compute instances delete $VM --zone $ZONE` · `gcloud compute disks delete $DISK --zone $ZONE` · `gcloud compute addresses delete $IP --region $REGION` · `gcloud compute firewall-rules delete $VM-web $VM-iap-ssh $VM-deny-admin`.

## 5. First bundle and desired version (by hand once; Cloud Build does it afterwards)

On a machine with the repository at the commit to run:
```bash
SHA=$(git rev-parse HEAD)
BACKEND_IMAGE=<registry>/backend@sha256:…        FRONTEND_IMAGE=<registry>/frontend-vm@sha256:…   # the frontend image for the VM is built with the VM's API host (§9)
python3 deploy/vm/bin/make_bundle.py --sha $SHA --backend-image $BACKEND_IMAGE --frontend-image $FRONTEND_IMAGE --out /tmp/vm-bundle
gcloud storage cp /tmp/vm-bundle/bundles/$SHA.tgz gs://$DEPLOY_BUCKET/bundles/$SHA.tgz     # bundle first …
# … desired.json is uploaded in §7 step 6, after the database is restored
```

## 6. Bootstrap the VM

```bash
# the bundle goes to the VM from the PO's machine (the VM needs no gcloud for this step; bootstrap installs the Google Cloud CLI if the image lacks it):
gcloud storage cp gs://$DEPLOY_BUCKET/bundles/$SHA.tgz /tmp/vm-bundle.tgz
gcloud compute scp /tmp/vm-bundle.tgz $VM:/tmp/ --zone $ZONE --tunnel-through-iap
gcloud compute ssh $VM --zone $ZONE --tunnel-through-iap
# on the VM:
mkdir b && tar -xzf /tmp/vm-bundle.tgz -C b
sudo b/bin/bootstrap.sh dev sprintable-494803 sprintable-vm-dev-deploy sprintable-vm-dev-backups <ops-email>
```
Re-run it from a newer bundle whenever `deployer.py`, `render_env.py`, the units, `bootstrap.sh` or **`compose.yml`** change (README; the deployer refuses a bundle whose `compose.yml` differs from the copy bootstrap installed).

**Private plain file** — the non-secret values of the live services, per service, readable by root only. Made from the live Cloud Run services (values stay on this machine / that VM; they are not pasted anywhere):
```bash
for SVC in backend frontend; do
  gcloud run services describe sprintable-$SVC-$ENV --region $REGION --format=json \
   | jq --arg s $SVC '{($s): ([.spec.template.spec.containers[0].env[] | select(.value != null) | {(.name): .value}] | add)}'
done | jq -s 'add' > private-plain.json
gcloud compute scp private-plain.json $VM:/tmp/ --zone $ZONE --tunnel-through-iap && rm private-plain.json
# on the VM:  sudo install -m 0600 -o root -g root /tmp/private-plain.json /etc/sprintable/private-plain.json && shred -u /tmp/private-plain.json
```
The deployer reports which names are missing (names only) and refuses a file that group/others can read. Entries the live service holds as secrets are not in the file (they come from Secret Manager).

**Before any cutover — do the live services still have the names this declaration was written from?** (the tests only compare the declaration with the copy; this compares the copy with the service as it is now)
```bash
for SVC in backend frontend; do
  gcloud run services describe sprintable-$SVC-$ENV --region $REGION --format=json \
   | python3 deploy/vm/bin/check_live_names.py deploy/vm/env/live-names.$ENV.txt sprintable-$SVC-$ENV
done   # «ok: N names match» twice; anything else lists added / gone / changed NAMES (never values) — update the declaration first
```

**`JWT_SECRET` is per environment (story 4798 AC6 — done).** Dev reads `JWT_SECRET_DEV` (backend and frontend, as the live dev services do since 2026-10-26 23:52Z); prod's declaration reads `JWT_SECRET_PROD` from the start. The old shared `JWT_SECRET` entry is deleted at 4798 AC9, so **no declaration may read that name** (a test pins it). The IAM loop in §2 grants exactly the ids the declarations read.

## 7. Move the data — **disruptive, announced first**

Writers (users, desktop apps, phones) are stopped for the length of the dump-restore. Measure first (§7a), announce with the measured number.

7a. Rehearsal (no downtime): dump Cloud SQL dev to a file, restore it on the VM with the steps below, time each step, compare row counts, then `RESTORE_WIPE=yes` and discard.

1. `gcloud sql instances describe <dev-instance> --format='value(connectionName)'`, start the Cloud SQL Auth Proxy locally (`cloud-sql-proxy <connectionName> --port 5433`).
2. Stop writes: close the public door of the Cloud Run dev backend (`--max-instances 0` is not allowed — the minimum is 1) and pause the scheduler jobs that call it.
   `gcloud run services update sprintable-backend-dev --region $REGION --ingress internal` — then check from outside: `curl -s -o /dev/null -w '%{http_code}\n' https://dev-api.sprintable.ai/api/v2/health` must NOT print 200.
   `gcloud scheduler jobs list --location $REGION` → `gcloud scheduler jobs pause <job>` for each job that targets the backend (note them).
   Undo: `gcloud run services update sprintable-backend-dev --region $REGION --ingress all` and `gcloud scheduler jobs resume <job>`.
3. `PGPASSWORD=… pg_dump -h 127.0.0.1 -p 5433 -U <user> -d <db> -Fc --no-owner -f dev.dump` and the source row counts:
   `PGPASSWORD=… psql -h 127.0.0.1 -p 5433 -U <user> -d <db> -X -A -t -F $'\t' -f deploy/vm/bin/rowcounts.sql > counts-source.tsv`
4. Checksum sidecar (restore.sh verifies it before touching anything), then upload both: `shasum -a 256 dev.dump > dev.dump.sha256` · `gcloud storage cp dev.dump dev.dump.sha256 gs://$BACKUPS_BUCKET/import/`
5. On the VM: `sudo python3 /opt/sprintable/bin/deployer.py --db-only` (needs step 6 first only for `desired.json`; for the rehearsal upload any valid one), then
   `sudo /opt/sprintable/bin/restore.sh gs://$BACKUPS_BUCKET/import/dev.dump > counts-vm.tsv` and `diff counts-source.tsv <(grep -P '^\S+\t\d+$' counts-vm.tsv)` — **empty diff = row counts equal**.
6. Upload `desired.json` (`gcloud storage cp /tmp/vm-bundle/desired.json gs://$DEPLOY_BUCKET/desired.json`) and enable the deployer: `sudo systemctl enable --now sprintable-deploy.timer`. Watch `journalctl -u sprintable-deploy -f` and the newest object under `gs://$BACKUPS_BUCKET/status/dev/`: states go `deploying → deployed` (migrate runs before the swap).

Undo of the move as a whole: nothing was deleted from Cloud SQL — scale Cloud Run back up (step 2 undo) and leave DNS where it is (§8 is a separate step).

## 8. Lane wheel on the VM, then DNS — **disruptive, announced first**

Before any DNS record moves, the VM is tested by address (hosts file or `curl --resolve`) with the lane wheel: login · conversation · desktop relay · MCP · phone instruction.
**First-VM measurement — which address does the backend count?** (`TRUST_FORWARDED_FOR` is on; the answer must be the real caller, not Caddy and not a forged value.) From a machine outside Google, through the whole path (Caddy → backend, no hop in between):
send more requests than the limit of a per-IP-limited endpoint (e.g. the verification-resend limiter) from ONE machine, each with a different forged header `-H 'X-Forwarded-For: 9.9.9.<n>'`. Expected: you hit 429 at the limit regardless of the forged values (the limiter counts your real address). If you never reach 429, the forged value is being counted; if a *second* machine is limited at the same moment, a shared (Caddy/private) address is being counted. Either way stop and tell the agent — do not switch DNS.
Caddy needs the real hostnames to issue certificates; until DNS points at the VM it cannot, so the **first certificate is issued after the record is switched** (a short window with a certificate error is expected; announce it).
For the `app` host behind the Cloudflare proxy: Cloudflare SSL/TLS mode must be **Full (strict)**.

Records (PO edits them in Cloudflare; note the old value first — that is the undo line):

| Host | Now | Switch to |
|---|---|---|
| `dev-api` | CNAME → run.app, proxied | A → `$(gcloud compute addresses describe $IP --region $REGION --format='value(address)')`, **DNS only** |
| `dev-realtime` | A, DNS only | same A |
| `dev-app` | CNAME → run.app, proxied | A → same address, **proxied** (UI stays behind the proxy) |
| `dev-mcp` | CNAME → run.app, proxied | unchanged (hosted MCP stays on Cloud Run; its backend URL changes, §9) |

Undo: put the old values back (TTL 60 s while switching); Cloud Run dev stays untouched until the soak is over.

## 9. What points at `run.app` and must be told the new address

The list of code and configuration places is in the story evidence (`run.app consumers`). Order of work: (1) VM frontend image built with `NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai`
(the frontend bakes this at build time; Cloud Build builds a second image `frontend-vm` for it); (2) every lane Mac's MCP `SPRINTABLE_API_URL`; (3) hosted MCP / office-converter / support-gateway services
(`_BACKEND_URL`); (4) GCS CORS files; (5) login consoles and integration callbacks (Dan's list) — those are changed **at the DNS switch**, not before.

## 10. After the soak (one full day, status `deployed`, no rollback) — removals, one line of undo each

Only on the PO's go. Take a final dump first (`sudo systemctl start sprintable-backup.service`).

| Remove | Command | Undo |
|---|---|---|
| Cloud Run dev backend/frontend | `gcloud run services delete sprintable-backend-dev sprintable-frontend-dev --region $REGION` | redeploy from the last Cloud Build run of the same sha |
| Cloud SQL dev | `gcloud sql instances delete <dev-instance>` (take `gcloud sql backups create` + the §7 dump first) | restore the Cloud SQL backup / dump into a new instance |
| Redis dev | `gcloud redis instances delete <dev-redis> --region $REGION` | recreate with the same size (cache only) |
| pgbouncer dev VM | `gcloud compute instances delete <pgbouncer-dev>` | recreate from its instance template |
| realtime-gateway dev VM/LB | as above, then the forwarding rule | recreate from its template |

## 11. Day-to-day on the VM

- Status: the newest object under `gs://$BACKUPS_BUCKET/status/dev/` (`gcloud storage ls gs://$BACKUPS_BUCKET/status/dev/ | tail -n1`; one small object per tick, kept 7 days; `state`: up-to-date · deploying · deployed · failed · rolled-back · rollback-failed · skipping-failed).
- A version that failed **before** the swap is retried after 5 minutes; one that failed **after** the swap (and was rolled back) is not retried until `desired.json` changes, or `sudo python3 /opt/sprintable/bin/deployer.py --force` (which also redeploys the version that is already running, e.g. after a rotated secret).
- Roll back by hand: upload the previous `desired.json` (keep the last one: `gcloud storage cp gs://$DEPLOY_BUCKET/desired.json ./desired.prev.json` before a risky release). Migrations are not rolled back — a migration must work with the previous image.
- Backups: daily 03:00 KST → `gs://$BACKUPS_BUCKET/db/` (14 days); weekly `restore-check` prints `restore_seconds=… tables=… rows=…` (`journalctl -u sprintable-restore-check`).
- Secrets: a rotated secret takes effect on the next deploy (`--force` redeploys the same version); the database password has its own rule (§3).
- What the VM trusts: **write access to the deploy bucket = control of the deployment.** Whoever can write it (Cloud Build's service account) decides what runs as root there; only `compose.yml` is pinned to the copy installed on the VM — the `Caddyfile` (front door, certificates) and `env/<environment>.yaml` (which secrets are read, which variables are set) come from the bundle itself. The deployer therefore accepts images only from our own Artifact Registry project, and a `compose.yml` only if it is **exactly** the one `bootstrap.sh` installed on the VM (every key and value of every service, compared as documents) — so a compose change is an infrastructure change: re-run `bootstrap.sh` from the new bundle (§6), a human step; a normal release only changes image digests and `Caddyfile`/`env` files. Keep write access to the deploy bucket to that one service account.
- A migration that already ran is not undone by a rollback; the previous image must work with the new schema (expand first, contract in a later release). Before a risky migration run `sudo systemctl start sprintable-backup.service`.
- The registry login exists only while images are pulled (`docker logout` right after).
- If a swap to a new release succeeded but the run died before `current.json` was written, the next run first puts the previously recorded release back and then deploys the new one again (one extra flip, nothing lost).
- Log scrubbing covers the values read from Secret Manager (and the database password) — not plain values from the private file, split values or re-encoded ones (base64); do not put secrets in the private plain file.
- Docker keeps each container's environment in its own root-only configuration under `/var/lib/docker` (as for any container); only root on the VM can read it, and IAP-only SSH + OS Login decide who is root.

## 12. Prod

Same steps with `ENV=prod`, `env/prod.yaml`, a new `api.sprintable.ai` record (DNS only) in place of the Cloud Run URL, and the cutover only after dev has soaked. Prod is announced separately.
