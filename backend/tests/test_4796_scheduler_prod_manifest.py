"""story 4796 (P4 of the prod cutover) - prod's Cloud Scheduler jobs are defined in the repository, exactly as they run.

Why: the prod cutover moves the jobs' target from the Cloud Run backend to the VM's API name, and the repository is the source of truth (no value changed only by hand). The manifest was dev's 27 jobs with
`environments.dev` alone, so `apply_cloud_scheduler.py --env prod` stopped with a KeyError; and had it not, it would have created dev's other 23 jobs in prod and moved two schedules.
Now: `environments.prod.jobs` names the four jobs prod has, and `env_overrides.prod` carries the two schedules that differ from dev's.

The expected values below are the product owner's read-only dump of the live prod jobs (2026-10-28; names, schedules, time zones, methods, paths, deadlines, retry values, and the NAMES of the headers - no header value).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "infra" / "cloud-scheduler" / "jobs.json"
API = "https://api.sprintable.ai"
OLD = "https://sprintable-backend-prod-57iommnikq-du.a.run.app"   # the address form the live prod jobs carry today
SECRET = "test-bearer-not-a-real-secret"
ROUTE = "/api/v2/internal/cron/"

# name -> (schedule, time zone, method, route, attempt deadline, header names)
LIVE = {
    "publication-commands-prod": ("* * * * *", "Etc/UTC", "POST", "publication-commands", "1800s", ["Authorization", "Content-Type", "User-Agent"]),
    "a2a-task-deadline-sweep-prod": ("*/10 * * * *", "Etc/UTC", "GET", "a2a-task-deadline-sweep", "180s", ["Authorization", "User-Agent"]),
    "storage-usage-warn-prod": ("0 9 * * *", "Asia/Seoul", "GET", "storage-usage-warn", "180s", ["Authorization", "User-Agent"]),
    "assets-grace-hard-delete-prod": ("0 3 * * *", "Asia/Seoul", "GET", "assets-grace-hard-delete", "180s", ["Authorization", "User-Agent"]),
}
RETRY = {"maxBackoffDuration": "3600s", "maxDoublings": 5, "maxRetryDuration": "0s", "minBackoffDuration": "5s"}


def _load():
    spec = importlib.util.spec_from_file_location("apply_cloud_scheduler_p4", REPO_ROOT / "infra" / "apply_cloud_scheduler.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _live_prod(base: str = OLD) -> list[dict]:
    out = []
    for name, (schedule, tz, method, route, deadline, header_names) in LIVE.items():
        headers = {h: ("Bearer " + SECRET if h == "Authorization" else "application/json" if h == "Content-Type" else "Google-Cloud-Scheduler") for h in header_names}
        out.append({"name": f"projects/p/locations/asia-northeast3/jobs/{name}", "schedule": schedule, "timeZone": tz, "attemptDeadline": deadline,
                    "httpTarget": {"uri": f"{base}{ROUTE}{route}", "httpMethod": method, "headers": headers}, "retryConfig": dict(RETRY)})
    return out


def test_prod_has_exactly_the_four_jobs_it_runs_and_dev_still_has_all_of_its_own(manifest) -> None:
    mod = _load()
    prod = mod.desired_jobs(manifest, "prod", SECRET, base_url=API)
    assert sorted(j.name for j in prod) == sorted(LIVE), "prod's jobs are the four of the live prod project, with the -prod suffix"
    dev = mod.desired_jobs(manifest, "dev", SECRET, base_url="https://dev-api.sprintable.ai")
    assert len(dev) == len(manifest["jobs"]) and len(dev) > 20 and all(j.name.endswith("-dev") for j in dev), "dev takes every job of the manifest as before"
    assert "jobs" not in manifest["environments"]["dev"], "no list for dev: every job"


def test_every_value_of_a_prod_job_equals_what_runs_today_except_the_address(manifest) -> None:
    mod = _load()
    prod = {j.name: j for j in mod.desired_jobs(manifest, "prod", SECRET, base_url=API)}
    for name, (schedule, tz, method, route, deadline, header_names) in LIVE.items():
        job = prod[name]
        assert (job.schedule, job.time_zone, job.http_method, job.attempt_deadline) == (schedule, tz, method, deadline), name
        assert job.uri == f"{API}{ROUTE}{route}", name
        assert sorted(job.headers) == sorted(header_names), name
        assert (job.retry["max_retry_attempts"], job.retry["min_backoff"], job.retry["max_backoff"], job.retry["max_doublings"], job.retry["max_retry_duration"]) == (0, "5s", "3600s", 5, "0s"), name


def test_the_plan_against_the_live_prod_jobs_is_four_updates_of_the_address_and_nothing_else(manifest) -> None:
    mod = _load()
    desired = mod.desired_jobs(manifest, "prod", SECRET, base_url=API)
    plan = mod.make_plan(desired, _live_prod(), "prod")
    assert plan.create == [] and plan.unmanaged == [] and plan.unchanged == [], (plan.create, plan.unmanaged)
    assert sorted(job.name for job, _ in plan.update) == sorted(LIVE)
    assert all(changed == ["uri"] for _, changed in plan.update), [changed for _, changed in plan.update]
    # once the address is the new one, applying prod changes nothing at all
    again = mod.make_plan(desired, _live_prod(API), "prod")
    assert again.update == [] and again.create == [] and len(again.unchanged) == 4


def test_without_the_overrides_the_plan_would_have_moved_two_schedules(manifest) -> None:
    """the reason for env_overrides: dev's two daily jobs run at other times than prod's"""
    mod = _load()
    stripped = json.loads(json.dumps(manifest))
    for job in stripped["jobs"]:
        job.pop("env_overrides", None)
    plan = mod.make_plan(mod.desired_jobs(stripped, "prod", SECRET, base_url=API), _live_prod(API), "prod")
    changed = {job.name: changed for job, changed in plan.update}
    assert sorted(changed) == ["assets-grace-hard-delete-prod", "storage-usage-warn-prod"] and all(c == ["schedule"] for c in changed.values()), changed
    dev_jobs = {j["name"]: j["schedule"] for j in manifest["jobs"]}
    assert dev_jobs["storage-usage-warn"] == "45 3 * * *" and dev_jobs["assets-grace-hard-delete"] == "30 4 * * *", "dev keeps its own schedules"


def test_dev_schedules_are_not_touched_by_the_prod_overrides(manifest) -> None:
    mod = _load()
    dev = {j.name: j for j in mod.desired_jobs(manifest, "dev", SECRET, base_url=API)}
    assert dev["storage-usage-warn-dev"].schedule == "45 3 * * *" and dev["assets-grace-hard-delete-dev"].schedule == "30 4 * * *"


def test_a_job_list_naming_a_job_the_manifest_does_not_define_is_refused(manifest) -> None:
    mod = _load()
    manifest["environments"]["prod"]["jobs"].append("no-such-job")
    with pytest.raises(ValueError, match="no-such-job"):
        mod.desired_jobs(manifest, "prod", SECRET, base_url=API)


@pytest.mark.parametrize("key", ["route", "name", "basis", "unknown"])
def test_an_override_may_only_set_what_an_environment_really_differs_in(manifest, key: str) -> None:
    mod = _load()
    next(j for j in manifest["jobs"] if j["name"] == "storage-usage-warn")["env_overrides"]["prod"][key] = "x"
    with pytest.raises(ValueError, match="may not set"):
        mod.desired_jobs(manifest, "prod", SECRET, base_url=API)


class _Fake:
    def __init__(self, live: list[dict]) -> None:
        self.live, self.calls = live, []

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        if args[:3] == ["run", "services", "describe"]:
            return json.dumps({"spec": {"template": {"spec": {"containers": [{"env": [{"name": "CRON_SECRET", "valueFrom": {"secretKeyRef": {"name": "cron-secret", "key": "latest"}}}]}]}}}, "status": {"url": OLD}})
        if args[:3] == ["secrets", "versions", "access"]:
            return SECRET + "\n"
        if args[:3] == ["scheduler", "jobs", "list"]:
            return json.dumps(self.live)
        raise AssertionError(f"unexpected gcloud call: {args}")


def test_the_dry_run_of_prod_prints_four_updates_creates_nothing_and_never_prints_the_secret(manifest, capsys) -> None:
    mod = _load()
    fake = _Fake(_live_prod())
    assert mod.main(["--env", "prod", "--base-url", API], run=fake) == 0
    out = capsys.readouterr().out
    assert out.count("UPDATE ") == 4 and "CREATE" not in out and "UNMANAGED" not in out and "UNCHANGED 0" in out and "dry-run" in out
    assert SECRET not in out
    assert [c for c in fake.calls if c[:3] == ["run", "services", "describe"]] and "sprintable-backend-prod" in " ".join(fake.calls[0]), "the bearer is read from the prod backend (still on Cloud Run at that step)"
    assert not [c for c in fake.calls if c[:3] in (["scheduler", "jobs", "update"], ["scheduler", "jobs", "create"])], "a dry run changes nothing"


def test_the_environment_block_of_prod_names_the_prod_backend_and_the_same_region(manifest) -> None:
    prod = manifest["environments"]["prod"]
    assert prod["backend_service"] == "sprintable-backend-prod" and prod["location"] == manifest["environments"]["dev"]["location"]
    assert prod["jobs"] == ["publication-commands", "a2a-task-deadline-sweep", "storage-usage-warn", "assets-grace-hard-delete"]
    for name in prod["jobs"]:
        assert sum(1 for j in manifest["jobs"] if j["name"] == name) == 1, name


def test_the_deploy_step_still_applies_the_scheduler_for_dev_only() -> None:
    """P4 puts prod in the manifest; it does not make the prod build apply it (the cutover sheet runs the script once, by hand)"""
    cloudbuild = (REPO_ROOT / "cloudbuild.yaml").read_text(encoding="utf-8")
    step = cloudbuild.split("id: apply-cloud-scheduler")[1].split("\n  - id: ")[0]
    assert 'if [ "${_DEPLOY_ENV}" != "dev" ]; then' in step and "dev 전용 스텝이라 스킵" in step, "any environment but dev skips the step"
    assert "--env prod" not in step
