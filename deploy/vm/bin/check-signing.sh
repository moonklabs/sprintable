#!/usr/bin/env bash
# story 4869 — can THIS VM's service account sign as itself? Run on the VM (bootstrap.sh runs it last; re-run by hand: `sudo /opt/sprintable/bin/check-signing.sh`).
#
# Why: the backend (and the frontend) make V4 signed URLs for attachment previews / file opening with the VM account's metadata credentials and NO key file. That calls IAM signBlob on the
# account's own name, which needs `roles/iam.serviceAccountTokenCreator` granted to the account ON ITSELF (RUNBOOK §2). Without it every /api/attachments/sign answers 400 «Permission
# 'iam.serviceAccounts.signBlob' denied» and every picture / file in a chat stops opening (11-09: dev and prod, since the move from Cloud Run). Nothing else shows it at setup time — so the setup asks once.
#
# Every curl call is made with -q (no ~/.curlrc) and --noproxy '*' (an http_proxy / https_proxy / all_proxy in root's environment must not be able to receive the bearer header): this check talks to the metadata server and to Google directly or it reports «no answer».
# One signBlob call with a fixed harmless payload; exit 0 only on HTTP 200. The bearer token is passed on standard input (never in an argument list) and is never printed.
# IAM grants take up to a minute to reach every endpoint: a refusal is retried SIGNING_CHECK_TRIES times (default 6) SIGNING_CHECK_WAIT seconds apart (default 10) before it is called a failure.
# Exit codes: 0 signed · 1 refused or no answer (the message says which) · 2 the metadata server could not be read (not on a GCE VM?), or the settings are refused (bad count/wait, a URL override that is not loopback).
set -uo pipefail

# curl writes TLS session secrets to the file named by SSLKEYLOGFILE (with them a recorded HTTPS exchange, bearer header included, can be read back): not for this check
unset SSLKEYLOGFILE
md="${SIGNING_CHECK_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1}"
iam="${SIGNING_CHECK_IAM_URL:-https://iamcredentials.googleapis.com}"
tries="${SIGNING_CHECK_TRIES-6}"
wait_s="${SIGNING_CHECK_WAIT-10}"

# The URLs can be overridden for a test, and ONLY to this machine's own loopback address: the bearer token goes wherever they point, so an environment that names another host is refused, not obeyed.
for u in "${SIGNING_CHECK_METADATA_URL:-}" "${SIGNING_CHECK_IAM_URL:-}"; do
  case "$u" in
    *@*) echo "SIGNING CHECK: refusing a SIGNING_CHECK_*_URL override with a user-info part (http://127.0.0.1:80@host is host 'host')" >&2; exit 2 ;;
    '' | http://127.0.0.1[:/]* | http://localhost[:/]*) ;;
    *) echo "SIGNING CHECK: refusing a SIGNING_CHECK_*_URL override that is not this machine's loopback address (the VM's token would be sent there)" >&2; exit 2 ;;
  esac
done
# A retry count that is not a whole number >= 1, or a wait that is not a whole number, is a refusal to run (never an endless loop, never a silent single try).
case "$tries" in '' | *[!0-9]* | 0) echo "SIGNING CHECK: SIGNING_CHECK_TRIES must be a whole number >= 1 (got '$tries')" >&2; exit 2 ;; esac
case "$wait_s" in '' | *[!0-9]*) echo "SIGNING CHECK: SIGNING_CHECK_WAIT must be a whole number of seconds (got '$wait_s')" >&2; exit 2 ;; esac

sa="$(curl -q --noproxy '*' -fsS -m 10 -H 'Metadata-Flavor: Google' "$md/instance/service-accounts/default/email" 2> /dev/null)" || sa=""
if [ -z "$sa" ]; then
  echo "SIGNING CHECK: could not read this VM's service account from the metadata server (is this a GCE VM?)" >&2
  exit 2
fi

attempt=1
code=000
body=""
while :; do
  token_json="$(curl -q --noproxy '*' -fsS -m 10 -H 'Metadata-Flavor: Google' "$md/instance/service-accounts/default/token" 2> /dev/null)" || token_json=""
  token="$(printf '%s' "$token_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' 2> /dev/null)" || token=""
  if [ -n "$token" ]; then
    out="$(printf 'Authorization: Bearer %s\n' "$token" | curl -q --noproxy '*' -sS -m 20 -w '\n%{http_code}' -X POST -H @- -H 'Content-Type: application/json' \
      -d '{"payload":"c2lnbmluZy1jaGVjaw=="}' "$iam/v1/projects/-/serviceAccounts/$sa:signBlob" 2> /dev/null)" || out=""
    code="$(printf '%s' "$out" | tail -n 1)"
    case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac   # the transfer failed outright (no network · DNS · TLS) = «no answer», not an empty code
    body="$(printf '%s' "$out" | sed '$d' | head -c 300)"
  else
    code=000
    body="no access token from the metadata server"
  fi
  [ "$code" = 200 ] && break
  [ "$attempt" -ge "$tries" ] && break
  attempt=$((attempt + 1))
  sleep "$wait_s"
done

if [ "$code" = 200 ]; then
  echo "signing check: $sa can sign as itself (signBlob 200) — attachment previews and file opening work"
  exit 0
fi

{
  if [ "$code" = 000 ]; then
    echo "SIGNING CHECK FAILED: no answer from the IAM API for $sa after $attempt tries (network, DNS or TLS — or no access token)."
  else
    echo "SIGNING CHECK FAILED: $sa cannot sign as itself (signBlob answered HTTP $code after $attempt tries)."
  fi
  echo "  Attachment previews and file opening (/api/attachments/sign) are BLOCKED for everyone until this is fixed."
  [ -n "$body" ] && echo "  answer: $body"
  echo "  Fix, from a machine with gcloud (RUNBOOK §2 — on this account only, never project-wide):"
  echo "    gcloud iam service-accounts add-iam-policy-binding $sa --member serviceAccount:$sa --role roles/iam.serviceAccountTokenCreator"
  echo "  then run this check again: sudo /opt/sprintable/bin/check-signing.sh"
} >&2
exit 1
