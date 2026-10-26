#!/usr/bin/env python3
"""Before a cutover: do the live Cloud Run service's variable NAMES (and which of them are secrets, and which secret) still match the copy this declaration was written from?

  gcloud run services describe <service> --region <region> --format=json | python3 deploy/vm/bin/check_live_names.py deploy/vm/env/live-names.<env>.txt <section>

Prints what was added / removed / changed (names and secret ids only — never a value) and exits 1 if anything differs. The tests compare the declaration with the fixture;
this closes the other half: the fixture with the service as it is now.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

LINE = re.compile(r"^([A-Za-z0-9_]+) <(plain|secret)(?: ([^>]+))?>$")


def fixture_names(path: Path, section: str) -> dict[str, str]:
    out: dict[str, str] = {}
    current = None
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            current = line[3:].strip()
            continue
        m = LINE.match(line)
        if current == section and m:
            out[m.group(1)] = "plain" if m.group(2) == "plain" else f"secret {m.group(3)}"
    return out


def live_names(describe: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in describe["spec"]["template"]["spec"]["containers"][0].get("env", []):
        ref = (item.get("valueFrom") or {}).get("secretKeyRef")
        out[item["name"]] = f"secret {ref['name']}" if ref else "plain"
    return out


def compare(fixture: dict[str, str], live: dict[str, str]) -> list[str]:
    problems = [f"added live (not in the declaration): {n}" for n in sorted(set(live) - set(fixture))]
    problems += [f"gone live (still in the declaration): {n}" for n in sorted(set(fixture) - set(live))]
    problems += [f"changed: {n} was «{fixture[n]}», is «{live[n]}»" for n in sorted(set(fixture) & set(live)) if fixture[n] != live[n]]
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: check_live_names.py <live-names file> <section> < describe.json", file=sys.stderr)
        return 2
    fixture = fixture_names(Path(argv[1]), argv[2])
    if not fixture:
        print(f"no section «{argv[2]}» in {argv[1]}", file=sys.stderr)
        return 2
    problems = compare(fixture, live_names(json.load(sys.stdin)))
    print("\n".join(problems) if problems else f"ok: {len(fixture)} names match")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
