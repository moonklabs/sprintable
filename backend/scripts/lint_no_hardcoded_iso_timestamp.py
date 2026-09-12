"""story #3528(BE·재발 가드, 페드루 PO 근본처방 2026-09-12) — `backend/app/**`
(tests 제외) 문자열 리터럴에 ISO 절대 일시(`"20\\d\\d-\\d\\d-\\d\\dT`)가 박히는 재발
클래스를 막는다.

## 실사고(2026-09-12 00:00Z 넘어가며 develop 전수 destructive-schema shard RED)
`sandbox_publish.py`/`instagram_sandbox_publish.py`/`facebook_sandbox_publish.py`
세 파일이 sandbox 댓글의 `external_created_at`을 벽시계 고정 절대 타임스탬프
("2026-09-05T00:00:00+00:00" 등)로 박아 뒀다 — 그 발행물이 **언제 발행됐든** 벽시계가
그 날짜+7일을 지나는 순간부터 `channel_post_comments.py::_is_publication_active`의
「마지막 댓글로부터 7일 이내」 창이 영구 False가 돼 자가회수 재생성 전체가 죽었다.
근본처방은 그 타임스탬프를 벽시계가 아니라 **그 발행물 자신의 published_at 기준
결정적 오프셋**으로 바꾸는 것 — 이 가드는 그 klass(고정 절대 일시)가 다시 코드에
박히는 것을 잡는다.

## 기전 — AST(story #3779 한글 가드와 동형 사상, 정규식 줄 스캔이 아니라 `ast.Constant`
문자열 노드만 본다). docstring(모듈/클래스/함수 body의 첫 statement가 문자열 리터럴인
경우)은 제외 — 이 파일 자신의 위 문단처럼 "과거에 있었던 버그값"을 설명하는 문서
텍스트까지 걸리면 이 가드 자신이 이 스크립트를 걸 정도로 우스워진다.

## 허용 목록(ALLOWLIST) — 명시(fail-closed 원칙: 여기 없는 매치는 전부 FAIL)
지금은 0건. 진짜로 "이 시각 이후부터 사양이 바뀐다" 같은 의도적 절대 기준일이
필요해지면 `(file, line, literal)` 튜플로 여기 추가하고 그 옆에 사유를 남길 것 —
말없이 넘어가는 예외는 없다."""
from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
APP_DIR = Path(__file__).resolve().parent.parent / "app"

_ISO_TIMESTAMP_RE = re.compile(r"\b20\d\d-\d\d-\d\dT")

# (상대경로, 리터럴 문자열) — 명시적으로 봐준 자리. 지금은 0건(위 docstring 참고).
ALLOWLIST: frozenset[tuple[str, str]] = frozenset()

# self-assert — 스캔 대상이 비정상적으로 적으면(경로가 헛돌면) 조용한 통과 대신 죽는다.
MIN_EXPECTED_FILES = 300


def _docstring_constant_ids(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                ids.add(id(body[0].value))
    return ids


@dataclass
class Violation:
    file: str
    line: int
    text: str


def scan_source(source: str, file_label: str) -> list[Violation]:
    tree = ast.parse(source)
    docstring_ids = _docstring_constant_ids(tree)
    violations: list[Violation] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstring_ids:
            continue
        if not _ISO_TIMESTAMP_RE.search(node.value):
            continue
        if (file_label, node.value) in ALLOWLIST:
            continue
        violations.append(Violation(file=file_label, line=node.lineno, text=node.value))
    return violations


def scan_repo() -> list[Violation]:
    py_files = sorted(APP_DIR.rglob("*.py"))
    if len(py_files) < MIN_EXPECTED_FILES:
        raise RuntimeError(
            f"스캔 대상 파일이 비정상적으로 적습니다({len(py_files)}건 < {MIN_EXPECTED_FILES}) — "
            "경로가 잘못됐을 가능성(조용한 통과 대신 죽는다, story #3164/#3741류 관례)."
        )
    violations: list[Violation] = []
    for path in py_files:
        file_label = str(path.relative_to(REPO_ROOT))
        violations.extend(scan_source(path.read_text(encoding="utf-8"), file_label))
    return violations


def main() -> int:
    violations = scan_repo()
    if violations:
        print(f"FAIL: backend/app/** ISO 절대 일시 하드코딩 {len(violations)}건(story #3528 재발 클래스)")
        for v in violations:
            print(f"  {v.file}:{v.line} {v.text!r}")
        print(
            "벽시계 고정 절대 타임스탬프는 시간이 지나면 조용히 썩는다(2026-09-12 실사고) — "
            "그 값을 요구하는 자신의 데이터(예: 발행물의 published_at)에서 상대 오프셋으로 "
            "유도할 것. 정말 의도적인 절대 기준일이면 이 스크립트의 ALLOWLIST에 사유와 함께 등재."
        )
        return 1
    print("OK: backend/app/** ISO 절대 일시 하드코딩 0건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
