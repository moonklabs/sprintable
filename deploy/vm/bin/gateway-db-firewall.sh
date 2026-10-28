#!/usr/bin/env bash
# story 4796 — keeps the metadata server out of reach of the support gateway's database container (its own docker bridge, br-gwdb, is named in compose.yml). That container serves a database to the VPC
# and has no reason to ask Google for anything; if a mistake in it ever ran a program on the server, the VM service account's token must not be one request away. Idempotent; run at boot by
# sprintable-gateway-db-firewall.service, and checked by the deployer from INSIDE the container before a release is swapped in.
set -euo pipefail
rule=(DOCKER-USER -i br-gwdb -d 169.254.169.254 -j DROP)
if ! iptables -C "${rule[@]}" 2> /dev/null; then
  iptables -I DOCKER-USER 1 "${rule[@]:1}"
fi
