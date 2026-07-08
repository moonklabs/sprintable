"""S20(`5736c1a5`): authz-coverage 스캐너 — enumerate/scan 유틸.

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
"""
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

# Depends(...) 콜러블 — 결과 id가 caller auth에서 서버-파생돼 클라이언트가 스푸핑할 여지가
# 없는 패턴(예: app.routers.webhooks._get_caller_member_id). 이름 자체가 곧 계약이라 이름
# registry로 관리 — 새 self-deriving dependency 추가 시 여기만 갱신.
SELF_DERIVING_DEPENDENCIES: frozenset[str] = frozenset({
    "_get_caller_member_id",
})

MUTATING_METHODS: frozenset[str] = frozenset({"POST", "PATCH", "PUT", "DELETE"})
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


def _identity_fields_from_annotation(annotation) -> set[str]:
    """파라미터 타입이 Pydantic body 모델이면 그 필드명 중 identity-shaped 것도 대상에 포함.

    (예: events.py create_event의 ``body: CreateEventRequest``의 ``sender_id`` 필드 — 최상위
    함수 시그니처엔 안 보이지만 body 모델 필드로 존재.)
    """
    try:
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            return {name for name in annotation.model_fields if IDENTITY_PARAM_RE.search(name)}
    except TypeError:
        pass
    return set()


def _identity_params(endpoint) -> set[str]:
    try:
        sig = inspect.signature(endpoint)
    except (ValueError, TypeError):
        return set()
    found: set[str] = set()
    for name, p in sig.parameters.items():
        if IDENTITY_PARAM_RE.search(name):
            found.add(name)
        found |= _identity_fields_from_annotation(p.annotation)
    return found


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


def enumerate_identity_routes(app, methods: frozenset[str] = COVERED_METHODS) -> list[RouteTarget]:
    """앱의 전 라우트 중 covered method + identity-shaped param을 가진 것만 열거.

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
        identity_params = _identity_params(endpoint)
        if not identity_params:
            continue
        out.append(RouteTarget(
            path=route.path,
            methods=tuple(sorted(matched)),
            module=endpoint.__module__,
            qualname=endpoint.__qualname__,
            identity_params=tuple(sorted(identity_params)),
            endpoint=endpoint,
        ))
    return out


def has_declared_guard(target: RouteTarget) -> bool:
    """이름 registry 매치(바디 호출) 또는 self-deriving Depends 매치 — 둘 중 하나면 가드 有."""
    if _called_names(target.endpoint) & GUARD_FUNCTIONS:
        return True
    if _depends_callable_names(target.endpoint) & SELF_DERIVING_DEPENDENCIES:
        return True
    return False
