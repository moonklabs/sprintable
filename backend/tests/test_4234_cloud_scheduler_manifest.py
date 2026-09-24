"""story #4234 — cron 라우트 ↔ Cloud Scheduler 정의(`infra/cloud-scheduler/jobs.json`) 대조 가드 + 적용 스크립트 단위 테스트.

결함: dev 스케줄러 작업은 손으로 만든 것이라 레포에 정의가 없었고, `workflow-sla`·`workflow-handoff-watchdog` 라우트가
생긴 뒤에도 작업이 없다는 걸 아무도 몰랐다(4228·4190 SLA 경로가 dev에서 한 번도 안 돎). 이제:
- 모든 cron 라우트(백엔드 `/api/v2/internal/cron/*` + FE `/api/cron/*`)는 정의의 `jobs`(주기) 아니면 `unscheduled`
  (일회성·수동)에 **정확히 한 번** 분류돼야 한다 — 새 라우트가 분류 없이 생기면 RED.
- 정의의 작업·분류가 가리키는 라우트는 실제로 있어야 하고, 작업의 method는 라우트와 같아야 한다.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "infra" / "cloud-scheduler" / "jobs.json"
FE_CRON_DIR = REPO_ROOT / "apps" / "web" / "src" / "app" / "api" / "cron"


def _load_apply_module():
    spec = importlib.util.spec_from_file_location("apply_cloud_scheduler", REPO_ROOT / "infra" / "apply_cloud_scheduler.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # dataclass(+postponed annotations)가 모듈을 sys.modules에서 찾는다
    spec.loader.exec_module(mod)
    return mod


def _backend_cron_routes() -> dict[str, set[str]]:
    """`/api/v2/internal/cron/` 뒤 경로 → HTTP method 집합(라우터를 실제로 import해 읽음)."""
    from app.routers.cron import router

    prefix = "/api/v2/internal/cron/"
    out: dict[str, set[str]] = {}
    for route in router.routes:
        path = getattr(route, "path", "")
        assert path.startswith(prefix), path
        out.setdefault(path[len(prefix):], set()).update(route.methods or set())
    return out


def _fe_cron_routes() -> set[str]:
    if not FE_CRON_DIR.exists():
        return set()
    return {p.parent.relative_to(FE_CRON_DIR).as_posix() for p in FE_CRON_DIR.rglob("route.ts")}


def guard_violations(manifest: dict, backend: dict[str, set[str]], fe: set[str]) -> list[str]:
    """가드 본체 — 위반 문장 목록(비면 통과). 테스트가 사본 정의·가짜 라우트로 뮤테이션을 고정하려고 함수로 뺐다."""
    problems: list[str] = []
    classified: list[str] = [j["route"] for j in manifest["jobs"]] + [u["route"] for u in manifest["unscheduled"]]
    for route in sorted({r for r in classified if classified.count(r) > 1}):
        problems.append(f"두 번 분류됨: {route}")
    names = [j["name"] for j in manifest["jobs"]]
    for name in sorted({n for n in names if names.count(n) > 1}):
        problems.append(f"작업 이름 중복: {name}")
    for route in sorted(set(backend) - set(classified)):
        problems.append(f"분류 없는 백엔드 cron 라우트: {route} — jobs.json의 jobs(주기) 또는 unscheduled(일회성·수동)에 넣을 것")
    for route in sorted(fe - set(classified)):
        problems.append(f"분류 없는 FE cron 라우트: /api/cron/{route}")
    for job in manifest["jobs"]:
        methods = backend.get(job["route"])
        if methods is None:
            problems.append(f"없는 라우트를 가리키는 작업: {job['name']} → {job['route']}")
        elif job["method"] not in methods:
            problems.append(f"method 불일치: {job['name']} {job['method']} vs 라우트 {sorted(methods)}")
        if not job.get("basis"):
            problems.append(f"근거 없는 작업: {job['name']}")
    for item in manifest["unscheduled"]:
        if item["route"] not in backend and item["route"] not in fe:
            problems.append(f"없는 라우트를 분류함: {item['route']}")
        if item.get("kind") not in ("one_off", "manual"):
            problems.append(f"알 수 없는 kind: {item['route']} {item.get('kind')!r}")
        if not item.get("basis"):
            problems.append(f"근거 없는 분류: {item['route']}")
    return problems


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def test_every_cron_route_is_classified_exactly_once_and_jobs_match_real_routes(manifest):
    assert guard_violations(manifest, _backend_cron_routes(), _fe_cron_routes()) == []


def test_route_inventory_is_real():
    """라우트 수집이 조용히 비지 않았다 — 이 카드의 두 라우트가 실제로 잡힌다."""
    backend = _backend_cron_routes()
    assert len(backend) >= 25
    assert backend["workflow-sla"] == {"GET"} and backend["workflow-handoff-watchdog"] == {"GET"}


def test_sla_and_handoff_watchdog_are_scheduled(manifest):
    """이 카드의 결함 자체 — 두 작업이 주기 정의에 있다."""
    scheduled = {j["route"] for j in manifest["jobs"]}
    assert {"workflow-sla", "workflow-handoff-watchdog"} <= scheduled


def test_guard_goes_red_when_a_job_is_dropped(manifest):
    """뮤테이션 — 정의에서 작업 하나를 빼면 그 라우트가 «분류 없음»으로 RED."""
    mutated = {**manifest, "jobs": [j for j in manifest["jobs"] if j["route"] != "workflow-sla"]}
    assert guard_violations(mutated, _backend_cron_routes(), _fe_cron_routes()) == [
        "분류 없는 백엔드 cron 라우트: workflow-sla — jobs.json의 jobs(주기) 또는 unscheduled(일회성·수동)에 넣을 것",
    ]


def test_guard_goes_red_when_a_new_route_appears_unclassified(manifest):
    """뮤테이션 — 새 cron 라우트(백엔드·FE 각각)가 분류 없이 생기면 RED."""
    backend = {**_backend_cron_routes(), "brand-new-sweep": {"GET"}}
    problems = guard_violations(manifest, backend, _fe_cron_routes() | {"brand-new-proxy"})
    assert "분류 없는 백엔드 cron 라우트: brand-new-sweep — jobs.json의 jobs(주기) 또는 unscheduled(일회성·수동)에 넣을 것" in problems
    assert "분류 없는 FE cron 라우트: /api/cron/brand-new-proxy" in problems


def test_guard_goes_red_on_wrong_method_or_missing_route(manifest):
    jobs = [dict(j) for j in manifest["jobs"]]
    jobs[0]["method"] = "DELETE"
    jobs.append({**jobs[1], "name": "ghost", "route": "no-such-route"})
    problems = guard_violations({**manifest, "jobs": jobs}, _backend_cron_routes(), _fe_cron_routes())
    assert any(p.startswith(f"method 불일치: {jobs[0]['name']}") for p in problems), problems
    assert "없는 라우트를 가리키는 작업: ghost → no-such-route" in problems


# ─── 적용 스크립트(infra/apply_cloud_scheduler.py) ─────────────────────────────

_SECRET = "s3cr3t-value-4234"
_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"


def _live_from_desired(job) -> dict:
    r = job.retry
    return {
        "name": f"projects/p/locations/asia-northeast3/jobs/{job.name}",
        "schedule": job.schedule, "timeZone": job.time_zone, "attemptDeadline": job.attempt_deadline,
        "httpTarget": {"uri": job.uri, "httpMethod": job.http_method, "headers": dict(job.headers)},
        "retryConfig": {
            "retryCount": r["max_retry_attempts"], "minBackoffDuration": r["min_backoff"],
            "maxBackoffDuration": r["max_backoff"], "maxDoublings": r["max_doublings"],
            "maxRetryDuration": r["max_retry_duration"],
        },
    }


class _FakeGcloud:
    def __init__(self, live: list[dict], *, cron_env: dict | None = None):
        self.live = live
        self.calls: list[list[str]] = []
        self.cron_env = cron_env if cron_env is not None else {
            "name": "CRON_SECRET", "valueFrom": {"secretKeyRef": {"name": "cron-secret", "key": "latest"}},
        }

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        if args[:3] == ["run", "services", "describe"]:
            env = [self.cron_env] if self.cron_env else []
            return json.dumps({"spec": {"template": {"spec": {"containers": [{"env": env}]}}}, "status": {"url": _URL}})
        if args[:3] == ["secrets", "versions", "access"]:
            return _SECRET + "\n"
        if args[:3] == ["scheduler", "jobs", "list"]:
            return json.dumps(self.live)
        if args[:3] == ["scheduler", "jobs", "create"] or args[:3] == ["scheduler", "jobs", "update"]:
            return ""
        raise AssertionError(f"예상 밖 gcloud 호출: {args}")


def test_plan_is_empty_when_live_equals_the_definition(manifest):
    mod = _load_apply_module()
    desired = mod.desired_jobs(manifest, "dev", _SECRET, base_url=_URL)
    plan = mod.make_plan(desired, [_live_from_desired(j) for j in desired], "dev")
    assert (plan.create, plan.update, plan.unmanaged) == ([], [], [])
    assert len(plan.unchanged) == len(manifest["jobs"])


def test_plan_creates_missing_updates_changed_and_only_reports_unmanaged(manifest):
    mod = _load_apply_module()
    desired = mod.desired_jobs(manifest, "dev", _SECRET, base_url=_URL)
    live = [_live_from_desired(j) for j in desired if j.name != "workflow-sla-dev"]
    live[0]["schedule"] = "0 0 * * *"
    live.append({**_live_from_desired(desired[1]), "name": "projects/p/locations/l/jobs/hand-made-dev"})
    live.append({**_live_from_desired(desired[1]), "name": "projects/p/locations/l/jobs/storage-usage-warn"})  # 다른 env
    plan = mod.make_plan(desired, live, "dev")
    assert [j.name for j in plan.create] == ["workflow-sla-dev"]
    assert [(j.name, changed) for j, changed in plan.update] == [(desired[0].name, ["schedule"])]
    assert plan.unmanaged == ["hand-made-dev"]


def test_bearer_comes_only_from_the_backend_secret_key_ref():
    mod = _load_apply_module()
    def _resolve(fake):
        return mod.resolve_bearer(fake, mod.describe_backend(fake, service="s", region="r"), service="s")

    assert _resolve(_FakeGcloud([])) == (_SECRET, "secretKeyRef cron-secret:latest")
    with pytest.raises(SystemExit, match="secretKeyRef가 아님"):
        _resolve(_FakeGcloud([], cron_env={"name": "CRON_SECRET", "value": "plain"}))
    with pytest.raises(SystemExit, match="CRON_SECRET이 없음"):
        _resolve(_FakeGcloud([], cron_env={}))


def test_job_uri_host_comes_from_the_backend_status_url(manifest):
    """호스트는 정의 파일에 없다 — 실물 서비스 `status.url` + route_prefix + route."""
    mod = _load_apply_module()
    assert "backend_base_url" not in manifest["environments"]["dev"]
    job = next(j for j in mod.desired_jobs(manifest, "dev", _SECRET, base_url=_URL + "/") if j.name == "workflow-sla-dev")
    assert job.uri == f"{_URL}/api/v2/internal/cron/workflow-sla"


def test_no_path_builds_a_job_without_authorization(manifest):
    mod = _load_apply_module()
    with pytest.raises(ValueError):
        mod.desired_jobs(manifest, "dev", "", base_url=_URL)
    assert all(j.headers["Authorization"] == f"Bearer {_SECRET}" for j in mod.desired_jobs(manifest, "dev", _SECRET, base_url=_URL))


def test_dry_run_changes_nothing_and_never_prints_the_secret(manifest, capsys):
    mod = _load_apply_module()
    desired = mod.desired_jobs(manifest, "dev", _SECRET, base_url=_URL)
    fake = _FakeGcloud([_live_from_desired(j) for j in desired if j.name != "workflow-sla-dev"])
    assert mod.main(["--env", "dev"], run=fake) == 0
    out = capsys.readouterr().out
    assert "CREATE workflow-sla-dev" in out and "dry-run" in out
    assert _SECRET not in out
    assert not [c for c in fake.calls if c[:3] in (["scheduler", "jobs", "create"], ["scheduler", "jobs", "update"])]


def test_apply_fails_when_live_still_differs_afterwards(manifest, capsys):
    """적용 뒤 다시 읽어 정의와 다르면 0이 아닌 코드(빌드 실패) — 가짜 gcloud가 create를 받아도 실물에 반영하지 않는 경우."""
    mod = _load_apply_module()
    desired = mod.desired_jobs(manifest, "dev", _SECRET, base_url=_URL)
    fake = _FakeGcloud([_live_from_desired(j) for j in desired if j.name != "workflow-sla-dev"])
    assert mod.main(["--env", "dev", "--apply"], run=fake) == 1
    creates = [c for c in fake.calls if c[:3] == ["scheduler", "jobs", "create"]]
    assert [c[4] for c in creates] == ["workflow-sla-dev"]
    assert _SECRET not in capsys.readouterr().out
