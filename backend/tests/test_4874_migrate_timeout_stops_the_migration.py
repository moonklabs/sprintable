"""story #4874 — a migration that runs out of time (`T_MIGRATE`) is STOPPED, not left running behind the old release.

`Runner.run` ends a call that is over time by killing the `docker compose` CLIENT (`subprocess.run(timeout=)`). The migrate container belongs to docker's daemon and the statement it started belongs to
Postgres: both lived on (measured, story 4874 AC1: after the timeout the session stayed `active` in pg_stat_activity, its ACCESS EXCLUSIVE lock kept the old release's reads waiting, and the next
turn's migration died on the lock). Now every migration has ONE name per release — its container (`--name`) and its database connections (PGAPPNAME) — and on a timeout (and, as a prefix, before the next try) the deployer removes the container
by that name and cancels, then terminates, the sessions with that name and no others (the backend that serves has connections on the same role: they carry other names and are never matched). The release in
service is untouched (the failure is still `pre-swap`) and the next turn starts from a clean place.

The first group runs the deployer against a fake docker that REMEMBERS what is running; the second group is real Postgres: the deployer's own SQL, a migration session and a serving session side by side.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from tests.test_4796_vm_deployer import D, FakeRunner, _state, world  # noqa: F401 — `world` is a fixture used by name

_VM = Path(__file__).resolve().parents[2] / "deploy/vm"
_CID = "c0ffee" + "0" * 58     # a container id as `docker ps -aq --no-trunc` prints it
_NAME_B = D.MIGRATE_NAME_PREFIX + "b" * 40      # the migration of release b (the whole sha)…
_NAME_A = D.MIGRATE_NAME_PREFIX + "a" * 40


class DaemonRunner(FakeRunner):
    """a docker that keeps a container alive after its client is gone, and a database that keeps the session until it is ended — only a removal / a terminate ends them"""

    def __init__(self) -> None:
        super().__init__()
        self.container_alive = False
        self.session_alive = False
        self.timeout_next_migrate = False
        self.rm_rc = 0
        self.sessions_raise = False
        self.container_name = _NAME_B
        self.log_of_effects: list[str] = []

    def run(self, args, env, cwd=None, timeout=900, stdin=None, whole=False):
        a = list(args)
        joined = " ".join(a)
        if a[:2] == ["docker", "ps"]:
            self.calls.append({"args": a, "env": dict(env), "stdin": stdin, "whole": whole, "timeout": timeout})
            out = (f"{_CID} {self.container_name}\n" if self.container_alive else "") + (f"{'f' * 64} other-container-{self.container_name}\n" if self.container_alive else "")
            return 0, out
        if a[:3] == ["docker", "rm", "-f"]:
            self.calls.append({"args": a, "env": dict(env), "stdin": stdin, "whole": whole, "timeout": timeout})
            if self.rm_rc == 0 and _CID in a:
                self.container_alive = False
                self.log_of_effects.append("container removed")
            return self.rm_rc, "" if self.rm_rc == 0 else "Error response from daemon: cannot remove"
        if a[:2] == ["docker", "compose"] and "pg_terminate_backend" in joined:
            self.calls.append({"args": a, "env": dict(env), "stdin": stdin, "whole": whole, "timeout": timeout})
            if self.sessions_raise:
                raise OSError("docker compose exec could not start")
            self.session_alive = False
            self.log_of_effects.append("sessions ended")
            return 0, "1\n"
        if a[:2] == ["docker", "compose"] and "run" in a and "migrate" in a:
            self.calls.append({"args": a, "env": dict(env), "stdin": stdin, "whole": whole, "timeout": timeout})
            self.container_alive = self.session_alive = True      # started: it is in the daemon / in the database from now on
            if self.timeout_next_migrate:
                return 124, f"timed out after {int(timeout)} s"   # the client is killed; the container and the session are NOT
            self.container_alive = self.session_alive = False     # finished on its own
            return 0, ""
        return super().run(args, env, cwd=cwd, timeout=timeout, stdin=stdin, whole=whole)


def _deploy_b_over_a(world, timeout_b: bool = True) -> DaemonRunner:
    runner = DaemonRunner()
    world.dep.runner = runner
    world.publish("a" * 40)
    assert world.dep.run_once() == "deployed"
    world.publish("b" * 40)
    runner.timeout_next_migrate = timeout_b
    runner.calls.clear()
    runner.log_of_effects.clear()
    return runner


def test_a_migration_that_runs_out_of_time_is_removed_and_its_database_sessions_are_ended(world) -> None:
    runner = _deploy_b_over_a(world)
    assert world.dep.run_once() == "failed"
    assert runner.container_alive is False and runner.session_alive is False, "after the timeout nothing of the migration is left running"
    assert runner.log_of_effects == ["sessions ended", "container removed", "sessions ended"], runner.log_of_effects   # (the first: the look before the run, which found nothing)
    # …and it was done AFTER the run, with the container id the daemon listed
    verbs = runner.verbs()
    run_at = verbs.index("run")
    assert verbs[run_at + 1:run_at + 4] == ["ps", "rm", "exec:migrate-stop"], verbs
    rm = next(c for c in runner.calls if c["args"][:3] == ["docker", "rm", "-f"])
    assert rm["args"][3:] == [_CID]
    run = next(c for c in runner.calls if c["args"][:2] == ["docker", "compose"] and "run" in c["args"])
    assert run["args"][run["args"].index("--name") + 1] == _NAME_B and f"PGAPPNAME={_NAME_B}" in run["args"], "the container and its database connections carry the same, per-release name"
    ps = [c for c in runner.calls if c["args"][:2] == ["docker", "ps"]][-1]
    assert f"name={_NAME_B}" in ps["args"]
    rm = next(c for c in runner.calls if c["args"][:3] == ["docker", "rm", "-f"])
    assert rm["args"][3:] == [_CID], "a container whose name only CONTAINS the name (docker's filter is a substring match) is not removed"
    # the sessions: cancel, wait, terminate — each only for THAT name (a LIKE on the name, not on a role / a state / a database)
    term = [c for c in runner.calls if "pg_terminate_backend" in " ".join(c["args"])][-1]
    sql = " ".join(term["args"])
    assert sql.count(f"application_name like '{_NAME_B}%'") == 2 and "pg_cancel_backend" in sql and "pg_terminate_backend" in sql and sql.index("pg_cancel_backend") < sql.index("pg_sleep") < sql.index("pg_terminate_backend")
    assert "usename" not in sql and "state" not in sql and "datname" not in sql and "pg_backend_pid()" in sql


def test_the_failure_is_still_before_the_swap_and_says_what_happened(world) -> None:
    runner = _deploy_b_over_a(world)
    assert world.dep.run_once() == "failed"
    assert "up:all" not in runner.verbs() and "exec:reload" not in runner.verbs(), "the new release is never swapped in"
    assert _state(world, "current.json")["sha"] == "a" * 40
    failed = _state(world, "failed.json")
    assert failed["phase"] == "pre-swap" and "migrate timed out after 1800 s" in failed["detail"] and "removed" in failed["detail"]
    status = world.store.puts[-1][2]
    assert status["state"] == "failed" and status["serving"] == "a" * 40


def test_the_next_turn_retries_from_a_clean_place_and_deploys(world) -> None:
    runner = _deploy_b_over_a(world)
    assert world.dep.run_once() == "failed"
    world.clock.sleep(60)
    assert world.dep.run_once() == "skipping-failed"
    world.clock.sleep(300)
    runner.timeout_next_migrate = False
    runner.calls.clear()
    assert world.dep.run_once() == "deployed"
    assert _state(world, "current.json")["sha"] == "b" * 40
    # before the run of the second try, the clean-up looked once more (and found nothing)
    verbs = runner.verbs()
    assert verbs.index("ps") < verbs.index("run") and verbs.index("exec:migrate-stop") < verbs.index("run")
    assert not [c for c in runner.calls if c["args"][:3] == ["docker", "rm", "-f"]], "nothing was left to remove"


def test_what_an_earlier_cut_off_run_left_behind_is_cleared_before_the_next_migration_starts(world) -> None:
    """a deployer that died (killed unit, reboot of the unit) leaves the container and the session — of ITS release, not necessarily the one now deployed: the clean-up before a migration goes by the
    PREFIX, so release b's migration does not start behind what release a left (the container, and the session with its locks)"""
    runner = _deploy_b_over_a(world, timeout_b=False)
    runner.container_alive = runner.session_alive = True
    runner.container_name = _NAME_A                                                # a leftover of ANOTHER release's name
    assert world.dep.run_once() == "deployed"
    assert runner.log_of_effects[:2] == ["container removed", "sessions ended"], runner.log_of_effects
    verbs = runner.verbs()
    assert verbs.index("rm") < verbs.index("run")
    ps = next(c for c in runner.calls if c["args"][:2] == ["docker", "ps"])
    assert f"name={D.MIGRATE_NAME_PREFIX}" in ps["args"] and f"name={_NAME_B}" not in ps["args"], "the look before the run is for the prefix"
    rm = next(c for c in runner.calls if c["args"][:3] == ["docker", "rm", "-f"])
    assert rm["args"][3:] == [_CID]
    before = next(c for c in runner.calls if "pg_terminate_backend" in " ".join(c["args"]))
    assert " ".join(before["args"]).count(f"application_name like '{D.MIGRATE_NAME_PREFIX}%'") == 2, "…and so are the sessions"


def test_a_container_that_cannot_be_removed_is_said_so_and_the_swap_still_does_not_happen(world) -> None:
    runner = _deploy_b_over_a(world)
    runner.rm_rc = 1
    # the clean-up BEFORE the run already meets nothing; the run times out and the removal fails
    assert world.dep.run_once() == "failed"
    assert "up:all" not in runner.verbs()
    failed = _state(world, "failed.json")
    assert "migrate timed out" in failed["detail"] and "could NOT be stopped" in failed["detail"]
    assert any("migrate container removal failed" in m for m in world.logs)


def test_a_migration_that_fails_on_its_own_is_not_treated_as_a_timeout(world) -> None:
    runner = _deploy_b_over_a(world, timeout_b=False)
    # make the migration fail by its own exit code
    orig = runner.run

    def failing(args, env, **kw):
        if list(args)[:2] == ["docker", "compose"] and "run" in args and "migrate" in args:
            runner.calls.append({"args": list(args), "env": dict(env), "stdin": None, "whole": False, "timeout": kw.get("timeout")})
            return 1, "alembic: error"
        return orig(args, env, **kw)

    runner.run = failing                                                         # type: ignore[method-assign]
    assert world.dep.run_once() == "failed"
    failed = _state(world, "failed.json")
    assert failed["detail"].startswith("migrate failed:") and "timed out" not in failed["detail"]
    after_run = runner.verbs()[runner.verbs().index("run") + 1:]
    assert not [v for v in after_run if v in ("ps", "rm") or v.startswith("exec:migrate")], f"an ordinary failure does no timeout clean-up: {after_run}"


def test_a_migration_that_itself_exits_with_124_is_an_ordinary_failure_not_a_timeout(world) -> None:
    runner = _deploy_b_over_a(world, timeout_b=False)
    orig = runner.run

    def exits_124(args, env, **kw):
        if list(args)[:2] == ["docker", "compose"] and "run" in args and "migrate" in args:
            runner.calls.append({"args": list(args), "env": dict(env), "stdin": None, "whole": False, "timeout": kw.get("timeout")})
            return 124, "alembic: the script itself exited 124"
        return orig(args, env, **kw)

    runner.run = exits_124                                                        # type: ignore[method-assign]
    assert world.dep.run_once() == "failed"
    failed = _state(world, "failed.json")
    assert failed["detail"].startswith("migrate failed:") and "timed out" not in failed["detail"]


def test_an_earlier_container_that_cannot_be_removed_stops_the_deploy_before_a_new_migration_starts(world) -> None:
    """the new `run --name` would meet the old name (and the old locks): better to say so than to start"""
    runner = _deploy_b_over_a(world, timeout_b=False)
    runner.container_alive = runner.session_alive = True
    runner.rm_rc = 1
    assert world.dep.run_once() == "failed"
    assert "run" not in runner.verbs() and "up:all" not in runner.verbs()
    failed = _state(world, "failed.json")
    assert failed["phase"] == "pre-swap" and "earlier migration's container could not be listed or removed" in failed["detail"]
    assert _state(world, "current.json")["sha"] == "a" * 40


def test_a_failure_of_the_sessions_statement_is_not_taken_for_a_container_that_cannot_be_removed(world) -> None:
    """the two stages are told apart: the containers were removed, only the database statement could not run — the deploy goes on to the migration (a session left over makes it fail on the lock timeout, a clean pre-swap failure)"""
    runner = _deploy_b_over_a(world, timeout_b=False)
    runner.container_alive = True
    runner.sessions_raise = True
    assert world.dep.run_once() == "deployed"
    assert runner.container_alive is False and any("ending the migration's database sessions failed" in m for m in world.logs)


def test_a_timeout_whose_sessions_statement_cannot_run_says_it_could_not_stop_everything(world) -> None:
    runner = _deploy_b_over_a(world)
    runner.sessions_raise = True
    assert world.dep.run_once() == "failed"
    failed = _state(world, "failed.json")
    assert "migrate timed out" in failed["detail"] and "could NOT be stopped" in failed["detail"] and "up:all" not in runner.verbs()


def test_the_names_are_per_release_and_the_backend_never_has_one() -> None:
    assert D.migrate_name(Path("/opt/releases/" + "c" * 40)) == D.MIGRATE_NAME_PREFIX + "c" * 40, "the whole sha: two releases never share a name"
    assert len(D.migrate_name(Path("/x/" + "c" * 40))) <= 63, "a Postgres application_name is cut at 63 characters"
    # the backend's own connections are named `K_SERVICE:K_REVISION[:suffix]` (app/core/database.py) — never with this prefix; and the migration's own engine (alembic/env.py) sets no name that would replace PGAPPNAME
    from app.core.database import db_application_name
    assert not db_application_name().startswith(D.MIGRATE_NAME_PREFIX) and not db_application_name("listen").startswith(D.MIGRATE_NAME_PREFIX)
    env_py = (Path(__file__).resolve().parents[1] / "alembic/env.py").read_text()
    assert "application_name" not in env_py


# ─── real Postgres: the deployer's own SQL, a migration session and a serving session side by side ───────────────────────────────────────────

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


class _Real:
    def __init__(self) -> None:
        import psycopg2
        from sqlalchemy.engine import make_url

        url = make_url(_REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://"))
        self.psycopg2 = psycopg2
        self.dsn = {k: v for k, v in dict(host=url.host, port=url.port or 5432, user=url.username, password=url.password, dbname=url.database).items() if v is not None}
        self.table = f"t4874_{uuid.uuid4().hex[:8]}"
        # story 4922 — every name this test puts into `pg_stat_activity` is its OWN: `pg_stat_activity` is the whole cluster, and the backend's pooled connections of the tests that ran
        # before this one are still there under the app's name (`local:dev`) — counting by that name gave 2 / 3 instead of 1 (CI runs 43449408634 / 43424348327). A migration name keeps the
        # deployer's shape (prefix + 40 characters, ≤ 63) so the deployer's own SQL is what is exercised; the serving session carries the app-like name plus this test's token.
        self.token = uuid.uuid4().hex
        self.name_a = D.MIGRATE_NAME_PREFIX + self.token[:20] + "a" * 20
        self.name_b = D.MIGRATE_NAME_PREFIX + self.token[:20] + "b" * 20
        self.prefix = D.MIGRATE_NAME_PREFIX + self.token[:20]            # this test's slice of «every migration»: the deployer takes any LIKE pattern, the production one is the bare prefix
        self.serving_name = f"local:dev:{self.token[:12]}"
        self.children: list[subprocess.Popen] = []
        self.adm = self.connect()
        with self.adm.cursor() as cur:
            cur.execute("SELECT rolsuper OR pg_has_role(current_user, 'pg_signal_backend', 'member') FROM pg_roles WHERE rolname = current_user")
            if not cur.fetchone()[0]:
                self.adm.close()
                pytest.skip("the test role may not cancel / terminate other sessions (pg_signal_backend)")
            cur.execute(f"CREATE TABLE {self.table}(id int)")

    def connect(self):
        c = self.psycopg2.connect(connect_timeout=15, **self.dsn)
        c.autocommit = True
        return c

    def session(self, app_name: str, sql_after_lock: str, lock: str = "ALTER TABLE {t} ADD COLUMN x int") -> subprocess.Popen:
        """a client process whose connection is named ONLY by PGAPPNAME (as `docker compose run -e PGAPPNAME=…` does): takes a lock, then runs `sql_after_lock` (or sits idle in its transaction)"""
        code = ("import psycopg2, sys, time\n"
                f"c = psycopg2.connect(**{self.dsn!r})\n"
                f"cur = c.cursor(); cur.execute({lock.format(t=self.table)!r}); print('locked', flush=True)\n"
                + (f"cur.execute({sql_after_lock!r})\n" if sql_after_lock else "time.sleep(120)\n"))
        child = subprocess.Popen([sys.executable, "-c", code], env={**os.environ, "PGAPPNAME": app_name}, stdout=subprocess.PIPE, text=True)
        self.children.append(child)
        assert child.stdout.readline().strip() == "locked"
        return child

    def named(self, like: str) -> int:
        with self.adm.cursor() as cur:
            cur.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE %s", (like,))
            return cur.fetchone()[0]

    def wait_gone(self, like: str, seconds: float = 10) -> bool:
        deadline = time.time() + seconds
        while self.named(like) and time.time() < deadline:
            time.sleep(0.2)
        return self.named(like) == 0

    def deployer_sql(self, name: str) -> list[str]:
        env = {**os.environ, "POSTGRES_USER": self.dsn["user"], "PGHOST": str(self.dsn["host"]), "PGPORT": str(self.dsn["port"]), "PGDATABASE": "postgres"}
        if self.dsn.get("password"):
            env["PGPASSWORD"] = self.dsn["password"]
        out = subprocess.run(["sh", "-c", D.MIGRATE_SQL_SHELL, "sh", *D.migrate_sessions_sql(name + "%")], env=env, capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        return [l for l in out.stdout.splitlines() if l.strip()]

    def reader_waits(self) -> bool:
        r = self.connect()
        try:
            with r.cursor() as cur:
                cur.execute("SET statement_timeout = 1500")
                try:
                    cur.execute(f"SELECT count(*) FROM {self.table}")
                except self.psycopg2.errors.QueryCanceled:
                    return True
                return False
        finally:
            r.close()

    def close(self) -> None:
        for c in self.children:
            c.kill()
            c.wait()
        with self.adm.cursor() as cur:
            # story 4922 — killing the client ends an idle session at once but NOT a running `pg_sleep(120)`: the server goes on until the statement ends. A test that failed half way used to leave
            # that session (and its lock) for two minutes under the shared name, and the next test counted it. The sessions THIS test made are ended here, by the names that are its own.
            cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND (application_name LIKE %s OR application_name = %s)", (self.prefix + "%", self.serving_name))
            cur.execute(f"DROP TABLE IF EXISTS {self.table}")
        self.adm.close()


_needs_real = pytest.mark.skipif(not _REAL_DB_URL or not shutil.which("psql"), reason="real Postgres and psql needed")


@_needs_real
def test_a_running_migration_statement_is_cancelled_and_its_lock_freed_and_the_serving_session_is_not_touched(monkeypatch) -> None:
    monkeypatch.setattr(D, "CANCEL_GRACE_SECONDS", 1)
    real = _Real()
    t = None
    try:
        migration = real.session(real.name_b, "SELECT pg_sleep(120)")                      # the slow migration: ACCESS EXCLUSIVE lock, then a long statement
        assert real.named(real.name_b) == 1 and real.reader_waits(), "the lock holds the old release's reads"
        serving = real.connect()                                                          # a connection of the backend that serves: same role, other name, active at this moment
        with serving.cursor() as cur:
            cur.execute(f"SET application_name = '{real.serving_name}'")
        import threading
        errors: list[Exception] = []

        def serve() -> None:
            try:
                with serving.cursor() as cur:
                    cur.execute("SELECT pg_sleep(8)")
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        t = threading.Thread(target=serve)
        t.start()
        deadline = time.time() + 10
        while not real.named(real.serving_name) and time.time() < deadline:   # the serving statement is running before the clean-up looks
            time.sleep(0.05)
        assert real.named(real.serving_name) == 1
        lines = real.deployer_sql(real.name_b)
        assert lines[0] == "1", lines                                                      # one session cancelled
        assert lines[-1] == "0", lines                                                     # …and the cancel was enough while its client was alive: nothing was left to terminate
        assert real.wait_gone(real.name_b), "…and, whatever the cancel left, the session is gone after the call"
        assert not real.reader_waits(), "the lock is free"
        t.join()
        assert not errors, f"the serving session was hit: {errors}"
        with real.adm.cursor() as cur:
            cur.execute("SELECT count(*) FROM information_schema.columns WHERE table_name = %s AND column_name = 'x'", (real.table,))
            assert cur.fetchone()[0] == 0, "the migration's transaction was rolled back, not left half-done"
        serving.close()
    finally:
        if t is not None:
            t.join(timeout=20)
        real.close()


@_needs_real
def test_a_migration_session_left_idle_in_its_transaction_is_terminated_because_a_cancel_does_not_reach_it(monkeypatch) -> None:
    """the client of a timed-out migration is dead; what is left can be a session that is NOT running a statement but holds its locks (idle in transaction): `pg_cancel_backend` does nothing to it"""
    monkeypatch.setattr(D, "CANCEL_GRACE_SECONDS", 1)
    real = _Real()
    try:
        real.session(real.name_b, "")                                                      # takes the lock and sits idle in its transaction
        assert real.reader_waits()
        with real.adm.cursor() as cur:
            cur.execute("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = %s", (real.name_b,))
        assert real.named(real.name_b) == 1 and real.reader_waits(), "a cancel alone leaves it, lock and all"
        lines = real.deployer_sql(real.name_b)
        assert lines[-1] == "1", lines                                                     # one session had to be terminated
        assert real.wait_gone(real.name_b) and not real.reader_waits()
    finally:
        real.close()


@_needs_real
def test_one_release_name_touches_only_that_release_while_the_prefix_clears_every_migration(monkeypatch) -> None:
    monkeypatch.setattr(D, "CANCEL_GRACE_SECONDS", 0)
    real = _Real()
    try:
        # two migrations of two releases cannot both hold ALTER on one table: the second takes a lock of its own table
        real.session(real.name_a, "", lock="LOCK TABLE {t} IN ACCESS SHARE MODE")
        real.session(real.name_b, "", lock="LOCK TABLE {t} IN ACCESS SHARE MODE")
        real.deployer_sql(real.name_b)
        assert real.wait_gone(real.name_b) and real.named(real.name_a) == 1, "b's name touches b only"
        real.deployer_sql(real.prefix)
        assert real.wait_gone(real.prefix + "%"), "the prefix (before a new try) clears what an older release left"
    finally:
        real.close()


@_needs_real
def test_a_neighbour_named_like_the_app_does_not_move_this_tests_own_counts() -> None:
    """story 4922 — the root of the CI flake (runs 43449408634 · 43424348327: `assert named("local:dev") == 1` saw 2 and 3). `pg_stat_activity` is the whole cluster: the backend's pooled connections
    that earlier tests left behind carry the app's own name. A test that counts by that shared name is moved by its neighbours; one that counts by a name of its own is not."""
    real = _Real()
    neighbours = []
    own = None
    try:
        before = real.named("local:dev")                             # whatever else already carries the app's name (earlier tests, other processes): not ours to count
        for _ in range(2):                                           # what the tests before this one leave: the same role, the app's name, idle
            c = real.connect()
            with c.cursor() as cur:
                cur.execute("SET application_name = 'local:dev'")
            neighbours.append(c)
        shared = real.connect()                                      # the OLD shape of the serving session in this file: the shared name
        with shared.cursor() as cur:
            cur.execute("SET application_name = 'local:dev'")
        neighbours.append(shared)
        assert real.named("local:dev") == before + 3, "counted by the shared name, the test's own session is not alone (the CI flake: 2 and 3 where 1 was expected)"
        own = real.connect()                                         # the NEW shape: a name of its own
        with own.cursor() as cur:
            cur.execute(f"SET application_name = '{real.serving_name}'")
        assert real.named(real.serving_name) == 1, "counted by its own name, the neighbours do not matter"
        assert real.serving_name != "local:dev" and real.serving_name.startswith("local:dev:") and not real.serving_name.startswith(D.MIGRATE_NAME_PREFIX), "app-like, but never a migration name"
        assert real.name_a.startswith(D.MIGRATE_NAME_PREFIX) and real.name_b.startswith(D.MIGRATE_NAME_PREFIX) and real.name_a != real.name_b and len(real.name_b) <= 63, "migration names keep the deployer's shape"
    finally:
        for c in neighbours + ([own] if own is not None else []):
            c.close()
        real.close()
