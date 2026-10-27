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
# always (a project-level binding names its condition — the project policy holds a conditional binding, and gcloud then refuses an unconditioned call in a script):
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/logging.logWriter --condition=None
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/monitoring.metricWriter --condition=None
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/artifactregistry.reader --condition=None
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
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SAE --role roles/aiplatform.user --condition=None
```
Undo: `gcloud iam service-accounts delete $SAE` (removes its bindings with it).

**Accepted limit — one identity on the VM.** The containers can reach the metadata server, because the backend needs it for Vertex AI, Cloud Storage and Firebase exactly as it does on Cloud Run. So an SSRF/RCE in the backend could use the VM service account, which also holds the deploy-time grants (database password secret, read of the backups bucket, create-only write there). Mitigations in place: per-secret grants only, backups bucket create-only (no overwrite/delete), deploy bucket read-only. Splitting the identities would need a second VM and is not part of this story.
Cloud Build's service account additionally needs `roles/storage.objectAdmin` on `gs://$DEPLOY_BUCKET` (the dev bundle build writes the bundle and `candidates/<sha>.json`, §5 — never `desired.json`, which is written by hand in §7 step 6).

## 3. Database password (new, VM only)

```bash
openssl rand -hex 24 | tr -d '\n' | gcloud secrets create DB_PASSWORD_VM_DEV --project $PROJECT --data-file=-
```
Hex only, no line ending (`tr -d '\n'`): the password is placed inside a connection URL and the tooling refuses anything else. (The deployer takes off ONE trailing line ending, because the first dev run showed the unstripped form is easy to create — `openssl` ends its output with one; a value with more than that, or a space, is still refused.) The value is used the first time the database folder is created;
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

## 5. The bundle of a sha (dev: Cloud Build builds it on every dev deploy)

**Dev.** After the Cloud Run build of a dev deploy has finished, `cloud-build.yml` starts a **second, separate build** (`cloudbuild-vm.yaml`, `gcloud builds submit --async`, tag `vm-bundle`; the workflow run does not wait for it and does not fail if it fails). Its three steps, dev only: `resolve-backend` (digest of `backend:<sha>` from the registry), `build-frontend-vm` (builds and pushes `frontend-vm:<sha>` for amd64 with the Cloud Run build's public values, the baked values checked before the push), `bundle-vm` (`make_bundle.py`, then uploads `gs://$DEPLOY_BUCKET/bundles/<sha>.tgz` and `candidates/<sha>.json` — the `desired.json` that sha would have; the deployer never reads that path). It writes **no** `desired.json`. It is its own build because a step inside the Cloud Run build once took the worker down (build 844cd9a1) — `allowFailure` and step limits do not help against a dead worker. Where to look: `gcloud builds list --filter="tags=vm-bundle"` and `gcloud storage ls gs://$DEPLOY_BUCKET/bundles/ gs://$DEPLOY_BUCKET/candidates/`. A failed build means this sha has no bundle (the next dev deploy makes one).

**By hand** (only if no dev build has produced the sha you need; not on an Apple-silicon Mac). On a machine with the repository at the commit to run:
```bash
SHA=$(git rev-parse HEAD)
BACKEND_IMAGE=<registry>/backend@sha256:…        # the Cloud Build backend image of this sha, by digest
# the VM's frontend image: apps/web/Dockerfile is unchanged, but the API host is baked in at build time, so it is built again with the VM's hosts (needs Docker + python3/PyYAML).
# It is built for linux/amd64 (the VM's architecture). On an Apple-silicon Mac that runs under emulation and takes long (Next.js build, 6 GB heap) — run it in Cloud Shell or on a Linux amd64 machine instead.
# Backend image digest: gcloud artifacts docker images describe asia-northeast3-docker.pkg.dev/$PROJECT/sprintable/backend:$SHA --format='value(image_summary.digest)'   (the sha must be a develop commit whose dev build exists)
# --set values = the public build values of the Cloud Run build of the SAME environment (cloud-build.yml `steps.env`); an empty one is written `NAME=`.
FRONTEND_IMAGE=$(deploy/vm/bin/build-frontend-vm.sh $ENV $SHA <registry>/frontend-vm:$SHA --push \
  --set NEXT_PUBLIC_GA4_MEASUREMENT_ID= --set NEXT_PUBLIC_EE_ENABLED=true --set NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED=true \
  --set NEXT_PUBLIC_SUPPORT_GATEWAY_URL=<the support-gateway URL — a Cloud Run service that stays where it is> --set NEXT_PUBLIC_TOSS_CLIENT_KEY=<dev toss client key> | tail -n1)   # prints <registry>/frontend-vm@sha256:…
python3 deploy/vm/bin/make_bundle.py --sha $SHA --backend-image $BACKEND_IMAGE --frontend-image $FRONTEND_IMAGE --out /tmp/vm-bundle
gcloud storage cp /tmp/vm-bundle/bundles/$SHA.tgz gs://$DEPLOY_BUCKET/bundles/$SHA.tgz     # bundle first …
# … desired.json is put in place in §7 step 1 (the deploy timer stays off until step 6, after the database is restored)
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
Bootstrap enables only Docker: the deploy, backup and restore-check timers are enabled in §7 step 6, after the database is restored. (A VM bootstrapped by the first version of this script has the backup and restore-check timers on: `sudo systemctl disable --now sprintable-backup.timer sprintable-restore-check.timer` until §7 step 6.)

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

7a. Rehearsal (no downtime): dump Cloud SQL dev to a file, restore it on the VM with steps 1, 3, 4 and 5 only (not step 2, and **not step 6**: the application and the timers stay off, or the real restore later would find a running backend and refuse), time each step, compare row counts, then **clean up**: the rehearsal dump is a copy of the whole dev database — `sudo find /srv/sprintable/import -name '*-rehearsal-*' -delete` on the VM (`find` does the matching as root; a `sudo rm` with a `*` would be expanded by your own shell, which cannot read the root-only folder) and, from the PO's machine, `gcloud storage rm "gs://$BACKUPS_BUCKET/import/*-rehearsal-*" --project $PROJECT` (double quotes: the variable must expand, the `*` is gcloud's) (the VM account may create objects there, not delete them). The same after the real move and the soak, for the `-final-` files. On a live database the tables written during the rehearsal differ in the row-count diff — expected; the real run (writers stopped, step 2) must give an empty diff. The restore command of step 5 carries `RESTORE_WIPE=yes` (the database may hold the rehearsal data; on an empty database the variable changes nothing).

**The dump is taken on the VM.** Cloud SQL dev has a private address only (no public IP — found on the first rehearsal attempt), so it can not be reached from a laptop; the VM is in the same VPC. The connection URL goes from the PO's machine to the VM on **standard input** of one ssh command and lives in the memory of `dump-source.sh` only (never in an argument list, a file, the history or the output); the VM account gets **no new permission** (it has no access to the database secrets, by design). Undo: nothing to undo — no grant was made.

1. The private address of the source: `gcloud sql instances describe <dev-instance> --project $PROJECT --format=json | jq -r '.ipAddresses[] | select(.type=="PRIVATE") | .ipAddress'` → `$SRC_IP`. The connection secret is `DATABASE_URL_DIRECT_DEV_SPRINTABLE` (the direct URL, not the pooler's); its value is read by the PO's own account.
   Once per VM, before the first dump: put the version to run in place and start only the database — `gcloud storage cp gs://$DEPLOY_BUCKET/candidates/$SHA.json gs://$DEPLOY_BUCKET/desired.json --project $PROJECT` (the sha of a dev build whose steps in §5 succeeded; with a hand-built bundle instead: `gcloud storage cp /tmp/vm-bundle/desired.json gs://$DEPLOY_BUCKET/desired.json --project $PROJECT`; the deploy timer is still off, so nothing deploys), then on the VM `sudo python3 /opt/sprintable/bin/deployer.py --db-only` (it needs a `desired.json` to know the release, and starts the database container and nothing else).
2. Stop writes: close the public door of the Cloud Run dev backend (`--max-instances 0` is not allowed — the minimum is 1) and pause the scheduler jobs that call it.
   `gcloud run services update sprintable-backend-dev --project $PROJECT --region $REGION --ingress internal` — then check from outside: `curl -s -o /dev/null -w '%{http_code}\n' https://<the Cloud Run backend address>/api/v2/health` must NOT print 200.
   **The ingress flag alone does not stop every writer:** Cloud Run's internal ingress also admits traffic from the same project's network (this VM included), and a request already in flight finishes. So (a) if the temporary front door of §7c runs, stop it first (`sudo /opt/sprintable/bin/front-door.sh stop`); (b) the Cloud Run frontend (`sprintable-frontend-dev`) and the hosted MCP (`sprintable-mcp-dev`) are same-project callers of the backend and write through it: close them for the dump too (`gcloud run services update <service> --project $PROJECT --region $REGION --ingress internal`; undo `--ingress all`); (c) wait out the longest request (the backend's request timeout) and then show in the Cloud Run request log that **no request other than the health check** arrived during the last minutes — the scheduler's cron endpoints are GET requests and still write, so «no POST» proves nothing; a non-200 from outside proves only the outside is closed.
   `gcloud scheduler jobs list --project $PROJECT --location $REGION` → `gcloud scheduler jobs pause <job> --project $PROJECT --location $REGION` for each job that targets the backend (note them).
   Undo: `gcloud run services update <service> --project $PROJECT --region $REGION --ingress all` for **each service closed above** (`sprintable-backend-dev`, `sprintable-frontend-dev`, `sprintable-mcp-dev`) and `gcloud scheduler jobs resume <job> --project $PROJECT --location $REGION` for each paused job. After a successful move the hosted MCP is reopened once its backend URL has been changed (§9, §7c); the backend and the frontend stay closed during the soak as the way back.
3. Dump and count **on the VM** (the database container must be up — the `--db-only` of step 1; `dump-source.sh` is installed by bootstrap, or `sudo install -m 0755` it from a bundle into `/opt/sprintable/bin/`):
   `gcloud secrets versions access latest --secret=DATABASE_URL_DIRECT_DEV_SPRINTABLE --project $PROJECT | gcloud compute ssh $VM --project $PROJECT --zone $ZONE --tunnel-through-iap --ssh-flag=-T --command "sudo /opt/sprintable/bin/dump-source.sh --host $SRC_IP --label rehearsal --upload"`
   (`--ssh-flag=-T`: no terminal, so the URL travels on the pipe; the script refuses a terminal on purpose. Use `--label final` for the real run.) It takes the row counts, dumps with a throw-away container of the VM database's own image (same Postgres major), checks the dump lists table data, writes the checksum, and with `--upload` copies dump, checksum and counts to `gs://$BACKUPS_BUCKET/import/` (created only (`--no-clobber`); file names carry the time and the process id, and an existing name is never reused). It prints seconds per step, the size, and the paths under `/srv/sprintable/import/` (`<env>-<label>-<time>-<pid>.dump` · `.dump.sha256` · `.counts.tsv`).
4. Nothing to do: the checksum sidecar and the upload were part of step 3 (`restore.sh` verifies a `gs://` source against the sidecar; a local file on the data disk needs no copy).
5. On the VM, restore from the file step 3 printed (the database container is already up from step 1):
   `sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh /srv/sprintable/import/<env>-<label>-<time>-<pid>.dump > counts-vm.tsv` and `sudo bash -c 'diff /srv/sprintable/import/<env>-<label>-<time>-<pid>.counts.tsv <(grep -P "^\S+\t\d+$" counts-vm.tsv)'` (the import folder is root-only; `sudo` closes the descriptor a bare `<(…)` would hand over, so the whole line runs under `bash -c`) — **empty diff = row counts equal** (writers stopped; see 7a for a rehearsal). restore.sh prints "restore done in N s".
6. Enable the deployer (`desired.json` is already in place from step 1; to run another version copy its `candidates/<sha>.json` over `desired.json` first) **and the two database timers** (they wait for the restored database — bootstrap leaves them off, a backup run before the restore would fail every night): `sudo systemctl enable --now sprintable-deploy.timer sprintable-backup.timer sprintable-restore-check.timer`. Watch `journalctl -u sprintable-deploy -f` and the newest object under `gs://$BACKUPS_BUCKET/status/dev/`: states go `deploying → deployed` (migrate runs before the swap).

Undo of the move as a whole: nothing was deleted from Cloud SQL — scale Cloud Run back up (step 2 undo) and leave DNS where it is (§8 is a separate step).

## 7c. Dev cutover in three phases — the front door first (PO decision 2026-10-27)

Why: the data move takes minutes, but moving every client (lane agents' MCP, the Electron app's stored addresses, GitHub/Polar/GA4 registrations, the scheduler, the connectors) takes people and days. So the clients move first, to the VM's address, while the VM still hands everything on to Cloud Run; the data move comes last and only flips where the VM hands requests to. In front of `dev-app` / `dev-api` / `dev-mcp` there are Cloudflare Worker routes (`sprintable-dev-app-proxy`, `sprintable-dev-api-proxy`, `sprintable-mcp-dev-proxy`) with `run.app` addresses written into them: changing a record's content does nothing while its route exists — a route has to be deleted (or retargeted) in the same step.

**Phase 1 — `dev-api` to the VM, data still on Cloud SQL (users notice nothing; `dev-app` and `dev-mcp` stay as they are).**
1. Cloudflare, in this order, after writing the old values down (`dns-before-cutover.json`): (a) delete the route `sprintable-dev-api-proxy`; (b) change the record `dev-api` to **A → the VM address, DNS only, TTL 60**; (c) **wait until two public resolvers agree** — `dig +short dev-api.sprintable.ai @1.1.1.1` and `dig +short dev-api.sprintable.ai @8.8.8.8` print only the VM address (no CNAME, no Cloudflare address) — before step 2: the certificate check of the front door otherwise sees the old answer and fails.
2. On the VM, if the rehearsal left the stack up (the front door refuses to start next to the stack's Caddy): `sudo systemctl disable --now sprintable-deploy.timer sprintable-backup.timer sprintable-restore-check.timer`, `sudo systemctl stop sprintable-deploy.service` (a deploy already running could bring the stack's Caddy back for up to its two-hour limit) and `sudo docker stop sprintable-caddy-1 sprintable-backend-1 sprintable-frontend-1`. Then at once: `sudo /opt/sprintable/bin/front-door.sh passthrough --host dev-api.sprintable.ai --upstream https://sprintable-backend-dev-787818285179.asia-northeast3.run.app` (checks the address, validates the Caddyfile, starts one Caddy container; it refuses to run while the stack's own Caddy runs; the certificate is requested now and is stored in the stack's Caddy folder). `sudo /opt/sprintable/bin/front-door.sh status` shows what it points at.
3. Measure: the seconds until the first 200 — `while :; do date +%T; curl -sS -o /dev/null -w '%{http_code}\n' https://dev-api.sprintable.ai/api/v2/health; sleep 1; done`; an event stream held open for 10 minutes (`curl -N … /api/v2/events/stream?member_id=…`) compared with the same call to the `run.app` address (gaps, buffering); the §8 «which address does the backend count» test (429 at the limit, forged X-Forwarded-For ignored) — **through this front door**: Cloud Run now sees the VM as its caller, so a shared bucket for everyone must be ruled out here.
   Undo: `sudo /opt/sprintable/bin/front-door.sh stop`; recreate the route; put the saved `dev-api` CNAME (proxied) back.

**Phase 2 — move the guests to `dev-api.sprintable.ai`, one at a time, each undoable** (people; Cloud Run's request log shows what still arrives at `run.app` directly — the end is «zero»): the Electron app's stored `api_url` / `mcp_url` (the server's `FASTAPI_URL` is the source; the desktop story refreshes stored addresses on connect) · the GitHub App callback and webhook · the GA4 redirect URI and `BACKEND_URL` · the Polar webhook · the Cloud Scheduler targets (§9 (4): the `apply-cloud-scheduler` step follows the one switch of §9, or the jobs are moved by hand with `infra/apply_cloud_scheduler.py --base-url`; the jobs stay paused while they are closed for the dump) · the hosted MCP's `SPRINTABLE_API_URL` (§9 (3)) · the support gateway's `SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL` (derived from `_FASTAPI_URL` by the dev pipeline: it follows the one switch of §9) · the connectors' default address (the old `…-57iommnikq-du.a.run.app` form). The phone app needs nothing (it talks to `dev-app` only). Login callbacks (Google, Apple, channel OAuth) are on the app domain and do not change.

**Phase 3 — the data move (the only part with downtime).** Preconditions: the rehearsal of §7a done, `desired.json` in place, the VM database restored once, the three timers off (`sudo systemctl disable --now sprintable-deploy.timer sprintable-backup.timer sprintable-restore-check.timer`, and no deploy running: `sudo systemctl stop sprintable-deploy.service`), the one switch of §9 flipped and the Cloud Run request log free of lane traffic at the old `run.app` address (every lane Mac has the 4801 app version and has connected once), the private plain file's `L2_TRIGGER_ENABLED` back to its live value after the rehearsal, and **the private plain file made again from the live dev services after the latest dev deploy** (story 4798 AC15: the admin screens moved to `run-admin-ui-dev` and the backend's `ADMIN_OPERATOR_ALLOWLIST` is a single address since #5296 — an export taken earlier would give the VM the old value; ask the security owner whether the admin tool's token audience still matches the declared `ADMIN_OPERATOR_AUDIENCE`).
1. **Stop the writers — the front door first.** `sudo /opt/sprintable/bin/front-door.sh stop` (it is the only way `dev-api` clients reach Cloud Run; from here they get «connection refused»). Do not rely on `--ingress internal` alone: Cloud Run's internal ingress also admits traffic from the same project's network, which includes this VM. Then Cloud Run `--ingress internal` + pause the scheduler jobs (§7 step 2) to cut every other caller. `dev-app` (the Cloud Run frontend `sprintable-frontend-dev`) and the hosted MCP (`sprintable-mcp-dev`) stay on Cloud Run until step 5 and are same-project callers of the backend: close them too for the dump (`gcloud run services update sprintable-frontend-dev --project $PROJECT --region $REGION --ingress internal`, the same for `sprintable-mcp-dev` **and `support-gateway-dev`**; undo `--ingress all`). The support gateway mounts the Cloud SQL instance and posts escalation events to the backend (`SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL`); whether its own tables are part of the dump is not verified here — check that first (`pg_restore --list` of the rehearsal dump, or the gateway's database name), and close it either way. Then **check from outside** that `https://<backend>.run.app/api/v2/health` no longer answers 200 and that the Cloud Run request log shows no writes any more.
2. `sudo docker stop sprintable-backend-1 sprintable-frontend-1` (restore.sh refuses with a running backend).
3. Final dump (§7 step 3 with `--label final`) and restore — `sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh <the final dump>` (the rehearsal left tables behind; §7 step 5 has the whole command with the row-count diff): the diff must be **empty** (writers are stopped).
4. `sudo python3 /opt/sprintable/bin/deployer.py --force` — the stack's own Caddy starts on the same certificate folder as the front door used, so no new certificate is needed for `dev-api`.
5. Checks from inside, then from outside (`/api/v2/health`, login, a stream). `dev-app`: delete the route `sprintable-dev-app-proxy` and point the record at the VM (A, proxied; Cloudflare SSL mode for this host must allow the origin certificate) — the VM's own frontend (the `frontend-vm` image) takes over the UI; `dev-mcp` stays on Cloud Run: its `SPRINTABLE_API_URL` is `https://dev-api.sprintable.ai` already if Phase 2 did §9 (3) (check with `gcloud run services describe sprintable-mcp-dev --project $PROJECT --region $REGION`; the dev pipeline writes it from the one switch of §9) and **reopen it** — `gcloud run services update sprintable-mcp-dev --project $PROJECT --region $REGION --ingress all` (it was closed for the dump; its Cloudflare route needs it open), and reopen `support-gateway-dev` the same way once its `SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL` names `https://dev-api.sprintable.ai/api/v2/support/escalation-events` (the dev pipeline derives it from `_FASTAPI_URL` on every deploy, like the scheduler and the hosted MCP address: it follows the one switch of §9).
6. The scheduler jobs: check their targets (`gcloud scheduler jobs describe <job> --project $PROJECT --location $REGION` shows `https://dev-api.sprintable.ai/…`; if not, `CLOUDSDK_CORE_PROJECT=$PROJECT python3 infra/apply_cloud_scheduler.py --env dev --base-url https://dev-api.sprintable.ai --apply`), then resume the jobs paused in step 1 (`gcloud scheduler jobs resume <job> --project $PROJECT --location $REGION`) — otherwise the scheduled work stops for good. Enable the timers (§7 step 6). `sprintable-frontend-dev` and `sprintable-backend-dev` stay closed (`--ingress internal`) for the soak: they are the way back. One day of soak, then §10.
   **Undo (before §10):** the stack's Caddy occupies ports 80/443 and the front door refuses to start next to it, so first `sudo systemctl disable --now sprintable-deploy.timer` and `sudo systemctl stop sprintable-deploy.service` (a deploy already running would start the stack's Caddy again), then `sudo docker stop sprintable-caddy-1 sprintable-backend-1 sprintable-frontend-1`; then `sudo /opt/sprintable/bin/front-door.sh passthrough --host dev-api.sprintable.ai --upstream <the Cloud Run backend>`; Cloud Run `--ingress all` (backend, `sprintable-frontend-dev`, `sprintable-mcp-dev`, `support-gateway-dev`) + resume the scheduler jobs; `dev-app` back to its route/CNAME. Writes made on the VM after the restore are not in Cloud SQL: a rollback after real use is a move back, not an undo.

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

The list of code and configuration places is in the story evidence (`run.app consumers`).

**The one switch (story 4796; the desktop story 4801 AC1 asks for it in writing).** The dev pipeline has exactly one line for the backend's address: `echo "fastapi_url=…"` in the dev branch of `.github/workflows/cloud-build.yml`. It feeds `_FASTAPI_URL`, which sets: the backend's `FASTAPI_URL` (the desktop setup's `exchange_urls()` hands it to the Mac app as `api_url`; the app refreshes its stored address from it when it connects — story 4801), the baked `NEXT_PUBLIC_FASTAPI_URL` of the Cloud Run frontend, the hosted MCP's `SPRINTABLE_API_URL`, the support gateway's escalation URL, and the Cloud Scheduler jobs' address (the `apply-cloud-scheduler` step passes `--base-url` when the value is `https://dev-api.sprintable.ai`). It does **not** set `_BACKEND_URL` (the GA4 redirect, its own line) or `MCP_PUBLIC_URL` (the clean MCP domain). The line is changed to `https://dev-api.sprintable.ai` in one small pull request **after Phase 1 is measured and before the guests are moved**; the next dev deploy then moves all of the above together. Order condition (story 4801 AC1): the old Cloud Run address keeps answering until every lane Mac has heard the new one (the 4801 app version installed, each Mac connected once) — Phase 3 closes the Cloud Run backend only when its request log shows no lane traffic any more.

Order of work: (1) VM frontend image built with `NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai`
(the frontend bakes this at build time; Cloud Build builds a second image `frontend-vm` for it); (2) every lane Mac's MCP `SPRINTABLE_API_URL`; (3) the services that carry the backend address as a setting: the hosted MCP's variable is **`SPRINTABLE_API_URL`** of `sprintable-mcp-dev` (`gcloud run services update sprintable-mcp-dev --project $PROJECT --region $REGION --update-env-vars SPRINTABLE_API_URL=https://dev-api.sprintable.ai`; the dev pipeline writes it from `fastapi_url` of `cloud-build.yml` on every dev deploy, so the one switch above moves it; a hand edit alone is overwritten by the next deploy), the support gateway's and the others' own variables (Dan's list); (4) the Cloud Scheduler jobs: `CLOUDSDK_CORE_PROJECT=$PROJECT python3 infra/apply_cloud_scheduler.py --env dev --base-url https://dev-api.sprintable.ai` (dry run; the tool calls gcloud without `--project`, so the environment variable names it) and the same with `--apply` — the jobs call the address they are given, and the dev pipeline's `apply-cloud-scheduler` step applies them on every dev deploy and now follows the same switch (it passes `--base-url` when `_FASTAPI_URL` is the dev API name; with the Cloud Run address it passes nothing, as before), so the manual `--apply` only moves the jobs earlier than the next dev deploy; (5) GCS CORS files; (6) login consoles and integration callbacks (Dan's list) — those are changed **at the DNS switch**, not before.

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
