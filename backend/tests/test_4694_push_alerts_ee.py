"""story 4694 AC2 (server half · PO 2026-10-19 · «the week nobody knew») — Expo push trouble is loud, and «nothing to send to» is no longer silent.

What the 10-08~10-15 week showed: every send of the dev app was refused by Expo with `InvalidCredentials` (the project's Firebase / FCM key) and the only trace was
`reasons=InvalidCredentials:N` inside an INFO line; days with no device left no line at all (`if not devices: return []`). Now:

1. a ticket error of the credentials class (a closed list) is one ERROR line of its own — `jsonPayload.event = expo_push_credentials_error` — even for a single ticket;
   a dead token (`DeviceNotRegistered`), free text or any other error is not that line;
2. recipients exist but nothing goes out → one INFO line `expo_push_skipped` with a closed `reason` (`all_muted` · `no_devices`) and counts;
3. both lines carry ids · counts · closed codes only — no e-mail, no name, no token (pinned here);
4. the worker (outbox path) passes the event type to the fetch, the same as the direct path;
5. the alert policy file has the log-match policy for the event on both backend services, no channel baked in, and `setup_monitoring.sh alerts` skips a policy that exists
   and reuses the channels it is given (a second run must not duplicate what is already there).
"""
from __future__ import annotations

import json
import logging
import re
import shlex
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import ee.services.expo_push as expo

BACKEND = Path(__file__).resolve().parent.parent
TOKEN = "ExponentPushToken[SECRET-DEVICE-TOKEN-4694]"
EMAIL = "teacher.private@example.com"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _dev(token: str = TOKEN):
    return SimpleNamespace(id=uuid.uuid4(), platform="android", expo_push_token=token, member_id=uuid.uuid4())


def _mock_db(devices: list) -> AsyncMock:
    sel = MagicMock()
    sel.scalars.return_value.all.return_value = devices
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[sel] + [AsyncMock() for _ in range(5)])
    db.flush = AsyncMock()
    return db


def _records(caplog, event: str):
    return [r for r in caplog.records if getattr(r, "structured", {}).get("event") == event]


async def _send(devices: list, tickets: list[dict], org=None, event_type="conversation.message"):
    org = org or uuid.uuid4()
    with patch("ee.services.expo_push._expo_send_chunk", new=AsyncMock(return_value=tickets)):
        await expo._send_expo_push_targets(
            [{"expo_push_token": d.expo_push_token, "id": d.id, "platform": d.platform} for d in devices],
            title="T", body=f"hello {EMAIL}", event_type=event_type, org_id=org,
        )
    return org


# ─── 1. the credentials-class ticket error is an ERROR line of its own ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_one_credentials_error_is_one_error_line_with_closed_fields(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    org = await _send([_dev()], [{"status": "error", "message": f"{TOKEN} is not usable", "details": {"error": "InvalidCredentials"}}])
    lines = _records(caplog, expo.EXPO_CREDENTIALS_ERROR_EVENT)
    assert len(lines) == 1, [r.getMessage() for r in caplog.records]
    r = lines[0]
    assert r.levelno == logging.ERROR
    assert r.structured == {
        "event": "expo_push_credentials_error", "org_id": str(org), "event_type": "conversation.message",
        "codes": {"InvalidCredentials": 1}, "errors": 1, "devices": 1,
    }


@pytest.mark.anyio
async def test_codes_are_counted_and_mixed_with_ok_tickets(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    devs = [_dev(f"ExponentPushToken[{i}]") for i in range(5)]
    tickets = [
        {"status": "ok", "id": "t1"},
        {"status": "error", "details": {"error": "InvalidCredentials"}},
        {"status": "error", "details": {"error": "InvalidCredentials"}},
        {"status": "error", "details": {"error": "MismatchSenderId"}},
        {"status": "error", "details": {"error": "DeviceNotRegistered"}},
    ]
    await _send(devs, tickets)
    (r,) = _records(caplog, expo.EXPO_CREDENTIALS_ERROR_EVENT)
    assert r.structured["codes"] == {"InvalidCredentials": 2, "MismatchSenderId": 1}      # the dead token is not in it
    assert r.structured["errors"] == 3 and r.structured["devices"] == 5


@pytest.mark.anyio
async def test_other_errors_do_not_raise_the_credentials_line(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    for ticket in (
        {"status": "error", "details": {"error": "DeviceNotRegistered"}},                       # a dead token: the recipient's, handled as before
        {"status": "error", "details": {"error": "MessageTooBig"}},
        {"status": "error", "message": f"{TOKEN} is not a valid Expo push token"},              # free text — never matched, never copied
        {"status": "ok", "id": "t"},
    ):
        caplog.clear()
        await _send([_dev()], [ticket])
        assert _records(caplog, expo.EXPO_CREDENTIALS_ERROR_EVENT) == [], ticket
        assert not any(r.levelno >= logging.ERROR for r in caplog.records), ticket


@pytest.mark.anyio
async def test_the_credentials_line_never_carries_a_token_a_name_or_an_address(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    await _send([_dev()], [{"status": "error", "message": f"{TOKEN} bad for {EMAIL}", "details": {"error": "InvalidCredentials"}}])
    (r,) = _records(caplog, expo.EXPO_CREDENTIALS_ERROR_EVENT)
    text = r.getMessage() + json.dumps(r.structured)
    assert "SECRET-DEVICE-TOKEN" not in text and "ExponentPushToken" not in text and EMAIL not in text and "@" not in text


# ─── 2 · 3. «nothing to send to» is one line with a closed reason ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_no_devices_is_a_line(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    org, member = uuid.uuid4(), uuid.uuid4()
    out = await expo._fetch_expo_push_targets(_mock_db([]), org, [member], event_type="conversation.message")
    assert out == []
    (r,) = _records(caplog, expo.EXPO_PUSH_SKIPPED_EVENT)
    assert r.levelno == logging.INFO
    assert r.structured == {
        "event": "expo_push_skipped", "reason": "no_devices", "org_id": str(org), "event_type": "conversation.message",
        "recipients": 1, "muted": 0, "devices": 0,
    }
    text = r.getMessage() + json.dumps(r.structured)
    assert str(member) not in text, "no member id in the line"                                   # ids of the org · counts · a reason only


@pytest.mark.anyio
async def test_all_muted_is_a_line_and_still_no_query(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    m1, m2 = uuid.uuid4(), uuid.uuid4()
    db = _mock_db([])
    out = await expo._fetch_expo_push_targets(db, uuid.uuid4(), [m1, m2], muted_member_ids={m1, m2}, event_type="x")
    assert out == []
    db.execute.assert_not_awaited()                                                               # the early return stays early
    (r,) = _records(caplog, expo.EXPO_PUSH_SKIPPED_EVENT)
    assert (r.structured["reason"], r.structured["recipients"], r.structured["muted"]) == ("all_muted", 2, 2)


@pytest.mark.anyio
async def test_devices_present_or_no_recipients_is_no_skipped_line(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    out = await expo._fetch_expo_push_targets(_mock_db([_dev()]), uuid.uuid4(), [uuid.uuid4()], event_type="x")
    assert len(out) == 1
    assert await expo._fetch_expo_push_targets(_mock_db([]), uuid.uuid4(), [], event_type="x") == []
    assert _records(caplog, expo.EXPO_PUSH_SKIPPED_EVENT) == []


@pytest.mark.anyio
async def test_the_direct_path_passes_the_event_type_to_the_skipped_line(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    await expo.deliver_expo_push(_mock_db([]), uuid.uuid4(), [uuid.uuid4()], title="T", body="B", event_type="story.assigned", via_outbox=False)
    (r,) = _records(caplog, expo.EXPO_PUSH_SKIPPED_EVENT)
    assert r.structured["event_type"] == "story.assigned"


# ─── 4. the worker (outbox) path passes it too ────────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_the_worker_passes_the_event_type_to_the_fetch():
    from app.services import delivery_dispatcher as dd

    org, member = uuid.uuid4(), uuid.uuid4()
    seen: dict = {}

    async def _fetch(session, org_id, member_ids, **kw):
        seen.update(kw)
        return []

    class _Session:
        async def __aenter__(self):
            s = AsyncMock()
            return s

        async def __aexit__(self, *a):
            return False

    job = {
        "id": uuid.uuid4(), "org_id": org, "kind": "expo_push", "attempts": 0,
        "payload": {"member_ids": [str(member)], "title": "T", "body": None, "event_type": "conversation.message", "muted_member_ids": None},
    }
    with patch("app.core.database.async_session_factory", new=lambda: _Session()), \
         patch("ee.services.expo_push._fetch_expo_push_targets", new=_fetch), \
         patch("ee.services.expo_push._send_expo_push_targets", new=AsyncMock(return_value=[])):
        await dd._deliver_one(job)
    assert seen.get("event_type") == "conversation.message"


# ─── 5. the alert policy + the script ─────────────────────────────────────────────────────────────────────────────────────────

def _policies():
    return json.loads((BACKEND / "monitoring" / "alert_policies.json").read_text())


def test_the_policy_file_has_the_log_match_policy_for_both_backends_and_bakes_in_no_channel():
    policies = _policies()
    names = [p["displayName"] for p in policies]
    assert len(names) == len(set(names)), "a policy name appears twice (the script skips by name)"
    (p,) = [p for p in policies if "Expo push credentials error" in p["displayName"]]
    cond = p["conditions"][0]["conditionMatchedLog"]
    f = cond["filter"]
    assert 'jsonPayload.event="expo_push_credentials_error"' in f
    assert 'resource.type="cloud_run_revision"' in f
    pattern = re.search(r'service_name=~"([^"]+)"', f).group(1)
    assert re.search(pattern, "sprintable-backend-dev") and re.search(pattern, "sprintable-backend-prod")
    assert not re.search(pattern, "sprintable-frontend-dev") and not re.search(pattern, "sprintable-backend-devx")
    assert p["severity"] == "ERROR"
    assert p["alertStrategy"]["notificationRateLimit"]["period"].endswith("s")                  # a log-match policy needs the rate limit
    assert p["notificationChannels"] == [], "the channel is the operator's (existing one, passed in) — none baked into the file"
    assert expo.EXPO_CREDENTIALS_ERROR_EVENT == "expo_push_credentials_error"                    # the filter and the code say the same word


def test_the_script_skips_existing_policies_and_reuses_given_channels():
    sh = (BACKEND / "scripts" / "setup_monitoring.sh").read_text()
    assert "ALERT_CHANNEL_IDS" in sh
    assert re.search(r'if \[\[ -n "\$\{ALERT_CHANNEL_IDS\}" \]\]; then.*?return 0', sh, re.S), "given channels → none created"
    assert "policies list" in sh and "already exists, skipped" in sh, "a policy that exists is skipped, not created twice"
    # the skip comes before the create
    assert sh.index("already exists, skipped") < sh.index("policies create")


# ─── the `sent` line's reasons are codes, never Expo's free text (PO 2026-10-19 · measured: Expo's `message` carries the token) ──────────

@pytest.mark.anyio
async def test_the_sent_line_copies_codes_never_expo_free_text(caplog):
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    real_shape = {  # what the real API answers for a bad token (measured 2026-10-19): the token is in the message and in details
        "status": "error", "message": f'"{TOKEN}" is not a valid Expo push token',
        "details": {"error": "DeviceNotRegistered", "expoPushToken": TOKEN},
    }
    message_only = {"status": "error", "message": f'"{TOKEN}" went wrong for {EMAIL}'}
    odd_code = {"status": "error", "details": {"error": f"free text with {TOKEN} and spaces"}}
    for tickets in ([real_shape], [message_only], [odd_code], [real_shape, message_only, odd_code]):
        caplog.clear()
        await _send([_dev() for _ in tickets], tickets)
        sent = [r.getMessage() for r in caplog.records if r.getMessage().startswith("expo push: sent")]
        assert len(sent) == 1, [r.getMessage() for r in caplog.records]
        assert "ExponentPushToken" not in sent[0] and "SECRET-DEVICE-TOKEN" not in sent[0] and EMAIL not in sent[0] and "@" not in sent[0], sent[0]
    # the code word itself survives, and message-only / odd-shaped errors become «unknown»
    caplog.clear()
    await _send([_dev(), _dev(), _dev()], [real_shape, message_only, odd_code])
    (line,) = [r.getMessage() for r in caplog.records if r.getMessage().startswith("expo push: sent")]
    assert "DeviceNotRegistered" in line and "unknown" in line and "error=3" in line
    assert expo._expo_error_code({"details": {"error": "InvalidCredentials"}}) == "InvalidCredentials"
    assert expo._expo_error_code({"message": "x"}) == "unknown" and expo._expo_error_code({}) == "unknown" and expo._expo_error_code({"details": None}) == "unknown"


# ─── Kadir's pins on d142f7d58 (PO 2026-10-19): the code-shape bound and the script's skip, each pinned by BEHAVIOUR ───────────────────────────

def test_a_code_is_at_most_64_characters_of_code_shape_anything_else_is_unknown():
    code64 = "A" + "b" * 63
    assert len(code64) == 64 and expo._expo_error_code({"details": {"error": code64}}) == code64          # the bound itself: 64 passes …
    assert expo._expo_error_code({"details": {"error": code64 + "x"}}) == "unknown"                         # … 65 does not (raising the bound turns this RED)
    assert expo._expo_error_code({"details": {"error": "Invalid_Credentials2"}}) == "Invalid_Credentials2"  # underscores · digits after the first letter
    for bad in ("9Starts", "has space", "dash-ed", "tok[en]", "", "x" * 200, "ünï", "A\n"):
        assert expo._expo_error_code({"details": {"error": bad}}) == "unknown", bad                          # lowering the bound / loosening the shape turns one of these RED


def _run_alerts_script(tmp_path: Path, existing: list[str], channel_ids: str | None):
    """Run `setup_monitoring.sh alerts` against a fake `gcloud` that records every call — the real script, the real policy file, no network."""
    import os
    import subprocess

    calls, created = tmp_path / "calls.log", tmp_path / "created"
    created.mkdir(exist_ok=True)
    fake = tmp_path / "bin"
    fake.mkdir(exist_ok=True)
    (fake / "gcloud").write_text(
        "#!/bin/bash\n"
        f'echo "$*" >> "{calls}"\n'
        'case "$*" in\n'
        '  *"monitoring policies list"*) printf "%s\\n" ' + " ".join(shlex.quote(n) for n in existing) + " ;;\n"
        f'  *"monitoring policies create"*) cat > "$(mktemp "{created}/policy.XXXXXX")" ;;\n'
        f'  *"monitoring channels create"*) echo "projects/x/notificationChannels/NEW" ;;\n'
        "esac\n"
    )
    (fake / "gcloud").chmod(0o755)
    env = {**os.environ, "PATH": f"{fake}:{os.environ['PATH']}", "GCP_PROJECT": "p-test", "ALERT_EMAIL": "", "DISCORD_WEBHOOK_URL": ""}
    env.pop("ALERT_CHANNEL_IDS", None)
    if channel_ids is not None:
        env["ALERT_CHANNEL_IDS"] = channel_ids
    r = subprocess.run(["bash", str(BACKEND / "scripts" / "setup_monitoring.sh"), "alerts"], env=env, capture_output=True, text=True, timeout=60)
    made = [json.loads(p.read_text()) for p in sorted(created.glob("policy.*"))]
    return r, calls.read_text().splitlines() if calls.exists() else [], made


NEW_POLICY = "Sprintable — Expo push credentials error (dev · prod)"


def test_the_script_creates_only_the_missing_policy_with_the_given_channel_and_no_channel(tmp_path):
    existing = [p["displayName"] for p in _policies() if p["displayName"] != NEW_POLICY]
    r, calls, made = _run_alerts_script(tmp_path, existing, "projects/x/notificationChannels/EXISTING")
    assert r.returncode == 0, r.stderr[-600:]
    assert [m["displayName"] for m in made] == [NEW_POLICY], [m["displayName"] for m in made]                # the three that exist are skipped by name
    assert made[0]["notificationChannels"] == ["projects/x/notificationChannels/EXISTING"]                   # the channel given is the channel used
    assert not any("channels create" in c for c in calls), calls                                              # none created


def test_a_second_run_creates_nothing(tmp_path):
    names = [p["displayName"] for p in _policies()]
    r, calls, made = _run_alerts_script(tmp_path, names, "projects/x/notificationChannels/EXISTING")
    assert r.returncode == 0, r.stderr[-600:]
    assert made == [], [m["displayName"] for m in made]                                                       # removing the skip turns this RED (it would create all four)
    assert not any("policies create" in c for c in calls) and not any("channels create" in c for c in calls)


def test_without_given_channels_the_old_way_still_applies_and_a_fresh_project_gets_every_policy(tmp_path):
    r, calls, made = _run_alerts_script(tmp_path, [], None)                                                  # no ALERT_CHANNEL_IDS, no e-mail / webhook → no channel to create either
    assert r.returncode == 0, r.stderr[-600:]
    assert sorted(m["displayName"] for m in made) == sorted(p["displayName"] for p in _policies())
