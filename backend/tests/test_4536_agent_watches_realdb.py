"""story #4536 (E-DESKTOP-2 C-2) — watches that live on the server, past the agent's session.

Agents with real keys come from a real code → confirm → exchange (4424's world). A merge arrives through the real GitHub webhook
(signed · one row per delivery id), a serving through record_serving — each fires the watch once, as a `watch.fired` Event on
that agent's stream.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio

REPO = "moonklabs/d4536"
SECRET = "d4536-webhook-secret"
SHA = lambda n: hashlib.sha1(f"d4536-{n}".encode()).hexdigest()  # noqa: E731 — distinct even in a 7-char prefix


@pytest.fixture(autouse=True)
async def _fresh_github_and_serving_records():
    """These two tables are not org-scoped (the world's cleanup does not reach them): each test starts from none of its own."""
    clean = (f"DELETE FROM github_pull_requests WHERE repo = '{REPO}'", "DELETE FROM deploy_servings WHERE revision LIKE 'be-%'")
    await _sql(*clean)
    yield
    await _sql(*clean)


async def _agent(c, name="d4536 mac"):
    code, verifier = await _code(c, name)
    assert (await _confirm(c, code)).status_code == 200
    a = (await _exchange(c, code, verifier)).json()["agents"][0]
    return a["member_id"], {"Authorization": f"Bearer {a['api_key']}"}


async def _hook(c, event, payload):
    from app.routers import verdict_capture as mod

    body = json.dumps(payload).encode()
    headers = {"X-GitHub-Event": event, "X-GitHub-Delivery": str(uuid.uuid4()),
               "X-Hub-Signature-256": "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()}
    with patch.object(mod.settings, "github_webhook_secret", SECRET):
        r = await c.post("/api/v2/internal/verdict/github-webhook", content=body, headers=headers)
    assert r.status_code == 200, r.text
    return headers["X-GitHub-Delivery"], body, headers


def _pr_event(number, action, *, merged=False, merged_at=None, sha=None, base="develop", state=None):
    return {"action": action, "number": number, "repository": {"full_name": REPO},
            "pull_request": {"number": number, "state": state or ("closed" if action == "closed" else "open"), "merged": merged,
                             "merged_at": merged_at, "merge_commit_sha": sha, "base": {"ref": base},
                             "head": {"sha": SHA(number + 7000)}, "merged_by": {"login": "po"} if merged else None}}


def _ts(minutes):
    return (datetime(2026, 10, 3, 6, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


async def _fired_events(agent):
    return await _sql(fetch=(f"SELECT payload->>'watch_id', payload->'fact', recipient_seq FROM events "
                             f"WHERE recipient_id = '{agent}' AND event_type = 'watch.fired' ORDER BY recipient_seq"))


async def _watch(c, h, condition, target, **extra):
    return await c.post("/api/v2/watches", json={"condition": condition, "target": target, **extra}, headers=h)


async def test_a_merge_through_the_webhook_fires_the_watch_once_on_the_agents_stream(world):
    async with _client() as c:
        agent, h = await _agent(c)
        await _hook(c, "pull_request", _pr_event(101, "opened"))
        w = await _watch(c, h, "github.pr_merged", {"repo": REPO, "pr": 101})
        assert w.status_code == 201 and w.json()["status"] == "active", w.text
        await _hook(c, "pull_request", _pr_event(101, "closed", merged=True, merged_at=_ts(1), sha=SHA(101)))
        ev = await _fired_events(agent)
        assert len(ev) == 1 and ev[0][0] == w.json()["id"] and ev[0][2] is not None  # numbered on the agent's stream
        assert ev[0][1]["merge_commit"] == SHA(101) and ev[0][1]["merged_by"] == "po"
        # the same merge again (another delivery) — the watch already fired: nothing more
        await _hook(c, "pull_request", _pr_event(101, "closed", merged=True, merged_at=_ts(1), sha=SHA(101)))
        assert len(await _fired_events(agent)) == 1
        listed = (await c.get("/api/v2/watches", params={"include_done": "true"}, headers=h)).json()["watches"]
        assert [x["status"] for x in listed] == ["fired"]


async def test_set_time_refusals_and_target_shapes(world):
    async with _client() as c:
        _agent_id, h = await _agent(c)
        r = await _watch(c, h, "github.pr_merged", {"repo": REPO, "pr": 999})
        assert (r.status_code, r.json()["error"]["code"]) == (422, "PR_NOT_SEEN")
        await _hook(c, "pull_request", _pr_event(102, "closed"))  # closed, never merged
        r = await _watch(c, h, "deploy.serving", {"service": "backend", "repo": REPO, "pr": 102})
        assert (r.status_code, r.json()["error"]["code"]) == (422, "PR_CLOSED_UNMERGED")
        await _hook(c, "pull_request", _pr_event(102, "reopened", state="open"))  # reopened → can be watched again
        assert (await _watch(c, h, "deploy.serving", {"service": "backend", "repo": REPO, "pr": 102})).status_code == 201
        for target in ({"repo": REPO, "pr": 102, "extra": 1}, {"service": "backend", "repo": REPO, "pr": 102, "commit": "abcdef1"},
                       {"service": "web", "commit": "abcdef1"}, {"service": "backend", "commit": "xyz"}):
            cond = "deploy.serving" if "service" in target else "github.pr_merged"
            r = await _watch(c, h, cond, target)
            assert (r.status_code, r.json()["error"]["code"]) == (422, "invalid_target"), target
        assert (await c.post("/api/v2/watches", json={"condition": "github.pr_merged", "target": {"repo": REPO, "pr": 102}},
                             headers=_person(OWNER))).status_code == 403  # a person has no watches here


async def test_another_agents_watch_is_not_found_and_never_listed(world):
    async with _client() as c:
        _a, ha = await _agent(c, "mac a")
        _b, hb = await _agent(c, "mac b")
        await _hook(c, "pull_request", _pr_event(103, "opened"))
        wid = (await _watch(c, ha, "github.pr_merged", {"repo": REPO, "pr": 103})).json()["id"]
        assert (await c.delete(f"/api/v2/watches/{wid}", headers=hb)).status_code == 404
        assert (await c.get("/api/v2/watches", headers=hb)).json()["watches"] == []
        assert (await c.delete(f"/api/v2/watches/{wid}", headers=ha)).json()["status"] == "cancelled"
        await _hook(c, "pull_request", _pr_event(103, "closed", merged=True, merged_at=_ts(2), sha=SHA(103)))
        assert await _fired_events(_a) == []  # a cleared watch never fires


async def test_a_completed_check_suite_fires_the_checks_watch(world):
    async with _client() as c:
        agent, h = await _agent(c)
        await _hook(c, "pull_request", _pr_event(104, "opened"))
        assert (await _watch(c, h, "github.pr_checks_completed", {"repo": REPO, "pr": 104})).status_code == 201
        await _hook(c, "check_suite", {"action": "completed", "repository": {"full_name": REPO},
                                       "check_suite": {"conclusion": "failure", "head_sha": SHA(7104), "app": {"slug": "github-actions"},
                                                       "pull_requests": [{"number": 104}]}})
        ev = await _fired_events(agent)
        assert len(ev) == 1 and ev[0][1]["conclusion"] == "failure"


async def test_a_serving_fires_my_pr_by_the_merge_line_and_not_a_later_one(world):
    """PO 06:00Z — the served commit is a recorded merge: every earlier merge on that repo · base is served."""
    from app.core.database import async_session_factory
    from app.services.agent_watches import record_serving

    async with _client() as c:
        agent, h = await _agent(c)
        for n, minute in ((105, 1), (106, 2), (107, 3)):
            await _hook(c, "pull_request", _pr_event(n, "opened"))
            await _hook(c, "pull_request", _pr_event(n, "closed", merged=True, merged_at=_ts(minute), sha=SHA(n)))
        w105 = (await _watch(c, h, "deploy.serving", {"service": "backend", "repo": REPO, "pr": 105})).json()["id"]
        w107 = (await _watch(c, h, "deploy.serving", {"service": "backend", "repo": REPO, "pr": 107})).json()["id"]
        async with async_session_factory() as s:
            assert await record_serving(s, service="backend", revision="be-00009", commit_sha=SHA(106)) == 1
            await s.commit()
        ev = await _fired_events(agent)
        assert [e[0] for e in ev] == [w105]
        assert ev[0][1]["line"] == "known" and ev[0][1]["served_merge_pr"] == 106 and ev[0][1]["service"] == "backend"
        async with async_session_factory() as s:  # the same revision again: recorded once, nothing new
            assert await record_serving(s, service="backend", revision="be-00009", commit_sha=SHA(106)) == 0
            await s.commit()
        async with async_session_factory() as s:
            assert await record_serving(s, service="backend", revision="be-00010", commit_sha=SHA(107)) == 1
            await s.commit()
        assert [e[0] for e in await _fired_events(agent)] == [w105, w107]


async def test_a_commit_not_on_record_matches_only_itself_and_says_the_line_is_unknown(world):
    from app.core.database import async_session_factory
    from app.services.agent_watches import record_serving

    async with _client() as c:
        agent, h = await _agent(c)
        assert (await _watch(c, h, "deploy.serving", {"service": "backend", "commit": SHA(9001)[:12]})).status_code == 201
        async with async_session_factory() as s:
            await record_serving(s, service="backend", revision="be-direct", commit_sha=SHA(9001))
            await s.commit()
        ev = await _fired_events(agent)
        assert len(ev) == 1 and ev[0][1]["line"] == "unknown"


async def test_a_watch_whose_event_already_happened_fires_when_set(world):
    from app.core.database import async_session_factory
    from app.services.agent_watches import record_serving

    async with _client() as c:
        agent, h = await _agent(c)
        await _hook(c, "pull_request", _pr_event(108, "opened"))
        await _hook(c, "pull_request", _pr_event(108, "closed", merged=True, merged_at=_ts(10), sha=SHA(108)))
        async with async_session_factory() as s:
            await record_serving(s, service="backend", revision="be-00011", commit_sha=SHA(108))
            await s.commit()
        a = await _watch(c, h, "github.pr_merged", {"repo": REPO, "pr": 108})
        b = await _watch(c, h, "deploy.serving", {"service": "backend", "repo": REPO, "pr": 108})
        assert a.json()["status"] == b.json()["status"] == "fired"
        assert {e[1].get("already") for e in await _fired_events(agent)} == {True}


async def test_an_expired_watch_never_fires_and_reads_expired(world):
    async with _client() as c:
        agent, h = await _agent(c)
        await _hook(c, "pull_request", _pr_event(109, "opened"))
        wid = (await _watch(c, h, "github.pr_merged", {"repo": REPO, "pr": 109}, expires_in_hours=1)).json()["id"]
        await _sql(f"UPDATE agent_watches SET expires_at = now() - interval '1 minute' WHERE id = '{wid}'")
        await _hook(c, "pull_request", _pr_event(109, "closed", merged=True, merged_at=_ts(4), sha=SHA(109)))
        assert await _fired_events(agent) == []
        assert (await c.get("/api/v2/watches", headers=h)).json()["watches"] == []
        done = (await c.get("/api/v2/watches", params={"include_done": "true"}, headers=h)).json()["watches"]
        assert [x["status"] for x in done] == ["expired"]


def test_a_revision_reports_once_on_its_first_outside_request(monkeypatch):
    """Not on a health probe; once per process; nothing without a commit and a revision."""
    import app.services.agent_watches as svc

    calls = []

    def fake_task(coro):
        calls.append(coro.cr_frame.f_locals.get("revision") if coro.cr_frame else None)
        coro.close()

    monkeypatch.setattr("app.services.pg_pubsub.fire_and_forget", fake_task)
    monkeypatch.setattr(svc, "_reported", False)
    monkeypatch.setenv("APP_COMMIT_SHA", SHA(42))
    monkeypatch.delenv("K_REVISION", raising=False)
    svc.note_request("/api/v2/stories")
    assert calls == []  # no revision → nothing to report
    monkeypatch.setenv("K_REVISION", "sprintable-backend-dev-00042-abc")
    svc.note_request("/api/v2/health")
    assert calls == []  # a health probe is not an outside request
    svc.note_request("/api/v2/stories")
    svc.note_request("/api/v2/stories")
    assert calls == ["sprintable-backend-dev-00042-abc"]  # once
