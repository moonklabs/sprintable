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


@pytest.mark.parametrize("value", [
    "http://dev-api.sprintable.ai", "https://dev-api.sprintable.ai/api", "https://dev-api.sprintable.ai/?x=1", "https://dev-api.sprintable.ai#f",
    "https://user:pw@dev-api.sprintable.ai", "dev-api.sprintable.ai", "ftp://dev-api.sprintable.ai", "https://",
])
def test_a_value_that_is_not_an_origin_stops_the_app_at_start_up(value: str) -> None:
    with pytest.raises(ValueError):
        Settings(public_api_url=value)


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
    for needle in ("**Stored hosted-site links (story 4796).**", "python -m scripts.jobs.rewrite_site_post_links`", "--old-origin https://sprintable-backend-dev-787818285179.asia-northeast3.run.app", "--old-origin https://sprintable-backend-dev-57iommnikq-du.a.run.app",
                   "--new-origin https://dev-api.sprintable.ai`", "with `--apply`", "exits non-zero unless nothing with an old origin is left", "origins and counts, never a full link", "Undo of the rewrite"):
        assert needle in sec10, needle
    for flag in ("--old-origin", "--new-origin", "--apply"):
        assert f'"{flag}"' in job, flag
    assert "return 0 if (done == total_before and left == 0) else 1" in job
