# deploy/vm — one VM per environment (story 4796)

Everything needed to run an environment (database, backend, frontend, front door) on one Compute Engine VM, and to deploy to it without a person.
Design and reasons: `docs/infra/vm-hosting-design-4796.md` (PR #5259 — it lands with that PR; until then read it on its branch). Hands-on steps (gcloud, DNS, cutover, rollback): `RUNBOOK.md`.

| Path | What it is |
|---|---|
| `compose.yml` | db (pgvector/pg15), migrate (one-shot), backend, frontend, caddy. Only caddy publishes ports (80, 443). |
| `Caddyfile` | front door: TLS, `api`/`realtime` hosts → backend (no buffering, no compression), `app` host → frontend. |
| `env/<environment>.yaml` | names only: which live variable is carried, overridden, computed, read from a secret, or dropped (with the reason). `live-names.<environment>.txt` is the export of the live service the tests compare against. |
| `bin/render_env.py` | builds the service environments (private plain file < overrides < computed < Secret Manager) and the compose pass-through file (names only). |
| `bin/deployer.py` | the pull-based deployer a systemd timer runs every minute: bundle → environment → pull → migrate → swap → health → rollback → status. |
| `bin/check_live_names.py` | Before a cutover: compares the live service's variable names (and which are secrets) with the copy the declaration was made from. |
| `bin/bootstrap.sh` | one-time VM preparation (Docker, data disk, swap, Ops Agent, units). |
| `bin/backup.sh` `restore.sh` `restore-check.sh` `rowcounts.sh` | daily dump to Cloud Storage; restore; scratch-restore check with timing; row counts for the before/after comparison. |
| `systemd/` | units and timers for the deployer, the backup and the weekly restore check. |

Rules that hold everywhere in this folder:

- No secret value and no private plain value is written in this repository, in a file the deployer creates, in a log or in the status it uploads. Names only.
- `SPRINTABLE_LOCAL_DEV` and `K_SERVICE` are never set on a VM (`render_env.py` refuses them; a test pins it).
- The VM can read the deploy bucket but not write to it; it writes its status to the backups bucket.
- A change to the deployer, `render_env.py`, the units or `bootstrap.sh` takes effect when `bootstrap.sh` is run again from the new bundle (RUNBOOK §6). A change to `Caddyfile` or `env/*.yaml` deploys by itself with the next version. A change to `compose.yml` does not: the deployer only accepts a `compose.yml` identical to the copy `bootstrap.sh` installed, so it takes a bootstrap run (a human step).
