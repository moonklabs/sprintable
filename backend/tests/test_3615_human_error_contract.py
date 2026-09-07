"""story #3615(BE·계약, 페드루 PO 確定 2026-09-07) — 오류 봉투 `user_message`/
`user_message_key` additive 계약(`app/core/error_envelope.py::human_error`) 회귀.

두 축을 고정한다: (1) 헬퍼 자체의 shape(additive·기존 키 불변) (2) AC4 가드 — 지금
이 저장소에 `human_error(...)`로 채운 모든 `user_message=` 문자열 리터럴이 uuid나
스택/repr 패턴을 담지 않는다(정적 스캔 — 그 문자열이 애초에 «BE가 손으로 쓴 안전한
문장»이어야 한다는 이 계약의 전제 자체를 검산). 새 raise 자리가 uuid를 user_message에
실으면 이 테스트가 바로 잡는다."""
from __future__ import annotations

import ast
import re
from pathlib import Path

from app.core.error_envelope import human_error

_REPO_ROOT = Path(__file__).resolve().parents[2]
_APP_ROOT = _REPO_ROOT / "backend" / "app"

_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
# story #3601 docstring이 실측한 "안전하지 않은" 형(raw exception repr·내부 필드명
# 그대로) — 이 자체를 문자열 리터럴 안에서 재현할 리는 없지만, f-string 보간 흔적
# (중괄호)이 있으면 사람이 손으로 안 쓴 조립 문자열일 가능성이 높다는 신호로도 쓴다.
_FSTRING_INTERPOLATION_RE = re.compile(r"\{[^}]+\}")
_STACK_HINT_RE = re.compile(r"Traceback|File \"|line \d+, in ")


def test_human_error_is_additive_dict():
    d = human_error("CODE_A", "진단용 원문")
    assert d == {"code": "CODE_A", "message": "진단용 원문"}


def test_human_error_with_user_message():
    d = human_error("CODE_A", "진단용 원문", user_message="사람 문장")
    assert d["user_message"] == "사람 문장"
    assert d["code"] == "CODE_A"
    assert d["message"] == "진단용 원문"
    assert "user_message_key" not in d


def test_human_error_with_user_message_key():
    d = human_error("CODE_A", "진단용 원문", user_message_key="errorFoo")
    assert d["user_message_key"] == "errorFoo"
    assert "user_message" not in d


def test_human_error_extra_kwargs_passthrough():
    """기존 raise 자리가 부가 키(예: existing_reply_id)를 얹던 계약을 안 깬다."""
    d = human_error("CODE_A", "m", user_message="u", existing_reply_id="abc-123")
    assert d["existing_reply_id"] == "abc-123"


def _find_user_message_literals(tree: ast.AST) -> list[str]:
    """`human_error(..., user_message="...")`처럼 키워드 인자로 넘긴 **문자열 리터럴만**
    수집한다(변수·f-string 보간은 이 정적 스캔의 사각 — verify-no-date-tolocalestring.ts
    와 동형 한계 승계, 그 경우는 사람이 리뷰에서 직접 본다)."""
    found: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
        if name != "human_error":
            continue
        for kw in node.keywords:
            if kw.arg == "user_message" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                found.append(kw.value.value)
    return found


def test_all_human_error_user_message_literals_are_uuid_and_stack_free():
    """AC4 — 저장소 전체에서 `human_error(...)`가 채우는 user_message 문자열 리터럴을
    정적으로 모아 uuid·스택/repr 패턴이 0건임을 확認한다."""
    violations: list[tuple[str, str]] = []
    for py_file in _APP_ROOT.rglob("*.py"):
        content = py_file.read_text(encoding="utf-8")
        if "human_error(" not in content:
            continue
        tree = ast.parse(content, filename=str(py_file))
        for literal in _find_user_message_literals(tree):
            if _UUID_RE.search(literal) or _STACK_HINT_RE.search(literal):
                violations.append((str(py_file.relative_to(_REPO_ROOT)), literal))
    assert not violations, f"user_message에 uuid/스택 패턴이 실린 자리(0건이어야 함): {violations}"


def test_mutation_uuid_literal_would_be_caught():
    """뮤테이션 대조 — 위 스캐너가 실제로 uuid 패턴을 잡는지, 이 자리에 준비한 가짜
    소스(문자열, 파일 안 씀)로 직접 증명한다(레포를 더럽히지 않는다)."""
    fake_source = (
        'from app.core.error_envelope import human_error\n'
        'human_error("X", "m", user_message="연결 641adabf-1111-2222-3333-444455556666 실패")\n'
    )
    tree = ast.parse(fake_source)
    literals = _find_user_message_literals(tree)
    assert literals == ["연결 641adabf-1111-2222-3333-444455556666 실패"]
    assert _UUID_RE.search(literals[0]) is not None, "스캐너 자체가 uuid를 못 잡으면 본 테스트가 무의미해진다"
