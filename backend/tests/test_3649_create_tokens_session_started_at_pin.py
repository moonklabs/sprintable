"""story #3649(BE·보안·prod 결함, 페드루 PO 대조 발견 2026-09-07) — `create_tokens()`
호출부 전수 정적 핀. #3649의 세션 무효화 판정(`_is_session_stale_after_password_change`)
은 `session_started_at`이 int가 아니면 fail-closed(세션 무효로 본다)로 판정한다 — 그
판정을 refresh/switch-project/switch-org/switch-account 4개 재발급 경로로 넓히면서,
이 클레임을 안 싣는 로그인 경로가 하나라도 있으면 「그 경로로 로그인한 password_set_at
있는 유저는 첫 재발급 호출에서 조용히 락아웃」된다(실사고: `auth_firebase_internal.py`
의 oauth-handoff/consume이 이 클레임을 누락 — PO가 diff 밖 grep으로 발견, 이 핀이
그 재발을 막는다).

계약: `backend/app` 안 모든 `create_tokens(...)` 호출은 `session_started_at=` 키워드
인자를 실어야 한다(로그인 경로=지금 시각, 재발급 경로=원 값 이월 — 어느 쪽이든 "넘긴다"
는 계약은 같다, 값 자체의 정합성은 이 핀의 범위 밖)."""
from __future__ import annotations

import ast
from pathlib import Path

_APP_DIR = Path(__file__).parent.parent / "app"


def _find_create_tokens_calls_missing_session_started_at() -> list[str]:
    """`create_tokens(...)` 호출 중 `session_started_at=` 키워드가 없는 자리를
    `file:line` 문자열로 반환(빈 리스트=전부 넘긴다)."""
    missing: list[str] = []
    for path in sorted(_APP_DIR.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(), filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
            if name != "create_tokens":
                continue
            if any(kw.arg == "session_started_at" for kw in node.keywords):
                continue
            missing.append(f"{path.relative_to(_APP_DIR.parent)}:{node.lineno}")
    return missing


def test_all_create_tokens_call_sites_pass_session_started_at():
    """AC2 — 전수 열거해 누락 0을 단언. 양성대조(주석에 못박음, story #3649 PR 본문
    확認 절차): 이 핀을 auth_firebase_internal.py:759 수정 前 head에서 먼저 돌려
    빨강(`app/routers/auth_firebase_internal.py:...` 1건)임을 실측한 뒤 되돌렸다 —
    이 assert가 실제로 그 결함을 잡는다는 증거."""
    missing = _find_create_tokens_calls_missing_session_started_at()
    assert missing == [], (
        "session_started_at 없이 create_tokens()를 호출하는 자리 — 이 로그인 경로로 "
        f"들어온 password_set_at 있는 유저는 첫 재발급 호출에서 조용히 락아웃된다: {missing}"
    )


def test_positive_control_missing_kwarg_is_actually_detected():
    """가드 자체가 실제로 걸리는지 자가 증명 — 합성 소스(임시 파일)에 누락 호출을
    심어 이 함수가 빈 리스트가 아닌 결과를 낸다는 것을 고정."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        fake_app = Path(tmp) / "app"
        fake_app.mkdir()
        (fake_app / "fake_router.py").write_text(
            "def f():\n"
            "    tokens = create_tokens(str(1), email='e', app_metadata={})\n"
        )
        import importlib

        module = importlib.import_module(__name__)
        original_dir = module._APP_DIR
        module._APP_DIR = fake_app
        try:
            missing = module._find_create_tokens_calls_missing_session_started_at()
        finally:
            module._APP_DIR = original_dir
        assert len(missing) == 1
        assert "fake_router.py" in missing[0]
