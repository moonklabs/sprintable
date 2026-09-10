"""story #3779(1층, 페드루 PO 處方 2026-09-10 08:05Z) — BE 한글 사용자 문장 재발 가드.

3778(회고 「내보내기」)이 닫은 건 `app/routers/retros.py::export_session` 딱 한 자리였다.
그 카드 AC5를 `backend/app` 전체로 재측정하니(2026-09-10 미르코 AST 실측) 201개 파일·1681건
— 훨씬 큰 클래스였다. 이 lint는 그 전체를 "더 늘지 않게" 얼린다(story #3741 FE판·#2335
query-sentinel lint와 동일 계약 — grandfather baseline은 봐주되, 새로 추가되는 건 막는다).

## 기전 — AST(`app/scripts/verify-no-hardcoded-korean-ui-text.ts`와 동형, 새 기전 발명 금지)
정규식 줄 스캔이 아니라 Python `ast` 모듈로 `ast.Constant`(str) 노드를 walk한다 — 주석은
AST 노드가 아니라 파서가 버려서(이 저장소 주석은 한글 천지) 구조적으로 안 걸린다. 1차
grep(421파일/3539건)이 주석 안 따옴표 강조까지 오탐했던 것과 같은 이유로 AST가 필수.

## 제외 대상(페드루 PO 明示, 2026-09-10 08:05Z)
- **docstring** — 모듈/클래스/함수의 첫 statement가 문자열 리터럴인 경우. 개발자 문서지
  사용자 문장이 아니다.
- **logger.*** — `logger.info(...)`/`logger.warning(...)` 등 로깅 호출의 인자. 로그는
  운영자가 읽지 최종 사용자가 읽지 않는다. 매치: `<Name>.{method}(...)`에서 Name이
  `logger`/`_logger`(이 레포의 실제 관례, 2026-09-10 grep 확認)고 method가 표준 logging
  메서드 집합에 속할 때 — 그 Call 노드의 시작~끝 span 안에 있는 모든 Constant를 제외한다
  (인자가 f-string이어도 span으로 걸러지므로 안전).
- **tests/·alembic/** — 스캔 루트를 `backend/app`으로 한정해 구조적으로 제외(둘 다
  `app/`의 형제 디렉터리지 안이 아니다 — 별도 탐색 로직 불요).
- **EXEMPT 0** — 카드 明示: 이 레이어는 무배제 원칙. 예외가 필요해지면 이 스크립트가
  아니라 PO 승인 하 명시적으로 추가한다(지금은 빈 세트).

## 대상 밖(다른 가드의 몫)
`HTTPException(detail=...)`류 영문 에러 코드 문장은 이 가드가 아니라
`verify:no-raw-error-message`(FE)가 다루는 축 — 이 가드는 "한글이 있는가"만 보지 "그
문자열이 실제로 사용자에게 닿는가"는 안 본다(2층은 별도 스크립트/카드, 이 카드의 산출물
목록으로 남긴다).

## 계약 — story #3741/#2335와 동일
baseline(`korean_user_strings_baseline.txt`)에 없는 새 한글 문자열 리터럴이 있으면 FAIL.
baseline에 있는데 이번 스캔에서 안 걸리면(코드가 고쳐졌거나 삭제됐으면) stale로 경고만
(비차단) — CI의 별도 git-diff 스텝이 baseline 파일 자체가 "줄기만" 허용되도록 막는다.

⚠️이 가드가 «못 잡는» 것:
  ㉠ f-string의 `{expr}` 안에 동적으로 조립되는 한글(변수 값 자체) — 리터럴 조각만 본다.
  ㉡ dict/list 리터럴이 아닌 동적 생성 문자열(`''.join(...)`, `str.format` 등) — 정적
     AST가 값을 못 좇는 자리는 원천적으로 스캔 밖.
"""
from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path

APP_DIR = "app"
LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "log"}
LOG_BASE_NAMES = {"logger", "_logger"}

# self-assert — 재료가 비정상적으로 적으면(스캔이 헛돌고 있으면) 조용한 통과 대신 죽는다
# (story #3164/#3741류 관례).
MIN_EXPECTED_FILES = 500


def _is_hangul(s: str) -> bool:
    return any("가" <= ch <= "힣" for ch in s)


def _docstring_constant_ids(tree: ast.AST) -> set[int]:
    """모듈/클래스/함수 body의 첫 statement가 문자열 리터럴이면 그 Constant 노드의
    id()를 모아 제외 대상으로 삼는다."""
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


def _logger_call_spans(tree: ast.AST) -> list[tuple[int, int, int, int]]:
    """logger.{method}(...) 호출의 (start_lineno, start_col, end_lineno, end_col) span
    목록 — 이 범위 안의 Constant는 로그 인자라 제외한다."""
    spans: list[tuple[int, int, int, int]] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in LOG_METHODS
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in LOG_BASE_NAMES
        ):
            end_lineno = getattr(node, "end_lineno", node.lineno)
            end_col = getattr(node, "end_col_offset", node.col_offset)
            spans.append((node.lineno, node.col_offset, end_lineno, end_col))
    return spans


def _within_span(node: ast.AST, spans: list[tuple[int, int, int, int]]) -> bool:
    start = (node.lineno, node.col_offset)
    end = (getattr(node, "end_lineno", node.lineno), getattr(node, "end_col_offset", node.col_offset))
    for s_ln, s_col, e_ln, e_col in spans:
        if start >= (s_ln, s_col) and end <= (e_ln, e_col):
            return True
    return False


@dataclass
class Violation:
    file: str
    line: int
    text: str


def scan_source(source: str, file_label: str) -> list[Violation]:
    tree = ast.parse(source)
    docstring_ids = _docstring_constant_ids(tree)
    logger_spans = _logger_call_spans(tree)

    violations: list[Violation] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstring_ids:
            continue
        if not _is_hangul(node.value):
            continue
        if _within_span(node, logger_spans):
            continue
        violations.append(Violation(file=file_label, line=node.lineno, text=node.value.strip()))
    return violations


def scan_repo(backend_root: Path) -> list[Violation]:
    app_root = backend_root / APP_DIR
    files = sorted(
        p for p in app_root.rglob("*.py") if "__pycache__" not in p.parts
    )
    if len(files) < MIN_EXPECTED_FILES:
        raise RuntimeError(
            f"FAIL: 검사 대상 파일이 {len(files)}개뿐(app_root={app_root}) — 가드가 헛돌고 있다."
        )
    violations: list[Violation] = []
    for f in files:
        file_label = str(f.relative_to(backend_root))
        source = f.read_text(encoding="utf-8")
        try:
            violations.extend(scan_source(source, file_label))
        except SyntaxError:
            continue
    return violations


BASELINE_FILE = "scripts/korean_user_strings_baseline.txt"


def violation_key(v: Violation) -> str:
    """안정 키 — 파일+텍스트(줄 번호 제외, 인접 편집에 안 흔들리게 — FE
    verify-no-hardcoded-korean-ui-text.ts violationKey와 동일 계약).

    baseline 파일이 줄 단위 텍스트라 텍스트 안의 개행을 그대로 두면 한 항목이 여러
    physical line에 걸쳐 파일을 깨뜨린다(email_copy.py류 여러 줄 문자열 리터럴에서
    실측 — write 시점 key 수(1308)와 파일 실제 줄 수(1545)가 어긋나 발견됨). `\\n`
    리터럴 이스케이프로 한 줄에 눌러 담는다."""
    escaped = v.text.replace("\\", "\\\\").replace("\n", "\\n")
    return f"{v.file}::{escaped}"


def load_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }


def write_baseline(path: Path, keys: set[str]) -> None:
    header = (
        "# story #3779(1층, 미르코 실측 2026-09-10) grandfather baseline — 이 가드 첫 도입\n"
        "# 시점 develop의 기존 BE 한글 사용자 문장(app/ 전수, docstring·logger.*·tests·\n"
        "# alembic 제외).\n"
        "# 마이그레이션 대상 아님 — 이 게이트는 \"더 늘지 않는다\"만 보장한다(freeze, 처방②\n"
        "# 코드 정본+FE 번역 전환은 별건 카드).\n"
        "# 형식: 파일::문자열(줄번호 제외, 편집마다 안 흔들리게) — story #2335 query_sentinel\n"
        "# baseline과 동일 관례.\n"
    )
    path.write_text(header + "\n".join(sorted(keys)) + "\n", encoding="utf-8")


def main() -> int:
    backend_root = Path(__file__).resolve().parent.parent
    try:
        violations = scan_repo(backend_root)
    except RuntimeError as e:
        print(str(e))
        return 1
    baseline = load_baseline(backend_root / BASELINE_FILE)

    new_violations = [v for v in violations if violation_key(v) not in baseline]
    grandfathered_keys = {violation_key(v) for v in violations if violation_key(v) in baseline}
    stale = sorted(baseline - grandfathered_keys)

    file_count = len({v.file for v in violations})
    print(
        f"[story #3779] BE 한글 사용자 문장 스캔 — 검출 {len(violations)}건/{file_count}파일 · "
        f"baseline(grandfather) {len(baseline)}건 · 신규 {len(new_violations)}건"
    )
    if stale:
        print(f"  ⚠️ baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): {len(stale)}건")

    if new_violations:
        print("\nFAIL: baseline에 없는 BE 한글 사용자 문장 발견(story #3779 회귀):")
        for v in sorted(new_violations, key=lambda v: (v.file, v.line)):
            print(f"  - {v.file}:{v.line} \"{v.text}\"")
        print(
            "\n→ 이 문자열이 사람에게 닿는(응답/알림/문서 export 등) 자리라면 로케일 인지 낱말표"
            "(story #3778 retro_export_i18n.py류)로 옮기거나 코드/FE번역 축(story #3779 처방②)으로"
            " 옮길 것. logger.*(운영자 전용) 오탐이면 logger/_logger 호출로 감싸져 있는지 확認."
        )
        return 1

    print("\nOK: baseline 초과 없음(0건 증가 — «전부 깨끗»이 아니라 «안 늘었다»는 뜻).")
    return 0


if __name__ == "__main__":
    if "--write-baseline" in sys.argv:
        _backend_root = Path(__file__).resolve().parent.parent
        _violations = scan_repo(_backend_root)
        _keys = {violation_key(v) for v in _violations}
        write_baseline(_backend_root / BASELINE_FILE, _keys)
        print(f"wrote {len(_keys)} keys to {BASELINE_FILE}")
    else:
        sys.exit(main())
