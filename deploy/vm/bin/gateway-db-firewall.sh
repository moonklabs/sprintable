#!/usr/bin/env bash
# story 4796 — keeps the metadata server out of reach of the support gateway's database container (its own docker bridge, br-gwdb, is named in compose.yml). That container serves a database to the VPC
# and has no reason to ask Google for anything; if a mistake in it ever ran a program on the server, the VM service account's token must not be one request away. Idempotent; run at boot (and whenever docker restarts) by
# sprintable-gateway-db-firewall.service, which then starts the container, and checked by the deployer — at its start (the rule must be the FIRST rule of the chain) and from INSIDE the container before a release is swapped in.
set -euo pipefail
# IPv4 only, on purpose: IPv6 is off on this VM and in docker and the bridge has no IPv6 network (compose.yml). Turning IPv6 on needs the same rule with ip6tables FIRST (RUNBOOK section 13).
rule=(DOCKER-USER -i br-gwdb -d 169.254.169.254 -j DROP)
# `iptables -S` prints a rule in ITS order of options (the destination before the interface), not in the order they were given: the lines are compared as the SET of their option/value pairs, sorted, so no order of printing matters.
# A line with an option that has no value (a negation, a bare flag) does not pair up and so never equals the rule: it is not taken for it.
pairs() { awk '{ for (i = 1; i + 1 <= NF; i += 2) print $i " " $(i + 1) }' | sort | paste -sd, -; }
want="$(printf '%s\n' "-A DOCKER-USER -i br-gwdb -d 169.254.169.254/32 -j DROP" | pairs)"
# The rule must be the FIRST of DOCKER-USER: `iptables -C` finds it anywhere in the chain, and an ACCEPT in front of it would let the container through. `-S` prints the chain's own line first, so the first rule is line 2.
if [ "$(iptables -S DOCKER-USER | sed -n 2p | pairs)" != "$want" ]; then
  iptables -I DOCKER-USER 1 "${rule[@]:1}"                      # in front of everything first (no moment without the rule) …
fi
# … then every other copy goes, last one first (a number stays valid while the ones after it are removed); nothing to do when there is only the first
chain="$(iptables -S DOCKER-USER)"   # read into a variable first: a failure of iptables here stops the script (a process substitution would swallow it)
copies=""; n=0
while IFS= read -r line; do
  n=$((n + 1))
  if [ "$n" -gt 1 ] && [ "$(printf '%s\n' "$line" | pairs)" = "$want" ]; then copies="$((n - 1)) $copies"; fi
done <<< "$chain"
for n in $copies; do
  if [ "$n" != 1 ]; then iptables -D DOCKER-USER "$n"; fi
done
# the last word is the chain's own: the container is started only when the rule is, right now, the first one
if [ "$(iptables -S DOCKER-USER | sed -n 2p | pairs)" != "$want" ]; then echo "the metadata rule is not the first rule of DOCKER-USER: the gateway database is not started" >&2; exit 1; fi

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
