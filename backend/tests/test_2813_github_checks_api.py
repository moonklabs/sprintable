"""story #2813(Gate→GitHub required check) — Checks API 클라이언트 단위(mock, 실서버 0).

github_app.py의 App JWT/installation token은 test_github_app_bot_s.py가 이미 커버 — 여기는
create_check_run/update_check_run만(신규 함수, 그라운딩 doc §1에서 확認한 "repo 전수 0건").
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import pytest

from app.services import github_app as ga


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _seed_token_cache():
    ga._token_cache[999] = ("cached-tok", time.time() + 3600)
    yield
    ga._token_cache.clear()


def _resp(status_code: int, body: dict):
    return type("R", (), {"status_code": status_code, "json": lambda self: body})()


@pytest.mark.anyio
async def test_create_check_run_sends_correct_payload_and_returns_result():
    r = _resp(201, {"id": 555, "status": "in_progress"})
    captured = {}

    async def _post(self, url, headers=None, json=None):
        captured["url"] = url
        captured["json"] = json
        return r

    with patch("httpx.AsyncClient.post", new=_post):
        result = await ga.create_check_run(999, "acme/repo", "abc123", status="in_progress")

    assert result == {"id": 555, "status": "in_progress"}
    assert captured["url"] == "https://api.github.com/repos/acme/repo/check-runs"
    assert captured["json"]["name"] == "sprintable/gate"
    assert captured["json"]["head_sha"] == "abc123"
    assert captured["json"]["status"] == "in_progress"
    assert "conclusion" not in captured["json"]  # in_progress엔 conclusion 없음(GitHub API 제약).


@pytest.mark.anyio
async def test_create_check_run_completed_includes_conclusion():
    r = _resp(201, {"id": 556})
    captured = {}

    async def _post(self, url, headers=None, json=None):
        captured["json"] = json
        return r

    with patch("httpx.AsyncClient.post", new=_post):
        await ga.create_check_run(999, "acme/repo", "sha1", status="completed", conclusion="success")

    assert captured["json"]["status"] == "completed"
    assert captured["json"]["conclusion"] == "success"


@pytest.mark.anyio
async def test_create_check_run_http_failure_returns_none_not_raise():
    r = _resp(500, {})
    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=r)):
        result = await ga.create_check_run(999, "acme/repo", "sha1")
    assert result is None  # fail-closed: 예외 없이 None — 호출자가 "GitHub 쪽 무영향"으로 처리.


@pytest.mark.anyio
async def test_create_check_run_no_token_returns_none():
    ga._token_cache.clear()
    with patch.object(ga, "build_app_jwt", return_value=None):
        result = await ga.create_check_run(999, "acme/repo", "sha1")
    assert result is None


@pytest.mark.anyio
async def test_update_check_run_patches_correct_url():
    r = _resp(200, {"id": 555, "status": "completed", "conclusion": "success"})
    captured = {}

    async def _patch(self, url, headers=None, json=None):
        captured["url"] = url
        captured["json"] = json
        return r

    with patch("httpx.AsyncClient.patch", new=_patch):
        result = await ga.update_check_run(999, "acme/repo", 555, status="completed", conclusion="success")

    assert result["id"] == 555
    assert captured["url"] == "https://api.github.com/repos/acme/repo/check-runs/555"
    assert captured["json"]["conclusion"] == "success"


@pytest.mark.anyio
async def test_update_check_run_http_failure_returns_none_not_raise():
    r = _resp(404, {})
    with patch("httpx.AsyncClient.patch", new=AsyncMock(return_value=r)):
        result = await ga.update_check_run(999, "acme/repo", 555, status="completed", conclusion="failure")
    assert result is None


# story #2893(설계안 §3 B2-a) — remove_pr_label(신규, create/update_check_run과 동형 계약).
@pytest.mark.anyio
async def test_remove_pr_label_sends_delete_to_correct_url():
    r = _resp(200, {})
    captured = {}

    async def _delete(self, url, headers=None):
        captured["url"] = url
        return r

    with patch("httpx.AsyncClient.delete", new=_delete):
        result = await ga.remove_pr_label(999, "acme/repo", 42, "design:pass")

    assert result is True
    # ':' 는 URL 컴포넌트라 인코딩돼야 한다(라벨명이 그대로 path segment에 못 들어감).
    assert captured["url"] == "https://api.github.com/repos/acme/repo/issues/42/labels/design%3Apass"


@pytest.mark.anyio
async def test_remove_pr_label_404_is_idempotent_success():
    """라벨이 애초에 없었다 — 목표 상태(제거됨)와 동일하므로 성공 취급(fail-closed 아님,
    존재-확인 없이 매번 시도하는 설계에서 필수)."""
    r = _resp(404, {})
    with patch("httpx.AsyncClient.delete", new=AsyncMock(return_value=r)):
        result = await ga.remove_pr_label(999, "acme/repo", 42, "qa:pass")
    assert result is True


@pytest.mark.anyio
async def test_remove_pr_label_other_failure_returns_false_not_raise():
    r = _resp(500, {})
    with patch("httpx.AsyncClient.delete", new=AsyncMock(return_value=r)):
        result = await ga.remove_pr_label(999, "acme/repo", 42, "qa:pass")
    assert result is False


@pytest.mark.anyio
async def test_remove_pr_label_no_token_returns_false():
    ga._token_cache.clear()
    with patch.object(ga, "build_app_jwt", return_value=None):
        result = await ga.remove_pr_label(999, "acme/repo", 42, "qa:pass")
    assert result is False
