"""H1-S6: GitHub webhook PR/CI runtime verdict 캡처 테스트.

HMAC 검증 + 이벤트 파싱(pull_request/workflow_run) + [SID:] 파싱 → capture_pr_ci_verdict 호출.
R5 갭(프로덕션 호출자 0) 해소 = 실 runtime router 경로.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.routers import verdict_capture as mod
from app.routers.verdict_capture import (
    _candidate_texts,
    _extract_pr_ci,
    _hmac_match,
    _normalize_ci,
    _resolve_webhook_source,
)

_SECRET = "testsecret"
STORY_ID = uuid.uuid4()
ORG_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 단위: 정규화/추출/HMAC ──────────────────────────────────────────────────────

def test_normalize_ci():
    assert _normalize_ci("success") == "success"
    assert _normalize_ci("FAILURE") == "failure" and _normalize_ci("timed_out") == "failure"
    assert _normalize_ci("cancelled") == "cancelled" and _normalize_ci("skipped") == "cancelled"
    assert _normalize_ci("in_progress") is None and _normalize_ci(None) is None  # 미완료 skip.


def test_candidate_texts_collects_title_body_branch():
    payload = {"pull_request": {"title": "feat [SID:x]", "body": "b", "head": {"ref": "feat/sid"}}}
    texts = _candidate_texts(payload)
    assert "feat [SID:x]" in texts and "b" in texts and "feat/sid" in texts


def test_extract_pr_ci_pull_request_merged():
    payload = {"action": "closed",
               "pull_request": {"number": 12, "merged": True, "head": {"sha": "abc123"}}}
    pr_number, merged, ci, head_sha = _extract_pr_ci("pull_request", payload)
    assert pr_number == 12 and merged is True and ci is None
    assert head_sha == "abc123"  # S5: native CI 조회용 head SHA.


def test_extract_pr_ci_workflow_run_failure():
    payload = {"workflow_run": {"conclusion": "failure", "head_sha": "def456",
                                "pull_requests": [{"number": 7}]}}
    pr_number, merged, ci, head_sha = _extract_pr_ci("workflow_run", payload)
    assert pr_number == 7 and merged is False and ci == "failure"  # AC④.
    assert head_sha == "def456"


def test_hmac_match_format_and_compare():
    body = b'{"a":1}'
    sig = "sha256=" + hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()
    assert _hmac_match(body, sig, _SECRET) is True
    assert _hmac_match(body, "sha256=bad", _SECRET) is False          # 형식오류(hex64 아님).
    assert _hmac_match(body, sig.removeprefix("sha256="), _SECRET) is False  # bare hex(prefix 없음) 거부.
    assert _hmac_match(body, sig, "") is False                        # secret 미설정 거부.
    assert _hmac_match(body, None, _SECRET) is False                  # header 없음 거부.


def test_resolve_webhook_source_legacy_only_by_default():
    body = b'{"a":1}'
    legacy_sig = "sha256=" + hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()
    # app secret 미설정 → app inert·legacy 만.
    with patch.object(mod.settings, "github_webhook_secret", _SECRET), \
         patch.object(mod.settings, "github_app_webhook_secret", ""):
        assert _resolve_webhook_source(body, legacy_sig) == "legacy"
        assert _resolve_webhook_source(body, "sha256=" + "0" * 64) is None  # 둘다 실패.


# ── 엔드포인트(실 runtime 경로) ────────────────────────────────────────────────

def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()


async def _post(payload: dict, *, event: str, story=..., sign=True, installation=...):
    from app.dependencies.database import get_db
    from app.main import app

    session = AsyncMock()
    session.add = MagicMock()  # add 는 sync(AsyncMock 경고 방지).
    result = MagicMock()
    result.scalar_one_or_none.return_value = (
        MagicMock(org_id=ORG_ID) if story is ... else story
    )
    if installation is ...:
        session.execute = AsyncMock(return_value=result)  # 모든 query 동일(기존 동작).
    else:
        # 1st execute=story select, 2nd=installation select(native CI 블록), 이후 installation 반복.
        inst_result = MagicMock()
        inst_result.scalar_one_or_none.return_value = installation
        session.execute = AsyncMock(side_effect=[result, inst_result, inst_result, inst_result])

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    body = json.dumps(payload).encode()
    headers = {"X-GitHub-Event": event, "X-GitHub-Delivery": "test-delivery-legacy"}  # Bot-M.2: delivery 필수.
    headers["X-Hub-Signature-256"] = _sign(body) if sign else "sha256=bad"
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            # legacy source(app secret 미설정 → app inert): 기존 무회귀 검증.
            with patch.object(mod.settings, "github_webhook_secret", _SECRET), \
                 patch.object(mod.settings, "github_app_webhook_secret", ""):
                resp = await c.post("/api/v2/internal/verdict/github-webhook", content=body, headers=headers)
        return resp
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_invalid_signature_401():
    resp = await _post({"pull_request": {"title": "x"}}, event="pull_request", sign=False)
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_pr_merged_calls_capture():
    payload = {"action": "closed", "repository": {"full_name": "moonklabs/sprintable"},
               "pull_request": {"number": 12, "merged": True, "title": f"feat [SID:{STORY_ID}]"}}
    with patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})) as cap:
        resp = await _post(payload, event="pull_request")
    assert resp.status_code == 200  # AC①: runtime router가 capture 호출.
    cap.assert_awaited_once()
    kw = cap.await_args.kwargs
    assert kw["story_id"] == STORY_ID and kw["merged"] is True and kw["pr_number"] == 12


@pytest.mark.anyio
async def test_ci_failure_calls_capture_with_failure():
    payload = {"repository": {"full_name": "o/r"},
               "workflow_run": {"conclusion": "failure", "head_branch": f"feat-[SID:{STORY_ID}]",
                                "pull_requests": [{"number": 7}]}}
    with patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["ci"], "skipped_reason": None})) as cap:
        resp = await _post(payload, event="workflow_run")
    assert resp.status_code == 200
    kw = cap.await_args.kwargs
    assert kw["ci_result"] == "failure" and kw["merged"] is False  # AC④.


@pytest.mark.anyio
async def test_no_sid_skips():
    with patch.object(mod, "capture_pr_ci_verdict", new=AsyncMock()) as cap:
        resp = await _post({"pull_request": {"title": "no tag", "number": 1, "merged": True}, "action": "closed"},
                           event="pull_request")
    assert resp.status_code == 200 and resp.json()["data"]["skipped_reason"] == "no_sid_tag"
    cap.assert_not_awaited()  # AC②.


@pytest.mark.anyio
async def test_no_story_skips():
    payload = {"action": "closed", "pull_request": {"number": 1, "merged": True, "title": f"[SID:{STORY_ID}]"}}
    with patch.object(mod, "capture_pr_ci_verdict", new=AsyncMock()) as cap:
        resp = await _post(payload, event="pull_request", story=None)  # story 없음.
    assert resp.status_code == 200 and resp.json()["data"]["skipped_reason"] == "story_not_found"
    cap.assert_not_awaited()  # AC③.


@pytest.mark.anyio
async def test_no_actionable_signal_skips():
    # CI 미완료(in_progress) → conclusion None → skip.
    payload = {"workflow_run": {"conclusion": "in_progress", "head_branch": f"x-[SID:{STORY_ID}]"}}
    with patch.object(mod, "capture_pr_ci_verdict", new=AsyncMock()) as cap:
        resp = await _post(payload, event="workflow_run")
    assert resp.json()["data"]["skipped_reason"] == "no_actionable_signal"
    cap.assert_not_awaited()


@pytest.mark.anyio
async def test_duplicate_webhook_calls_capture_each_time():
    """AC⑤: duplicate webhook도 capture 호출(멱등은 record_verdict의 uq(participation,source) upsert)."""
    payload = {"action": "closed", "repository": {"full_name": "o/r"},
               "pull_request": {"number": 3, "merged": True, "title": f"[SID:{STORY_ID}]"}}
    with patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})) as cap:
        await _post(payload, event="pull_request")
        await _post(payload, event="pull_request")
    assert cap.await_count == 2  # 두 번 호출되나 record_verdict가 upsert로 1 verdict 유지.


# ── SID 브랜치 링킹 견고성(CI 이벤트 — PR title 없는 경우) ──────────────────────

def test_parse_story_id_branch_safe_formats():
    from app.services.verdict_capture import parse_story_id

    sid = uuid.uuid4()
    assert parse_story_id(f"feat [SID:{sid}]") == sid       # PR 제목(콜론).
    assert parse_story_id(f"feat/h1-sid-{sid}") == sid      # 브랜치 sid-uuid.
    assert parse_story_id(f"sid/{sid}") == sid              # 브랜치 sid/uuid.
    assert parse_story_id(f"feat/h1-sid_{sid}") == sid      # sid_uuid.
    assert parse_story_id("feat/h1-fix-3") is None          # 태그 없으면 None.


def test_candidate_texts_status_branches():
    sid = uuid.uuid4()
    texts = _candidate_texts({"state": "success", "branches": [{"name": f"feat/h1-sid-{sid}"}]})
    assert f"feat/h1-sid-{sid}" in texts  # status는 branches[].name로 브랜치 노출.


@pytest.mark.anyio
async def test_workflow_run_branch_sid_links_capture():
    """CI 이벤트(workflow_run)는 PR title 없이 head_branch의 sid-<uuid>로 verdict 연결."""
    sid = STORY_ID
    payload = {"repository": {"full_name": "o/r"},
               "workflow_run": {"conclusion": "failure", "head_branch": f"feat/h1-sid-{sid}", "pull_requests": []}}
    with patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["ci"], "skipped_reason": None})) as cap:
        resp = await _post(payload, event="workflow_run")
    assert resp.status_code == 200
    kw = cap.await_args.kwargs
    assert kw["story_id"] == sid and kw["ci_result"] == "failure"  # 브랜치 SID로 링킹 성공.


# ── S5 Phase S: native CI (statusCheckRollup) ─────────────────────────────────
from app.services import verdict_capture as _svc  # noqa: E402


def _native_ci(resp):
    """응답 envelope-tolerant native_ci 추출({state, reason} or None)."""
    body = resp.json()
    data = body.get("data", body) if isinstance(body, dict) else {}
    return (data or {}).get("native_ci")


_MERGE_PAYLOAD = {"action": "closed", "repository": {"full_name": "moonklabs/sprintable"},
                  "pull_request": {"number": 12, "merged": True, "title": f"feat [SID:{STORY_ID}]",
                                   "head": {"sha": "deadbeef"}}}


@pytest.mark.anyio
async def test_native_ci_fills_on_merge_when_no_conclusion():
    """머지 이벤트(ci 결론 없음)+confident SID → installation 토큰 rollup으로 ci 채움·native_ci.state=success."""
    with patch.object(mod, "get_installation_token", new=AsyncMock(return_value="inst-tok")), \
         patch.object(mod, "fetch_status_check_rollup",
                      new=AsyncMock(return_value=("success", "resolved"))) as roll, \
         patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["pr", "ci"], "skipped_reason": None})) as cap:
        resp = await _post(_MERGE_PAYLOAD, event="pull_request")
    assert resp.status_code == 200
    roll.assert_awaited_once_with("moonklabs/sprintable", "deadbeef", "inst-tok")  # installation 토큰(PAT 아님).
    assert cap.await_args.kwargs["ci_result"] == "success"
    assert _native_ci(resp) == {"state": "success", "reason": None}


@pytest.mark.anyio
async def test_native_ci_unknown_reason_no_installation():
    """unknown(reason): org 미연결(installation 행 없음) → native_ci.reason=no_installation·토큰 mint 안 함."""
    with patch.object(mod, "get_installation_token", new=AsyncMock()) as tok, \
         patch.object(mod, "fetch_status_check_rollup", new=AsyncMock()) as roll, \
         patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})) as cap:
        resp = await _post(_MERGE_PAYLOAD, event="pull_request", installation=None)
    assert resp.status_code == 200
    tok.assert_not_called(); roll.assert_not_called()          # 미연결 → 토큰/rollup 안 함.
    assert cap.await_args.kwargs["ci_result"] is None
    assert _native_ci(resp) == {"state": "unknown", "reason": "no_installation"}


@pytest.mark.anyio
async def test_native_ci_unknown_reason_no_token():
    """unknown(reason): installation 있으나 토큰 mint 실패 → reason=no_installation_token·rollup 안 함."""
    with patch.object(mod, "get_installation_token", new=AsyncMock(return_value=None)), \
         patch.object(mod, "fetch_status_check_rollup", new=AsyncMock()) as roll, \
         patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})) as cap:
        resp = await _post(_MERGE_PAYLOAD, event="pull_request")
    assert resp.status_code == 200
    roll.assert_not_called()
    assert cap.await_args.kwargs["ci_result"] is None
    assert _native_ci(resp) == {"state": "unknown", "reason": "no_installation_token"}


@pytest.mark.anyio
async def test_native_ci_unknown_reason_pending():
    """unknown(reason): rollup 미완료(pending) → reason=pending·ci unknown 유지(success 승격 0)."""
    with patch.object(mod, "get_installation_token", new=AsyncMock(return_value="inst-tok")), \
         patch.object(mod, "fetch_status_check_rollup", new=AsyncMock(return_value=(None, "pending"))), \
         patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})) as cap:
        resp = await _post(_MERGE_PAYLOAD, event="pull_request")
    assert resp.status_code == 200
    assert cap.await_args.kwargs["ci_result"] is None
    assert _native_ci(resp) == {"state": "unknown", "reason": "pending"}


@pytest.mark.anyio
async def test_native_ci_not_pulled_when_event_has_conclusion():
    """이벤트가 이미 CI 결론을 실으면 native pull 안 함(그 결론 유지·native_ci 미노출)."""
    payload = {"repository": {"full_name": "o/r"},
               "workflow_run": {"conclusion": "failure", "head_sha": "sha1",
                                "head_branch": f"feat-[SID:{STORY_ID}]", "pull_requests": [{"number": 7}]}}
    with patch.object(mod, "fetch_status_check_rollup", new=AsyncMock(return_value=("success", "resolved"))) as roll, \
         patch.object(mod, "capture_pr_ci_verdict",
                      new=AsyncMock(return_value={"recorded": ["ci"], "skipped_reason": None})) as cap:
        resp = await _post(payload, event="workflow_run")
    assert resp.status_code == 200
    roll.assert_not_awaited()  # 이벤트 결론 있으면 native 미호출.
    assert cap.await_args.kwargs["ci_result"] == "failure"
    assert _native_ci(resp) is None  # native 시도 안 함 → 미노출.


@pytest.mark.anyio
async def test_fetch_status_check_rollup_returns_ci_and_reason():
    """statusCheckRollup → (ci, reason). token 없음=(None,no_token)·state별 매핑·PAT 인자 없음."""
    assert await _svc.fetch_status_check_rollup("o/r", "sha", "") == (None, "no_token")
    assert await _svc.fetch_status_check_rollup("badrepo", "sha", "tok") == (None, "bad_input")

    def _resp(status, state):
        r = MagicMock()
        r.status_code = status
        r.json.return_value = {"data": {"repository": {"object": {"statusCheckRollup": ({"state": state} if state else None)}}}}
        return r

    import httpx
    cases = [
        (200, "SUCCESS", ("success", "resolved")),
        (200, "FAILURE", ("failure", "resolved")),
        (200, "ERROR", ("failure", "resolved")),
        (200, "PENDING", (None, "pending")),
        (200, "EXPECTED", (None, "pending")),
        (200, None, (None, "not_found")),
        (500, "SUCCESS", (None, "api_error")),
    ]
    for status, state, expected in cases:
        with patch.object(httpx.AsyncClient, "post", new=AsyncMock(return_value=_resp(status, state))):
            assert await _svc.fetch_status_check_rollup("moonklabs/sprintable", "abc", "inst-tok") == expected
