#!/usr/bin/env bash
# story 4798 (AC14): the ONLY way the setup scripts hand out access to a secret — one secret at a time, never a project-wide role.
#
# usage:  bash backend/scripts/grant_secret_access.sh <dev|prod|ci> <SECRET_NAME> [<SECRET_NAME> ...]
#   dev | prod  → the Cloud Run runtime account of that environment (cloudrun-runtime-<env>)
#   ci          → the CI deploy account (github-actions)
# Each named secret must exist. A grant is `secrets add-iam-policy-binding <secret>` (roles/secretmanager.secretAccessor); it is safe to run twice.
# (A project-level `secretAccessor` lets one account read every secret of the project, both environments — it must not be handed out; a test fails on it.)
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-sprintable-494803}"
TARGET="${1:-}"
[ "$#" -ge 2 ] || { echo "usage: $0 <dev|prod|ci> <SECRET_NAME> [<SECRET_NAME> ...]" >&2; exit 2; }
shift
case "${TARGET}" in
    dev|prod) MEMBER="serviceAccount:cloudrun-runtime-${TARGET}@${GCP_PROJECT}.iam.gserviceaccount.com" ;;
    ci)       MEMBER="serviceAccount:github-actions@${GCP_PROJECT}.iam.gserviceaccount.com" ;;
    *) echo "target must be dev, prod or ci" >&2; exit 2 ;;
esac
for SECRET in "$@"; do
    [[ "${SECRET}" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || { echo "not a secret name: ${SECRET}" >&2; exit 2; }
done
for SECRET in "$@"; do
    gcloud secrets describe "${SECRET}" --project="${GCP_PROJECT}" > /dev/null
    gcloud secrets add-iam-policy-binding "${SECRET}" --project="${GCP_PROJECT}" \
        --member="${MEMBER}" --role="roles/secretmanager.secretAccessor" --quiet > /dev/null
    echo "granted ${SECRET} to ${MEMBER#serviceAccount:}"
done
