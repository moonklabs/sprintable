#!/usr/bin/env bash
# story 4798 (AC14): the ONLY way the setup scripts hand out access to a secret — one secret at a time, never a project-wide role.
#
# usage:  bash backend/scripts/grant_secret_access.sh <dev|prod|ci|migrate-prod|mcp-prod> <SECRET_NAME> [<SECRET_NAME> ...]
#   dev | prod   → the Cloud Run runtime account of that environment (cloudrun-runtime-<env>)
#   ci           → the CI deploy account (github-actions, or $SA_NAME)
#   migrate-prod → the prod database jobs' account (run-migrate-prod)
#   mcp-prod     → the prod MCP service's account (run-mcp-prod)
# Each named secret must exist. A grant is `secrets add-iam-policy-binding <secret>` (roles/secretmanager.secretAccessor); it is safe to run twice.
# (A project-level `secretAccessor` lets one account read every secret of the project, both environments — it must not be handed out; a test fails on it.)
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
CI_SA_NAME="${SA_NAME:-github-actions}"  # the same variable and default as setup_workload_identity.sh
TARGET="${1:-}"
[ "$#" -ge 2 ] || { echo "usage: $0 <dev|prod|ci|migrate-prod|mcp-prod> <SECRET_NAME> [<SECRET_NAME> ...]" >&2; exit 2; }
shift
case "${TARGET}" in
    dev|prod) MEMBER="serviceAccount:cloudrun-runtime-${TARGET}@${GCP_PROJECT}.iam.gserviceaccount.com" ;;
    ci)       MEMBER="serviceAccount:${CI_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com" ;;
    migrate-prod) MEMBER="serviceAccount:run-migrate-prod@${GCP_PROJECT}.iam.gserviceaccount.com" ;;  # story 4798 (AC7): the prod database jobs
    mcp-prod)     MEMBER="serviceAccount:run-mcp-prod@${GCP_PROJECT}.iam.gserviceaccount.com" ;;      # story 4798 (AC7): the prod MCP service
    *) echo "target must be dev, prod, ci, migrate-prod or mcp-prod" >&2; exit 2 ;;
esac
# a name starts with a letter, digit or underscore (never `-`: it would be read as an option), then letters, digits, `_` or `-`
for SECRET in "$@"; do
    [[ "${SECRET}" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$ ]] || { echo "not a secret name: ${SECRET}" >&2; exit 2; }
done
# every secret must exist BEFORE anything is granted: a typo in the last name must not leave the first ones granted
for SECRET in "$@"; do
    gcloud secrets describe "${SECRET}" --project="${GCP_PROJECT}" > /dev/null || { echo "secret not found: ${SECRET} — nothing was granted" >&2; exit 1; }
done
for SECRET in "$@"; do
    gcloud secrets add-iam-policy-binding "${SECRET}" --project="${GCP_PROJECT}" \
        --member="${MEMBER}" --role="roles/secretmanager.secretAccessor" --quiet > /dev/null || { echo "grant failed for ${SECRET} (secrets granted before it stay granted; run again — it is safe to repeat)" >&2; exit 1; }
    echo "granted ${SECRET} to ${MEMBER#serviceAccount:}"
done
