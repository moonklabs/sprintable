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
    assert "PUBLIC_API_URL" not in (_ROOT / "deploy/vm/env/live-names.prod.txt").read_text() and "PUBLIC_API_URL" not in (_ROOT / "deploy/vm/env/prod.yaml").read_text(), "prod states nothing yet"


def _hand_deploy_spec(env: str) -> str:
    import os

    proc = subprocess.run(["bash", str(_ROOT / "backend/scripts/deploy_backend.sh"), env], capture_output=True, text=True, env={**os.environ, "DRY_RUN": "1"}, check=True)
    return next(line for line in proc.stdout.splitlines() if line.startswith("ENV_VARS_SPEC=")).split("=", 1)[1]


def test_the_hand_deploy_script_sets_the_public_address_for_dev_only() -> None:
    dev = _hand_deploy_spec("dev").split("@")
    assert "PUBLIC_API_URL=" + DEV_API in dev and "FASTAPI_URL=" + DEV_API in dev
    assert not any(item.startswith("PUBLIC_API_URL=") for item in _hand_deploy_spec("prod").split("@")), "prod states nothing"


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
    for needle in ("**Stored hosted-site links (story 4796).**", "python -m scripts.jobs.rewrite_site_post_links`", "--old-origin https://sprintable-backend-dev-787818285179.asia-northeast3.run.app", "--old-origin https://sprintable-backend-dev-57iommnikq-du.a.run.app",
                   "--new-origin https://dev-api.sprintable.ai`", "with `--apply`", "exits non-zero unless nothing with an old origin is left", "origins and counts, never a full link", "Undo of the rewrite"):
        assert needle in sec10, needle
    for needle in ("in the Cloud Run job, **before Phase 3's final dump**, so that dump already carries the rewritten links", "sudo docker exec sprintable-backend-1 python -m scripts.jobs.rewrite_site_post_links",
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


def _hand_deploy_config(env: str) -> dict[str, str]:
    import os

    proc = subprocess.run(["bash", str(_ROOT / "backend/scripts/deploy_backend.sh"), env], capture_output=True, text=True, env={**os.environ, "DRY_RUN": "1"}, check=True)
    return dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line and line.split("=", 1)[0].isupper())


def test_the_hand_deploy_script_removes_a_stale_public_address_on_prod_only() -> None:
    assert _hand_deploy_config("prod")["REMOVE_ENV_VARS"] == "PUBLIC_API_URL"
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
    for needle in ("**Before the prod move — what dev taught", "still names `https://realtime.sprintable.ai`", "the canonical prod value is empty since #5305", "The prod GCE realtime gateways have been off since 2026-10-26 15:17Z",
                   "the pipeline's prod branch removes it (`--remove-env-vars`)", "set it to `https://api.sprintable.ai`", "the same 20 + 10 as dev, inside the same 57 usable connections",
                   "The stored-link job against Cloud SQL **before** the final dump", "certificate gap about 6 s"):
        assert needle in sec, needle
    prod = yaml.safe_load((_ROOT / "deploy/vm/env/prod.yaml").read_text())
    assert prod["services"]["frontend"]["overrides"]["REALTIME_URL"] == "https://realtime.sprintable.ai", "the item is still open: change this line and the pin together, then this runbook item"
    assert "PUBLIC_API_URL" not in prod["services"]["backend"]["overrides"] and "PUBLIC_API_URL" not in str(prod["services"]["backend"].get("added") or {})
    main = (_ROOT / "cloudbuild.yaml").read_text()
    assert 'REMOVE_ENV_VARS="$${REMOVE_ENV_VARS},DB_TIMING_LOG_ENABLED,PUBLIC_API_URL"' in main
    assert (prod["services"]["backend"]["overrides"]["DB_POOL_SIZE"], prod["services"]["backend"]["overrides"]["DB_MAX_OVERFLOW"]) == ("20", "10")
