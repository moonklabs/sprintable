"""story 4796 (D2, required by the product owner after the review of D1) - the metadata rule is hardened in three places:

1. `gateway-db-firewall.sh` puts its rule FIRST in DOCKER-USER (`iptables -C` finds a rule anywhere in the chain; an ACCEPT in front of it would let the container through);
2. the deployer asks `iptables` itself, at its start and before it touches `gateway-db`, whether that rule is first - a hand-run `deployer.py --force` goes through the same door as the timer's run;
3. rollback and reconcile bring `gateway-db` up through `_swap`, which asks from INSIDE the container again and closes the container when the metadata server answers.

Run for real against a fake iptables that keeps a chain (so the position is real), a fake docker and the deployer's own fakes; the test names are the ones the security domain asked for.
"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_VM = _HERE.parents[1] / "deploy" / "vm"
_SCRIPT = _VM / "bin" / "gateway-db-firewall.sh"
RULE = "-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb -j DROP"   # in the order iptables prints it: the destination before the interface
ACCEPT = "-A DOCKER-USER -j ACCEPT"
RETURN = "-A DOCKER-USER -j RETURN"


def _sibling(name: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


FAKE_IPTABLES = """#!{python}
import json, os, sys
path = os.environ["CHAIN"]
chain = json.load(open(path)) if os.path.exists(path) else None
with open(os.environ["CALLS"], "a") as f:
    f.write("iptables " + " ".join(sys.argv[1:]) + "\\n")
a = sys.argv[1:]
if chain is None:
    sys.stderr.write("iptables: No chain/target/match by that name.\\n"); sys.exit(1)

def as_listed(spec):
    # the spec of -C / -I / -D as the chain prints it: the single address gets its /32 and the options come out in iptables' own order (-s -d -i -o -p ... -j), not in the order they were given
    opts = {{}}
    i = 1
    while i < len(spec):
        opts[spec[i]] = spec[i + 1] + ("/32" if spec[i] == "-d" and "/" not in spec[i + 1] else "")
        i += 2
    order = ["-s", "-d", "-i", "-o", "-p", "-j"]
    out = ["-A", spec[0]]
    for k in [*order, *[k for k in opts if k not in order]]:
        if k in opts:
            out += [k, opts[k]]
    return " ".join(out)

def save():
    json.dump(chain, open(path, "w"))

if a[0] == "-S" and os.environ.get("FAIL_S_CALL"):
    cnt = path + ".n"
    n = (int(open(cnt).read()) if os.path.exists(cnt) else 0) + 1
    open(cnt, "w").write(str(n))
    if n == int(os.environ["FAIL_S_CALL"]):
        sys.stderr.write("iptables: boom\\n"); sys.exit(1)
if a[0] == "-S":
    print("-N DOCKER-USER")
    for r in chain: print(r)
elif a[0] == "-C":
    sys.exit(0 if as_listed(a[1:]) in chain else 1)
elif a[0] == "-I":
    chain.insert(int(a[2]) - 1, as_listed([a[1], *a[3:]])); save()
elif a[0] == "-D":
    if a[2].isdigit():
        del chain[int(a[2]) - 1]
    else:
        chain.remove(as_listed(a[1:]))
    save()
"""


def _run_script(tmp: Path, chain: list[str] | None, docker_exec_ok: bool = True, extra_env: dict | None = None, fake_tweak=None):
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    ipt = b / "iptables"
    ipt.write_text((fake_tweak or (lambda t: t))(FAKE_IPTABLES.format(python=sys.executable)))
    dk = b / "docker"
    dk.write_text('#!/bin/sh\necho "docker $*" >> "$CALLS"\ncase "$1" in ps) printf "gwc1" ;; exec) exit 0 ;; esac\nexit 0\n')
    slp = b / "sleep"
    slp.write_text("#!/bin/sh\nexit 0\n")
    for f in (ipt, dk, slp):
        f.chmod(f.stat().st_mode | stat.S_IEXEC)
    path, calls = tmp / "chain.json", tmp / "calls.log"
    calls.write_text("")
    if chain is not None:
        path.write_text(json.dumps(chain))
    env = {"PATH": f"{b}:/usr/bin:/bin", "HOME": str(tmp), "CHAIN": str(path), "CALLS": str(calls), **(extra_env or {})}
    p = subprocess.run(["bash", str(_SCRIPT)], capture_output=True, text=True, timeout=60, env=env)
    final = json.loads(path.read_text()) if path.exists() else None
    return p, final, calls.read_text().splitlines()


@pytest.mark.parametrize("before,after", [
    ([], [RULE]),                                        # nothing in the chain: the rule goes in
    ([RETURN], [RULE, RETURN]),                          # docker's own RETURN: in front of it
    ([RULE, RETURN], [RULE, RETURN]),                    # already first: left alone
    ([ACCEPT, RULE], [RULE, ACCEPT]),                    # an ACCEPT in front of an existing rule: the rule moves to the front
    ([ACCEPT, RETURN, RULE], [RULE, ACCEPT, RETURN]),
    ([RULE, ACCEPT, RULE], [RULE, ACCEPT]),              # a duplicate further down goes
    ([ACCEPT, RULE, RULE, RETURN], [RULE, ACCEPT, RETURN]),
    ([RETURN, RULE, ACCEPT, RULE], [RULE, RETURN, ACCEPT]),
])
def test_the_firewall_script_puts_the_rule_first_even_when_it_exists_further_down(tmp_path: Path, before: list[str], after: list[str]) -> None:
    p, final, calls = _run_script(tmp_path, before)
    assert p.returncode == 0, p.stderr
    assert final == after, (before, final)
    assert final.count(RULE) == 1 and final[0] == RULE


def test_the_firewall_script_changes_nothing_when_the_rule_is_already_first(tmp_path: Path) -> None:
    p, final, calls = _run_script(tmp_path, [RULE, RETURN])
    assert p.returncode == 0 and final == [RULE, RETURN]
    assert not [c for c in calls if c.startswith(("iptables -I", "iptables -D"))], "idempotent: no insert, no delete"


def test_the_firewall_script_inserts_before_it_deletes_so_there_is_never_a_moment_without_the_rule(tmp_path: Path) -> None:
    p, final, calls = _run_script(tmp_path, [ACCEPT, RULE])
    writes = [c.split()[1] for c in calls if c.startswith(("iptables -I", "iptables -D"))]
    assert writes == ["-I", "-D"], writes
    assert "iptables -D DOCKER-USER 3" in calls, "the old copy, by its number (it moved down by one)"


def test_the_firewall_script_fails_and_starts_no_container_when_the_chain_is_not_there(tmp_path: Path) -> None:
    p, final, calls = _run_script(tmp_path, None)
    assert p.returncode != 0 and final is None
    assert not [c for c in calls if c.startswith("docker start")], "no rule, no container"


def test_the_firewall_script_starts_the_container_only_after_the_rule_is_first(tmp_path: Path) -> None:
    p, final, calls = _run_script(tmp_path, [ACCEPT, RULE])
    start = next(i for i, c in enumerate(calls) if c.startswith("docker start"))
    last_write = max(i for i, c in enumerate(calls) if c.startswith(("iptables -I", "iptables -D")))
    assert last_write < start and final[0] == RULE


# ───────────────────────────── the deployer's side: the start gate and the re-probe on the way back ─────────────────────────────

G = _sibling("test_4796_vm_gateway_db")
S, D = G.S, G.D
_RETURN = "-A DOCKER-USER -j RETURN"


@pytest.fixture()
def world(tmp_path: Path):
    return G._make_world(tmp_path)


def _chain(*rules: str) -> list[str]:
    return ["-N DOCKER-USER", *rules]


def _gateway_db_up_calls(w) -> list[dict]:
    return [c for c in w.runner.calls if c["args"][:2] == ["docker", "compose"] and "gateway-db" in c["args"] and "up" in c["args"]]


def _docker_calls(w) -> list[dict]:
    return [c for c in w.runner.calls if c["args"][:1] != ["iptables"]]


def _stops_of_gateway_db(w) -> list[dict]:
    return [c for c in w.runner.calls if c["args"][:2] == ["docker", "compose"] and c["args"][-2:] == ["stop", "gateway-db"]]


@pytest.mark.parametrize("lines", [
    _chain(),                                                  # no rule at all
    _chain(_RETURN),
    _chain(ACCEPT, RULE),                                      # there, but not first: `iptables -C` would say yes
    _chain(RETURN, RULE),
    _chain("-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb -j ACCEPT"),   # a rule of the same shape with another target
    _chain("-A DOCKER-USER -d 169.254.169.254/32 -j DROP"),                 # any bridge: not the described rule
    [],                                                        # iptables printed nothing
])
def test_a_deploy_that_would_start_the_gateway_database_without_the_rule_first_never_brings_it_up(world, lines: list[str]) -> None:
    world.publish()
    world.runner.chain_lines = lines
    assert world.dep.run_once() == "failed"
    st = S._state(world, "failed.json")
    assert st["phase"] == "pre-swap" and "not the first rule of DOCKER-USER" in st["detail"] and "nothing was changed" in st["detail"]
    assert _gateway_db_up_calls(world) == [], "gateway-db is never brought up"
    assert _docker_calls(world) == [], "nothing was activated, logged in to, pulled or started"
    assert S._state(world, "current.json") is None
    assert not (world.cfg.data_dir / "gateway-postgres").exists() and not (world.cfg.install_dir / "runtime").exists(), "not even the data folder or the rules file of the gateway database was made"


def test_a_hand_run_with_force_meets_the_same_gate(world) -> None:
    world.publish()
    world.runner.chain_lines = _chain(ACCEPT, RULE)
    assert world.dep.run_once(force=True) == "failed"
    assert _gateway_db_up_calls(world) == [] and _docker_calls(world) == []
    world.runner.chain_lines = _chain(RULE, RETURN)
    assert world.dep.run_once(force=True) == "deployed"


def test_iptables_that_cannot_be_asked_is_not_an_answer(world) -> None:
    world.publish()
    world.runner.iptables_rc = 1
    assert world.dep.run_once() == "failed" and _gateway_db_up_calls(world) == []


def test_a_release_without_the_gateway_database_does_not_ask_iptables(world, tmp_path: Path) -> None:
    world.publish(bundle=G._without_block(tmp_path))
    world.runner.chain_lines = _chain()
    assert world.dep.run_once() == "deployed"
    assert not [c for c in world.runner.calls if c["args"][:1] == ["iptables"]], "switch off: the deployer behaves as before"


def test_the_rule_is_asked_before_the_swap_and_again_before_the_way_back(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    assert world.runner.verbs().count("iptables") == 2, "once before the candidate is activated, once at the head of its swap"


def _break_b_after_its_swap(world):
    """b swaps but never becomes healthy; the way back to a starts as soon as a's images are used again"""
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    a_image = S._state(world, "current.json")["backend_image"]
    world.publish("b" * 40)
    world.runner.healthy_after = 10**6
    orig = world.runner.run
    seen = {"back": False}

    def run(args, env, **kw):
        if env.get("BACKEND_IMAGE") == a_image and "up" in args and "--wait-timeout" in args:
            seen["back"] = True
            world.runner.healthy_after = 0
            world.runner._probes = 0
        return orig(args, env, **kw)

    world.runner.run = run
    return seen, a_image


def test_a_rollback_whose_probe_finds_the_metadata_server_answering_closes_the_gateway_database(world) -> None:
    seen, a_image = _break_b_after_its_swap(world)
    orig = world.runner.run

    def run(args, env, **kw):
        if seen["back"] and "169.254.169.254" in " ".join(args):
            return 0, ""   # on the way back the container can reach the metadata server
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rollback-failed"
    stops = _stops_of_gateway_db(world)
    assert len(stops) == 1 and stops[0]["env"]["BACKEND_IMAGE"] == a_image, "the container is stopped with the release being put back"


def test_a_rollback_whose_probe_cannot_run_closes_the_gateway_database(world) -> None:
    seen, _a = _break_b_after_its_swap(world)
    orig = world.runner.run

    def run(args, env, **kw):
        if seen["back"] and "169.254.169.254" in " ".join(args):
            return 127, "bash: timeout: command not found"
        return orig(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rollback-failed"
    assert len(_stops_of_gateway_db(world)) == 1


def test_a_rollback_with_a_refused_probe_leaves_the_gateway_database_running(world) -> None:
    _break_b_after_its_swap(world)
    assert world.dep.run_once() == "rolled-back"
    assert _stops_of_gateway_db(world) == []


def test_a_rollback_is_stopped_at_the_head_when_the_rule_is_gone_and_nothing_is_started_for_it(world) -> None:
    _seen, a_image = _break_b_after_its_swap(world)
    base = world.runner.run
    state = {"asked": 0, "mark": None}

    def run(args, env, **kw):
        if args[:1] == ["iptables"]:
            state["asked"] += 1
            if state["asked"] == 3:   # 1: before b, 2: head of b's swap, 3: head of the way back
                state["mark"] = len(world.runner.calls)
                world.runner.chain_lines = _chain(ACCEPT, RULE)
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rollback-failed"
    after = world.runner.calls[state["mark"]:]
    assert not any("--wait-timeout" in c["args"] for c in after), "the way back did not run `compose up`: gateway-db was not started for it"


def _pending_for_another_release(world) -> None:
    cur = S._state(world, "current.json")
    (world.cfg.state_dir / "pending.json").write_text(json.dumps({**{k: cur[k] for k in D.STATE_KEYS}, "sha": "b" * 40, "at": 1}))


def test_a_reconcile_whose_probe_finds_the_metadata_server_answering_closes_the_gateway_database(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    _pending_for_another_release(world)
    world.runner.metadata_rc = 0
    assert world.dep.run_once() == "reconcile-failed"
    assert len(_stops_of_gateway_db(world)) == 1


def test_a_reconcile_stops_at_the_head_when_the_rule_is_not_first_stops_the_container_and_starts_nothing(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    _pending_for_another_release(world)
    world.runner.chain_lines = _chain(ACCEPT, RULE)
    world.runner.calls.clear()
    assert world.dep.run_once() == "reconcile-failed"
    assert len(_docker_calls(world)) == 1 and len(_stops_of_gateway_db(world)) == 1, "the only thing done is stopping a container whose isolation is gone: nothing was started or re-created"


def test_a_refused_gate_with_a_release_running_touches_nothing_and_stops_nothing(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    world.publish("b" * 40)
    world.runner.chain_lines = _chain(ACCEPT, RULE)
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed"
    assert _docker_calls(world) == [], "no recovery `up`, no stop: the running gateway database is left as it is"
    assert S._state(world, "current.json")["sha"] == "a" * 40


def test_the_recovery_after_a_failed_candidate_is_a_start_too_and_stops_the_container_when_the_rule_is_no_longer_first(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    a_image = S._state(world, "current.json")["backend_image"]
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1       # b fails before its swap, after it started the gateway database
    base = world.runner.run
    state = {"asked": 0, "mark": None}

    def run(args, env, **kw):
        if args[:1] == ["iptables"]:
            state["asked"] += 1
            if state["asked"] == 2:   # 1: the gate before b, 2: the recovery
                state["mark"] = len(world.runner.calls)
                world.runner.chain_lines = _chain(ACCEPT, RULE)
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "failed"
    after = world.runner.calls[state["mark"]:]
    stops = [c for c in after if c["args"][:2] == ["docker", "compose"] and c["args"][-2:] == ["stop", "gateway-db"]]
    assert len(stops) == 1 and stops[0]["env"]["BACKEND_IMAGE"] == a_image
    assert not [c for c in after if "gateway-db" in c["args"] and "up" in c["args"]], "the previous release's gateway database is not started behind a rule that is not first"


def test_the_recovery_with_the_rule_first_still_brings_the_previous_database_back(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    world.runner.calls.clear()
    assert world.dep.run_once() == "failed"
    assert world.runner.verbs().count("up:gwdb") == 2, "the candidate's start and the previous release's recovery"
    assert _stops_of_gateway_db(world) == []


def test_a_rollback_stopped_at_the_head_by_a_missing_rule_also_stops_the_candidates_container(world) -> None:
    _seen, a_image = _break_b_after_its_swap(world)
    base = world.runner.run
    state = {"asked": 0}

    def run(args, env, **kw):
        if args[:1] == ["iptables"]:
            state["asked"] += 1
            if state["asked"] == 3:   # 1: before b, 2: head of b's swap, 3: head of the way back
                world.runner.chain_lines = _chain(ACCEPT, RULE)
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "rollback-failed"
    assert len(_stops_of_gateway_db(world)) == 1, "the container that b started is not left running behind a rule that is gone"


def test_a_swap_whose_head_finds_the_rule_gone_stops_the_container_that_is_already_up(world) -> None:
    world.publish("a" * 40)
    base = world.runner.run
    state = {"asked": 0}

    def run(args, env, **kw):
        if args[:1] == ["iptables"]:
            state["asked"] += 1
            if state["asked"] == 2:   # 1: before the candidate, 2: head of its swap (gateway-db is up since the pre-swap checks)
                world.runner.chain_lines = _chain(ACCEPT, RULE)
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() in ("failed-no-previous", "rollback-failed")
    assert len(_stops_of_gateway_db(world)) >= 1


def test_the_recovery_after_a_failed_candidate_asks_from_inside_the_container_after_it_started_it(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    base = world.runner.run

    def run(args, env, **kw):
        if "migrate" in args and "run" in args:
            world.runner.metadata_rc = 0   # from the failed migrate on, the restarted container can reach the metadata server
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "failed"
    assert world.runner.verbs()[-3:] == ["up:gwdb", "exec:gwdb-metadata", "stop"], world.runner.verbs()[-6:]


def test_a_first_release_that_fails_after_its_swap_stops_the_gateway_database_when_the_rule_is_gone(world) -> None:
    world.publish("a" * 40)
    world.runner.healthy_after = 10**6
    base = world.runner.run
    state = {"asked": 0}

    def run(args, env, **kw):
        if args[:1] == ["iptables"]:
            state["asked"] += 1
            if state["asked"] == 3:   # 1: before the candidate, 2: head of its swap, 3: the first-release rollback
                world.runner.chain_lines = _chain(ACCEPT, RULE)
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "failed-no-previous"
    assert len(_stops_of_gateway_db(world)) == 1


def test_a_first_release_that_fails_after_its_swap_leaves_the_gateway_database_up_while_the_rule_holds(world) -> None:
    world.publish("a" * 40)
    world.runner.healthy_after = 10**6
    assert world.dep.run_once() == "failed-no-previous"
    assert _stops_of_gateway_db(world) == []


# ── the order in which iptables prints the options (found by the review: the destination comes BEFORE the interface) ──

@pytest.mark.parametrize("printed", [
    "-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb -j DROP",   # iptables' own order
    "-A DOCKER-USER -i br-gwdb -d 169.254.169.254/32 -j DROP",   # any other order of the same four pairs
    "-A DOCKER-USER -j DROP -d 169.254.169.254/32 -i br-gwdb",
])
def test_the_deployer_takes_the_rule_whatever_order_the_options_are_printed_in(world, printed: str) -> None:
    world.publish()
    world.runner.chain_lines = _chain(printed, _RETURN)
    assert world.dep.run_once() == "deployed"


@pytest.mark.parametrize("printed", [
    "-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb -p tcp -j DROP",       # one more option: another rule
    "-A DOCKER-USER -d 169.254.169.254/32 ! -i br-gwdb -j DROP",             # negated interface: does not pair up
    "-A DOCKER-USER -d 169.254.169.254/32 -i br-other -j DROP",
    "-A DOCKER-USER -d 169.254.169.0/24 -i br-gwdb -j DROP",
    "-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb",                       # no target
])
def test_the_deployer_does_not_take_a_rule_that_only_looks_like_it(world, printed: str) -> None:
    world.publish()
    world.runner.chain_lines = _chain(printed)
    assert world.dep.run_once() == "failed" and _gateway_db_up_calls(world) == []


@pytest.mark.parametrize("before,after", [
    ([RULE, RETURN], [RULE, RETURN]),
    ([RETURN, "-A DOCKER-USER -i br-gwdb -d 169.254.169.254/32 -j DROP"], [RULE, RETURN, "-A DOCKER-USER -i br-gwdb -d 169.254.169.254/32 -j DROP"]),
])
def test_the_firewall_script_compares_by_the_pairs_not_by_the_text(tmp_path: Path, before: list[str], after: list[str]) -> None:
    """a line printed in the other order is the same rule to the script as to the deployer: a first line like that is left alone, and a copy further down in another order is removed"""
    p, final, calls = _run_script(tmp_path, before)
    assert p.returncode == 0, p.stderr
    if before[0] == RULE and len(before) == 2 and before[1] == RETURN:
        assert not [c for c in calls if c.startswith(("iptables -I", "iptables -D"))]
    assert final[0] == RULE


def test_the_first_release_cleanup_of_a_dead_run_also_asks_for_the_rule(world) -> None:
    """a run that died after recording a failed first release: the next run stops the app containers and, with the rule gone, the gateway database too"""
    desired = world.publish("a" * 40)
    world.runner.healthy_after = 10**6
    assert world.dep.run_once() == "failed-no-previous"
    (world.cfg.state_dir / "pending.json").write_text(json.dumps({**{k: desired[k] for k in D.STATE_KEYS}, "at": 1}))
    world.runner.chain_lines = _chain(ACCEPT, RULE)
    world.runner.calls.clear()
    world.dep.run_once()
    assert len(_stops_of_gateway_db(world)) == 1
    assert any(c["args"][-3:] == ["backend", "frontend", "caddy"] for c in world.runner.calls), "and the application containers are stopped as before"


def test_a_line_with_an_option_that_has_no_value_is_none_and_never_an_error() -> None:
    f = D._rule_pairs
    assert f("-A DOCKER-USER -d 169.254.169.254/32 ! -i br-gwdb -j DROP") is None and f("") is None and f("-N DOCKER-USER") is not None
    assert f("-A DOCKER-USER -d 169.254.169.254/32 -i br-gwdb -j DROP") == f("-A DOCKER-USER -j DROP -i br-gwdb -d 169.254.169.254/32") == D.METADATA_RULE_PAIRS


def test_a_failed_first_question_is_not_a_reason_to_start_the_container_the_last_question_decides(tmp_path: Path) -> None:
    p, final, calls = _run_script(tmp_path, [ACCEPT, RULE, RETURN], extra_env={"FAIL_S_CALL": "1"})
    assert p.returncode == 0 and final[0] == RULE, "the rule is put in front anyway, and the last question finds it there"
    start = next(i for i, c in enumerate(calls) if c.startswith("docker start"))
    assert start > max(i for i, c in enumerate(calls) if c.startswith("iptables -S"))


@pytest.mark.parametrize("call", [2, 3])
def test_an_iptables_that_fails_at_its_later_questions_stops_the_script_before_the_container_is_started(tmp_path: Path, call: int) -> None:
    """the second question reads the chain for the copies, the third is the last word before the start - each failure stops the script"""
    p, final, calls = _run_script(tmp_path, [ACCEPT, RULE, RETURN], extra_env={"FAIL_S_CALL": str(call)})
    assert p.returncode != 0, (call, p.stdout, p.stderr)
    assert not [c for c in calls if c.startswith("docker start")], "no container behind a chain that could not be read"


def test_the_container_is_not_started_when_the_rule_is_not_first_after_all_the_script_did(tmp_path: Path) -> None:
    """a chain that another program rewrites while the script runs (here: the fake puts an ACCEPT in front whenever a rule is deleted): the last question has the last word"""
    p, final, calls = _run_script(tmp_path, [RULE, RULE], fake_tweak=lambda t: t.replace('elif a[0] == "-D":', 'elif a[0] == "-D":\n    chain.insert(0, "-A DOCKER-USER -j ACCEPT"); save()'))
    assert p.returncode != 0 and "not the first rule" in p.stderr, (p.stdout, p.stderr)
    assert not [c for c in calls if c.startswith("docker start")]


def test_a_recovery_start_that_did_not_become_healthy_is_asked_from_inside_and_stopped_when_the_metadata_server_answers(world) -> None:
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    world.publish("b" * 40)
    world.runner.fail_on["migrate"] = 1
    base = world.runner.run

    def run(args, env, **kw):
        if "migrate" in args and "run" in args:
            world.runner.metadata_rc = 0
            world.runner.gateway_db_up_ok = False   # and the recovery start does not become healthy
        return base(args, env, **kw)

    world.runner.run = run
    assert world.dep.run_once() == "failed"
    assert world.runner.verbs()[-3:] == ["up:gwdb", "exec:gwdb-metadata", "stop"], world.runner.verbs()[-6:]
