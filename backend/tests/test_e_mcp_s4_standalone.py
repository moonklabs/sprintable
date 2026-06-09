"""E-MCP S4: sprintable-mcp 독립 패키지 — import 디탱글 + vendored 규칙 동기 검증.

핵심 AC1: backend(app/*) import 없이 구동 가능. + pyproject 패키지 메타/엔트리포인트.
"""
import glob
import os
import tomllib

_PKG_DIR = os.path.join(os.path.dirname(__file__), "..", "sprintable_mcp")


def _pkg_py_files() -> list[str]:
    return glob.glob(os.path.join(_PKG_DIR, "*.py")) + glob.glob(os.path.join(_PKG_DIR, "tools", "*.py"))


# ── 디탱글: backend(app/*) import 0 ───────────────────────────────────────────

def test_no_backend_app_imports_in_package():
    offenders = []
    for path in _pkg_py_files():
        with open(path, encoding="utf-8") as f:
            src = f.read()
        for ln, line in enumerate(src.splitlines(), 1):
            s = line.strip()
            if s.startswith("from app.") or s.startswith("import app") or s.startswith("from backend"):
                offenders.append(f"{os.path.basename(path)}:{ln} {s}")
    assert offenders == [], f"독립 패키지에 backend import 잔존: {offenders}"


def test_toolset_vendored_module_present():
    assert os.path.exists(os.path.join(_PKG_DIR, "toolset.py"))


# ── vendored 규칙이 백엔드 SSOT와 동일(드리프트 방지) ─────────────────────────

def test_vendored_toolset_matches_backend_rules():
    from sprintable_mcp import toolset as vend
    from app.services import mcp_toolset as backend

    matrix_tools = [
        "sprintable_add_story", "sprintable_add_task", "sprintable_delete_story",
        "sprintable_give_reward", "sprintable_send_chat_message", "sprintable_get_velocity",
        "sprintable_ping", "sprintable_create_sprint", "sprintable_lock_files",
    ]
    matrix_scopes = [None, [], ["read", "write"], ["stories"], ["stories", "tasks"],
                     ["stories", "destructive"], ["admin"]]
    for t in matrix_tools:
        # 그룹/destructive 동일
        assert vend.tool_group(t) == backend.tool_group(t), t
        assert vend.is_destructive(t) == backend.is_destructive(t), t
        for sc in matrix_scopes:
            assert vend.is_tool_allowed(t, sc) == backend.is_tool_allowed(t, sc), (t, sc)


# ── pyproject 패키지 메타 ─────────────────────────────────────────────────────

def test_pyproject_metadata_and_entrypoint():
    with open(os.path.join(_PKG_DIR, "pyproject.toml"), "rb") as f:
        cfg = tomllib.load(f)
    assert cfg["project"]["name"] == "sprintable-mcp"
    assert cfg["project"]["scripts"]["sprintable-mcp"] == "sprintable_mcp.__main__:main"
    deps = " ".join(cfg["project"]["dependencies"])
    assert "mcp" in deps and "httpx" in deps and "pydantic" in deps
    # backend(app/*) 의존 미선언
    assert "app" not in cfg["project"].get("dependencies", []) and "backend" not in deps
    # entry target import + main 존재
    import sprintable_mcp.__main__ as m
    assert callable(m.main)
