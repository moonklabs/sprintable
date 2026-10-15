"""story #4394 — push diagnostics receiver (EE · /api/v2/push/diagnostics).

A release build of the app that is denied notification permission or fails to get a push token used to fail silently (the
app logs only in debug builds). The app now reports where registration stopped; the server keeps it as one structured log
line (no table, no migration). Contract pinned here:
- body fields and values as agreed with the app side (Min, 2026-09-28); any unknown field — a token above all — is a 422;
- a request without a session is a 401;
- the log line carries member_id · org_id (from the session, not the body) and every reported field;
- a per-member hourly cap answers 429 with Retry-After, and does not touch other members;
- a limiter storage failure does not turn a report into an error (best-effort channel).

The real EE router is mounted in a small app; only the org / member / EE-gate dependencies are overridden (no DB).
"""
from __future__ import annotations

import logging
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from limits.errors import StorageError
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter

from app.dependencies.auth import get_verified_org_id
from ee.routers import push_devices

ORG_ID = uuid.uuid4()
MEMBER_A = uuid.uuid4()
MEMBER_B = uuid.uuid4()
LOGGER = "ee.routers.push_devices"

VALID = {
    "platform": "android",
    "app_version": "1.4.2",
    "app_build": "142",
    "permission": "granted",
    "can_ask_again": True,
    "stage": "device_token",
    "error_code": "FIS_AUTH_ERROR",
}


@pytest.fixture(autouse=True)
def fresh_limiter(monkeypatch):
    monkeypatch.setattr(push_devices, "_diagnostics_limiter", MovingWindowRateLimiter(MemoryStorage()))


def _client(member_id: uuid.UUID | None = MEMBER_A, *, authed: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(push_devices.router, prefix="/api/v2/push")
    app.dependency_overrides[push_devices._require_ee] = lambda: None
    if authed:
        app.dependency_overrides[get_verified_org_id] = lambda: ORG_ID
        app.dependency_overrides[push_devices._get_caller_member_id] = lambda: member_id
    return TestClient(app)


def _post(client: TestClient, body: dict):
    return client.post("/api/v2/push/diagnostics", json=body)


def _diag_records(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == LOGGER and getattr(r, "structured", {}).get("event") == "push_diagnostics"]


def test_valid_report_is_204_and_one_log_line_carries_every_field(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    res = _post(_client(), VALID)
    assert res.status_code == 204 and res.content == b""
    records = _diag_records(caplog)
    assert len(records) == 1
    assert records[0].structured == {
        "event": "push_diagnostics", "member_id": str(MEMBER_A), "org_id": str(ORG_ID), **VALID,
    }
    # the production JSON formatter puts these at the top of jsonPayload — the Cloud Logging query in the PR filters on them
    import json

    from app.core.logging_config import JsonFormatter

    payload = json.loads(JsonFormatter().format(records[0]))
    assert payload["event"] == "push_diagnostics" and payload["member_id"] == str(MEMBER_A) and payload["stage"] == "device_token"


def test_error_code_is_optional_and_a_permission_stop_reports_without_it(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    body = {**VALID, "permission": "denied", "can_ask_again": False, "stage": "permission"}
    del body["error_code"]
    assert _post(_client(), body).status_code == 204
    assert _diag_records(caplog)[0].structured["error_code"] is None


@pytest.mark.parametrize("token_field", ["expo_push_token", "apns_device_token", "device_token", "token"])
def test_a_token_field_is_rejected_and_nothing_is_logged(caplog, token_field):
    caplog.set_level(logging.INFO, logger=LOGGER)
    res = _post(_client(), {**VALID, token_field: "ExponentPushToken[abc123]"})
    assert res.status_code == 422
    assert _diag_records(caplog) == []


def test_member_id_in_the_body_is_rejected_the_member_comes_from_the_session():
    assert _post(_client(), {**VALID, "member_id": str(MEMBER_B)}).status_code == 422


@pytest.mark.parametrize(("field", "value"), [
    ("platform", "macos"),
    ("platform", "web"),
    ("permission", "blocked"),
    ("stage", "done"),
    ("can_ask_again", "maybe"),
    ("app_version", "x" * 33),
    ("app_version", ""),
    ("app_build", "1" * 17),
    ("app_build", ""),
    ("error_code", "FIS auth error: 403"),  # a raw message, not a code
    ("error_code", "e_lowercase"),
    ("error_code", "A" * 65),
])
def test_field_checks(field, value):
    assert _post(_client(), {**VALID, field: value}).status_code == 422


@pytest.mark.parametrize("missing", ["platform", "app_version", "app_build", "permission", "can_ask_again", "stage"])
def test_required_fields(missing):
    body = dict(VALID)
    del body[missing]
    assert _post(_client(), body).status_code == 422


@pytest.mark.parametrize("value", [
    "E_REGISTRATION_FAILED", "FIS_AUTH_ERROR", "SERVICE_NOT_AVAILABLE", "HTTP_401", "UNKNOWN", "A" * 64, "ERR:NET.1-2",
])
def test_error_code_shapes_the_app_sends_are_accepted(value):
    assert _post(_client(), {**VALID, "error_code": value}).status_code == 204


def test_all_stage_and_permission_values_are_accepted():
    client = _client()
    for stage in ("permission", "device_token", "expo_token", "register", "ok"):
        for permission in ("granted", "provisional", "denied", "undetermined"):
            assert _post(client, {**VALID, "stage": stage, "permission": permission}).status_code == 204
            push_devices._diagnostics_limiter.storage.reset()


def test_without_a_session_it_is_401():
    res = _post(_client(authed=False), VALID)
    assert res.status_code == 401


def test_per_member_hourly_cap_is_429_with_retry_after_and_other_members_are_unaffected(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    a = _client(MEMBER_A)
    for _ in range(push_devices.DIAGNOSTICS_PER_HOUR):
        assert _post(a, VALID).status_code == 204
    over = _post(a, VALID)
    assert over.status_code == 429
    assert 1 <= int(over.headers["Retry-After"]) <= 3600
    assert len(_diag_records(caplog)) == push_devices.DIAGNOSTICS_PER_HOUR  # the refused report is not logged
    assert _post(_client(MEMBER_B), VALID).status_code == 204


def _over_cap_client(monkeypatch, *, window_stats):
    """The next report is over the cap (hit → False); the window lookup behaves as given."""
    monkeypatch.setattr(push_devices._diagnostics_limiter, "hit", lambda *_a, **_k: False)
    monkeypatch.setattr(push_devices._diagnostics_limiter, "get_window_stats", window_stats)
    return _client()


def test_window_lookup_failure_after_an_over_cap_hit_is_still_429_with_a_whole_window(monkeypatch):
    """PO 17:15Z ① — storage dropping between the over-cap hit and the Retry-After lookup must not become a 500."""
    def broken_stats(*_a, **_k):
        raise StorageError(ConnectionError("redis down"))

    res = _post(_over_cap_client(monkeypatch, window_stats=broken_stats), VALID)
    assert res.status_code == 429
    assert res.headers["Retry-After"] == "3600"


def test_retry_after_rounds_up(monkeypatch):
    """PO 17:15Z ② — 10.2 s left is Retry-After 11, not 10 (retrying a second early is another 429)."""
    import time

    now = time.time()
    monkeypatch.setattr(push_devices.time, "time", lambda: now)
    res = _post(_over_cap_client(monkeypatch, window_stats=lambda *_a, **_k: (now + 10.2, 0)), VALID)
    assert res.status_code == 429
    assert res.headers["Retry-After"] == "11"


def test_limiter_storage_failure_still_accepts_the_report(caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger=LOGGER)

    def broken_hit(*_args, **_kwargs):
        raise StorageError(ConnectionError("redis down"))

    monkeypatch.setattr(push_devices._diagnostics_limiter, "hit", broken_hit)
    assert _post(_client(), VALID).status_code == 204
    assert len(_diag_records(caplog)) == 1
    assert any("rate-limit storage unavailable" in r.getMessage() for r in caplog.records if r.name == LOGGER)


def test_it_rides_the_router_that_serves_push_devices_under_api_v2_push():
    """EE is off under pytest, so the app does not mount the EE routers here. Pin the wiring instead: the endpoint is on the same
    router object as /devices, and main.py mounts that router at /api/v2/push when EE is on."""
    import inspect

    import app.main as main_module

    routes = {(r.path, tuple(sorted(r.methods))): r for r in push_devices.router.routes}
    diag = routes[("/diagnostics", ("POST",))]
    assert diag.status_code == 204
    assert ("/devices", ("POST",)) in routes
    assert 'app.include_router(push_devices.router, prefix="/api/v2/push")' in inspect.getsource(main_module)
