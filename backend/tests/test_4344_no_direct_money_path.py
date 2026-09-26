"""story #4344 AC3 — 걷은 옛 돈 경로가 되살아나지 않게 막는 가드(소스 AST · DB 불필요).

옛 동기 `change_tier()`는 결제 시도(story #4335) 밖에서 청구 → 옛 결제 부분취소를 한 호출에 잇던 판이었다. 결제 시도 뒤 운영
호출처가 0이 되어 걷었다(«돈 기록 하나에 주인 하나» — 결제 시도 행 없이 환불이 나갈 자리).

1. `app/` 어디에도 이름이 정확히 `change_tier`인 함수가 다시 생기지 않는다(요금제 변경은 `start_change_tier_attempt` 하나).
2. 환불(`billing_refund.refund_org`)을 가져오거나 부르는 운영 모듈은 결제 시도(`billing_payment_attempt.py`)뿐이다. 다른 모듈이
   환불을 직접 부르면 시도 행(환불 임대 · 멱등 키 · 알림) 없이 돈이 나간다 — 새 호출처가 정말 필요하면 이 목록을 PR에서 늘리고
   그 경로가 시도 행을 거치는지 리뷰에서 본다.
"""
from __future__ import annotations

import ast
from pathlib import Path

_APP = Path(__file__).resolve().parents[1] / "app"
_REFUND_ALLOWED = {"services/billing_payment_attempt.py", "services/billing_refund.py"}


def _modules():
    for path in sorted(_APP.rglob("*.py")):
        yield path.relative_to(_APP).as_posix(), ast.parse(path.read_text(encoding="utf-8"))


def test_no_function_named_change_tier_comes_back():
    found = [
        f"{rel}:{node.lineno}"
        for rel, tree in _modules()
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "change_tier"
    ]
    assert not found, f"옛 동기 요금제 변경 `change_tier`가 다시 생겼다 — 결제 시도(start_change_tier_attempt)로: {found}"


def test_only_the_payment_attempt_module_touches_refund_org():
    offenders = []
    for rel, tree in _modules():
        if rel in _REFUND_ALLOWED:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and any(a.name == "refund_org" for a in node.names):
                offenders.append(f"{rel}:{node.lineno} import")
            elif isinstance(node, ast.Call):
                fn = node.func
                name = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
                if name == "refund_org":
                    offenders.append(f"{rel}:{node.lineno} call")
    assert not offenders, f"결제 시도 밖 환불 호출 — 시도 행 없이 돈이 나갈 자리: {offenders}"


def test_the_guard_sees_the_real_refund_call_site():
    """양성 대조 — 스캔이 비어 공허하게 통과하지 않게: 허용 모듈에는 실제 호출이 있다."""
    tree = ast.parse((_APP / "services" / "billing_payment_attempt.py").read_text(encoding="utf-8"))
    calls = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "refund_org"
    ]
    assert calls, "billing_payment_attempt.py의 refund_org 호출을 못 찾음 — 가드 스캔이 망가졌다"
