"""story #4513 (PO 01:53Z) — the health read says what the instance runs: commit · revision · build time, each «unknown» when
absent or off its shape (a value is never echoed unchecked). A deploy is confirmed serving by this read, not only by gcloud."""
from __future__ import annotations

import pytest

SHA = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def build_time_file(tmp_path, monkeypatch):
    import app.core.build_info as bi

    f = tmp_path / ".build_time"
    monkeypatch.setattr(bi, "_BUILD_TIME_FILE", f)
    return f


def test_reports_the_commit_revision_and_build_time(monkeypatch, build_time_file):
    from app.core.build_info import build_info

    monkeypatch.setenv("APP_COMMIT_SHA", SHA)
    monkeypatch.setenv("K_REVISION", "sprintable-backend-dev-00412-abc")
    build_time_file.write_text("2026-10-03T01:55:00Z\n")
    assert build_info() == {"commit_sha": SHA, "revision": "sprintable-backend-dev-00412-abc", "build_time": "2026-10-03T01:55:00Z"}


def test_absent_values_are_unknown(monkeypatch, build_time_file):
    from app.core.build_info import build_info

    monkeypatch.delenv("APP_COMMIT_SHA", raising=False)
    monkeypatch.delenv("K_REVISION", raising=False)
    assert build_info() == {"commit_sha": "unknown", "revision": "unknown", "build_time": "unknown"}


@pytest.mark.parametrize("sha,revision,time", [
    ("unknown", "x" * 70, "yesterday"),
    ("not-a-sha!", "Has Spaces", "2026-10-03 01:55"),
    ("postgresql://user:pw@10.0.0.1/db", "https://internal.example", "<script>"),
])
def test_values_off_their_shape_are_unknown_never_echoed(monkeypatch, build_time_file, sha, revision, time):
    from app.core.build_info import build_info

    monkeypatch.setenv("APP_COMMIT_SHA", sha)
    monkeypatch.setenv("K_REVISION", revision)
    build_time_file.write_text(time)
    assert build_info() == {"commit_sha": "unknown", "revision": "unknown", "build_time": "unknown"}


@pytest.mark.anyio
async def test_the_health_endpoint_carries_them(monkeypatch, build_time_file):
    from unittest.mock import AsyncMock, MagicMock

    from fastapi import Response

    from app.routers.health import health_check

    monkeypatch.setenv("APP_COMMIT_SHA", SHA)
    monkeypatch.setenv("K_REVISION", "sprintable-backend-dev-00412-abc")
    build_time_file.write_text("2026-10-03T01:55:00Z")
    db = MagicMock()
    db.execute = AsyncMock()
    body = await health_check(Response(), db)
    assert body["status"] == "ok"
    assert (body["commit_sha"], body["revision"], body["build_time"]) == (SHA, "sprintable-backend-dev-00412-abc", "2026-10-03T01:55:00Z")
    db.execute = AsyncMock(side_effect=RuntimeError("db down"))
    body = await health_check(Response(), db)
    assert body["status"] == "error" and body["commit_sha"] == SHA  # also when the DB is down — that is when it matters


def test_the_images_are_built_with_the_commit():
    """The wiring: both deploy builds pass the commit, and both Dockerfiles turn it into the env + build-time file."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    cloudbuild = (root / "cloudbuild.yaml").read_text()
    assert cloudbuild.count("- APP_COMMIT_SHA=${COMMIT_SHA}") == 2  # frontend + backend
    for dockerfile in (root / "backend/Dockerfile", root / "apps/web/Dockerfile"):
        text = dockerfile.read_text()
        assert "ARG APP_COMMIT_SHA" in text and "ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}" in text and "/app/.build_time" in text
