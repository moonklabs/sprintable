"""story #2078 핫픽스 회귀 가드: `Settings` 클래스에 같은 필드명이 두 번 선언되면 파이썬
클래스 바디에서 나중 선언이 조용히 이긴다(필드 shadowing) — `redis_url`이 정확히 이 패턴으로
`event_broker`용 `None` 기본값이 `RedisRateLimiter`용 `"redis://localhost:6379/0"`에 가려져,
Memorystore 배선 전까지 아무도 못 알아챘다. 정적 grep으로 재발을 원천 차단한다.
"""
from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent.parent / "app" / "core" / "config.py"


def _settings_field_names() -> list[str]:
    tree = ast.parse(_CONFIG_PATH.read_text())
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    names.append(stmt.target.id)
    return names


def test_settings_has_no_duplicate_field_declarations():
    names = _settings_field_names()
    assert names, "Settings 클래스에서 필드를 하나도 못 찾았다 — 파서/경로 확인 필요"
    dupes = {name: count for name, count in Counter(names).items() if count > 1}
    assert not dupes, (
        f"Settings에 중복 선언된 필드 발견 — 나중 선언이 조용히 앞 선언을 가린다(story #2078 재발): {dupes}"
    )
