"""S20(`5736c1a5`) + SEC-S8 CC 후속(`83ea3d6a`): authz-coverage 스캐너 — enumerate/scan 유틸.

설계 근거: Sprintable 문서 `s20-authz-coverage-design`(SSOT). 핵심 발견 두 가지가 이 구현을
결정한다:

1. 기존 caller-ownership 가드(assert_caller_is_member 등)는 전부 핸들러 **바디 안에서 직접
   await 호출**되고 FastAPI ``Depends()``로 선언되지 않는다(실측: ``Depends(assert_...)`` /
   ``Depends(_assert...)`` 매치 0건) — 그래서 가드 탐지는 **정적(AST) 바디 스캔**이 필수다.
   런타임(``app.routes``)은 "실제 서빙되는 라우트" 캐노니컬 소스로만 쓴다.
2. 앱의 mutating 라우트 대다수(story/task/sprint 등 협업 리소스)는 caller-identity ownership이
   아니라 **tenancy 스코프**(``get_verified_org_id``/``enforce_body_context`` 등, Depends 체인)로
   보호된다 — 이건 다른 축의 관심사라 스캐너 대상에서 자연히 제외해야 한다(안 그러면 오탐 100+건).
   그래서 대상은 "identity-shaped 파라미터를 가진" 라우트로 좁힌다(member_id/assignee_id/
   recipient_id/sender_id/agent_id/user_id — path/query든 body 모델 필드든).

SEC-S8 CC 후속(2026-07-11): E-SECURITY SEC-S8(story `83ea3d6a`) R~CC 스윕이 발견한 취약점
클래스는 identity-shaped가 아니라 **project-shaped**(project_id/story_id/sprint_id/epic_id/
doc_id/meeting_id/parent_id) 파라미터에 caller의 project 접근권 검증이 없는 것 — org_id는
검증하나 caller-supplied project-scoped id에 has_project_access류가 없어 same-org
cross-project IDOR가 발생했다. 같은 스캔 축을 param-pattern/guard-set만 갈아끼워 재사용
(신규 프리미티브 발명 금지) — 아래 ``enumerate_routes_matching``/``has_guard``가 일반화된
버전이고, ``enumerate_identity_routes``/``has_declared_guard``는 S20 기존 axis용 thin wrapper로
그대로 보존(회귀 0)."""
from __future__ import annotations

import ast
import inspect
import re
import textwrap
from dataclasses import dataclass, field

from pydantic import BaseModel

# ── (b) "가드 선언" 인정 기준 — 기존 프리미티브 재사용만(신규 프리미티브 발명 금지) ────────────
GUARD_FUNCTIONS: frozenset[str] = frozenset({
    "assert_caller_is_member",
    "is_caller_member",
    "assert_agent_owner",
    "_is_org_admin",
    "has_project_role",
    "has_project_access",
    "is_org_owner_or_admin",
    "is_org_owner",
    "_assert_can_manage_human",
    "_assert_self_or_org_admin",
})

# ── SEC-S8 CC 후속: project-scope axis (identity axis와 별개 파라미터 클래스+가드셋) ──────────
PROJECT_PARAM_RE = re.compile(
    r"(?:^|_)(project_id|story_id|sprint_id|epic_id|doc_id|meeting_id|parent_id)$"
)

PROJECT_GUARD_FUNCTIONS: frozenset[str] = frozenset({
    "has_project_access",
    "resolve_member",
    "accessible_project_ids_in_org",
    "get_project_role",
    "_assert_story_link_targets_in_project",
    "_assert_doc_parent_in_project",
    "_assert_link_target_in_scope",
    "_assert_task_project_access",
    "_assert_story_project_access",
    "_require_doc_project_access",
    "_require_retro_project_access",
})

# ── PATH_ID 뮤테이션 축(story 5285888c): `DELETE|PATCH|PUT /resource/{id}` 처럼 리소스 자기
# PK(path param `id`/`*_id`)로 잡는 뮤테이션 라우트는 param 이름이 project_id/story_id가 아니라
# `id`라 PROJECT_PARAM_RE에 원천 비가시였다(add_feedback body-claimed에 이은 2번째 계열 사각).
# 이 축은 그 라우트가 **대상 리소스의 project 접근권을 검증**하는지 본다.
PATH_ID_PARAM_RE = re.compile(r"^(?:id|[a-z][a-z0-9]*_id)$")

# id-뮤테이션 축의 "project 가드" 셋 — resolve_member는 **제외**한다: 인자 없는
# resolve_member(auth, org_id, session)는 신원해소만 하고 project 접근권을 검증하지 않기
# 때문(hypotheses.update 등 실 갭). resolve_member는 아래 _resolve_member_checks_project 로
# **project_id= 키워드로 호출됐을 때만** 가드로 인정(sprints.delete 등 정당 사용 보존).
ID_MUTATION_PROJECT_GUARDS: frozenset[str] = frozenset(PROJECT_GUARD_FUNCTIONS - {"resolve_member"}) | {
    "assert_target_in_caller_org",
}

# Depends(...) 콜러블 — 결과 id가 caller auth에서 서버-파생돼 클라이언트가 스푸핑할 여지가
# 없는 패턴(예: app.routers.webhooks._get_caller_member_id). 이름 자체가 곧 계약이라 이름
# registry로 관리 — 새 self-deriving dependency 추가 시 여기만 갱신.
SELF_DERIVING_DEPENDENCIES: frozenset[str] = frozenset({
    "_get_caller_member_id",
})

# 제네릭 tenancy/auth/db 의존성 — 이들의 바디는 Depends-바디 가드스캔서 **제외**한다.
# 근거: get_verified_org_id는 JWT의 org+project **클레임**을 has_project_access로 검증하지만,
# 이건 caller가 주장한 project지 **대상 리소스의 project**가 아니다(cross-project IDOR 무방비).
# 거의 모든 라우트에 붙어 있어 포함하면 전 라우트가 가드로 오인된다(hypotheses false-negative 원인).
# resource-특정 의존성(_get_repo류: path id로 대상 리소스 fetch+project 검증)만 인정한다.
GENERIC_DEPENDENCIES: frozenset[str] = frozenset({
    "get_verified_org_id",
    "get_db",
    "get_current_user",
    "get_optional_current_user",
})

MUTATING_METHODS: frozenset[str] = frozenset({"POST", "PATCH", "PUT", "DELETE"})
# PATH_ID 축은 **리소스 자체를 뮤테이트**하는 메서드로 좁힌다(DELETE/PATCH/PUT). POST는
# /resource/{id}/subaction(하위리소스 생성) shape라 별개 축(향후 확장) — 이 스토리 스코프 밖.
ID_MUTATION_METHODS: frozenset[str] = frozenset({"PATCH", "PUT", "DELETE"})
# (GET 포함 — PO 크럭스 승인: read 사이드 정보노출도 이 스토리의 핵심 동기이자 커버리지 대상).
COVERED_METHODS: frozenset[str] = MUTATING_METHODS | {"GET"}

IDENTITY_PARAM_RE = re.compile(
    r"(?:^|_)(member_id|assignee_member_id|assignee_id|recipient_id|sender_id|agent_id|user_id)$"
)


@dataclass(frozen=True)
class RouteTarget:
    path: str
    methods: tuple[str, ...]
    module: str
    qualname: str
    identity_params: tuple[str, ...]
    endpoint: object = field(repr=False, compare=False)

    @property
    def key(self) -> str:
        """중앙 allowlist 키 — ``<module>:<qualname>`` 형식."""
        return f"{self.module}:{self.qualname}"


def _fields_from_annotation(annotation, pattern: re.Pattern) -> set[str]:
    """파라미터 타입이 Pydantic body 모델이면 그 필드명 중 pattern-shaped 것도 대상에 포함.

    (예: events.py create_event의 ``body: CreateEventRequest``의 ``sender_id`` 필드 — 최상위
    함수 시그니처엔 안 보이지만 body 모델 필드로 존재.)
    """
    try:
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            return {name for name in annotation.model_fields if pattern.search(name)}
    except TypeError:
        pass
    return set()


def _matched_params(endpoint, pattern: re.Pattern) -> set[str]:
    try:
        sig = inspect.signature(endpoint)
    except (ValueError, TypeError):
        return set()
    found: set[str] = set()
    for name, p in sig.parameters.items():
        if pattern.search(name):
            found.add(name)
        found |= _fields_from_annotation(p.annotation, pattern)
    return found


def _identity_fields_from_annotation(annotation) -> set[str]:
    return _fields_from_annotation(annotation, IDENTITY_PARAM_RE)


def _identity_params(endpoint) -> set[str]:
    return _matched_params(endpoint, IDENTITY_PARAM_RE)


def _called_names(endpoint) -> set[str]:
    """엔드포인트 함수 바디의 Call 노드 이름(Name/Attribute 양쪽) 전부 — AST 정적 스캔.

    v1 제약(설계 문서에 명시): 이 함수 자신의 바디만 본다 — 헬퍼 함수 한 단계 아래 감긴 가드는
    안 보인다(예: channel.py의 ``_resolve_agent``). 대상 규모가 작아(식별된 identity-param
    라우트 기준 수십 건 이내) 이런 케이스는 findings 리뷰에서 수동 확인 후 allowlist하는 편이
    재귀 콜그래프 분석의 자체 실패모드(동적 임포트·repo 간접호출 등)보다 안전하다는 판단.
    """
    try:
        src = textwrap.dedent(inspect.getsource(endpoint))
        tree = ast.parse(src)
    except (OSError, TypeError, SyntaxError):
        return set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name):
                names.add(f.id)
            elif isinstance(f, ast.Attribute):
                names.add(f.attr)
    return names


def _depends_callable_names(endpoint) -> set[str]:
    """시그니처의 ``Depends(...)`` 콜러블 이름 — 자가파생 의존성(SELF_DERIVING_DEPENDENCIES) 인식용.

    미래 대비: 가드가 언젠가 Depends 기반으로 리팩터되면 이 경로로도 잡히게(현재는 실사용 0건).
    """
    try:
        sig = inspect.signature(endpoint)
    except (ValueError, TypeError):
        return set()
    names: set[str] = set()
    for p in sig.parameters.values():
        dependency = getattr(p.default, "dependency", None)
        if dependency is not None:
            names.add(getattr(dependency, "__name__", ""))
    return names


def enumerate_routes_matching(
    app, pattern: re.Pattern, methods: frozenset[str] = COVERED_METHODS,
) -> list[RouteTarget]:
    """앱의 전 라우트 중 covered method + pattern-shaped param을 가진 것만 열거.

    같은 엔드포인트 함수가 여러 route(예: 여러 path alias)에 바인딩된 경우 중복 제거.
    """
    seen: set = set()
    out: list[RouteTarget] = []
    for route in app.routes:
        route_methods = getattr(route, "methods", None)
        if not route_methods:
            continue
        matched = route_methods & methods
        if not matched:
            continue
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None or endpoint in seen:
            continue
        seen.add(endpoint)
        matched_params = _matched_params(endpoint, pattern)
        if not matched_params:
            continue
        out.append(RouteTarget(
            path=route.path,
            methods=tuple(sorted(matched)),
            module=endpoint.__module__,
            qualname=endpoint.__qualname__,
            identity_params=tuple(sorted(matched_params)),
            endpoint=endpoint,
        ))
    return out


def enumerate_identity_routes(app, methods: frozenset[str] = COVERED_METHODS) -> list[RouteTarget]:
    return enumerate_routes_matching(app, IDENTITY_PARAM_RE, methods)


def has_guard(target: RouteTarget, guard_functions: frozenset[str] = GUARD_FUNCTIONS) -> bool:
    """이름 registry 매치(바디 호출) 또는 self-deriving Depends 매치 — 둘 중 하나면 가드 有."""
    if _called_names(target.endpoint) & guard_functions:
        return True
    if _depends_callable_names(target.endpoint) & SELF_DERIVING_DEPENDENCIES:
        return True
    return False


def has_declared_guard(target: RouteTarget) -> bool:
    return has_guard(target, GUARD_FUNCTIONS)


def _path_param_names(route) -> set[str]:
    """route.path(`/api/v2/epics/{id}`)의 `{...}` path param 이름 집합 — 리소스 자기 PK 식별용
    (body/query가 아닌 **path** param만)."""
    return set(re.findall(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", getattr(route, "path", "")))


def _resolve_member_checks_project(endpoint) -> bool:
    """엔드포인트 바디에서 resolve_member(...)가 **project_id= 키워드**로 호출됐는지 AST로 판정.
    인자 없는 resolve_member는 project 접근권을 검증 안 하므로 id-뮤테이션 가드로 인정 불가."""
    try:
        src = textwrap.dedent(inspect.getsource(endpoint))
        tree = ast.parse(src)
    except (OSError, TypeError, SyntaxError):
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            fname = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")
            if fname == "resolve_member" and any(kw.arg == "project_id" for kw in node.keywords):
                return True
    return False


def _depends_bodies_call_guard(endpoint, guard_set: frozenset[str]) -> bool:
    """엔드포인트의 ``Depends(...)`` 콜러블 **바디**에서 guard_set 함수를 호출하는지 AST 스캔.

    다수 라우트가 가드를 핸들러 바디가 아니라 의존성(예: meetings ``_get_repo``가 내부에서
    has_project_access 호출)에 둔다 — 바디-only 스캔이 이를 놓쳐 오탐이 되므로, Depends 콜러블
    한 단계는 들여다본다(재귀는 안 함·v1 제약 유지)."""
    try:
        sig = inspect.signature(endpoint)
    except (ValueError, TypeError):
        return False
    for p in sig.parameters.values():
        dep = getattr(p.default, "dependency", None)
        if dep is None:
            continue
        if getattr(dep, "__name__", "") in GENERIC_DEPENDENCIES:
            continue  # 제네릭 tenancy/auth 의존성은 대상-리소스 가드가 아니다(제외).
        try:
            src = textwrap.dedent(inspect.getsource(dep))
            tree = ast.parse(src)
        except (OSError, TypeError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                f = node.func
                fname = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")
                if fname in guard_set:
                    return True
    return False


def has_id_mutation_guard(target: RouteTarget) -> bool:
    """id-뮤테이션 라우트가 대상 리소스에 대한 인가 가드를 갖는가.

    "가드"로 인정: ①project 접근권 가드(ID_MUTATION_PROJECT_GUARDS) ②resolve_member(project_id=)
    ③org-level/ownership/self 가드(GUARD_FUNCTIONS: is_org_owner_or_admin/assert_caller_is_member/
    assert_agent_owner 등) ④self-deriving Depends.
    ②③를 인정하는 근거: org-level/user-level 리소스(organizations/labels/org_members 등)는 project
    축이 없어 org-admin/ownership 가드가 곧 올바른 가드다. ⚠️한계: project-소속 리소스를 **org-admin
    으로만** 가드하면 non-admin의 cross-project 뮤테이션을 놓친다(false-negative) — 그러나 전수
    감사(story 5285888c)상 그런 케이스는 없었고, project-소속 리소스의 6 후보는 **어떤 가드도 없다**.
    신규 project-소속 리소스는 반드시 has_project_access류를 쓸 것(리뷰 규율)."""
    guard_set = ID_MUTATION_PROJECT_GUARDS | GUARD_FUNCTIONS
    called = _called_names(target.endpoint)
    if called & guard_set:
        return True
    if _resolve_member_checks_project(target.endpoint):
        return True
    if _depends_callable_names(target.endpoint) & SELF_DERIVING_DEPENDENCIES:
        return True
    if _depends_bodies_call_guard(target.endpoint, guard_set):
        return True
    return False


def enumerate_id_mutation_routes(app) -> list[RouteTarget]:
    """MUTATING(DELETE/PATCH/PUT) + path에 리소스 PK(id/*_id) param을 가진 라우트 전수.

    대상 리소스가 project-소속이면 그 리소스의 project 접근권을 검증해야 하나, 스캐너는 리소스의
    project-scoped 여부를 정적 자동판정하지 못한다(라우트→모델→컬럼/polymorphic 해소 필요) —
    그래서 org/user-level(project 축 없음) 및 self-derived 안전 라우트는 baseline의 false-positive로
    흡수하고(identity axis 38건 흡수 선례 동형), 실 project-scoped IDOR는 known-debt로 상환한다.
    identity_params 필드엔 매치된 path-id param을 담는다."""
    seen: set = set()
    out: list[RouteTarget] = []
    for route in app.routes:
        route_methods = getattr(route, "methods", None)
        if not route_methods:
            continue
        matched = route_methods & ID_MUTATION_METHODS
        if not matched:
            continue
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None or endpoint in seen:
            continue
        path_ids = {p for p in _path_param_names(route) if PATH_ID_PARAM_RE.match(p)}
        if not path_ids:
            continue
        seen.add(endpoint)
        out.append(RouteTarget(
            path=route.path,
            methods=tuple(sorted(matched)),
            module=endpoint.__module__,
            qualname=endpoint.__qualname__,
            identity_params=tuple(sorted(path_ids)),
            endpoint=endpoint,
        ))
    return out


def sibling_asymmetry_advisory(app) -> list[RouteTarget]:
    """형제-비대칭 advisory(story 5285888c §3.3): 같은 라우터 모듈에 project 가드를 호출하는
    라우트(형제)가 하나라도 있는데, 그 모듈의 미가드 {id}-뮤테이션 라우트는 대상 리소스의 project를
    검증 안 하면 — 그 모듈 리소스가 project-소속일 개연성이 높다는 **고신뢰 시그널**이다(감사서 epics·
    agent_runs·과거 participation/github 반복 확認). project-scoped 정적 자동판정 없이도 후보를 좁힌다.

    비-강제(advisory) — CI를 RED로 만들지 않고 후보를 surface만 한다. 반환: 비대칭에 걸린 미가드
    {id}-뮤테이션 RouteTarget 목록."""
    id_routes = enumerate_id_mutation_routes(app)
    # 모듈별로 project 가드를 호출하는 (임의 메서드) 라우트가 있는지 — COVERED_METHODS 전 축에서.
    guarded_modules: set[str] = set()
    for r in enumerate_routes_matching(app, PROJECT_PARAM_RE, COVERED_METHODS):
        if has_guard(r, PROJECT_GUARD_FUNCTIONS):
            guarded_modules.add(r.module)
    return [
        r for r in id_routes
        if not has_id_mutation_guard(r) and r.module in guarded_modules
    ]
