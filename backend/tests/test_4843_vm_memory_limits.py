"""story 4843 - the VM's containers have memory cages, and the cages fit in the VM.

The incident (prod, 2026-11-04 01:04Z-03:20Z, 2 h 16 min without an answer): `next-server` and `caddy` grew about 0.4 GB a day together, nothing in compose.yml limited any container, so the VM's memory and
its 2 GiB of swap filled up, the machine thrashed (disk reads 0.6 -> 75 MB/s) and stopped answering. With `mem_limit` and `memswap_limit` EQUAL on every service a leaking container is killed by the kernel alone and
restarted by `restart: unless-stopped`; the VM keeps standing.

What is pinned here (a number cannot change without this file changing with it):
  - every service of compose.yml has `mem_limit` and `memswap_limit`, and they are equal (equal = no swap for the container);
  - the table of limits below is the compose.yml, service by service;
  - the services that RUN ALL THE TIME fit in the VM's memory minus the operating system's share (measured 273-288 MiB, 400 MiB taken);
  - the one-shot `migrate` (it runs while the old backend still runs) fits in the VM beside the resident services at their normal size and the system's share.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
COMPOSE = yaml.safe_load((_ROOT / "deploy/vm/compose.yml").read_text())["services"]

# The machine: e2-medium, 3.83 GiB visible to the operating system (story 4843, measured by `free`), 2 GiB of swap (the containers get none of it).
VM_MEMORY_MIB = 3922
# What the operating system, Docker and the ops agent keep for themselves. MEASURED by the product owner on 2026-11-04 03:31Z with `free -m` and `docker stats`: used minus the containers' sum =
# 273 MiB on prod (ops agent 188 and dockerd 110 inside it) and 288 MiB on dev. 400 MiB = the measured value plus a margin for the ops agent and page cache spikes.
OS_SHARE_MIB = 400
RESIDENT_BUDGET_MIB = VM_MEMORY_MIB - OS_SHARE_MIB

# service -> (limit in MiB, what it comes from)
# The rule of story 4843 (the factor 1.5 and the margin of 256 MiB of deploy/vm/MCP-IN-VM.md section 3): measured size x 1.5 + 256 MiB, here rounded UP to 32 MiB. The measurement is each container's size in NORMAL running - prod 11 minutes after
# the reset, before the leak (`docker stats` MemUsage, 2026-11-04 03:31Z; the backend from its hourly maximum). A limit is the line at which the container is killed, not its normal size: while next-server and caddy leak
# (story 4843, AC3) the two of them are killed and restarted every day or two - the cage that keeps the VM standing until the root cause is fixed or prod is switched off.
LIMITS_MIB: dict[str, tuple[int, str]] = {
    "gateway-db": (288, "measured 16 MiB x 1.5 + 256 = 280"),
    "caddy": (352, "measured 48 MiB (prod, after the reset) x 1.5 + 256 = 328; leaks 96-257 MiB a day, so it is killed about every 1-3 days until the cause is fixed"),
    "frontend": (576, "measured 205 MiB (prod, after the reset) x 1.5 + 256 = 564; next-server leaks 240-620 MiB a day, so it is killed about every 1-2 days until the cause is fixed"),
    "backend": (800, "measured 353 MiB (prod, hourly maximum of the last 24 h, flat) x 1.5 + 256 = 786"),
    "db": (1312, "measured 703 MiB (prod, after the reset, docker stats MemUsage) x 1.5 + 256 = 1311; the page cache the database uses counts in the container's cgroup and is given back under pressure"),
    "migrate": (1024, "one-shot alembic run on the backend image (the backend itself runs at 312-353 MiB). NOT measured yet: the real peak is read from `docker stats` during the first migration on the dev VM (RUNBOOK section 11). It is set high on purpose - a one-shot does not leak, so a high cage costs nothing, while a migrate killed by a too small one fails the release before the swap (the old release stays) and would block a hotfix"),
}
# the same measurements, for the one moment two of them overlap: while `migrate` runs the old backend still runs. The resident services are taken at their NORMAL size there (a leaking one is killed at its limit, so
# no more than one is anywhere near it), `migrate` at its limit, and the system at its share.
NORMAL_MIB = {"db": 703, "backend": 353, "frontend": 205, "caddy": 48, "gateway-db": 16}
RESIDENT = ("db", "backend", "frontend", "caddy", "gateway-db")
TRANSIENT = ("migrate",)

_UNIT = {"b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}


def _mib(value: object) -> float:
    m = re.fullmatch(r"(\d+)([bkmg]?)", str(value).strip().lower())
    assert m, f"not a memory size: {value!r}"
    return int(m.group(1)) * _UNIT[m.group(2) or "b"] / 1024**2


def problems(services: dict) -> list[str]:
    """everything wrong with the memory cages of a compose `services` mapping (empty = fine); the tests below run it on the real file and on broken copies of it"""
    out: list[str] = []
    for name, svc in services.items():
        if "mem_limit" not in svc:
            out.append(f"{name}: no mem_limit - a leak in it would take the whole VM")
        if "memswap_limit" not in svc:
            out.append(f"{name}: no memswap_limit - without it the container may swap (limit + the same again)")
        if "mem_limit" in svc and "memswap_limit" in svc and _mib(svc["memswap_limit"]) != _mib(svc["mem_limit"]):
            out.append(f"{name}: memswap_limit must EQUAL mem_limit (equal = no swap for the container)")
    if set(services) != set(LIMITS_MIB):
        out.append(f"the services are {sorted(services)}, the table has {sorted(LIMITS_MIB)}: give a new service a limit (and a reason) in LIMITS_MIB")
    for name, (mib, _why) in LIMITS_MIB.items():
        if name in services and "mem_limit" in services[name] and _mib(services[name]["mem_limit"]) != mib:
            out.append(f"{name}: compose.yml says {services[name]['mem_limit']}, the table says {mib} MiB")
    for name, (mib, _why) in LIMITS_MIB.items():
        if mib < 128:
            out.append(f"{name}: {mib} MiB would kill it at start")
    got = {n: _mib(s["mem_limit"]) for n, s in services.items() if "mem_limit" in s}
    resident = sum(got.get(n, 0) for n in RESIDENT)
    if resident > RESIDENT_BUDGET_MIB:
        out.append(f"the resident limits add up to {resident:.0f} MiB, the VM can give {RESIDENT_BUDGET_MIB} MiB ({VM_MEMORY_MIB} - {OS_SHARE_MIB} for the system)")
    during_migration = sum(NORMAL_MIB.values()) + max(got.get(n, 0) for n in TRANSIENT) + OS_SHARE_MIB
    if during_migration > VM_MEMORY_MIB:
        out.append(f"during a migration the resident services at their normal size + the migration's limit + the system's share add up to {during_migration:.0f} MiB, the VM has {VM_MEMORY_MIB} MiB")
    for name in RESIDENT:
        if name != "gateway-db" and name in services and services[name].get("restart") != "unless-stopped":  # gateway-db: restart "no" on purpose, only its firewall unit starts it (story 4796)
            out.append(f"{name}: a limit kills the container; it must come back by itself (restart: unless-stopped)")
    return out


def _copy() -> dict:
    return {k: dict(v) for k, v in COMPOSE.items()}


def test_the_compose_file_has_every_cage_and_the_cages_fit() -> None:
    assert problems(COMPOSE) == []


def test_the_budget_arithmetic_is_what_the_comment_says() -> None:
    assert sum(LIMITS_MIB[n][0] for n in RESIDENT) == 3328
    assert RESIDENT_BUDGET_MIB == 3522
    assert sum(NORMAL_MIB.values()) + LIMITS_MIB["migrate"][0] + OS_SHARE_MIB == 2749 <= VM_MEMORY_MIB


def test_every_limit_is_the_rule_applied_to_the_measured_size_and_the_rule_fits_the_vm() -> None:
    measured = NORMAL_MIB
    literal = {name: int(m * 1.5 + 256 + 0.999) for name, m in measured.items()}
    assert literal == {"db": 1311, "backend": 786, "frontend": 564, "caddy": 328, "gateway-db": 280}
    assert sum(literal.values()) == 3269 <= RESIDENT_BUDGET_MIB, "the rule applied as it stands fits the VM"
    for name, floor in literal.items():
        mib = LIMITS_MIB[name][0]
        assert mib % 32 == 0 and floor <= mib < floor + 32, f"{name}: the table value is the rule's value rounded UP to a multiple of 32 MiB ({floor} -> {mib})"


@pytest.mark.parametrize("name", sorted(LIMITS_MIB))
def test_a_service_without_a_limit_is_found(name: str) -> None:
    broken = _copy()
    del broken[name]["mem_limit"]
    assert any(p.startswith(f"{name}: no mem_limit") for p in problems(broken))


@pytest.mark.parametrize("name", sorted(LIMITS_MIB))
def test_a_service_without_a_swap_limit_or_with_a_different_one_is_found(name: str) -> None:
    broken = _copy()
    del broken[name]["memswap_limit"]
    assert any(p.startswith(f"{name}: no memswap_limit") for p in problems(broken))
    broken = _copy()
    broken[name]["memswap_limit"] = f"{int(_mib(broken[name]['mem_limit'])) * 2}m"
    assert any("must EQUAL" in p for p in problems(broken))


def test_a_new_service_without_a_limit_is_found() -> None:
    broken = _copy()
    broken["worker"] = {"image": "x", "restart": "unless-stopped"}
    got = problems(broken)
    assert any(p.startswith("worker: no mem_limit") for p in got) and any("give a new service a limit" in p for p in got)


def test_a_limit_changed_without_the_table_is_found() -> None:
    broken = _copy()
    broken["caddy"]["mem_limit"] = broken["caddy"]["memswap_limit"] = "1024m"
    assert any(p.startswith("caddy: compose.yml says 1024m") for p in problems(broken))


def test_limits_that_add_up_to_more_than_the_vm_can_give_are_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(LIMITS_MIB, "frontend", (1024, "x"))
    broken = _copy()
    broken["frontend"]["mem_limit"] = broken["frontend"]["memswap_limit"] = "1024m"
    got = problems(broken)
    assert any("resident limits add up to" in p for p in got), got


def test_a_resident_service_that_does_not_restart_after_a_kill_is_found() -> None:
    broken = _copy()
    broken["backend"]["restart"] = "no"
    assert any(p.startswith("backend: a limit kills the container") for p in problems(broken))


def test_a_swap_limit_in_other_units_is_read_as_a_size() -> None:
    assert _mib("1g") == 1024 and _mib("524288k") == 512 and _mib(536870912) == 512
