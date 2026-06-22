"""E-GHAPP Bot-M.2: 웹훅 통합 ingress 보안 단위(산티아고 lock 게이트 기준).

커버: HMAC-before-parse(invalid sig→parse/DB/capture 0) · dual-secret source(검증된 secret로만·payload
금지) · app sig로 legacy spoof 불가 · equal-secret misconfig→app inert+legacy 보존 · no-delivery-id reject
· dedup (source,delivery_id) 중복→2xx no-op + 세션 clean · 처리 실패→rollback(retry 보존) · **app=
installation→org resolve 先 → story org-scoped 조회**(anti-IDOR 순서·타 org SID 미매치·존재 oracle 0) ·
미등록/suspended→graceful ignore.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import IntegrityError

from app.routers import verdict_capture as mod

LEGACY_SECRET = "legacy-secret"
APP_SECRET = "app-secret"
STORY_ID = uuid.uuid4()
ORG_A = uuid.uuid4()
ORG_B = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_warn():
    mod._app_inert_warned = False
    yield


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _result(val):
    """val 이 list 면 scalars().all()=val(스캔 쿼리)·아니면 scalar_one_or_none=val(단건 쿼리)."""
    r = MagicMock()
    if isinstance(val, list):
        r.scalar_one_or_none.return_value = None
        r.scalars.return_value.all.return_value = val
    else:
        r.scalar_one_or_none.return_value = val
        r.scalars.return_value.all.return_value = []
    return r


def _mk_session(execute_results=(), *, flush_error=False):
    """execute 는 호출 순서대로 execute_results 반환(여분 빈 결과). add sync·flush 옵션 IntegrityError.

    Bot-L.1 resolver 쿼리 순서 — app: [installation, explicit_link, auto_stories(list), sid_story],
    legacy: [sid_story(전역)]. native CI skip(ci=failure)·close-on-merge skip(merged=False) 가정.
    """
    session = AsyncMock()
    session.add = MagicMock()
    seq = [_result(v) for v in execute_results] + [_result(None) for _ in range(6)]
    session.execute = AsyncMock(side_effect=seq)
    session.flush = AsyncMock(
        side_effect=IntegrityError("dup", {}, Exception()) if flush_error else None
    )
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    return session


async def _post(payload, *, event="workflow_run", delivery="dlv-1", sign_secret=LEGACY_SECRET,
                bad_sig=False, legacy=LEGACY_SECRET, app=APP_SECRET, session=None, cap=None):
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app

    if session is None:
        session = _mk_session()
    if cap is None:
        cap = AsyncMock(return_value={"recorded": ["ci"], "skipped_reason": None})

    async def override_db():
        yield session

    fastapi_app.dependency_overrides[get_db] = override_db
    body = json.dumps(payload).encode()
    headers = {"X-GitHub-Event": event}
    if delivery is not None:
        headers["X-GitHub-Delivery"] = delivery
    headers["X-Hub-Signature-256"] = "sha256=" + "f" * 64 if bad_sig else _sign(body, sign_secret)
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_webhook_secret", legacy), \
                 patch.object(mod.settings, "github_app_webhook_secret", app), \
                 patch.object(mod, "capture_pr_ci_verdict", new=cap):
                resp = await c.post("/api/v2/internal/verdict/github-webhook", content=body, headers=headers)
        return resp, session, cap
    finally:
        fastapi_app.dependency_overrides.clear()


def _wf(sid=STORY_ID, installation_id=555):
    """workflow_run failure(ci=failure → actionable·native CI 블록 skip → capture 직행)."""
    return {
        "installation": {"id": installation_id},
        "repository": {"full_name": "moonklabs/sprintable"},
        "workflow_run": {"conclusion": "failure", "head_sha": "sha1",
                         "head_branch": f"feat-[SID:{sid}]", "pull_requests": [{"number": 7}]},
    }


def _story(org_id=ORG_A):
    return MagicMock(org_id=org_id)


def _inst(org_id=ORG_A, installation_id=555):
    return MagicMock(org_id=org_id, installation_id=installation_id, suspended_at=None)


# ── HMAC-before-parse ───────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_invalid_sig_401_no_side_effect():
    session = _mk_session([_story()])
    resp, session, cap = await _post(_wf(), bad_sig=True, session=session)
    assert resp.status_code == 401
    session.add.assert_not_called()       # DB insert 0.
    cap.assert_not_awaited()              # capture 0.
    session.execute.assert_not_awaited()  # parse/DB 0.


@pytest.mark.anyio
async def test_malformed_json_with_invalid_sig_401_not_parse_error():
    """invalid sig면 json.loads 전에 401 — malformed body여도 parse error(400) 안 남."""
    from app.dependencies.database import get_db
    from app.main import app as fastapi_app
    session = _mk_session()

    async def override_db():
        yield session
    fastapi_app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_webhook_secret", LEGACY_SECRET), \
                 patch.object(mod.settings, "github_app_webhook_secret", APP_SECRET):
                resp = await c.post(
                    "/api/v2/internal/verdict/github-webhook",
                    content=b"not-json{{{", headers={"X-GitHub-Event": "push",
                    "X-GitHub-Delivery": "d", "X-Hub-Signature-256": "sha256=" + "a" * 64},
                )
        assert resp.status_code == 401   # parse error(400)가 아니라 sig 거부(401).
        session.add.assert_not_called()
    finally:
        fastapi_app.dependency_overrides.clear()


# ── dual-secret source 결정 ──────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_app_source_routed_by_app_secret():
    """app secret 서명 → source=app → installation resolve(org_a) 先 → resolver(explicit∅·auto∅·SID) → capture(org_a)."""
    # 쿼리 순서: installation → explicit_link(None) → auto_stories([]) → sid_story(org_a).
    session = _mk_session([_inst(ORG_A), None, [], _story(ORG_A)])
    resp, session, cap = await _post(_wf(), sign_secret=APP_SECRET, session=session)
    assert resp.status_code == 200
    cap.assert_awaited_once()
    assert cap.await_args.kwargs["org_id"] == ORG_A   # resolved installation org_id로만 capture.


@pytest.mark.anyio
async def test_legacy_source_routed_by_legacy_secret():
    """legacy secret 서명 → source=legacy → story.org_id로 capture(installation 불요)."""
    session = _mk_session([_story(ORG_A)])
    resp, session, cap = await _post(_wf(), sign_secret=LEGACY_SECRET, session=session)
    assert resp.status_code == 200
    cap.assert_awaited_once()
    assert cap.await_args.kwargs["org_id"] == ORG_A


@pytest.mark.anyio
async def test_app_sig_cannot_spoof_legacy():
    """app secret 서명 payload는 source=app으로 분류 → installation.id 없으면 ignore(legacy SID capture 0)."""
    payload = _wf()
    payload.pop("installation")  # app source인데 installation.id 없음.
    session = _mk_session([_story(ORG_A)])
    resp, session, cap = await _post(payload, sign_secret=APP_SECRET, session=session)
    assert resp.status_code == 200
    assert "no_installation_id" in resp.text
    cap.assert_not_awaited()  # legacy로 spoof되어 capture 되지 않음.


@pytest.mark.anyio
async def test_equal_secret_app_inert_legacy_preserved():
    """app secret == legacy secret(misconfig) → app inert. 그 secret 서명은 source=legacy로 처리(보존)."""
    shared = "shared-secret"
    session = _mk_session([_story(ORG_A)])  # legacy 경로 → story 1회.
    resp, session, cap = await _post(
        _wf(), sign_secret=shared, legacy=shared, app=shared, session=session
    )
    assert resp.status_code == 200
    cap.assert_awaited_once()
    assert cap.await_args.kwargs["org_id"] == ORG_A  # legacy 경로(story.org_id)·installation resolve 안 탐.


# ── no-delivery-id ──────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_missing_delivery_id_rejected_after_sig():
    session = _mk_session([_story(ORG_A)])
    resp, session, cap = await _post(_wf(), delivery=None, sign_secret=LEGACY_SECRET, session=session)
    assert resp.status_code == 400
    session.add.assert_not_called()  # DB insert 0(sig 검증은 통과·delivery 없음만 reject).
    cap.assert_not_awaited()


# ── dedup ───────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_duplicate_delivery_2xx_noop():
    """uq(source, delivery_id) 충돌(flush IntegrityError) → rollback + 2xx no-op + capture 0."""
    session = _mk_session([_story(ORG_A)], flush_error=True)
    resp, session, cap = await _post(_wf(), sign_secret=LEGACY_SECRET, session=session)
    assert resp.status_code == 200
    assert "duplicate_delivery" in resp.text
    session.rollback.assert_awaited()  # 세션 clean.
    cap.assert_not_awaited()           # capture 0.
    session.commit.assert_not_awaited()


@pytest.mark.anyio
async def test_processing_failure_rolls_back_for_retry():
    """처리(capture) 실패 → rollback(delivery row 포함) → 500(GitHub retry 재처리·영구 no-op 금지)."""
    session = _mk_session([_story(ORG_A)])
    cap = AsyncMock(side_effect=RuntimeError("boom"))
    resp, session, cap = await _post(_wf(), sign_secret=LEGACY_SECRET, session=session, cap=cap)
    assert resp.status_code == 500
    session.rollback.assert_awaited()    # delivery insert 도 함께 rollback → retry 보존.
    session.commit.assert_not_awaited()


# ── per-install routing / anti-IDOR (P1: resolve 先 → org-scoped story) ───────────
@pytest.mark.anyio
async def test_app_unregistered_or_suspended_installation_ignored():
    """app source·installation 미등록(or suspended_at 필터 제외) → resolve None → story 조회 없이 2xx ignore·capture 0."""
    session = _mk_session([None])  # 1st execute=installation resolve → None.
    resp, session, cap = await _post(_wf(), sign_secret=APP_SECRET, session=session)
    assert resp.status_code == 200
    assert "installation_not_registered_or_suspended" in resp.text
    cap.assert_not_awaited()                  # org side-effect 0.
    assert session.execute.await_count == 1   # ⭐installation resolve 만 — story 전역 조회 안 함(oracle 0).


@pytest.mark.anyio
async def test_app_cross_org_sid_not_found_via_scoped_query():
    """app installation=org_a resolve인데 SID story가 타 org → org-scoped 조회서 미매치(not_found)·capture 0."""
    # execute: installation(org_a) → explicit_link(None) → auto_stories([]) → sid scoped(org_a) 미매치(None).
    session = _mk_session([_inst(ORG_A), None, [], None])
    resp, session, cap = await _post(_wf(), sign_secret=APP_SECRET, session=session)
    assert resp.status_code == 200
    assert "story_not_found" in resp.text  # 전역 lookup 아닌 org-scoped 미매치.
    cap.assert_not_awaited()
