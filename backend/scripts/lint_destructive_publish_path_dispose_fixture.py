"""story a05da51b — 「발행 경로를 타는 destructive realdb 테스트는 전역 엔진 dispose
fixture 필수」 정적 가드. CI가 커밋 시점에 잡는다.

배경(2026-09-02 — story #3330/PR#3711 CI 2회 flake): `test_3330_gate_verdict_
notification.py`가 실제로 메시지를 발행해 `send_message`의 background task
(`mark_agent_replied`)를 태우는데, 그 task는 이 테스트의 throwaway 엔진이 아니라
`app.core.database.async_session_factory`(전역·프로세스 수명 엔진)를 쓴다.
pytest-anyio가 테스트마다 새 이벤트 루프를 만드는데 dispose 없이 두면, 이 전역
엔진의 커넥션 풀이 "이전 루프에 묶인" 커넥션을 다음 테스트(같은 파일의 다음
테스트도 포함)에 재사용시키려다 `Event loop is closed`류로 죽는다.

⛔이 가드가 다루는 건 **destructive_schema 마커 파일만**이다 — non-destructive
파일은 story #3330(PR#3711)이 conftest.py의 `pytest_collection_modifyitems`에
심은 collection-시점 자동 주입(non-destructive **async** 테스트에만
`_dispose_global_engine_for_non_destructive_tests`를 자동으로 끼워 넣는다)이
이미 구조적으로 커버한다 — "그 파일 작성자가 이 위험을 알고 있었는가"에 기대지
않는다. destructive 파일은 그 자동 주입의 스코프 밖(파일별 완전 격리 프로세스라
**다른 파일**로는 안 새지만, **같은 파일 안의** 여러 테스트끼리는 여전히 같은
전역 엔진 풀을 공유하므로 위험이 남는다 — test_3329_embedded_entity_ref_
tokenization.py(PR#3713)가 정확히 이 클래스로 실측 재현됨, story a05da51b).

⛔무엇을 잡는가: destructive_schema 마커가 있는 파일이 "실 발행/HTTP 경로"
신호 함수(아래 `_TRIGGER_CALL_NAMES` — 전역 엔진의 background task 체인을
실제로 태우는 것으로 소스에서 확認된 것들, story #3330 그라운딩 근거)를 호출
하면서 `_dispose_global_engine_after_test`(246개 파일이 이미 쓰는 표준 fixture
이름) 문자열이 파일 안에 전혀 없으면 위반.

⛔판별 방식 — 이름 기반(호출 대상 함수가 실제로 그 경로를 타는지 타입 추적은
안 한다, `lint_destructive_test_sql.py`와 같은 비용/이득 판단): `ast.Call`의
함수명이 `_TRIGGER_CALL_NAMES`에 있으면 트리거로 센다. fixture 존재 여부는
파일 전체에서 `_dispose_global_engine_after_test` 문자열 출현으로 판별(정의든
호출이든 상관없이 — 오탐보다 미탐 방지를 우선, «있는데 못 찾음»보다 «있다고
쳐줌»이 이 가드의 목적에 안전).

⛔예외(마커) — 정말 이 fixture가 필요 없는 게 확실한 자리(예: 발행이 항상
mock/patch되어 전역 엔진에 절대 안 닿는 경우)는 같은 줄 또는 바로 윗줄에
`# dispose-fixture-not-needed: <사유>` 주석이 있으면 통과.

⛔이 가드가 **못 잡는 것**(선언, `lint_destructive_test_sql.py` docstring과
동일 원칙):
  · 트리거 함수를 **간접 호출**(다른 헬퍼 함수 안에서 한 단계 이상 건너 호출)하는
    경우 — 이 스캐너는 파일 안의 직접 `ast.Call` 이름만 본다, 호출 그래프 추적
    없음.
  · 트리거 함수를 동적으로(문자열 리플렉션·`getattr` 등) 호출하는 경우.
  · fixture 이름이 파일에 "문자열로만" 있고 실제로 `@pytest.fixture`로 등록/
    사용되지 않는 경우(예: 주석 안에만 언급) — 존재 여부만 보고 등록 여부는
    검증하지 않는다.
  다음에 이 사각을 밟는 사람이 있다면 그게 이 판단이 틀렸다는 신호이니 그때
  확장한다.

⛔baseline — 이 가드 도입 시점(2026-09-02) 스윕으로 기존 위반 전부 정리(test_3329
포함, story a05da51b이 이 커밋에서 함께 고침) 후 켰다. "봐주는 게 없다" 원칙은
`lint_destructive_test_sql.py`(#2786)와 동형.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).parent.parent / "tests"

# story #3330 그라운딩(gate_service.py::_publish_gate_verdict_notification·
# events.py::_publish_registry_event_core) 근거 — 실제로 send_message의
# background task(mark_agent_replied, 전역 엔진 소비처)를 태우는 것으로 소스에서
# 확認된 진입점만 담는다(추측 0).
_TRIGGER_CALL_NAMES = {
    "publish_registry_event",  # events.py 라우터 함수 — 직접 호출 realdb 테스트가 흔함.
    "publish_preset_event",  # 서버 자동발행 진입점(#2791) — 위와 같은 core를 태움.
    "transition_gate",  # story #3330 이후 approved/rejected 전이마다 무조건 알림 발행 시도.
    "send_message",  # conversations.py — 발행 경로의 최종 메시지 생성 지점.
}
_FIXTURE_NAME = "_dispose_global_engine_after_test"
_ALLOW_MARKER_RE = re.compile(r"#\s*dispose-fixture-not-needed\s*:")


def _call_func_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _is_destructive_schema_mark(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "destructive_schema"
        and isinstance(node.value, ast.Attribute)
        and node.value.attr == "mark"
    )


def _has_destructive_schema_marker(tree: ast.AST) -> bool:
    """lint_destructive_test_sql.py::_has_destructive_schema_marker와 동일 판별(재사용
    — 두 벌 유지 대신 같은 시그널을 각 스크립트가 독립적으로 같은 규칙으로 재현, story
    #2643/conftest.py의 판별축과도 동형)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and _is_destructive_schema_mark(node.value):
            return True
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for deco in node.decorator_list:
                target = deco.func if isinstance(deco, ast.Call) else deco
                if _is_destructive_schema_mark(target):
                    return True
    return False


def _has_allow_marker(source: str) -> bool:
    return bool(_ALLOW_MARKER_RE.search(source))


def _find_trigger_calls(tree: ast.AST) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _call_func_name(node)
            if name in _TRIGGER_CALL_NAMES:
                hits.append((node.lineno, name))
    return hits


def find_violation(path: Path) -> tuple[str, list[str]] | None:
    """destructive 마커 파일이 트리거 호출을 갖는데 fixture 문자열이 파일에 없으면
    (파일, [트리거명 목록]) 반환, 아니면 None."""
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        return None
    if not _has_destructive_schema_marker(tree):
        return None
    triggers = _find_trigger_calls(tree)
    if not triggers:
        return None
    if _FIXTURE_NAME in source:
        return None
    if _has_allow_marker(source):
        return None
    trigger_names = sorted({name for _, name in triggers})
    return str(path), trigger_names


def scan_dir(root: Path) -> tuple[list[tuple[str, list[str]]], int]:
    violations: list[tuple[str, list[str]]] = []
    files = sorted(root.rglob("*.py"))
    for path in files:
        v = find_violation(path)
        if v is not None:
            violations.append(v)
    return violations, len(files)


def scan_repo() -> tuple[list[tuple[str, list[str]]], int]:
    return scan_dir(TESTS_DIR)


def main() -> int:
    violations, scanned = scan_repo()
    print(f"스캔 파일 {scanned}개(tests/ 재귀)")
    if violations:
        print(f"FAIL: 발행 경로를 타는데 dispose fixture가 없는 destructive 테스트 파일 {len(violations)}건")
        print("story a05da51b 판정: 이 파일들은 publish_registry_event/publish_preset_event/")
        print("transition_gate/send_message를 호출해 전역 엔진(app.core.database.engine)의")
        print("background task 경로를 태우는데, `_dispose_global_engine_after_test` fixture가")
        print("없다 — 같은 파일 안 여러 테스트 사이에서 커넥션 누수/Event loop is closed로")
        print("이어질 수 있다(story #3330/PR#3711 실사고).")
        print("정말 필요 없으면 `# dispose-fixture-not-needed: <사유>` 마커를 파일에 다세요.")
        for file, trigger_names in violations:
            print(f"  {file} — 트리거: {', '.join(trigger_names)}")
        return 1
    print("OK: 발행 경로 타는 destructive 파일 전부 dispose fixture 보유")
    return 0


if __name__ == "__main__":
    sys.exit(main())
