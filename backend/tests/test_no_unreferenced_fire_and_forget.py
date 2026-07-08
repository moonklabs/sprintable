"""까심 QA 후속(#1970 RC, 2026-07-08): fire_and_forget 근본fix가 pg_notify 4곳만 잡고
`conversation_webhook.py`/`dispatch_router.py`의 동일 취약 패턴(`asyncio.ensure_future`,
참조 미보관)을 놓쳤다 — 이 회귀 가드가 있었으면 자동으로 걸렸을 것.

정적 grep 가드: `backend/app` 전체에서 참조 미보관 fire-and-forget 패턴(`.create_task(`·
`ensure_future(`)이 허용 목록(main.py의 lifespan-tracked task·pg_pubsub.py의 fire_and_forget
구현 자체) 밖에 하나도 없어야 한다.
"""
from __future__ import annotations

import re
from pathlib import Path

_APP_DIR = Path(__file__).parent.parent / "app"

# main.py: task/l2_task 변수에 참조 보관 + lifespan finally에서 cancel()+await로 명시 추적(안전).
# pg_pubsub.py: fire_and_forget() 자체의 정석 구현(강한 참조 set 보관) + 그걸 설명하는 docstring.
# l2_trigger_worker.py: 실 호출 없음 — docstring이 "asyncio.create_task(...)" 문자열을 언급할 뿐.
_ALLOWED_FILES = {
    _APP_DIR / "main.py",
    _APP_DIR / "services" / "pg_pubsub.py",
    _APP_DIR / "services" / "l2_trigger_worker.py",
}
_PATTERN = re.compile(r"\.create_task\(|\bensure_future\(")


def test_no_unreferenced_create_task_or_ensure_future_outside_allowlist():
    violations = []
    for path in _APP_DIR.rglob("*.py"):
        if path in _ALLOWED_FILES:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if _PATTERN.search(line):
                violations.append(f"{path.relative_to(_APP_DIR)}:{lineno}: {line.strip()}")
    assert not violations, (
        "참조 미보관 fire-and-forget task 발견 — app.services.pg_pubsub.fire_and_forget()으로 "
        "전환 필요(GC 조기수거→커넥션 누수 재발, #1970 근본fix 취지):\n" + "\n".join(violations)
    )
