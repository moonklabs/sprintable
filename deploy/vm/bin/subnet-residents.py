#!/usr/bin/env python3
# Written by the security domain (story 4796, review of the gateway database): READ ONLY, standard library only, names only.
"""READ ONLY. Who sits on the gateway's own subnet? (RUNBOOK §13: only the gateway service and its migrate job may — anything else deployed there reaches the gateway database's port.)

usage: subnet_residents.py PROJECT REGION SUBNET [--allow-service NAME ...] [--allow-job PREFIX ...]

Looks at: Cloud Run services (the template AND every revision that serves traffic or carries a tag), Cloud Run jobs (the template), VM instances and instance templates whose network interface is on that subnet.
NOT looked at: Cloud Run worker pools (the gcloud this was written against cannot list them) - the tool says so in its output and a person looks in the console.
Prints names only (never an address). Exit 0 = nobody but the allowed; 1 = somebody else is there (named); 2 = it could not look (gcloud failed, the subnet is missing) — never read a 2 as «fine».
"""
from __future__ import annotations

import json
import subprocess
import sys


def gj(project: str, *args: str):
    r = subprocess.run(["gcloud", *args, "--project", project, "--format=json"], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print(f"could not look: gcloud {' '.join(args[:3])} failed (exit {r.returncode}): {(r.stderr.strip().splitlines() or ['(no message)'])[0][:140]}")
        raise SystemExit(2)
    return json.loads(r.stdout) if r.stdout.strip() else []


def interfaces_of(annotations: dict) -> list[dict]:
    raw = (annotations or {}).get("run.googleapis.com/network-interfaces")
    if not raw:
        return []
    try:
        return [x for x in json.loads(raw) if isinstance(x, dict)]
    except ValueError:
        print("could not look: a network-interfaces annotation is not JSON")
        raise SystemExit(2)


def on_subnet(annotations: dict, subnet: str) -> bool:
    return any(str(x.get("subnetwork", "")).rsplit("/", 1)[-1] == subnet for x in interfaces_of(annotations))


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    project, region, subnet = argv[0], argv[1], argv[2]
    allow_services: list[str] = []
    allow_jobs: list[str] = []
    rest = argv[3:]
    while rest:
        flag = rest.pop(0)
        if flag in ("--allow-service", "--allow-job") and rest:
            (allow_services if flag == "--allow-service" else allow_jobs).append(rest.pop(0))
        else:
            print(__doc__)
            return 2

    sn = gj(project, "compute", "networks", "subnets", "describe", subnet, "--region", region)
    print(f"subnet {subnet}: found in {region}, /{str(sn.get('ipCidrRange', '?')).rsplit('/', 1)[-1]}, purpose {sn.get('purpose')}")

    services_here: list[str] = []
    for svc in gj(project, "run", "services", "list", "--region", region):
        name = svc["metadata"]["name"]
        hit = on_subnet(svc["spec"]["template"]["metadata"].get("annotations", {}), subnet)
        if not hit:
            # a revision that still serves traffic or is reachable by a tag runs on whatever it was deployed with
            for t in svc.get("status", {}).get("traffic", []) or []:
                rev = t.get("revisionName")
                if rev and ((t.get("percent") or 0) > 0 or t.get("tag")):
                    r = gj(project, "run", "revisions", "describe", rev, "--region", region)
                    if on_subnet(r.get("metadata", {}).get("annotations", {}), subnet):
                        hit = True
                        break
        if hit:
            services_here.append(name)

    jobs_here = [j["metadata"]["name"] for j in gj(project, "run", "jobs", "list", "--region", region) if on_subnet(j["spec"]["template"]["metadata"].get("annotations", {}), subnet)]
    vms_here = [i["name"] for i in gj(project, "compute", "instances", "list") if any(str(n.get("subnetwork", "")).rsplit("/", 1)[-1] == subnet for n in i.get("networkInterfaces", []))]
    templates_here = [t["name"] for t in gj(project, "compute", "instance-templates", "list") if any(str(n.get("subnetwork", "")).rsplit("/", 1)[-1] == subnet for n in (t.get("properties", {}) or {}).get("networkInterfaces", []))]

    def mark(names: list[str], ok) -> str:
        return ", ".join(f"{n} ({'allowed' if ok(n) else 'NOT ALLOWED'})" for n in sorted(names)) or "none"

    svc_ok = lambda n: n in allow_services
    job_ok = lambda n: any(n == p or n.startswith(p) for p in allow_jobs)
    print(f"Cloud Run services on it: {mark(services_here, svc_ok)}")
    print(f"Cloud Run jobs on it    : {mark(jobs_here, job_ok)}")
    print(f"VM instances on it      : {', '.join(sorted(vms_here)) or 'none'}")
    print(f"VM instance templates   : {', '.join(sorted(templates_here)) or 'none'}")
    print("Cloud Run worker pools : NOT LOOKED AT by this tool - Console > Cloud Run > Worker pools must show none on this network")
    intruders = [n for n in services_here if not svc_ok(n)] + [n for n in jobs_here if not job_ok(n)] + vms_here + templates_here
    if intruders:
        print(f"VERDICT: NOT OK — somebody other than the allowed is on this subnet: {', '.join(sorted(intruders))}")
        return 1
    print("VERDICT: OK — nobody but the allowed (gateway service, its migrate job, throw-away probe jobs)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
