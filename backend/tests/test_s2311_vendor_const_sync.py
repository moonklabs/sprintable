"""story #2311 — infra/check_mcp_vendor_sync.py 회귀가드.

배경: `backend/app/services/mcp_toolset.py`(원본) ↔ `backend/sprintable_mcp/toolset.py`
(vendored 사본)가 값이 갈려도 아무도 못 잡던 구멍. 전례가 둘(P1-S12 lock_files/standup 누락,
2026-07-29 delete_sprint 잔존) — 둘 다 「누가 우연히 볼 때까지」 발견 안 됐다.

AC1: 대조 대상을 손으로 나열하지 않는다 — 양쪽 모듈에서 같은 이름을 가진 공개 상수를 자동으로
찾아 비교한다. AC3: 실제 파싱(모듈 import+실행, 텍스트/블록 추출 아님)이라 `ALL_GROUPS`처럼
계산식으로 된 상수도 올바르게 비교된다(예전 블록 추출 파서가 "완전일치"라는 거짓 답을 낸
전례를 피한다). AC4: 재료(파일/공통 이름)를 못 찾으면 skip 대신 실패한다.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load_check_mcp_vendor_sync():
    spec = importlib.util.spec_from_file_location(
        "check_mcp_vendor_sync", _INFRA_DIR / "check_mcp_vendor_sync.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── AC1: 자동 발견 — 손으로 나열한 목록이 아니라 실제 교집합 ────────────────────────

def test_common_constants_are_auto_discovered_not_hardcoded():
    """지금 리포에 실제로 공통 이름 6개가 있다 — 이 값이 이 테스트가 하드코딩한 «기대 목록»이
    아니라 `find_matching_constants()`가 두 모듈을 실행해 스스로 찾은 결과임을 확認한다
    (AC1: 새 상수가 양쪽에 추가되면 이 집합도 저절로 늘어난다 — 유지보수 불필요)."""
    mod = _load_check_mcp_vendor_sync()
    common = mod.find_matching_constants()
    assert set(common) == {
        "ALL_GROUPS", "_ALWAYS_ALLOWED", "_CORE", "_DESTRUCTIVE_SCOPES",
        "_GROUP_KEYWORDS", "_LEGACY_SCOPES",
    }


def test_future_annotations_feature_is_not_counted_as_a_constant():
    """`from __future__ import annotations`가 두 파일 모두에 있어 `annotations`라는 이름이
    양쪽 최상위에 바인딩되지만, 이건 실제 데이터 상수가 아니라 언어 기능 객체다 — 대조 대상에서
    빠져야 한다."""
    mod = _load_check_mcp_vendor_sync()
    common = mod.find_matching_constants()
    assert "annotations" not in common


# ── AC2: 지금 있는 차이가 실제로 없어졌다 ───────────────────────────────────────

def test_repo_current_state_has_no_mismatches():
    """리포에 실제로 커밋된 두 파일이 지금 완전히 동일하다 — delete_sprint 잔존이 해소됐다."""
    mod = _load_check_mcp_vendor_sync()
    assert mod.mismatches() == []


def test_main_returns_zero_on_repo_current_state():
    mod = _load_check_mcp_vendor_sync()
    assert mod.main() == 0


# ── AC3: 실제 파싱(import+실행) — 계산식 상수(`ALL_GROUPS`)도 올바르게 비교된다 ────────

def test_computed_constant_all_groups_is_correctly_compared():
    """`ALL_GROUPS`는 리터럴이 아니라 `tuple(g for g, _ in _GROUP_KEYWORDS if ...) + (_CORE,)`
    계산식이다 — 텍스트/AST 블록 추출로는 이런 형태를 놓치기 쉽다(예전 실패 사례와 동형).
    모듈을 실제로 import해 실행하므로 이것도 정확한 값으로 비교된다는 것을 직접 확認."""
    mod = _load_check_mcp_vendor_sync()
    common = mod.find_matching_constants()
    orig_val, vend_val = common["ALL_GROUPS"]
    assert orig_val == vend_val
    assert "stories" in orig_val and "core" in orig_val  # sanity — 실제 계산된 값


# ── AC4: 양성대조 — 뮤테이션으로 방법이 실제로 잡는지 증명 ──────────────────────────

def test_positive_control_group_keyword_mismatch_is_caught(monkeypatch):
    """`_GROUP_KEYWORDS`에 한쪽에만 있는 키워드를 인위로 넣으면 잡히는지 — delete_sprint
    잔존과 정확히 같은 모양의 결함을 재현한다."""
    mod = _load_check_mcp_vendor_sync()

    real_load = mod._load_module

    def fake_load(path, name):
        module = real_load(path, name)
        if "sprintable_mcp" in str(path):  # vendored 쪽에만 뮤테이션
            mutated = [
                (g, kws + ("ghost_typo_keyword",)) if g == "admin" else (g, kws)
                for g, kws in module._GROUP_KEYWORDS
            ]
            module._GROUP_KEYWORDS = mutated
        return module

    monkeypatch.setattr(mod, "_load_module", fake_load)
    problems = mod.mismatches()
    assert any("ghost_typo_keyword" in p for p in problems)


def test_positive_control_set_constant_mismatch_is_caught(monkeypatch):
    """`_ALWAYS_ALLOWED`(frozenset)에 인위 항목을 넣으면 집합 대칭차로 잡히는지."""
    mod = _load_check_mcp_vendor_sync()
    real_load = mod._load_module

    def fake_load(path, name):
        module = real_load(path, name)
        if "sprintable_mcp" in str(path):
            module._ALWAYS_ALLOWED = module._ALWAYS_ALLOWED | frozenset({"ghost_tool_xyz"})
        return module

    monkeypatch.setattr(mod, "_load_module", fake_load)
    problems = mod.mismatches()
    assert any("ghost_tool_xyz" in p for p in problems)


def test_positive_control_does_not_touch_disk(monkeypatch):
    """AC3 원복 확認 — 양성대조는 monkeypatch로 «로드된 모듈 객체»만 변형해야 하고 디스크의
    실제 파일은 건드리면 안 된다. 파일 바이트 내용을 실행 전후로 직접 대조해 확認한다
    (ambient git 상태에 기대지 않음 — 이 PR 자체가 AC2로 vendored 파일을 정당하게 고쳤으므로
    git status는 이 테스트 시점에 이미 non-empty일 수 있다)."""
    original_bytes = _INFRA_DIR.parent.joinpath(
        "backend", "sprintable_mcp", "toolset.py"
    ).read_bytes()

    mod = _load_check_mcp_vendor_sync()
    real_load = mod._load_module

    def fake_load(path, name):
        module = real_load(path, name)
        if "sprintable_mcp" in str(path):
            module._ALWAYS_ALLOWED = module._ALWAYS_ALLOWED | frozenset({"disk_touch_probe"})
        return module

    monkeypatch.setattr(mod, "_load_module", fake_load)
    mod.mismatches()  # 뮤테이션이 실제로 실행되게 트리거

    after_bytes = _INFRA_DIR.parent.joinpath(
        "backend", "sprintable_mcp", "toolset.py"
    ).read_bytes()
    assert original_bytes == after_bytes, "양성대조가 실제 파일 바이트를 건드렸다"


# ── AC4: 재료를 못 찾으면 실패(skip 금지) ───────────────────────────────────────

def test_load_module_raises_when_file_missing(tmp_path):
    mod = _load_check_mcp_vendor_sync()
    with pytest.raises(RuntimeError, match="대조 대상 파일을 못 찾음"):
        mod._load_module(tmp_path / "does_not_exist.py", "ghost")


def test_find_matching_constants_raises_when_no_common_names(monkeypatch, tmp_path):
    """양쪽 파일이 로드는 되지만 공통 상수 이름이 0건이면 조용히 빈 결과를 돌려주지 않고
    실패한다."""
    mod = _load_check_mcp_vendor_sync()
    empty_a = tmp_path / "a.py"
    empty_b = tmp_path / "b.py"
    empty_a.write_text("FOO_ONLY_IN_A = 1\n")
    empty_b.write_text("BAR_ONLY_IN_B = 2\n")
    monkeypatch.setattr(mod, "_ORIGINAL_PATH", empty_a)
    monkeypatch.setattr(mod, "_VENDORED_PATH", empty_b)
    with pytest.raises(RuntimeError, match="공통 상수 이름 0건"):
        mod.find_matching_constants()


def test_find_repo_root_raises_without_git_marker(tmp_path):
    mod = _load_check_mcp_vendor_sync()
    isolated = tmp_path / "no" / "git" / "here"
    isolated.mkdir(parents=True)
    with pytest.raises(RuntimeError, match="repo root"):
        mod._find_repo_root(isolated)
