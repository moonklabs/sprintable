#!/usr/bin/env bash
# One-time (and re-runnable) preparation of a Sprintable VM — Debian 12 on GCE. Run as root from an unpacked deploy/vm bundle:
#   sudo ./bootstrap.sh <environment> <project> <deploy-bucket> <backups-bucket> <acme-email>
# Installs Docker + compose, mounts the data disk, adds swap, installs the deployer / backup tooling and their systemd units, and the Ops Agent.
# It does NOT start deploying: restore the database first (RUNBOOK), put the private plain file in place, then `systemctl enable --now sprintable-deploy.timer`.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <environment> <project> <deploy-bucket> <backups-bucket> <acme-email>" >&2
  exit 2
fi
env_name="$1"; project="$2"; deploy_bucket="$3"; backups_bucket="$4"; acme_email="$5"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data=/srv/sprintable
disk=/dev/disk/by-id/google-sprintable-data

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg python3 python3-yaml
if ! docker compose version > /dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
if ! command -v gcloud > /dev/null; then
  # backups upload with `gcloud storage`; Google's Debian images normally carry the CLI, but do not rely on it
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -qq
  apt-get install -y -qq google-cloud-cli
fi
command -v gcloud > /dev/null || { echo "gcloud could not be installed — backups upload with it" >&2; exit 1; }

echo "== data disk → $data"
[ -b "$disk" ] || { echo "data disk $disk not attached (attach it with --device-name=sprintable-data)" >&2; exit 1; }
if ! blkid "$disk" > /dev/null 2>&1; then
  mkfs.ext4 -q -m 0 -L sprintable-data "$disk"
fi
mkdir -p "$data"
uuid="$(blkid -s UUID -o value "$disk")"
grep -q "$uuid" /etc/fstab || echo "UUID=$uuid $data ext4 discard,defaults 0 2" >> /etc/fstab
mountpoint -q "$data" || mount "$data"
mountpoint -q "$data" || { echo "$data is not a mount point" >&2; exit 1; }
# containers must never start on the boot disk while the data disk is missing: docker waits for the mount
mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=%s\n' "$data" > /etc/systemd/system/docker.service.d/data-disk.conf

echo "== swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile > /dev/null; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Ops Agent"
if ! systemctl list-unit-files | grep -q google-cloud-ops-agent; then
  curl -fsSL https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh -o /tmp/add-ops-agent.sh
  bash /tmp/add-ops-agent.sh --also-install
  rm -f /tmp/add-ops-agent.sh
fi

echo "== tooling → /opt/sprintable"
install -d -m 0755 /opt/sprintable/bin /opt/sprintable/releases /opt/sprintable/runtime /etc/sprintable
for f in deployer.py render_env.py lib.sh backup.sh restore.sh restore-check.sh rowcounts.sh rowcounts.sql; do
  install -m 0755 "$src/bin/$f" "/opt/sprintable/bin/$f"
done
# the compose file the deployer holds bundles to: a bundle whose compose.yml differs from this copy is refused (changing compose = re-run this script)
install -m 0644 "$src/compose.yml" /opt/sprintable/bin/compose.yml
for f in "$src"/systemd/*; do install -m 0644 "$f" "/etc/systemd/system/$(basename "$f")"; done
python3 - "$env_name" "$project" "$deploy_bucket" "$backups_bucket" "$acme_email" <<'PY'
import json, sys
keys = ("environment", "project", "deploy_bucket", "backups_bucket", "acme_email")
doc = dict(zip(keys, sys.argv[1:]))
open("/etc/sprintable/deployer.json", "w").write(json.dumps(doc, indent=2) + "\n")
PY
chmod 0644 /etc/sprintable/deployer.json
if [ ! -f /etc/sprintable/private-plain.json ]; then
  echo "NOTE: /etc/sprintable/private-plain.json is not there yet (RUNBOOK step «private plain file»); the deployer refuses to run without it" >&2
fi

systemctl daemon-reload
systemctl enable --now docker
systemctl enable --now sprintable-backup.timer sprintable-restore-check.timer
echo "bootstrap done for $env_name — deploy timer NOT enabled yet (restore the database first, see RUNBOOK)"
