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
from app.routers.verdict_capture import _candidate_texts, _extract_pr_ci, _normalize_ci, _verify_github_signature

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
    payload = {"action": "closed", "pull_request": {"number": 12, "merged": True}}
    pr_number, merged, ci = _extract_pr_ci("pull_request", payload)
    assert pr_number == 12 and merged is True and ci is None


def test_extract_pr_ci_workflow_run_failure():
    payload = {"workflow_run": {"conclusion": "failure", "pull_requests": [{"number": 7}]}}
    pr_number, merged, ci = _extract_pr_ci("workflow_run", payload)
    assert pr_number == 7 and merged is False and ci == "failure"  # AC④.


def test_verify_signature():
    body = b'{"a":1}'
    sig = "sha256=" + hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()
    with patch.object(mod.settings, "github_webhook_secret", _SECRET):
        assert _verify_github_signature(body, sig) is True
        assert _verify_github_signature(body, "sha256=bad") is False
    with patch.object(mod.settings, "github_webhook_secret", ""):
        assert _verify_github_signature(body, sig) is False  # 시크릿 미설정 → 거부.


# ── 엔드포인트(실 runtime 경로) ────────────────────────────────────────────────

def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()


async def _post(payload: dict, *, event: str, story=..., sign=True):
    from app.dependencies.database import get_db
    from app.main import app

    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = (
        MagicMock(org_id=ORG_ID) if story is ... else story
    )
    session.execute = AsyncMock(return_value=result)

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    body = json.dumps(payload).encode()
    headers = {"X-GitHub-Event": event}
    headers["X-Hub-Signature-256"] = _sign(body) if sign else "sha256=bad"
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_webhook_secret", _SECRET):
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
