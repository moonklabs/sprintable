"""story #1952 (E-MOBILE P1a-S2): 딥링크 계약 CI 스캐너.

story #1951이 만든 `DEEPLINK_MANIFEST` SSOT(app/schemas/deeplink_manifest.py)를 실제 CI
게이트로 승격한다. 이 모듈은 두 축을 정적으로 검증하는 유틸을 제공한다:

  AC1/AC2 — `dispatch_notification()` 실제 호출부가 발화 가능한 (event_type, entity_type)
  조합과 그 payload kwarg를 **소스에서 AST로 직접 추출**해 매니페스트와 대조한다. S1의 draft
  테스트(`test_manifest_covers_all_24_dispatch_notification_event_types`)는 하드코딩된
  "기대 집합" 문자열 리터럴과 매니페스트를 대조했다 — 이건 회귀 고정(regression-lock)으로는
  유용하지만, **신규 dispatch_notification() 호출부가 코드에 추가되고 그 하드코딩 집합도
  매니페스트도 갱신되지 않으면 조용히 통과한다**(이 스토리가 존재하는 이유 자체를 무력화).
  이 모듈은 소스를 직접 훑어 "실제 코드가 무엇을 발화하는지"를 스스로 재구성하므로, 신규
  호출부가 생기면 매니페스트 갱신 없이는 자동으로 CI가 실패한다.

  AC3 — 매니페스트 `target`이 실제 `apps/web` 웹 라우트에 대응하는지 파일시스템으로 대조.

설계 근거(authz_coverage_lib.py 패턴 재사용, S20/SEC-S8): AST 바디 스캔 + **1-hop 래퍼 해소만**
(재귀 콜그래프 분석 없음) — 대상 규모가 작아(호출부 24곳) 이 제약이 안전하다는 판단도 동일하게
적용한다. 새로운 래퍼 계층이 추가되면(2-hop 이상) 이 스캐너가 `UnresolvedDispatchCallError`로
fail-closed 처리한다 — 조용히 놓치지 않는다.

## 스캔 알고리즘

1. `backend/app`+`backend/ee` 전 `.py` 파일을 AST 파싱, `dispatch_notification(...)` 호출
   노드를 전수 수집한다(각 노드 = 코드상 물리적 호출 지점 하나, 현재 24곳).
2. 각 호출 노드의 `event_type=`/`reference_type=` kwarg를 리터럴로 직접 해석 시도:
   - 문자열 리터럴 → 그대로.
   - `X.replace(a, b)` 형태(단순 1단계 메서드 호출) → `X`를 재귀 해석 후 변환 적용.
   - 이름(Name)이 **감싸는 함수의 파라미터**와 일치 → 그 함수를 "래퍼"로 등록하고, 코드베이스
     전체에서 그 함수를 호출하는 지점(현재 known 래퍼: `_notify`·`_emit`)을 찾아 인자 값을
     역추적한다(1-hop만).
   - 그래도 리터럴로 못 좁히면(예: `sr.entity_type`·`entity_type` 파라미터) — 이름이
     `entity_type` 패턴에 매치하면 `WORKFLOW_ENTITY_DOMAIN`(READINESS_MATRIX의
     dispatch_capable 5종, SSOT 재사용 — 하드코딩 금지)으로 전개한다. 그 외 미해결
     동적 표현식은 `UnresolvedDispatchCallError`.
3. 래퍼 호출부가 게이팅 `if <param>:` 안에서만 실제 `dispatch_notification`에 도달하는 경우
   (예: `goal_events.py:_emit`의 `if notify_ids:`) — 호출자가 그 파라미터에 falsy 리터럴
   (`None`/`False`)을 넘기면 해당 호출은 "도달 불가"로 스킵한다(정적으로 판별 가능한 경우만 —
   `emit_goal_removed`가 `notify_member_id=None`을 넘겨 `epic.removed`가 실제로는
   `dispatch_notification`에 절대 도달하지 않는 케이스가 실측 사례).
"""
from __future__ import annotations

import ast
import os
from dataclasses import dataclass, field
from pathlib import Path

_HERE = Path(__file__).resolve()
BACKEND_DIR = _HERE.parents[1]
REPO_ROOT = BACKEND_DIR.parent
APPS_WEB_APP_DIR = REPO_ROOT / "apps" / "web" / "src" / "app"

SCAN_ROOTS = [BACKEND_DIR / "app", BACKEND_DIR / "ee"]

_DISPATCH_FUNC_NAME = "dispatch_notification"


class UnresolvedDispatchCallError(RuntimeError):
    """정적으로 event_type/reference_type을 리터럴 또는 알려진 도메인으로 못 좁힌 호출부.

    fail-closed — 새 동적 패턴이 생기면 이 스캐너를 갱신해야 한다는 신호로 의도적으로 raise."""


@dataclass(frozen=True)
class DispatchCallSite:
    """`dispatch_notification(...)` 물리적 호출 노드 1개 = 소스상 위치 1곳."""

    file: str
    lineno: int
    kwarg_names: frozenset[str]
    resolved_event_types: tuple[str, ...]
    resolved_reference_types: tuple[str | None, ...]


def _iter_py_files(roots: list[Path]):
    for root in roots:
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if fn.endswith(".py"):
                    yield Path(dirpath) / fn


def _parse(path: Path) -> ast.Module | None:
    try:
        src = path.read_text()
        return ast.parse(src, filename=str(path))
    except (OSError, SyntaxError):
        return None


def _is_dispatch_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    f = node.func
    if isinstance(f, ast.Name):
        return f.id == _DISPATCH_FUNC_NAME
    if isinstance(f, ast.Attribute):
        return f.attr == _DISPATCH_FUNC_NAME
    return False


def _kwarg_value(call: ast.Call, name: str) -> ast.AST | None:
    for kw in call.keywords:
        if kw.arg == name:
            return kw.value
    return None


def _func_positional_params(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    return [a.arg for a in (fn.args.posonlyargs + fn.args.args)]


def _func_kwonly_params(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    return [a.arg for a in fn.args.kwonlyargs]


def _find_enclosing_function(
    module: ast.Module, target: ast.AST,
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    """target 노드를 body(재귀)로 포함하는 가장 안쪽 FunctionDef/AsyncFunctionDef.

    parent-pointer 없이 각 함수 정의를 후보로 놓고 `ast.walk`로 포함 여부(identity)를 검사—
    authz_coverage_lib.py와 달리 여기선 여러 함수가 중첩될 수 있어 "가장 작은(안쪽)" 함수를
    고른다(walk된 노드 수가 가장 적은 후보)."""
    best: ast.FunctionDef | ast.AsyncFunctionDef | None = None
    best_size = None
    for node in ast.walk(module):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            contained = list(ast.walk(node))
            if any(n is target for n in contained):
                if best_size is None or len(contained) < best_size:
                    best = node
                    best_size = len(contained)
    return best


def _alias_source_param(
    fn: ast.FunctionDef | ast.AsyncFunctionDef, local_name: str, params: list[str],
) -> str | None:
    """local_name이 fn 파라미터가 아니면, fn 바디에서 `local_name = <X> if <param> else ...`
    형태(3항 연산)의 대입을 찾아 그 조건절 파라미터 이름을 반환한다.

    (goal_events.py `_emit`: `notify_ids = {notify_member_id} if notify_member_id else None`
    — 게이팅 검사가 `if notify_ids:`를 보지만 실제 truthy 근원은 파라미터 `notify_member_id`.)
    """
    if local_name in params:
        return local_name
    for node in ast.walk(fn):
        targets: list[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
            value = node.value
        else:
            continue
        if not any(isinstance(t, ast.Name) and t.id == local_name for t in targets):
            continue
        if isinstance(value, ast.IfExp) and isinstance(value.test, ast.Name):
            if value.test.id in params:
                return value.test.id
    return None


def _gating_param_name(
    fn: ast.FunctionDef | ast.AsyncFunctionDef, call: ast.Call, params: list[str],
) -> str | None:
    """call이 fn 바디 안에서 `if <Name>:` 의 then-분기에만 있으면, 그 Name이 실제로
    가리키는 파라미터 이름을 반환(직접 파라미터거나, 3항연산 별칭을 통한 간접 참조 — 위
    `_alias_source_param` 참고).

    (goal_events.py `_emit`의 `if notify_ids: ... dispatch_notification(...)` 패턴 검출용
    — 호출자가 그 근원 파라미터에 falsy 리터럴을 넘기면 dispatch_notification에 도달 못 함.)
    """
    for node in ast.walk(fn):
        if isinstance(node, ast.If) and isinstance(node.test, ast.Name):
            contained_in_body = [n for stmt in node.body for n in ast.walk(stmt)]
            if any(n is call for n in contained_in_body):
                return _alias_source_param(fn, node.test.id, params)
    return None


def _literal_str(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _is_falsy_literal(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return node.value in (None, False, 0, "")
    return False


def _resolve_replace_transform(node: ast.AST) -> tuple[str, str, str] | None:
    """`X.replace("a", "b")` 형태면 (base_name, old, new) 반환, 아니면 None."""
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "replace"
        and isinstance(node.func.value, ast.Name)
        and len(node.args) == 2
    ):
        old = _literal_str(node.args[0])
        new = _literal_str(node.args[1])
        if old is not None and new is not None:
            return node.func.value.id, old, new
    return None


def _find_wrapper_call_sites(all_modules: dict[Path, ast.Module], func_name: str):
    """코드베이스 전체에서 `func_name(...)` 을 호출하는 ast.Call 노드 전부(파일 무관)."""
    for path, module in all_modules.items():
        for node in ast.walk(module):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == func_name
            ):
                yield path, node


def _bound_arg(
    call: ast.Call, params: list[str], kwonly: list[str], name: str,
) -> ast.AST | None:
    if name in params:
        idx = params.index(name)
        if idx < len(call.args):
            return call.args[idx]
    for kw in call.keywords:
        if kw.arg == name:
            return kw.value
    return None


def scan_dispatch_notification_call_sites() -> list[DispatchCallSite]:
    """`dispatch_notification()` 실제 물리 호출부 전수 스캔 + event_type/reference_type 해석.

    resolved_event_types/resolved_reference_types는 각각 이 호출부가 실제로 발화 가능한 값의
    전체 집합(카티전 곱은 호출자 쪽에서 필요시 구성) — 보통 1개, 동적 entity_type 도메인
    전개 시 여러 개(예: `dispatched`는 5개 reference_type)."""
    from app.services.workflow_readiness_matrix import READINESS_MATRIX

    workflow_entity_domain = tuple(
        sorted(k for k, v in READINESS_MATRIX.items() if v.dispatch_capable)
    )

    all_modules: dict[Path, ast.Module] = {}
    for path in _iter_py_files(SCAN_ROOTS):
        module = _parse(path)
        if module is not None:
            all_modules[path] = module

    sites: list[DispatchCallSite] = []

    for path, module in all_modules.items():
        for node in ast.walk(module):
            if not _is_dispatch_call(node):
                continue
            kwarg_names = frozenset(kw.arg for kw in node.keywords if kw.arg is not None)

            event_types = _resolve_field(
                node, "event_type", module, all_modules, workflow_entity_domain,
                file=path, lineno=node.lineno,
            )
            reference_types = _resolve_field(
                node, "reference_type", module, all_modules, workflow_entity_domain,
                file=path, lineno=node.lineno, allow_none=True,
            )

            sites.append(DispatchCallSite(
                file=str(path.relative_to(REPO_ROOT)),
                lineno=node.lineno,
                kwarg_names=kwarg_names,
                resolved_event_types=tuple(event_types),
                resolved_reference_types=tuple(reference_types),
            ))

    return sites


def _resolve_field(
    call: ast.Call, field_name: str, module: ast.Module,
    all_modules: dict[Path, ast.Module], workflow_entity_domain: tuple[str, ...],
    *, file: Path, lineno: int, allow_none: bool = False,
) -> list[str | None]:
    value = _kwarg_value(call, field_name)
    if value is None:
        if allow_none:
            return [None]
        raise UnresolvedDispatchCallError(
            f"{file}:{lineno} dispatch_notification() 호출에 {field_name}= kwarg가 없음"
        )

    lit = _literal_str(value)
    if lit is not None:
        return [lit]

    if isinstance(value, ast.Constant) and value.value is None and allow_none:
        return [None]

    # entity_type 패턴(Name 또는 Attribute) → 워크플로 엔티티 도메인 전개.
    if isinstance(value, ast.Name) and value.id == "entity_type":
        return list(workflow_entity_domain)
    if isinstance(value, ast.Attribute) and value.attr == "entity_type":
        return list(workflow_entity_domain)

    transform = _resolve_replace_transform(value)
    if transform is not None:
        base_name, old, new = transform
        resolved = _resolve_name_via_wrapper(
            call, base_name, module, all_modules, file=file, lineno=lineno,
        )
        return [r.replace(old, new) if r is not None else None for r in resolved]

    if isinstance(value, ast.Name):
        resolved = _resolve_name_via_wrapper(
            call, value.id, module, all_modules, file=file, lineno=lineno,
        )
        return resolved

    raise UnresolvedDispatchCallError(
        f"{file}:{lineno} dispatch_notification({field_name}=...) 표현식을 정적으로 "
        f"해석 못 함(ast dump: {ast.dump(value)}) — 신규 동적 패턴이면 "
        f"deeplink_contract_lib.py 스캐너를 갱신할 것."
    )


def _resolve_name_via_wrapper(
    call: ast.Call, param_name: str, module: ast.Module,
    all_modules: dict[Path, ast.Module], *, file: Path, lineno: int,
) -> list[str | None]:
    """call이 속한 함수(래퍼)의 파라미터 param_name을 코드베이스 전체 호출부에서 역추적."""
    fn = _find_enclosing_function(module, call)
    if fn is None or param_name not in (_func_positional_params(fn) + _func_kwonly_params(fn)):
        raise UnresolvedDispatchCallError(
            f"{file}:{lineno} '{param_name}'이 감싸는 함수의 파라미터가 아님 — "
            f"신규 동적 패턴이면 스캐너 갱신 필요."
        )

    params = _func_positional_params(fn)
    kwonly = _func_kwonly_params(fn)
    gating_param = _gating_param_name(fn, call, params + kwonly)

    resolved: list[str | None] = []
    for _caller_path, caller_call in _find_wrapper_call_sites(all_modules, fn.name):
        if gating_param is not None:
            gate_value = _bound_arg(caller_call, params, kwonly, gating_param)
            if gate_value is not None and _is_falsy_literal(gate_value):
                continue  # 정적으로 도달 불가 판정(예: emit_goal_removed의 notify_member_id=None).

        bound = _bound_arg(caller_call, params, kwonly, param_name)
        if bound is None:
            raise UnresolvedDispatchCallError(
                f"{fn.name}() 호출부가 '{param_name}' 인자를 안 넘김 — 정적 해석 실패."
            )
        lit = _literal_str(bound)
        if lit is None:
            raise UnresolvedDispatchCallError(
                f"{fn.name}() 호출부의 '{param_name}' 인자가 리터럴이 아님(ast dump: "
                f"{ast.dump(bound)}) — 신규 동적 패턴이면 스캐너 갱신 필요."
            )
        resolved.append(lit)
    return resolved


# ============================================================================
# AC3 — 매니페스트 target ↔ apps/web 실제 라우트 대조.
# ============================================================================

# S1 doc(`draft-1951-deeplink-manifest-v1` §2) 확인 4건(goal/sprint/chat/team_member) +
# 이 스토리(#1952) 착수 전 GATE1 확장 조사 결과.
#
# story_detail: `apps/web/.../[ws]/[proj]/board/board-client.tsx`가 쓰는
#   `kanban-board.tsx`가 `searchParams.get('story')`로 StoryDetailPanel을 연다(실측) — 별도
#   `[id]` 서브라우트가 아니라 board 페이지의 쿼리파람 소비 방식(sprint_detail과 동형).
# doc_detail: `docs/[slug]/page.tsx` 동적 라우트 존재(id→slug 변환은 §7 기존 GET
#   /docs/{id} 응답 필드로 해소 — 라우트 자체는 실존).
# artifact_detail: **GAP으로 확인**(`apps/web/src/components/canvas/artifact-gallery-view.tsx`
#   전수 확인 — `useSearchParams`/URL 기반 상세 오픈 로직 0건, `ArtifactExpandDialog`는
#   순수 클라이언트 인메모리 상태로만 열림 — 딥링크로 직접 도달 불가). gate_detail/
#   hypothesis 패턴과 동일하게 매니페스트 쪽에서 `target_promotion_pending=True`로 표시해
#   이 AC3 체크 대상에서 제외(별도 커밋으로 매니페스트 수정 — 근거는 최종 보고 참고).
TARGET_ROUTE_GLOBS: dict[str, tuple[str, ...]] = {
    "goal_detail": ("(authenticated)/[ws]/[proj]/goals/[id]/page.tsx",),
    "sprint_detail": ("(authenticated)/[ws]/[proj]/sprints/page.tsx",),
    "chat_thread": ("(authenticated)/chats/[conversation_id]/page.tsx",),
    "team_member_detail": ("(authenticated)/organization/workforce/[id]/page.tsx",),
    "doc_detail": ("(authenticated)/[ws]/[proj]/docs/[slug]/page.tsx",),
    "story_detail": ("(authenticated)/[ws]/[proj]/board/page.tsx",),
}


def resolve_target_route(target: str) -> tuple[str, ...] | None:
    """target(논리적 화면 식별자 또는 `/board?story=`류 리터럴 경로)을 apps/web 파일시스템
    후보 경로들로 변환. 매핑이 없으면 None(호출자가 fail-closed 처리)."""
    if target in TARGET_ROUTE_GLOBS:
        return TARGET_ROUTE_GLOBS[target]
    if target.startswith("/"):
        # task_completed의 "/board?story=" 같은 팀 기존 폴백 컨벤션 — 쿼리스트링 제거 후
        # 첫 경로 세그먼트를 프로젝트-스코프 라우트로 매핑.
        path_part = target.split("?", 1)[0].strip("/")
        segment = path_part.split("/", 1)[0] if path_part else ""
        if segment:
            return (f"(authenticated)/[ws]/[proj]/{segment}/page.tsx",)
    return None


def target_route_exists(target: str) -> bool:
    candidates = resolve_target_route(target)
    if not candidates:
        return False
    return any((APPS_WEB_APP_DIR / c).exists() for c in candidates)
