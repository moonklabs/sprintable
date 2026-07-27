"""E-UI-DAEGBYEON P0-05 후속(story 174be6bc·doc scope-violation-signal-design) — 순수함수 단위 테스트.

check_scope_violation(글롭 판정, dir/** 계약 고정) + fetch_pr_changed_files(신규 GitHub API,
graceful None on failure) 커버. DB 무의존."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.verdict_capture import check_scope_violation, fetch_pr_changed_files

pytestmark = [pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── check_scope_violation: 순수함수 글롭 판정 ────────────────────────────────

def test_no_declared_paths_no_violation():
    assert check_scope_violation([], ["backend/app/x.py"]) == (False, [])
    assert check_scope_violation(None, ["backend/app/x.py"]) == (False, [])


def test_no_changed_files_no_violation():
    assert check_scope_violation(["backend/app/**"], []) == (False, [])


def test_exact_file_match_in_scope():
    violated, out = check_scope_violation(
        ["backend/app/routers/stories.py"], ["backend/app/routers/stories.py"]
    )
    assert violated is False
    assert out == []


def test_file_outside_declared_globs_violates():
    violated, out = check_scope_violation(
        ["backend/app/routers/stories.py"], ["backend/app/other.py"]
    )
    assert violated is True
    assert out == ["backend/app/other.py"]


def test_mixed_in_and_out_of_scope_files():
    declared = ["backend/app/routers/stories.py"]
    changed = ["backend/app/routers/stories.py", "backend/app/other.py", "frontend/x.ts"]
    violated, out = check_scope_violation(declared, changed)
    assert violated is True
    assert out == ["backend/app/other.py", "frontend/x.ts"]


def test_dir_double_star_covers_arbitrary_depth():
    """⭐dir/** 계약(doc §2 오픈질문③ 확定) — 임의 depth 하위 파일까지 커버가 명시 계약."""
    declared = ["backend/tests/**"]
    changed = [
        "backend/tests/test_x.py",
        "backend/tests/sub/test_y.py",
        "backend/tests/sub/deep/nested/test_z.py",
    ]
    violated, out = check_scope_violation(declared, changed)
    assert violated is False
    assert out == []


def test_dir_double_star_does_not_leak_to_sibling_dir():
    declared = ["backend/tests/**"]
    violated, out = check_scope_violation(declared, ["backend/app/routers/stories.py"])
    assert violated is True
    assert out == ["backend/app/routers/stories.py"]


def test_multiple_declared_globs_any_match_in_scope():
    declared = ["backend/app/routers/stories.py", "backend/tests/**"]
    changed = ["backend/app/routers/stories.py", "backend/tests/sub/test_y.py"]
    violated, out = check_scope_violation(declared, changed)
    assert violated is False
    assert out == []


# ── fetch_pr_changed_files: 신규 GitHub API 호출(graceful None) ─────────────

async def test_no_token_returns_none():
    assert await fetch_pr_changed_files("o/r", 1, "") is None


async def test_bad_repo_or_pr_number_returns_none():
    assert await fetch_pr_changed_files("badrepo", 1, "tok") is None
    assert await fetch_pr_changed_files("o/r", 0, "tok") is None


def _files_resp(status, filenames):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = [{"filename": f} for f in filenames]
    return r


async def test_single_page_success():
    import httpx
    with patch.object(httpx.AsyncClient, "get", new=AsyncMock(return_value=_files_resp(200, ["a.py", "b.py"]))):
        result = await fetch_pr_changed_files("moonklabs/sprintable", 42, "inst-tok")
    assert result == ["a.py", "b.py"]


async def test_non_200_returns_none():
    import httpx
    with patch.object(httpx.AsyncClient, "get", new=AsyncMock(return_value=_files_resp(404, []))):
        assert await fetch_pr_changed_files("moonklabs/sprintable", 42, "inst-tok") is None


async def test_pagination_across_pages():
    import httpx
    page1 = _files_resp(200, [f"f{i}.py" for i in range(100)])
    page2 = _files_resp(200, ["last.py"])
    with patch.object(httpx.AsyncClient, "get", new=AsyncMock(side_effect=[page1, page2])):
        result = await fetch_pr_changed_files("moonklabs/sprintable", 42, "inst-tok")
    assert result == [f"f{i}.py" for i in range(100)] + ["last.py"]


async def test_exceeds_page_cap_gives_up_none():
    """상한(3페이지×100) 초과 — 부분 목록으로 오탐 방지 위해 판정 포기(None)."""
    import httpx
    full_page = _files_resp(200, [f"f{i}.py" for i in range(100)])
    with patch.object(httpx.AsyncClient, "get", new=AsyncMock(return_value=full_page)):
        assert await fetch_pr_changed_files("moonklabs/sprintable", 42, "inst-tok") is None


async def test_network_exception_returns_none():
    import httpx
    with patch.object(httpx.AsyncClient, "get", new=AsyncMock(side_effect=RuntimeError("boom"))):
        assert await fetch_pr_changed_files("moonklabs/sprintable", 42, "inst-tok") is None
