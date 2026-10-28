#!/usr/bin/env bash
# story 4796 — keeps the metadata server out of reach of the support gateway's database container (its own docker bridge, br-gwdb, is named in compose.yml). That container serves a database to the VPC
# and has no reason to ask Google for anything; if a mistake in it ever ran a program on the server, the VM service account's token must not be one request away. Idempotent; run at boot (and whenever docker restarts) by
# sprintable-gateway-db-firewall.service, which then starts the container, and checked by the deployer from INSIDE the container before a release is swapped in.
set -euo pipefail
rule=(DOCKER-USER -i br-gwdb -d 169.254.169.254 -j DROP)
if ! iptables -C "${rule[@]}" 2> /dev/null; then
  iptables -I DOCKER-USER 1 "${rule[@]:1}"
fi

# the support gateway's database container has the restart policy «no» (compose.yml): after a boot or a restart of docker it is started HERE, after the rule above, never before it
id="$(docker ps -aq --filter label=com.docker.compose.project=sprintable --filter label=com.docker.compose.service=gateway-db | head -n1)"
if [ -n "$id" ]; then
  docker start "$id" > /dev/null
  # the backup and restore-check units run after this one: they find a server that answers (a bounded wait; a server that does not come up is for the deployer's health check to report, not for this unit to fail on)
  for _ in $(seq 1 60); do
    if docker exec "$id" pg_isready -q; then break; fi
    sleep 1
  done
fi
