"""story 4796 — links that are stored or bound into signed records are built from the API's public address, not from the request's host.

Behind the VM's pass-through front door the request's host is the Cloud Run host (the door sets `Host` to it), so the public link of a hosted-site post was stored with `run.app`, and the `web_origin` of
device-proof challenges carried it too. `settings.public_api_url` (`PUBLIC_API_URL`, set for dev from `_FASTAPI_URL`, the one switch) is the origin they are built from; empty keeps the old behaviour.

Pinned: the helper's order (configured → fallback → request host); the setting accepts only an origin; the four call sites use the helper and none builds an origin from the request any more; the dev pipeline sets
`PUBLIC_API_URL` from `_FASTAPI_URL` and prod states nothing — run for real (the deploy-backend step against a fake gcloud, after the same substitution Cloud Build does).
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from app.core import public_origin
from app.core.config import Settings

_ROOT = Path(__file__).resolve().parents[2]
DEV_API = "https://dev-api.sprintable.ai"
CLOUD_RUN = "https://sprintable-backend-dev-787818285179.asia-northeast3.run.app"


def _request(base: str):
    return SimpleNamespace(base_url=base)


@pytest.fixture
def configured(monkeypatch):
    def _set(value: str):
        monkeypatch.setattr(public_origin.settings, "public_api_url", value)
    return _set


def test_the_configured_public_address_wins_over_the_request_host_and_the_fallback(configured) -> None:
    configured(DEV_API)
    assert public_origin.public_api_origin(_request(CLOUD_RUN + "/"), fallback="https://other.example") == DEV_API


def test_without_a_configured_address_the_fallback_then_the_request_host_is_used(configured) -> None:
    configured("")
    assert public_origin.public_api_origin(_request(CLOUD_RUN + "/"), fallback="https://fallback.example/") == "https://fallback.example"
    assert public_origin.public_api_origin(_request(CLOUD_RUN + "/")) == CLOUD_RUN, "the old behaviour: the request's own host, no trailing slash"
    assert public_origin.public_api_origin(None) == "" and public_origin.public_api_origin(None, fallback="  ") == ""


@pytest.mark.parametrize("value,expected", [
    ("", ""), ("  ", ""), (DEV_API, DEV_API), (DEV_API + "/", DEV_API), ("https://api.example:8443", "https://api.example:8443"),
    ("http://localhost:8000", "http://localhost:8000"), ("http://127.0.0.1:8000/", "http://127.0.0.1:8000"),
])
def test_the_setting_accepts_an_origin_only(value: str, expected: str) -> None:
    assert Settings(public_api_url=value).public_api_url == expected


BAD = [
    "http://dev-api.sprintable.ai", "https://dev-api.sprintable.ai/api", "https://dev-api.sprintable.ai/?x=1", "https://dev-api.sprintable.ai#f",
    "https://user:pw@dev-api.sprintable.ai", "dev-api.sprintable.ai", "ftp://dev-api.sprintable.ai", "https://",
    "/", "//", "https://dev-api.sprintable.ai:abc", "https://dev-api.sprintable.ai:99999", "https://dev-api.sprintable.ai:0", "https://dev-api.sprintable.ai:",
    "https://dev-api.sprintable.ai?", "https://dev-api.sprintable.ai#", "https://@dev-api.sprintable.ai", "https://dev-api.sprintable.ai\\@evil.example", "https://dev-api .sprintable.ai", "https://dev-api.sprintable.ai\\path", "https://dev-api.sprintable.ai\\", "https://dev-api\u00a0.sprintable.ai", "https://dev-api\x0b.sprintable.ai", "https://dev-api\x0c.sprintable.ai", "https://dev-api\u2003.sprintable.ai", "https://dev-api\x00.sprintable.ai", "https://dev-api\u200b.sprintable.ai",
]


@pytest.mark.parametrize("value", BAD)
def test_a_value_that_is_not_an_origin_stops_the_app_at_start_up(value: str) -> None:
    with pytest.raises(ValueError):
        Settings(public_api_url=value)


@pytest.mark.parametrize("value", BAD + ["", "  "])
def test_the_shared_origin_check_refuses_the_same_values_and_an_empty_one_unless_allowed(value: str) -> None:
    from app.core.origin_check import parse_origin

    if value.strip():
        with pytest.raises(ValueError):
            parse_origin(value)
        with pytest.raises(ValueError):
            parse_origin(value, allow_empty=True)
    else:
        with pytest.raises(ValueError):
            parse_origin(value)
        assert parse_origin(value, allow_empty=True) == ""


def test_the_job_and_the_setting_use_the_one_origin_check() -> None:
    assert "from app.core.origin_check import parse_origin" in (_ROOT / "backend/scripts/jobs/rewrite_site_post_links.py").read_text()
    assert "from app.core.origin_check import parse_origin" in (_ROOT / "backend/app/core/config.py").read_text()
    assert "urlsplit" not in (_ROOT / "backend/scripts/jobs/rewrite_site_post_links.py").read_text(), "no second copy of the check"


def test_the_vm_declares_the_new_variable_and_the_live_names_know_it() -> None:
    """codex (public origin PR): the dev deploy adds PUBLIC_API_URL to the live service; the cutover name check fails on a live name the declaration does not know"""
    env = (_ROOT / "deploy/vm/env/dev.yaml").read_text()
    assert 'PUBLIC_API_URL: "https://dev-api.sprintable.ai"' in env.split("secrets:")[0], "an override of the backend: the VM's own value"
    names = (_ROOT / "deploy/vm/env/live-names.dev.txt").read_text()
    backend = names[names.index("## sprintable-backend-dev"):]
    assert "\nPUBLIC_API_URL <plain>\n" in backend.split("\n## ")[0] + "\n"
    assert "PUBLIC_API_URL" not in (_ROOT / "deploy/vm/env/live-names.prod.txt").read_text(), "the live prod service does not have the name (the pipeline's prod branch removes it until P7)"
    import yaml
    prod = yaml.safe_load((_ROOT / "deploy/vm/env/prod.yaml").read_text())["services"]["backend"]
    assert prod["added"]["PUBLIC_API_URL"] == "https://api.sprintable.ai" and "PUBLIC_API_URL" not in prod["overrides"], "since P6 the VM's prod backend states it, as an addition (the live service has no such name to override)"


def _hand_deploy_spec(env: str, **extra: str) -> str:
    import os

    proc = subprocess.run(["bash", str(_ROOT / "backend/scripts/deploy_backend.sh"), env], capture_output=True, text=True, env={**os.environ, "DRY_RUN": "1", **extra}, check=True)
    return next(line for line in proc.stdout.splitlines() if line.startswith("ENV_VARS_SPEC=")).split("=", 1)[1]


def test_the_hand_deploy_script_sets_the_public_address_for_dev_and_for_prod_only_with_the_api_name() -> None:
    dev = _hand_deploy_spec("dev").split("@")
    assert "PUBLIC_API_URL=" + DEV_API in dev and "FASTAPI_URL=" + DEV_API in dev
    prod = _hand_deploy_spec("prod").split("@")
    assert "PUBLIC_API_URL=https://api.sprintable.ai" in prod and "FASTAPI_URL=https://api.sprintable.ai" in prod, "P7: the default of prod is the API name (P1), and the origin follows it"
    old = "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app"
    assert not any(item.startswith("PUBLIC_API_URL=") for item in _hand_deploy_spec("prod", FASTAPI_URL=old).split("@")), "a prod deploy whose address is still the Cloud Run one states nothing"


def test_the_four_call_sites_use_the_helper_and_no_origin_is_built_from_the_request_any_more() -> None:
    expect = {
        "backend/app/routers/site_posts.py": ["backend_base_url=public_api_origin(request),"],
        "backend/app/routers/auth_native_bootstrap.py": ["web_origin=public_api_origin(request),"] * 2,
        "backend/app/routers/device_installations.py": ["web_origin=public_api_origin(request),"],
        "backend/app/services/site_posts.py": ["backend_base_url=public_api_origin(fallback=settings.backend_url),"],
    }
    for rel, needles in expect.items():
        text = (_ROOT / rel).read_text()
        for needle in set(needles):
            assert text.count(needle) == len(needles), (rel, needle)
        assert "from app.core.public_origin import public_api_origin" in text, rel
        assert "str(request.base_url)" not in re.sub(r"(?m)^\s*#.*$", "", text), f"{rel} still builds an origin from the request"
    assert 'str(request.base_url).rstrip("/")' in (_ROOT / "backend/app/core/public_origin.py").read_text(), "the one place that may"


def _deploy_backend_calls(tmp_path: Path, env: str, fastapi_url: str) -> list[str]:
    steps = {s["id"]: s for s in yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())["steps"]}
    body = steps["deploy-backend"]["args"][1]
    body = re.sub(r"\$\{(_[A-Z_0-9]+)\}", lambda m: {"_DEPLOY_ENV": env, "_FASTAPI_URL": fastapi_url}.get(m.group(1), "v"), body).replace("$$", "$")
    fake = tmp_path / "bin"
    fake.mkdir(exist_ok=True)
    log = tmp_path / "calls.log"
    log.write_text("")
    (fake / "gcloud").write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >> "$FAKE_LOG"; done\n')
    (fake / "gcloud").chmod(0o755)
    p = subprocess.run(["bash", "-c", body], env={"PATH": f"{fake}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp_path), "PROJECT_ID": "p", "COMMIT_SHA": "s"}, capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return log.read_text().splitlines()


def test_the_dev_deploy_sets_the_public_address_from_the_one_switch(tmp_path: Path) -> None:
    args = _deploy_backend_calls(tmp_path, "dev", DEV_API)
    items = next(a for a in args if a.startswith("--update-env-vars=")).split("=", 1)[1].split(",")
    assert f"PUBLIC_API_URL={DEV_API}" in items, items
    assert f"FASTAPI_URL={DEV_API}" in items, "the same value as the address handed to clients"


def test_the_prod_deploy_states_no_public_address(tmp_path: Path) -> None:
    args = _deploy_backend_calls(tmp_path, "prod", "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app")
    update = next(a for a in args if a.startswith("--update-env-vars="))
    assert "PUBLIC_API_URL" not in update, "prod keeps the request's host until its own move"
    assert "FASTAPI_URL=https://sprintable-backend-prod-787818285179.asia-northeast3.run.app" in update, "and the rest of the line is the real prod one"


def test_the_runbook_names_the_new_setting_and_the_job_steps_that_the_job_really_has() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec9 = text[text.index("## 9. "):text.index("## 10. ")]
    for needle in ("`PUBLIC_API_URL` (`deploy-backend` sets it from `_FASTAPI_URL`)", "instead of the request's own host", "prod states nothing until its own move", "stops the app at start-up"):
        assert needle in sec9, needle
    sec10 = text[text.index("## 10. "):text.index("## 11. ")]
    job = (_ROOT / "backend/scripts/jobs/rewrite_site_post_links.py").read_text()
    assert "**Dev: waived by the PO (2026-10-27, the shortcut).**" in sec10 and "**Prod: a precondition of Phase 3 (§7c)**" in sec10 and "**before Phase 3's final dump**" in sec10 and "which comes after the soak" in sec10
    p3 = text[text.index("**Phase 3"):text.index("## 8. ")]
    assert "the stored hosted-site links rewritten and the report showing no `run.app` origin (§10, «Stored hosted-site links»; **waived for dev** by the PO on 2026-10-27" in p3.split("\n1. ")[0] and "**required for prod**" in p3.split("\n1. ")[0]
    for needle in ("**Stored hosted-site links (story 4796).**", "python -m scripts.jobs.rewrite_site_post_links`", "--old-origin http://sprintable-backend-dev-787818285179.asia-northeast3.run.app --old-origin https://sprintable-backend-dev-787818285179.asia-northeast3.run.app", "--old-origin http://sprintable-backend-dev-57iommnikq-du.a.run.app --old-origin https://sprintable-backend-dev-57iommnikq-du.a.run.app", "with the scheme the report shows", "`--old-origin` accepts `http` or `https` because it only selects what is stored, while `--new-origin` must be `https`",
                   "--new-origin https://dev-api.sprintable.ai`", "with `--apply`", "exits non-zero unless nothing with an old origin is left", "origins and counts, never a full link", "Undo of the rewrite: **for `https` sources only**", "cannot be put back by the job", "**before the first `--apply`** take a backup (`sudo systemctl start sprintable-backup.service`, §11)"):
        assert needle in sec10, needle
    for needle in ("in a Cloud Run job, **before Phase 3's final dump**, so that dump already carries the rewritten links (the commands below are dev's; prod needs its own job, §12)", "sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links",
                   "gcloud run jobs describe sprintable-verify-oneoff --project $PROJECT --region $REGION --format=export > verify-oneoff-before.yaml",
                   "gcloud run jobs update sprintable-verify-oneoff --project $PROJECT --region $REGION --command=python --image", "--format='value(spec.template.spec.containers[0].image)'", "`jobs execute` takes only `--args`",
                   "gcloud run jobs execute sprintable-verify-oneoff --project $PROJECT --region $REGION --wait --args=-m,scripts.jobs.rewrite_site_post_links",
                   "gcloud run jobs replace verify-oneoff-before.yaml --project $PROJECT --region $REGION"):
        assert needle in sec10, needle
    assert "jobs execute sprintable-verify-oneoff --project $PROJECT --region $REGION --wait --command" not in sec10, "execute has no --command"
    for flag in ("--old-origin", "--new-origin", "--apply"):
        assert f'"{flag}"' in job, flag
    assert "return 0 if (done == total_before and left == 0) else 1" in job


def test_surrounding_whitespace_is_stripped_like_any_env_value_but_whitespace_inside_is_refused() -> None:
    from app.core.origin_check import parse_origin

    assert parse_origin("  https://dev-api.sprintable.ai/\n") == "https://dev-api.sprintable.ai"
    with pytest.raises(ValueError):
        parse_origin("https://dev-api .sprintable.ai")


def test_the_dev_deploy_does_not_remove_the_public_address_and_the_prod_deploy_removes_a_stale_one(tmp_path: Path) -> None:
    """codex (public origin PR, round 4): `--update-env-vars` is additive, so a value set by hand on prod would stay: prod states nothing, therefore removes it"""
    prod = _deploy_backend_calls(tmp_path, "prod", "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app")
    removed = next(a for a in prod if a.startswith("--remove-env-vars=")).split("=", 1)[1].split(",")
    assert "PUBLIC_API_URL" in removed
    dev = _deploy_backend_calls(tmp_path, "dev", DEV_API)
    assert "PUBLIC_API_URL" not in next(a for a in dev if a.startswith("--remove-env-vars=")).split("=", 1)[1].split(","), "the same key is never switched on and removed in one call"


def _hand_deploy_config(env: str, **extra: str) -> dict[str, str]:
    import os

    proc = subprocess.run(["bash", str(_ROOT / "backend/scripts/deploy_backend.sh"), env], capture_output=True, text=True, env={**os.environ, "DRY_RUN": "1", **extra}, check=True)
    return dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line and line.split("=", 1)[0].isupper())


def test_the_hand_deploy_script_removes_a_stale_public_address_on_prod_unless_it_has_the_api_name() -> None:
    old = "https://sprintable-backend-prod-787818285179.asia-northeast3.run.app"
    assert _hand_deploy_config("prod", FASTAPI_URL=old)["REMOVE_ENV_VARS"] == "PUBLIC_API_URL"
    assert _hand_deploy_config("prod")["REMOVE_ENV_VARS"] == "", "P7: with the API name the origin is set, nothing is removed"
    assert _hand_deploy_config("dev")["REMOVE_ENV_VARS"] == ""
    assert '${REMOVE_ENV_VARS:+--remove-env-vars="${REMOVE_ENV_VARS}"}' in (_ROOT / "backend/scripts/deploy_backend.sh").read_text()


def test_the_rewrite_job_refuses_to_run_without_a_database_url_instead_of_falling_back_to_a_local_one(monkeypatch) -> None:
    import asyncio

    from scripts.jobs import rewrite_site_post_links as job

    monkeypatch.setattr(job, "_db_url_summary", None)
    with pytest.raises(SystemExit) as exc:
        asyncio.run(job.run([DEV_API], DEV_API, True))
    assert "neither DATABASE_URL nor ALEMBIC_URL" in str(exc.value)


def test_section_12_lists_what_dev_taught_and_each_item_is_true_of_the_files() -> None:
    """the prod checklist names the state of the repository it asks to change"""
    import yaml

    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec = text[text.index("## 12. Prod"):]
    for needle in ("**Before the prod move — what dev taught", "is **empty** (P6, story 4796)", "the canonical prod value is empty since #5305 (`cloud-build.yml`: `realtime_url=` in the prod branch", "the prod GCE realtime gateways have been off since 2026-10-26 15:17Z (the PO's finding",
                   "**P7** makes the pipeline say the same for Cloud Run prod", "**only when it is exactly `https://api.sprintable.ai`**", "**states `https://api.sprintable.ai`**", "That file is read by the VM only: Cloud Run prod does not read it", "the same 20 + 10 as dev, inside the same 57 usable connections",
                   "The stored-link rewrite against prod", "Prod has no Cloud Run job for it", "none is made", "**in the backend container on the VM inside the freeze**", "with a backup first",
                   "**as the PO measured them on 2026-10-27, quoted here and not derivable from the repository**", "about 6 s after the front door started and about 15 s after the resolvers agreed"):
        assert needle in sec, needle
    prod = yaml.safe_load((_ROOT / "deploy/vm/env/prod.yaml").read_text())
    assert prod["services"]["frontend"]["overrides"]["REALTIME_URL"] == "", "P6: the declaration is empty, as the pipeline's prod branch has been since #5305"
    assert prod["services"]["backend"]["added"]["PUBLIC_API_URL"] == "https://api.sprintable.ai" and "PUBLIC_API_URL" not in prod["services"]["backend"]["overrides"], "P6: the VM's prod backend states the origin; the live service does not have it, so it is an addition"
    main = (_ROOT / "cloudbuild.yaml").read_text()
    assert 'REMOVE_ENV_VARS="$${REMOVE_ENV_VARS},PUBLIC_API_URL"' in main and 'REMOVE_ENV_VARS="$${REMOVE_ENV_VARS},DB_TIMING_LOG_ENABLED"' in main
    # the claims that ARE derivable from the repository: the prod stream address is empty in the pipeline, and no prod one-off job is provisioned
    workflow = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
    prod_branch = workflow[workflow.index('echo "fastapi_url=https://api.sprintable.ai"'):workflow.index("story #2701")]
    assert 'echo "realtime_url=" >> "$GITHUB_OUTPUT"' in prod_branch, "the prod branch states an empty stream address (#5305)"
    jobs_readme = (_ROOT / "backend/scripts/jobs/README.md").read_text()
    assert "The only currently-provisioned Cloud Run Job for this is **`sprintable-verify-oneoff`**\n(dev)." in jobs_readme, "no prod one-off job is provisioned"
    assert (prod["services"]["backend"]["overrides"]["DB_POOL_SIZE"], prod["services"]["backend"]["overrides"]["DB_MAX_OVERFLOW"]) == ("20", "10")


def test_the_dev_waiver_is_stated_the_same_way_in_every_place_that_speaks_of_the_link_rewrite() -> None:
    """codex (wording PR): §9 said "a precondition of Phase 3" without the waiver while §7c and §10 said waived for dev"""
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    for marker in ("rewritten by the one-off job of §10", "**Dev: waived by the PO (2026-10-27, the shortcut).**", "**waived for dev** by the PO on 2026-10-27"):
        assert marker in text, marker
    assert "(«Stored hosted-site links»), a precondition of Phase 3;" not in text, "the unconditional sentence"
    assert "a precondition of Phase 3 for prod, waived for dev by the PO (the job runs on the VM afterwards)" in text


def test_a_prefix_may_be_plain_http_but_an_address_that_is_written_may_not() -> None:
    """the first dev report listed `http://…run.app` links (the request scheme behind the front door): `--old-origin` must be able to name them; everything else about an origin stays as strict"""
    from app.core.origin_check import parse_origin

    host = "http://sprintable-backend-dev-787818285179.asia-northeast3.run.app"
    assert parse_origin(host, allow_http=True) == host and parse_origin(host + "/", allow_http=True) == host
    with pytest.raises(ValueError):
        parse_origin(host)                      # not as an address that is written
    with pytest.raises(ValueError):
        Settings(public_api_url=host)           # the setting never takes it
    for still_bad in (host + "/path", host + "?q=1", "http://u:p@h.example", "http://", "http://h.example:abc", "ftp://h.example", "http://h .example", "http://h.example\\x"):
        with pytest.raises(ValueError):
            parse_origin(still_bad, allow_http=True)


def test_the_undo_claim_does_not_promise_what_the_job_cannot_do() -> None:
    """codex (http prefix PR): an http source cannot be restored by swapping the origins because the written origin is never plain http"""
    from scripts.jobs import rewrite_site_post_links as job

    with pytest.raises(SystemExit):
        job.check_origin("http://sprintable-backend-dev-787818285179.asia-northeast3.run.app", what="--new-origin")
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec10 = text[text.index("## 10. "):text.index("## 11. ")]
    assert "Undo of the rewrite: the same job with the two origins swapped" not in sec10, "the old unconditional claim"
    assert (_ROOT / "deploy/vm/systemd/sprintable-backup.service").exists(), "the backup unit the runbook tells the reader to start"
