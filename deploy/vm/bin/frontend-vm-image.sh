#!/usr/bin/env bash
# frontend-vm-image.sh <environment> <git-sha> <image-name> [--set NAME=VALUE]...   (story 4805; run from the repository root, in the build step of cloudbuild-vm.yaml)
# <image-name> is the repository path without a tag (…/frontend-vm). It pushes <image-name>:<sha> and prints its digest reference (`<image-name>@sha256:…`) as the LAST line.
#
# The Next.js build is most of the minutes of a dev dispatch, and the frontend did not change in most of them. So:
#   • input id (frontend_input_id.py) = the frontend's sources, base image digests, build values and build scripts. Equal id ⇒ the same frontend.
#   • if the registry has `<image-name>:<input id>` — an image an earlier FULL build made from that id and checked — the new image is that image with the commit and the build time put on
#     top again (deploy/vm/frontend-restamp/Dockerfile): the same as the last layers of apps/web/Dockerfile, so /api/health still names the commit.
#   • otherwise — no id (an unpinned base image, an uncounted COPY source), no such image, a pull or a restamp that fails — it is the full build of build-frontend-vm.sh, as before; after its
#     checks passed and the image is pushed, the image also gets the input id as a tag.
# Every doubt ends in the full build. The input-id tag is only ever put on an image a full build made.
# One line per build says which it was, for the re-measurement of the story (Cloud Logging, text payload of the build):  `frontend-vm-reuse: reused <input id>`  or  `frontend-vm-reuse: built <input id | none>`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
[ "$#" -ge 3 ] || { echo "usage: $0 <environment> <git-sha> <image-name> [--set NAME=VALUE]..." >&2; exit 2; }
env_name="$1"; sha="$2"; name="$3"; shift 3
sets=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --set) [ "$#" -ge 2 ] || { echo "--set needs NAME=VALUE" >&2; exit 2; }; sets+=(--set "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "the sha must be 7 to 40 lower-case hex characters (what /api/health of the frontend reads as a commit)" >&2; exit 2; }
# is_ref <text>: exactly `<image-name>@sha256:<64 hex>`
is_ref() { [ "${1%@*}" = "$name" ] && [[ "${1#*@}" =~ ^sha256:[0-9a-f]{64}$ ]]; }

# one image, by digest reference, as the last line of the build log (the form desired.json needs)
ref_of() { docker image inspect --format '{{index .RepoDigests 0}}' "$1"; }

restamp() { # restamp <input id> → pushes <name>:<sha> made from the earlier image; any failure returns 1 (the caller builds in full)
  local id="$1" base stamped built
  docker pull --platform linux/amd64 "$name:$id" > /dev/null 2>&1 || { echo "frontend-vm-image: no earlier image for $id"; return 1; }
  base="$(ref_of "$name:$id")" || return 1
  is_ref "$base" || { echo "frontend-vm-image: the earlier image has no digest reference («$base»)"; return 1; }
  echo "frontend-vm-image: the frontend inputs are the same as in $base ($id) — putting the commit on top"
  docker build --platform linux/amd64 -f "$root/deploy/vm/frontend-restamp/Dockerfile" --build-arg "BASE=$base" --build-arg "APP_COMMIT_SHA=$sha" -t "$name:$sha" "$root/deploy/vm/frontend-restamp" || return 1
  # what /api/health reads: the commit in the environment and a build time in the file
  stamped="$(docker run --rm --entrypoint sh "$name:$sha" -c 'printf %s "$APP_COMMIT_SHA"')" || return 1
  built="$(docker run --rm --entrypoint sh "$name:$sha" -c 'test -s /app/.build_time && echo yes')" || return 1
  [ "$stamped" = "$sha" ] && [ "$(printf '%s' "$built" | tr -d '[:space:]')" = yes ] || { echo "frontend-vm-image: the restamped image does not carry the commit (got «$stamped»)"; return 1; }
  docker push "$name:$sha" || return 1
  ref_of "$name:$sha"
}

id=""
if out="$(python3 "$here/frontend_input_id.py" "$here/../env/$env_name.yaml" --root "$root" ${sets[@]+"${sets[@]}"})" && [[ "$out" =~ ^inputs-[0-9a-f]{32}$ ]]; then
  id="$out"
else
  echo "frontend-vm-image: no input id — full build"
fi

if [ -n "$id" ] && ref="$(restamp "$id" | tee /dev/stderr | tail -n 1)" && is_ref "$ref"; then
  echo "frontend-vm-reuse: reused $id"
  printf '%s\n' "$ref"
  exit 0
fi
echo "frontend-vm-reuse: built ${id:-none}"

log="$(mktemp)"
bash "$here/build-frontend-vm.sh" "$env_name" "$sha" "$name:$sha" --push ${sets[@]+"${sets[@]}"} | tee "$log"
ref="$(tail -n 1 "$log")"
is_ref "$ref" || { echo "frontend-vm-image: the last line of the build is not a digest reference of $name: «$ref»" >&2; exit 1; }
if [ -n "$id" ]; then
  # best effort: a failure here only means the next build is in full again
  { docker tag "$name:$sha" "$name:$id" && docker push "$name:$id"; } > /dev/null || echo "frontend-vm-image: could not tag $id (the next build will be in full)" >&2
fi
printf '%s\n' "$ref"
