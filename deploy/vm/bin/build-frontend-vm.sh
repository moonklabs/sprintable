#!/usr/bin/env bash
# build-frontend-vm.sh <environment> <git-sha> <image-ref> [--push] [--set NAME=VALUE]...
# Builds the VM's frontend image from apps/web/Dockerfile (unchanged) with the VM's API/app hosts baked in, then checks what was baked before anything is pushed:
#   • the VM API host is inside the build output, and no Cloud Run (run.app) backend/frontend address is.
# With --push it pushes and prints the digest reference (`<image>@sha256:…`) — the form desired.json needs. Run from the repository root.
# The --set values are the public build values of the Cloud Run build of the same environment (see frontend_build_args.py).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$#" -ge 3 ] || { echo "usage: $0 <environment> <git-sha> <image-ref> [--push] [--set NAME=VALUE]..." >&2; exit 2; }
env_name="$1"; sha="$2"; image="$3"; shift 3
push=no
sets=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --push) push=yes; shift ;;
    --set) [ "$#" -ge 2 ] || { echo "--set needs NAME=VALUE" >&2; exit 2; }; sets+=(--set "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
decl="$here/../env/$env_name.yaml"
[ -f "$decl" ] || { echo "no declaration for $env_name" >&2; exit 2; }

pairs=()
while IFS= read -r line; do pairs+=("$line"); done < <(python3 "$here/frontend_build_args.py" "$decl" --sha "$sha" ${sets[@]+"${sets[@]}"})
[ "${#pairs[@]}" -gt 0 ] || exit 2
# the VM is an amd64 machine: build for it explicitly (on an Apple-silicon Mac this runs under emulation and is slow — run it in Cloud Shell or on the VM instead)
build=(docker build --platform linux/amd64 --no-cache -f apps/web/Dockerfile -t "$image")
api=""
for p in "${pairs[@]}"; do
  build+=(--build-arg "$p")
  case "$p" in NEXT_PUBLIC_FASTAPI_URL=*) api="${p#*=}" ;; esac
done
DOCKER_BUILDKIT=1 "${build[@]}" .

echo "== checking what was baked"
# Every check is a container command that ALWAYS ends 0 and prints a number: a docker/grep failure is then an error of the check (stop), never mistaken for «nothing found».
inspect() { # inspect <shell command run inside the image> → prints its output; any failure stops the script before a push
  local out
  out="$(docker run --rm --entrypoint sh -e VM_API="$api" "$image" -c "$1")" || { echo "could not inspect the image (docker run failed)" >&2; exit 1; }
  printf '%s' "$out" | tr -d '[:space:]'
}
# shellcheck disable=SC2016  # expands inside the container
baked="$(inspect 'grep -rlF "$VM_API" /app/apps/web/.next | wc -l')"
[[ "$baked" =~ ^[0-9]+$ ]] || { echo "unexpected answer from the image check: «$baked»" >&2; exit 1; }
[ "$baked" -ge 1 ] || { echo "the VM API address ($api) is not in the build output" >&2; exit 1; }
stale="$(inspect "grep -rlE 'sprintable-(backend|frontend)-(dev|prod)[-0-9a-z]*(\\.asia-northeast3)?\\.(a\\.)?run\\.app' /app/apps/web/.next | wc -l")"
[[ "$stale" =~ ^[0-9]+$ ]] || { echo "unexpected answer from the image check: «$stale»" >&2; exit 1; }
[ "$stale" -eq 0 ] || { echo "the build output still contains a Cloud Run service address" >&2; exit 1; }
# public/ (the static guides) is copied into the image as it is and still names the Cloud Run backend until the guides are changed at cutover (design appendix A, row 1): a warning, not a failure
public="$(inspect "grep -rlE 'run\\.app' /app/apps/web/public | wc -l")"
[[ "$public" =~ ^[0-9]+$ ]] || { echo "unexpected answer from the image check: «$public»" >&2; exit 1; }
[ "$public" -eq 0 ] || echo "WARNING: $public file(s) under public/ still mention run.app (the static guides) — change them before the cutover, see design appendix A row 1" >&2
echo "baked: $api"

if [ "$push" = yes ]; then
  docker push "$image"
  docker image inspect --format '{{index .RepoDigests 0}}' "$image"
fi
