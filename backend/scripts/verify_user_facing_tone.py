"""story #3931(2층, 페드루 PO 處方 2026-09-15) — BE 사용자 도달 문장 해요체 전환 + 2층 톤 가드.

1층(`verify_no_new_korean_user_strings.py`, story #3779/#3924)은 "코드에 하드코딩된 한글이
있는가"만 본다(grandfather baseline로 총량 동결). 이 2층은 그 중 **실제로 사용자에게
닿는 표면**만 스코프로 좁혀 "톤이 맞는가"를 본다 — baseline이 없다(전면 전환 대상이라
새 위반은 즉시 RED, grandfather 없음).

## 4표면(페드루 PO 明示 2026-09-15, develop 6ba498605 기준 실측 → 미르코 스크립트 재검산)
① `dispatch_notification(title=..., body=...)` 호출의 title/body 리터럴 — 알림 카드
② `app/services/i18n_catalog.py`의 `_CATALOG` ko 값 — 공용 카탈로그(가드1층 EXEMPT_FILES
   유일 예외라 1층이 못 보는 자리, 2층이 대신 본다)
③ `HUMAN_SAFE_ERROR_MESSAGE_CODES`(FE `apps/web/src/lib/api-error-message.ts`) 허용목록
   코드로 raise되는 `human_error(code, message, ...)`의 message
④ `app/services/email_copy.py`의 ko 값 — 발송 메일 카피

## needle — FE `verify-scoped-i18n-honorific-tone.ts`와 동일 정의(그대로 포팅, 새 기전
발명 금지). 습니다/십시오/습니까 리터럴 + NFD 자모분해 ㅂ니다/ㅂ니까(받침 ㅂ이 앞
음절에 합쳐진 모음어간 서술/의문형 — 합니다·됩니다·입니다·합니까류, NFC 원문엔 독립된
ㅂ 문자가 없어 NFD로 정규화해야 잡힌다 — FE 쪽 주석 그대로). FE와 BE가 "formal이란
무엇인가"에 대해 서로 다른 정의를 쓰면 같은 저장소 안 두 가드가 서로 다르게 판정하는
결함이 된다.

story #3931 AC3 明示로 3축을 추가한다(톤 전환 과정에서 새로 섞여 들어오기 쉬운 결함
클래스라 이 스토리가 처음부터 막는다):
  - 한자(`一`~`龥`, FE `verify-no-hanja-in-i18n.ts`의 `\\p{Script=Han}`과 동일 취지 —
    Python 표준 `re`는 `\\p{}`를 지원하지 않아 CJK 통합 한자 주 블록 범위로 대체)
  - 「당신」(격식 2인칭 누출 — 이 레포 사람 대상 문구는 2인칭을 생략하거나 "회원님"류
    호칭을 쓰지 「당신」을 쓰지 않는다, story #3903 workflow_parallel_approval.py 실사례)
  - 페르소나 관형형 종결(1층 스캐너·FE story #3900 axis②와 동일 정의 — 완결 종결어미
    없이 관형형 '는'/'인' + 마침표로 끝나는 것)

## AC2 — 표면별 추출 개수 자기검증(story #3924의 "조용히 0건 통과" 교훈 재적용, 페드루 PO
明示 2026-09-15 CHANGES) — 하드코딩 매직넘버 금지
추출 메커니즘이 조용히 깨져(예: AST 구조 가정이 실물과 어긋남) 적게/0건만 스캔하고
그대로 초록이 나면, 그 뒤로 그 표면에 새 합니다체가 아무리 늘어도 이 가드가 영원히 못
잡는다. 처음엔 "표면당 기대 총량"을 이 스크립트에 리터럴 상수(예: 60·70·8·82)로 박아
두는 안을 냈으나, 페드루 PO가 정정했다 — 그런 상수는 다음에 알림/카탈로그 키가 하나만
늘어도(이 스토리의 톤 전환과 무관한 통상적인 제품 변화) 사람이 매번 이 무관한 파일까지
와서 손으로 고쳐야 하고, 안 고치면 등식이 거짓말한다(실제로는 정상인데 RED). 그래서
"기대 수"를 리터럴로 박지 않고 **매 실행마다 스크립트 자신이 독립된 방법으로 두 번
세서 서로 비교**하는 자기검증(self-consistency) 형태로 고쳤다 — 두 계산이 다르면(추출
메커니즘이 실물과 어긋났다는 뜻) RED, 같으면(표면이 몇 개로 늘든 줄든) 그대로 초록:
  ① dispatch_notification 호출 «건수»(AST, title/body kwarg 유무 무관 — 순수 콜사이트
     카운트) × 2 == 추출된 title/body kwarg 총수(현재 전수 콜사이트가 둘 다 채운다는
     사실 자체를 매 실행 검증)
  ② `_CATALOG` dict 리터럴의 **AST 원시 키 개수**(literal_eval로 평가하기 전, 소스에
     실제로 적힌 key 리터럴 수) == 평가된 dict의 key 수(다르면 중복 키가 조용히
     서로를 덮어쓴 것 — Python dict 리터럴의 실 결함 클래스, literal_eval만으로는
     못 잡는다)
  ③ 허용목록 코드별 `human_error("<code>", ...)` 호출을 텍스트 정규식으로 독립
     카운트한 총수 == AST로 찾은 raise site 총수(AST 워커가 놓친 자리가 있으면 정규식
     쪽 수와 어긋난다)
  ④ `email_copy.py`의 모듈 레벨 dict 상수 이름을 텍스트 정규식으로 독립 발견한 집합
     == AST로 찾은 dict 상수 이름 집합(구조가 literal_eval이 못 씹는 형태로 바뀌면
     AST 쪽이 조용히 그 블록을 빼먹는데, 정규식 집합과 비교하면 바로 드러난다)

## 허용목록 fail-closed(페드루 PO 明示)
표면③의 "무엇이 허용목록인가"는 이 파일에 사본을 박아두지 않는다 — SSOT는 FE
`api-error-message.ts`뿐이라, CI 시점에 그 파일을 직접 파싱한다(`parse_human_safe_error_codes`).
파싱이 실패하면(마커를 못 찾음 등) 빈 집합으로 조용히 넘기지 않고 예외로 죽는다
(fail-closed — 빈 허용목록으로 계속 돌면 표면③ 전체가 조용히 사라지는 #3924급 결함).
"""
from __future__ import annotations

import ast
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
APP_ROOT = BACKEND_ROOT / "app"
I18N_CATALOG_PATH = APP_ROOT / "services" / "i18n_catalog.py"
EMAIL_COPY_PATH = APP_ROOT / "services" / "email_copy.py"
API_ERROR_MESSAGE_TS_PATH = REPO_ROOT / "apps" / "web" / "src" / "lib" / "api-error-message.ts"


# ---------------------------------------------------------------------------
# needle — FE verify-scoped-i18n-honorific-tone.ts::matchesFormalRegister 포팅 + 3931 확장.
# ---------------------------------------------------------------------------
NFD_JONGSEONG_B_NIDA = unicodedata.normalize("NFD", "ᆸ니다")
NFD_JONGSEONG_B_NIKKA = unicodedata.normalize("NFD", "ᆸ니까")
HANJA_RE = re.compile("[一-龥]")
ADNOMINAL_TERMINAL_RE = re.compile(r"[가-힣](는|인)\.(\s|$)")

# 카디르 QA 明示(2026-09-15) — 표면③에서 code는 허용목록에 속하는데 message를 정적으로
# 재구성 못 한 자리(변수·복잡한 f-string 조합 등)를 나타내는 센티넬. find_tone_issues가
# 이 값을 최우선으로 인식해 무조건 위반으로 처리한다(fail-closed).
UNRESOLVABLE_MESSAGE_SENTINEL = "\x00UNRESOLVABLE_LITERAL_MESSAGE\x00"


def matches_formal_register(value: str) -> list[str]:
    """FE `matchesFormalRegister`와 동일 정의 — 습니다/십시오/습니까 리터럴 +
    NFD 자모분해 ㅂ니다/ㅂ니까(합니다·됩니다·입니다·합니까류, NFC엔 독립 ㅂ 문자가 없어
    분해해야 잡힌다)."""
    matches = list(re.findall(r"습니다|십시오|습니까", value))
    nfd = unicodedata.normalize("NFD", value)
    if "습니다" not in matches and "십시오" not in matches and NFD_JONGSEONG_B_NIDA in nfd:
        matches.append("ㅂ니다")
    if "습니까" not in matches and NFD_JONGSEONG_B_NIKKA in nfd:
        matches.append("ㅂ니까")
    return matches


def find_tone_issues(value: str) -> list[str]:
    """story #3931 AC3 — FE needle(습니다체 축) + 이 스토리 확장 3축(한자·당신·페르소나
    관형형 종결). 어느 한 축이라도 걸리면 그 값은 "2층 위반".

    카디르 QA 明示(2026-09-15) — 표면③에서 code는 허용목록에 속하는데 message를
    정적으로 재구성 못 한 자리(UNRESOLVABLE_MESSAGE_SENTINEL)는 톤 판정 전에 먼저
    무조건 위반으로 처리한다(fail-closed — "판정 불가"를 "깨끗함"으로 착각하지 않는다)."""
    if value == UNRESOLVABLE_MESSAGE_SENTINEL:
        return ["정적 분석 불가(fail-closed) — message가 리터럴로 재구성 안 됨"]
    issues = list(matches_formal_register(value))
    if HANJA_RE.search(value):
        issues.append("한자")
    if "당신" in value:
        issues.append("당신")
    if ADNOMINAL_TERMINAL_RE.search(value):
        issues.append("페르소나 관형형 종결")
    return issues


@dataclass(frozen=True)
class ExtractedString:
    surface: str
    file: str
    line: int
    label: str
    text: str


# ---------------------------------------------------------------------------
# AST 공용 헬퍼.
# ---------------------------------------------------------------------------
def _call_func_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _literal_text(node: ast.expr | None) -> str | None:
    """Constant(str) 또는 JoinedStr(f-string)의 리터럴 조각만 이어붙인다(`{expr}` 자리는
    플레이스홀더 `{X}`로 치환) — 문장 끝 어미(톤 판정 대상)는 항상 마지막 리터럴 조각에
    있으므로 이걸로 충분하다."""
    if node is None:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for v in node.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                parts.append(v.value)
            elif isinstance(v, ast.FormattedValue):
                parts.append("{X}")
        return "".join(parts)
    return None


def _all_literal_texts(node: ast.expr) -> list[str]:
    """`resolution_note or f"...'{title}'가 {label}됐습니다."`류 분기 자리는 node 자신이
    literal이 아니라 하위 서브트리 전부를 훑어 문자열 리터럴 조각을 모은다(분기 중 하나라도
    formal이면 위반으로 잡아야 전환 누락을 안 놓친다)."""
    direct = _literal_text(node)
    if direct is not None:
        return [direct]
    texts: list[str] = []
    for sub in ast.walk(node):
        if sub is node:
            continue
        t = _literal_text(sub)
        if t is not None:
            texts.append(t)
    return texts


def _iter_py_files(root: Path):
    for f in sorted(root.rglob("*.py")):
        if "__pycache__" in f.parts:
            continue
        yield f


# ---------------------------------------------------------------------------
# 표면① — dispatch_notification(title=/body=).
# ---------------------------------------------------------------------------
def extract_surface1_from_source(source: str, file_label: str) -> list[ExtractedString]:
    tree = ast.parse(source)
    results: list[ExtractedString] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_func_name(node) != "dispatch_notification":
            continue
        for kw in node.keywords:
            if kw.arg not in ("title", "body"):
                continue
            combined = " ".join(_all_literal_texts(kw.value))
            results.append(
                ExtractedString(
                    surface="① dispatch_notification",
                    file=file_label,
                    line=kw.value.lineno,
                    label=kw.arg,
                    text=combined,
                )
            )
    return results


def count_surface1_call_sites_from_source(source: str) -> int:
    """표면① 자기검증 좌변 — dispatch_notification 호출 «건수»(kwarg 유무 무관, 순수
    콜사이트 카운트). 페드루 PO 明示(2026-09-15) — 이 수를 리터럴로 박지 않고 매 실행
    스스로 센다."""
    tree = ast.parse(source)
    return sum(
        1
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _call_func_name(node) == "dispatch_notification"
    )


def extract_surface1_notification_kwargs(app_root: Path) -> tuple[list[ExtractedString], int]:
    """반환: (추출된 title/body kwarg 목록, 독립 카운트한 콜사이트 총수)."""
    results: list[ExtractedString] = []
    call_site_total = 0
    for f in _iter_py_files(app_root):
        source = f.read_text(encoding="utf-8")
        try:
            file_results = extract_surface1_from_source(source, str(f.relative_to(app_root.parent)))
            call_site_total += count_surface1_call_sites_from_source(source)
        except SyntaxError:
            continue
        results.extend(file_results)
    return results, call_site_total


# ---------------------------------------------------------------------------
# 표면② — i18n_catalog.py::_CATALOG ko 값.
# ---------------------------------------------------------------------------
def extract_surface2_from_catalog(catalog: dict[str, dict[str, str]], file_label: str) -> list[ExtractedString]:
    return [
        ExtractedString(surface="② i18n_catalog", file=file_label, line=0, label=key, text=entry.get("ko", ""))
        for key, entry in catalog.items()
    ]


def extract_surface2_i18n_catalog(catalog_path: Path) -> tuple[list[ExtractedString], int]:
    """반환: (추출 목록, AST 원시 키 개수 — literal_eval 평가 前 소스에 실제로 적힌
    key 리터럴 수. 평가된 dict의 key 수와 다르면 중복 키가 조용히 서로를 덮어쓴 것)."""
    tree = ast.parse(catalog_path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "_CATALOG":
            raw_key_count = len(node.value.keys)
            catalog = ast.literal_eval(node.value)
            extracted = extract_surface2_from_catalog(catalog, str(catalog_path.relative_to(REPO_ROOT)))
            return extracted, raw_key_count
    raise RuntimeError(f"FAIL: {catalog_path}에서 _CATALOG AnnAssign을 못 찾음 — 파일 구조가 바뀌었다.")


# ---------------------------------------------------------------------------
# 표면③ — human_error(code, message, ...) 허용목록 raise site.
# ---------------------------------------------------------------------------
def parse_human_safe_error_codes(ts_path: Path) -> frozenset[str]:
    """CI 시점에 FE `api-error-message.ts`를 직접 파싱(SSOT는 그 파일 하나, 여기 사본을
    박지 않는다 — 페드루 PO 明示). 파싱 실패는 fail-closed(빈 집합으로 조용히 안 넘김)."""
    source = ts_path.read_text(encoding="utf-8")
    match = re.search(
        r"HUMAN_SAFE_ERROR_MESSAGE_CODES\s*=\s*new Set<string>\(\[(.*?)\]\)",
        source,
        re.DOTALL,
    )
    if match is None:
        raise RuntimeError(
            f"FAIL(fail-closed): {ts_path}에서 HUMAN_SAFE_ERROR_MESSAGE_CODES 배열을 못 찾음 "
            "— 파일 구조가 바뀌었다. 표면③ 허용목록 없이 조용히 통과시키지 않는다."
        )
    codes = frozenset(re.findall(r"'([A-Z0-9_]+)'", match.group(1)))
    if not codes:
        raise RuntimeError(f"FAIL(fail-closed): {ts_path}에서 코드를 0개 파싱함 — 정규식이 실물과 어긋났다.")
    return codes


def _extract_code_and_message_from_detail(
    detail_node: ast.expr,
) -> tuple[object, ast.expr | None]:
    """`HTTPException(detail=...)`의 detail 값에서 (code, message_node)를 뽑는다. 카디르
    QA 실 재현(2026-09-15, PR#4336 코멘트) — 원래는 `human_error(...)` 호출 shape만
    봤는데, `detail={"code": "...", "message": "..."}` 같은 **raw dict 리터럴**로 같은
    런타임 shape(FE가 code/message를 그대로 읽는 envelope)을 만들면 human_error(-국한
    스캔이 AST·regex 양쪽 다 못 봐서 0==0으로 "건강"을 오판했다(fail-open). 두 shape
    모두 지원한다 — 새 shape가 또 생기면(둘 다 아니면) code_val=None이라 허용목록
    매칭에서 자연히 걸러진다(아래 자기검증 좌변이 그 누락도 규정한다)."""
    if isinstance(detail_node, ast.Call) and _call_func_name(detail_node) == "human_error":
        code_node = detail_node.args[0] if detail_node.args else None
        code_val = code_node.value if isinstance(code_node, ast.Constant) else None
        message_node = detail_node.args[1] if len(detail_node.args) > 1 else None
        if message_node is None:
            message_node = next((kw.value for kw in detail_node.keywords if kw.arg == "message"), None)
        return code_val, message_node
    if isinstance(detail_node, ast.Dict):
        code_val = None
        message_node = None
        for k, v in zip(detail_node.keys, detail_node.values):
            if isinstance(k, ast.Constant) and k.value == "code" and isinstance(v, ast.Constant):
                code_val = v.value
            if isinstance(k, ast.Constant) and k.value == "message":
                message_node = v
        return code_val, message_node
    return None, None


def extract_surface3_from_source(
    source: str, file_label: str, allowed_codes: frozenset[str]
) -> list[ExtractedString]:
    tree = ast.parse(source)
    results: list[ExtractedString] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_func_name(node) != "HTTPException":
            continue
        detail_node = next((kw.value for kw in node.keywords if kw.arg == "detail"), None)
        if detail_node is None and len(node.args) > 1:
            detail_node = node.args[1]
        if detail_node is None:
            continue
        code_val, message_node = _extract_code_and_message_from_detail(detail_node)
        if code_val not in allowed_codes:
            continue
        text = _literal_text(message_node) if message_node is not None else None
        if text is None:
            text = UNRESOLVABLE_MESSAGE_SENTINEL
        results.append(
            ExtractedString(
                surface="③ human_error allowlist",
                file=file_label,
                line=node.lineno,
                label=str(code_val),
                text=text,
            )
        )
    return results


def count_surface3_regex_occurrences(source: str, allowed_codes: frozenset[str]) -> int:
    """표면③ 자기검증 좌변 — 허용목록 코드 **문자열 리터럴**이 파일 안에 등장하는 수를
    wrapper 무관하게 센다(카디르 QA 2026-09-15 — 예전엔 `human_error("<code>"` 패턴에만
    국한해 raw dict 우회 shape를 못 봤다). code 문자열이 raw dict든 human_error() 호출
    이든 «어떤 shape로든» 소스에 리터럴로 있으면 여기서 잡힌다 — AST 추출(우변)이 그
    shape를 아직 못 읽는 새로운 우회가 생기면 좌변>우변으로 갈라져 아래 main()의
    자기검증이 RED를 낸다(그 자리를 사람이 직접 봐야 한다는 신호)."""
    return sum(
        len(re.findall(r'["\']' + re.escape(code) + r'["\']', source)) for code in allowed_codes
    )


def extract_surface3_human_error_sites(
    app_root: Path, allowed_codes: frozenset[str]
) -> tuple[list[ExtractedString], int]:
    results: list[ExtractedString] = []
    regex_total = 0
    for f in _iter_py_files(app_root):
        source = f.read_text(encoding="utf-8")
        try:
            file_results = extract_surface3_from_source(source, str(f.relative_to(app_root.parent)), allowed_codes)
        except SyntaxError:
            continue
        results.extend(file_results)
        regex_total += count_surface3_regex_occurrences(source, allowed_codes)
    return results, regex_total


# ---------------------------------------------------------------------------
# 표면④ — email_copy.py 모듈 레벨 dict 리터럴의 ko locale leaf.
# ---------------------------------------------------------------------------
MODULE_DICT_CONST_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*\{", re.MULTILINE)


def discover_surface4_dict_const_names(source: str) -> frozenset[str]:
    """표면④ 자기검증 좌변 — 모듈 레벨 `NAME = {`/`NAME: dict[...] = {` 상수 이름을
    AST 없이 순수 텍스트 정규식으로 독립 발견. AST 쪽 발견 집합과 다르면 literal_eval이
    못 씹는 구조(리스트 컴프리헨션 등)로 바뀐 블록이 조용히 빠진 것."""
    return frozenset(MODULE_DICT_CONST_RE.findall(source))


def extract_surface4_from_module_dicts(module_dicts: dict[str, object], file_label: str) -> list[ExtractedString]:
    results: list[ExtractedString] = []

    def collect(value: object, keypath: str) -> None:
        if isinstance(value, str):
            results.append(ExtractedString(surface="④ email_copy", file=file_label, line=0, label=keypath, text=value))
        elif isinstance(value, list):
            for i, item in enumerate(value):
                collect(item, f"{keypath}[{i}]")
        elif isinstance(value, dict):
            for k, v in value.items():
                collect(v, f"{keypath}.{k}")

    def extract_ko(obj: object, prefix: str) -> None:
        if isinstance(obj, dict):
            if "ko" in obj:
                collect(obj["ko"], prefix)
                return
            for k, v in obj.items():
                extract_ko(v, f"{prefix}.{k}")

    for target_name, val in module_dicts.items():
        extract_ko(val, target_name)
    return results


def extract_surface4_email_copy(email_copy_path: Path) -> tuple[list[ExtractedString], frozenset[str], frozenset[str]]:
    """반환: (추출 목록, AST로 찾은 모듈 dict 상수 이름 집합, 정규식으로 독립 발견한 이름 집합)."""
    source = email_copy_path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    module_dicts: dict[str, object] = {}
    ast_names: set[str] = set()
    for node in tree.body:
        target_name: str | None = None
        value_node: ast.expr | None = None
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target_name, value_node = node.target.id, node.value
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target_name, value_node = node.targets[0].id, node.value
        if target_name is None or not isinstance(value_node, ast.Dict):
            continue
        ast_names.add(target_name)
        module_dicts[target_name] = ast.literal_eval(value_node)

    extracted = extract_surface4_from_module_dicts(module_dicts, str(email_copy_path.relative_to(REPO_ROOT)))
    regex_names = discover_surface4_dict_const_names(source)
    return extracted, frozenset(ast_names), regex_names


# ---------------------------------------------------------------------------
# main.
# ---------------------------------------------------------------------------
def main() -> int:
    allowed_codes = parse_human_safe_error_codes(API_ERROR_MESSAGE_TS_PATH)

    surface1, surface1_call_sites = extract_surface1_notification_kwargs(APP_ROOT)
    surface2, surface2_raw_key_count = extract_surface2_i18n_catalog(I18N_CATALOG_PATH)
    surface3, surface3_regex_count = extract_surface3_human_error_sites(APP_ROOT, allowed_codes)
    surface4, surface4_ast_names, surface4_regex_names = extract_surface4_email_copy(EMAIL_COPY_PATH)

    ok = True

    self_checks = [
        (
            "① dispatch_notification: 콜사이트×2 vs 추출 kwarg 수",
            surface1_call_sites * 2,
            len(surface1),
        ),
        (
            "② i18n_catalog: AST 원시 키 수 vs 평가된 dict 키 수(중복키 은닉 검사)",
            surface2_raw_key_count,
            len(surface2),
        ),
        (
            "③ human_error 허용목록: 정규식 독립 카운트 vs AST 추출 수",
            surface3_regex_count,
            len(surface3),
        ),
    ]
    for label, left, right in self_checks:
        if left != right:
            ok = False
            print(
                f"FAIL: 자기검증 어긋남 — {label}: {left} ≠ {right} "
                "(두 독립 계산이 다르다 — 추출 메커니즘이 실물과 어긋났다, story #3924 「조용히 0건」 교훈)."
            )

    if surface4_ast_names != surface4_regex_names:
        ok = False
        print(
            "FAIL: 자기검증 어긋남 — ④ email_copy: AST 발견 모듈 dict 상수 "
            f"{sorted(surface4_ast_names)} ≠ 정규식 독립 발견 {sorted(surface4_regex_names)} "
            "(AST가 못 씹는 구조로 바뀐 블록이 조용히 빠졌을 수 있다)."
        )

    all_extracted = surface1 + surface2 + surface3 + surface4
    tone_violations = [(item, find_tone_issues(item.text)) for item in all_extracted]
    tone_violations = [(item, issues) for item, issues in tone_violations if issues]

    if tone_violations:
        ok = False
        print(f"\nFAIL: 표면 4종에서 톤/표기 위반 {len(tone_violations)}건:")
        for item, issues in sorted(tone_violations, key=lambda t: (t[0].surface, t[0].file, t[0].line)):
            print(f'  - {item.surface} {item.file}:{item.line} [{item.label}] {issues} "{item.text[:60]}"')

    if not ok:
        return 1
    print(
        f"OK: 표면 4종 자기검증 일치(①{len(surface1)}·②{len(surface2)}·③{len(surface3)}·④{len(surface4)}) "
        "· 톤/표기 위반 0건"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
