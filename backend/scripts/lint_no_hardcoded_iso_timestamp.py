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
말없이 넘어가는 예외는 없다.

## story #4079(2026-09-21, 까디르 #4077 스캔 §4-4 처방) — 사각 봉합
위 정책(ISO-문자열만·backend/app만·docstring+ALLOWLIST 외 예외 0)은 「앱 코드는
절대 일시 리터럴이 있으면 안 된다」는 **전면 금지**라 backend/app엔 그대로 확장했다
(생성자 스타일 `datetime(2026, ...)`/`date(2026, ...)`도 이제 `scan_source`가 같이
잡는다 — 착수 시점 실측 backend/app 생성자 스타일 0건이라 전면 금지를 그대로 넓혀도
grandfather 불요).

`backend/tests/**`는 사정이 다르다 — 착수 시점 실측 ISO-문자열 145건·생성자 스타일
440건(datetime 405+date 35)이 이미 있고, 그중 절대다수가 안전한 고정 픽스처(#4077
문서 §AC2 (b) 분류 — DI 인자·freeze·"항상 과거/미래" sentinel, (c) 「상대오프셋의
앵커일 뿐」류 순수 시드값). 전면 금지를 그대로 넓히면 즉시 대량 오탐이라
AC3("오탐 0")를 못 지킨다.

`scan_tests_source`는 **함수 단위** 판정이다(파일 단위로 처음 만들었다가 실측
367→30건까지는 줄었지만, `_gate(...)` 같은 순수 픽스처 팩토리(자기 body 안엔 live-now
호출이 아예 없는데 같은 **파일**의 다른 무관한 테스트가 `deleted_at = datetime.now(...)`
를 쓴다는 이유만으로 오탐되는 사례 — test_1970_gate_single_get.py 실측 — 가 남아
함수 단위로 좁혔다). 리터럴의 **자기 자신의 직속 함수**(nested 포함, 모듈 최상위는
scope=module) 안에 실 벽시계 호출(`.now()`·`.utcnow()`·`.today()`)이 없으면 애초에
부딪힐 대상이 없어 무조건 통과 — 이게 실측 다수(순수 픽스처·페이지네이션 앵커·CRUD
시드값)를 통과시키는 1차 게이트다. 같은 함수에 live-now 호출이 있으면 ②sentinel 연도
(과거 2021년 이하·미래 2090년 이상 — 2020/2099류와 동형)③freeze 관용구
(`monkeypatch.setattr(..., "datetime"|"date", ...)`·`freeze_time`/`freezegun`)
④DI 이름 관용구(파라미터/키워드/대입 대상 이름이 now·today·current·frozen·as_of·
fixed_now류로 시작 — `now=`·`_NOW`·`current=frozen` 전부 이 한 규칙으로 잡힌다,
`_local_di_fallback_param_names`가 `param or <live-now 포함>` 꼴까지 이름 무관하게
추가로 잡는다) 중 하나로 안전하다고 "증명"되면 통과.

⚠️ 함수 단위로 좁히면 FE 자매 가드가 막아야 하는 #4453류(리터럴은 테스트에, 실
비교는 렌더되는 컴포넌트/다른 모듈에 있는 클래스)는 이 BE 휴리스틱으로 원천적으로
못 잡는다 — 그건 이 가드의 목표가 아니다(#3528 원 실사고 자체가 backend/**app**의
전면 금지로 이미 막혀 있다, 위 문단 — backend/tests는 "테스트 자신이 직접 위험한
비교를 짜는" 좁은 계급만 겨냥). 이 세 신호 중 하나도 없는 함수에 위험대 리터럴이
있으면 FAIL — 그중 정말 안전한데 이 휴리스틱의 사각에 걸리는 개별 자리(예:
test_3423_channel_post_scheduled_filter.py의 naive-datetime 422 검증용 임의값 —
값 자체가 무의미해 어떤 marker 패턴에도 안 걸린다·test_check_env_drift_code_read_
axis.py의 위치인자 DI — 파라미터명이 이 파일에 안 나타나 이름 기반 marker가
구조적으로 못 본다)는 기존 ALLOWLIST와 동형 원칙으로 `TEST_ALLOWLIST`에
(file, line, literal)+사유로 개별 등재한다(#4077 문서가 실제로 읽어 안전을 확認한
자리 — 새 예외 아님, 그 확認을 코드로 옮긴 것)."""
from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
APP_DIR = Path(__file__).resolve().parent.parent / "app"
TESTS_DIR = Path(__file__).resolve().parent.parent / "tests"

_ISO_TIMESTAMP_RE = re.compile(r"\b20\d\d-\d\d-\d\dT")
_ISO_YEAR_RE = re.compile(r"\b(20\d\d)-\d\d-\d\dT")
_DATETIME_CTOR_NAMES = {"datetime", "date"}
# story #4079 AC1 — 「지금」과 실제로 부딪힐 수 있는 위험대. 2020/2099류(#4077 문서
# 예시)처럼 그 바깥은 "항상 과거/미래" sentinel로 안전하다고 간주한다.
_SENTINEL_PAST_MAX_YEAR = 2021
_SENTINEL_FUTURE_MIN_YEAR = 2090
_DI_NAME_RE = re.compile(r"^_*(now|today|current|frozen|as_of|fixed_now)", re.IGNORECASE)

# (상대경로, 리터럴 문자열) — 명시적으로 봐준 자리. 지금은 0건(위 docstring 참고).
ALLOWLIST: frozenset[tuple[str, str]] = frozenset()

# story #4079 — backend/tests 전용 개별 예외(파일 단위 marker 판정의 사각). §4-4 처방
# 문단 참조 — #4077 문서가 실측으로 안전을 확認한 자리만, 사유와 함께.
TEST_ALLOWLIST: frozenset[tuple[str, int, str]] = frozenset({
    (
        "backend/tests/test_3423_channel_post_scheduled_filter.py", 455, "2026-09-10T00:00:00",
    ),  # naive-datetime(tz 없음) 422 검증용 임의값 — 비교 대상이 아니라 형식 검증 트리거,
        # 값 자체는 의미 없다(#4077 문서 §AC2 (b) 실측 확認).
    (
        "backend/tests/test_check_env_drift_code_read_axis.py", 420, "date(2026, 7, 28)",
    ),  # `mod._split_high_by_baseline(..., date(2026, 7, 28))`의 세 번째 위치인자
        # ("오늘"로 주입되는 DI값) — 파라미터명이 이 테스트 파일 자체엔 안 나타나(피
        # 대상 함수가 다른 모듈에 정의) 이름 기반 marker가 구조적으로 못 본다. #4077
        # 문서 §4-3이 직접 다룬 파일(같은 버그 klass의 선례이자 회귀가드 그 자체).
    (
        "backend/tests/test_1994_backlink_api_realdb.py", 362, "datetime(2026, 7, 17, 8, 0, 0, tzinfo=timezone.utc)",
    ),  # `T0 = datetime(...)` — 상대오프셋(`_t(minutes)` 헬퍼)의 앵커일 뿐, 비교 대상이
        # 아니다(#4077 문서 §AC2 (c) 부류). 이름이 "T0"라 now/today류 DI 이름 관용구에
        # 안 걸린다.
    (
        "backend/tests/test_s35.py", 29, "datetime(2026, 4, 30, tzinfo=timezone.utc)",
    ),  # `_mock_key()`의 `k.created_at = datetime(2026, 4, 30, ...)` — MagicMock 속성에
        # 심는 표시용 값일 뿐 비교되지 않는다(같은 함수의 expires_at/revoked_at는
        # `datetime.now(...)` 상대 계산이라 이 함수가 live-now 게이트를 통과했지만,
        # created_at 자체는 그 비교에 안 낀다 — #4077 문서 §AC2 (c) mock-echo 부류).
})

# self-assert — 스캔 대상이 비정상적으로 적으면(경로가 헛돌면) 조용한 통과 대신 죽는다.
MIN_EXPECTED_FILES = 300
MIN_EXPECTED_TEST_FILES = 1000


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


def _ctor_callee_name(node: ast.Call) -> str | None:
    """`datetime(...)`/`date(...)`(bare name) 그리고 `datetime.datetime(...)`(모듈
    임포트 스타일) 둘 다 인식한다 — 임포트 관례가 파일마다 갈려도(`from datetime import
    datetime` vs `import datetime`) 놓치지 않는다."""
    func = node.func
    if isinstance(func, ast.Name):
        return func.id if func.id in _DATETIME_CTOR_NAMES else None
    if isinstance(func, ast.Attribute):
        return func.attr if func.attr in _DATETIME_CTOR_NAMES else None
    return None


def _ctor_year(node: ast.Call) -> int | None:
    """`datetime(2026, 9, 20, ...)`의 첫 위치인자(연도)만 뽑는다 — `datetime(ts)`처럼
    연도가 아닌 형(epoch·다른 datetime 객체 재포장 등)은 첫 인자가 int 리터럴이 아니라
    자연히 매치되지 않는다(오탐 방지, 별도 분기 불요)."""
    if not node.args:
        return None
    first = node.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, int):
        return first.value
    return None


@dataclass
class Violation:
    file: str
    line: int
    text: str


def scan_source(source: str, file_label: str) -> list[Violation]:
    """backend/app/** 정책 — 전면 금지(docstring·ALLOWLIST·sentinel 연도만 예외).
    story #4079 — ISO-문자열뿐 아니라 생성자 스타일(`datetime(2026, ...)`/
    `date(2026, ...)`)도 같은 강도로 잡는다(착수 시점 backend/app 실측 0건이라
    grandfather 불요). sentinel(예: `_EPOCH = datetime(1970, 1, 1, ...)`류 "항상 과거"
    기준선 — conversations.py 실사례)만 `_is_sentinel_year`로 예외 — 그 밖은
    backend/tests 정책(scan_tests_source)과 달리 live-now 호출 존재 여부를 안 따진다
    (앱 코드는 애초에 절대 일시 리터럴 자체가 없어야 한다는 전제가 이 정책의 핵심)."""
    tree = ast.parse(source)
    docstring_ids = _docstring_constant_ids(tree)
    violations: list[Violation] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) in docstring_ids:
                continue
            m = _ISO_YEAR_RE.search(node.value)
            if not m or _is_sentinel_year(int(m.group(1))):
                continue
            if (file_label, node.value) in ALLOWLIST:
                continue
            violations.append(Violation(file=file_label, line=node.lineno, text=node.value))
        elif isinstance(node, ast.Call) and _ctor_callee_name(node) is not None:
            year = _ctor_year(node)
            if year is None or _is_sentinel_year(year):
                continue
            text = ast.unparse(node)
            if (file_label, text) in ALLOWLIST:
                continue
            violations.append(Violation(file=file_label, line=node.lineno, text=text))
    return violations


def _is_sentinel_year(year: int) -> bool:
    return year <= _SENTINEL_PAST_MAX_YEAR or year >= _SENTINEL_FUTURE_MIN_YEAR


_LIVE_NOW_ATTRS = {"now", "utcnow", "today"}


def _has_live_now_call(tree: ast.AST) -> bool:
    """story #4079 §4-4 — 위험대 리터럴이 있어도 그 **파일 안 어디에도** 실 벽시계 호출
    (`.now(...)`·`.utcnow(...)`·`.today(...)` — `datetime.now(timezone.utc)`처럼 tz
    인자를 받는 흔한 형까지 attr 이름만으로 포함)이 없으면 애초에 부딪힐 대상이 없다 —
    이게 실측 다수(순수 픽스처·페이지네이션 앵커·CRUD 시드값,
    #4077 문서 §AC2 (c) "상대오프셋의 앵커일 뿐" 부류)를 통과시키는 1차 게이트다.
    함수 단위가 아니라 파일 단위로 넓게 잡는 이유는 #4453류(리터럴은 테스트 파일에,
    실 비교는 렌더되는 컴포넌트/다른 모듈에 있는 클래스)와 동형 위험을 BE 쪽에서도
    놓치지 않기 위해서다 — 이 파일이 "그 데이터가 실제로 지금과 비교되는 로직을
    건드린다"는 신호(파일 안 어딘가의 live now 호출)를 스스로 갖고 있으면 위험대
    리터럴을 무죄추정하지 않는다."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        # `datetime.now(timezone.utc)`처럼 tz 인자를 받는 형이 실무 표준(인자 0개로
        # 제한하면 그 흔한 형을 다 놓친다) — attr 이름만으로 판정.
        if isinstance(func, ast.Attribute) and func.attr in _LIVE_NOW_ATTRS:
            return True
    return False


def _enclosing_function_scopes(tree: ast.Module) -> dict[int, ast.AST]:
    """story #4079 — 각 노드를 자신의 **직속** 함수(nested 포함)로 매핑한다. 모듈
    최상위(어떤 함수에도 안 속함)는 매핑에 없다(scan_tests_source가 `tree` 자신을
    module scope로 별도 취급). 표준 라이브러리 `ast`엔 부모 포인터가 없어 이 파일이
    직접 스택 기반 재귀 방문자로 만든다."""
    scope_of: dict[int, ast.AST] = {}

    def visit(node: ast.AST, current_scope: ast.AST | None) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            current_scope = node
        if current_scope is not None:
            scope_of[id(node)] = current_scope
        for child in ast.iter_child_nodes(node):
            visit(child, current_scope)

    visit(tree, None)
    return scope_of


def _local_di_fallback_param_names(scope: ast.AST) -> set[str]:
    """story #4079 실측 추가분 — `def _seed_story(..., created_at=None): ... created_at
    or datetime.now(timezone.utc)`류(test_3505_story_number_gap.py 실사례)를 잡는다.
    파라미터 이름이 now/current류 관용구가 아니어도(`created_at`·`updated_at`·
    `scheduled_at`... 필드마다 다 다르다 — 이름을 열거하는 방식은 못 버틴다) 이
    스코프(함수 또는 모듈) 안에서 `param or <live-now 포함 식>`(또는 반대 순서) 꼴
    BoolOp의 한쪽으로 쓰이면, 그 파라미터로 리터럴을 오버라이드하는 건 구조적으로
    안전하다(호출자가 안 넘기면 원래 live now가 쓰였을 자리를 결정적 값으로 대체하는
    것뿐) — 그 파라미터 이름을 이 스코프의 "안전 키워드"로 수집한다."""
    names: set[str] = set()
    for node in ast.walk(scope):
        if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.Or):
            continue
        param_names = {v.id for v in node.values if isinstance(v, ast.Name)}
        if not param_names:
            continue
        if any(_has_live_now_call(v) for v in node.values):
            names |= param_names
    return names


def _has_freeze_or_di_marker(scope: ast.AST) -> bool:
    """story #4079 §4-4 — 이 스코프(함수 또는 모듈) 안 안전 신호 3종(freeze·DI 이름
    관용구·로컬 fallback 파라미터) 중 하나라도 있으면 그 스코프의 위험대 리터럴
    전부를 통과시킨다."""
    local_fallback_names = _local_di_fallback_param_names(scope)
    for node in ast.walk(scope):
        if isinstance(node, ast.arg) and (
            _DI_NAME_RE.match(node.arg) or node.arg in local_fallback_names
        ):
            return True
        if isinstance(node, ast.keyword) and node.arg and (
            _DI_NAME_RE.match(node.arg) or node.arg in local_fallback_names
        ):
            return True
        if isinstance(node, ast.Name) and (
            _DI_NAME_RE.match(node.id) or node.id in local_fallback_names
        ):
            return True
        # ⚠️ ast.Attribute.attr는 여기서 일부러 안 본다 — `datetime.now(...)`의
        # attr="now" 자체가 _has_live_now_call의 "위험" 신호와 같은 토큰이라, Attribute
        # 기반으로도 매치시키면 살아있는 now() 호출 자체가 스스로를 "안전"으로
        # 자가증명해버린다(실측 회귀 — 아래 test_tests_policy_dangerous_literal_with_
        # live_now_call_and_no_marker_fails가 그 재발을 pin).
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr == "setattr":
                for arg in node.args:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and (
                        "datetime" in arg.value.lower() or "date" in arg.value.lower()
                    ):
                        return True
            callee_name = func.attr if isinstance(func, ast.Attribute) else (
                func.id if isinstance(func, ast.Name) else None
            )
            if callee_name in ("freeze_time",):
                return True
    return False


def _di_named_assignment_value_ids(tree: ast.AST) -> set[int]:
    """story #4079 — `_NOW = datetime(2026, 6, 19, ...)`류 모듈/함수 상수(test_edg_
    s18_runtime_mode.py 실사례, 여러 테스트가 `now=_NOW`로 주입해 쓴다). 대입 대상
    이름 자체가 DI 관용구면(밑줄 접두 허용) 그 리터럴은 스코프·live-now 여부와
    무관하게 안전 — "이 이름으로 불린다"는 사실 자체가 저자의 의도 선언이다."""
    ids: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and _DI_NAME_RE.match(target.id):
            ids.add(id(node.value))
    return ids


def scan_tests_source(source: str, file_label: str) -> list[Violation]:
    """backend/tests/** 정책 — §4-4 처방(파일 헤더 docstring 「story #4079」 문단
    참조). **함수 단위**(nested 포함, 모듈 최상위는 그 자체가 하나의 스코프) 판정 —
    sentinel 연도·DI 이름 대입·같은 스코프의 freeze/DI 이름 관용구·TEST_ALLOWLIST
    넷 중 하나도 없는 위험대(2022~2089) 리터럴만 FAIL. docstring은 backend/app
    정책과 동일하게 항상 제외."""
    tree = ast.parse(source)
    docstring_ids = _docstring_constant_ids(tree)
    di_named_ids = _di_named_assignment_value_ids(tree)
    scope_of = _enclosing_function_scopes(tree)
    marker_cache: dict[int, bool] = {}

    def scope_has_marker(scope: ast.AST) -> bool:
        key = id(scope)
        if key not in marker_cache:
            marker_cache[key] = _has_freeze_or_di_marker(scope)
        return marker_cache[key]

    violations: list[Violation] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) in docstring_ids or id(node) in di_named_ids:
                continue
            m = _ISO_YEAR_RE.search(node.value)
            if not m:
                continue
            year = int(m.group(1))
            if _is_sentinel_year(year):
                continue
            scope = scope_of.get(id(node), tree)
            if not _has_live_now_call(scope) or scope_has_marker(scope):
                continue
            if (file_label, node.lineno, node.value) in TEST_ALLOWLIST:
                continue
            violations.append(Violation(file=file_label, line=node.lineno, text=node.value))
        elif isinstance(node, ast.Call) and _ctor_callee_name(node) is not None:
            if id(node) in di_named_ids:
                continue
            year = _ctor_year(node)
            if year is None or _is_sentinel_year(year):
                continue
            scope = scope_of.get(id(node), tree)
            if not _has_live_now_call(scope) or scope_has_marker(scope):
                continue
            text = ast.unparse(node)
            if (file_label, node.lineno, text) in TEST_ALLOWLIST:
                continue
            violations.append(Violation(file=file_label, line=node.lineno, text=text))
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


def scan_tests_repo() -> list[Violation]:
    py_files = sorted(TESTS_DIR.rglob("*.py"))
    if len(py_files) < MIN_EXPECTED_TEST_FILES:
        raise RuntimeError(
            f"스캔 대상 파일이 비정상적으로 적습니다({len(py_files)}건 < {MIN_EXPECTED_TEST_FILES}) — "
            "경로가 잘못됐을 가능성(조용한 통과 대신 죽는다, story #3164/#3741류 관례)."
        )
    violations: list[Violation] = []
    for path in py_files:
        file_label = str(path.relative_to(REPO_ROOT))
        violations.extend(scan_tests_source(path.read_text(encoding="utf-8"), file_label))
    return violations


def main() -> int:
    violations = scan_repo()
    test_violations = scan_tests_repo()
    all_violations = violations + test_violations
    if all_violations:
        print(
            f"FAIL: 하드코드 절대 일시 리터럴 {len(all_violations)}건"
            f"(backend/app {len(violations)}건·backend/tests {len(test_violations)}건, story #3528/#4079 재발 클래스)"
        )
        for v in all_violations:
            print(f"  {v.file}:{v.line} {v.text!r}")
        print(
            "벽시계 고정 절대 타임스탬프는 시간이 지나면 조용히 썩는다(2026-09-12 실사고) — "
            "그 값을 요구하는 자신의 데이터(예: 발행물의 published_at)에서 상대 오프셋으로 "
            "유도할 것. backend/app은 ALLOWLIST, backend/tests는 freeze/DI 이름 관용구나 "
            "TEST_ALLOWLIST에 사유와 함께 등재."
        )
        return 1
    print(
        f"OK: 하드코드 절대 일시 리터럴 0건"
        f"(backend/app·backend/tests 전체, ALLOWLIST {len(ALLOWLIST)}건·TEST_ALLOWLIST {len(TEST_ALLOWLIST)}건 제외)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
