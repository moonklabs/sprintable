"""story #2632 — event_definitions 네임스페이스 강제 + payload 검증 (AC2/AC3).

이 모듈이 "서버 강제"의 진짜 지점이다(model.py의 CHECK 제약은 접두사 모양만 보는 방어선 —
`org.{slug}.*`의 slug가 **호출자 자신의 org slug**인지는 CHECK가 알 도리가 없다, model
docstring 참조). story #2636(커스텀 등록 API)이 실제로 이 함수들을 호출하는 콜사이트가
될 것 — #2632는 함수와 그 계약을 확정하고 시드로 증명한다(#2630의 release_circuit_breaker
선례와 동형: 소비 endpoint 없이 함수+테스트로 먼저 굳힘).
"""
from __future__ import annotations

import re
import uuid

import jsonschema

_PRESET_KEY_RE = re.compile(r"^preset\.[a-z0-9_]+(\.[a-z0-9_]+)+$")
_ORG_KEY_RE = re.compile(r"^org\.([a-z0-9-]+)\.[a-z0-9_]+(\.[a-z0-9_]+)*$")

# routing.{escalation,broadcast}.kind="server_derived"의 닫힌 어휘(model.py docstring 참조,
# 페드루 판정 2026-08-13) — story #2633(해석기)이 실제로 이 target들을 member_id로 풀어야
# 하므로, 여기 없는 target을 server_derived로 등록하면 해석기가 절대 못 푸는 정의가 만들어진다
# — validate_event_routing이 등록 시점에 막는다(발행 시점에야 발견되는 것보다 이르게).
SERVER_DERIVED_TARGETS = frozenset({"none", "work_item_stakeholders", "goal_owner"})
_ROUTING_KINDS = frozenset({"payload_field", "server_derived"})


class InvalidEventDefinitionKeyError(ValueError):
    """key 네임스페이스 규칙 위반 — AC2."""


class InvalidEventPayloadError(ValueError):
    """payload가 payload_schema를 위반(모르는 필드 포함) — AC3."""

    def __init__(self, message: str, *, errors: list[str]) -> None:
        super().__init__(message)
        self.errors = errors


class InvalidPayloadSchemaError(ValueError):
    """story #2636 AC1: payload_schema가 additionalProperties: false를 선언하지 않음 —
    org 커스텀 등록 시점에 거부(스키마 저작 자체의 책임 소재 문제, 발행 시점 payload 위반과는
    다른 축)."""


class InvalidEventRoutingError(ValueError):
    """routing 선언이 두 부류 계약(model.py docstring)을 위반 — 등록 시점에 막아 #2633
    해석기가 절대 못 푸는 정의가 저장되는 것을 방지."""


def validate_event_definition_key(
    key: str, *, org_id: uuid.UUID | None, org_slug: str | None,
) -> None:
    """AC2: preset.*는 org_id 없을 때만(플랫폼 전용) · org.{slug}.*는 그 org 자신의 slug와
    정확히 일치할 때만(타 org 도용 차단) — 이 둘 다 CHECK 제약이 못 잡는 축이라 여기가
    진짜 게이트. org_id가 주어졌는데 org_slug가 없으면(호출부 실수) fail-closed."""
    if org_id is None:
        if not _PRESET_KEY_RE.match(key):
            raise InvalidEventDefinitionKeyError(
                f"프리셋 정의(org_id=None)의 key는 'preset.'로 시작해야 합니다: {key!r}"
            )
        return

    if not org_slug:
        raise InvalidEventDefinitionKeyError(
            "org 커스텀 정의는 org_slug 없이 검증할 수 없습니다(fail-closed)."
        )
    m = _ORG_KEY_RE.match(key)
    if m is None:
        raise InvalidEventDefinitionKeyError(
            f"org 커스텀 정의의 key는 'org.{{slug}}.'로 시작해야 합니다: {key!r}"
        )
    if m.group(1) != org_slug:
        raise InvalidEventDefinitionKeyError(
            f"key의 네임스페이스 slug({m.group(1)!r})가 호출자 org의 slug({org_slug!r})와 "
            "일치하지 않습니다 — 타 org 네임스페이스 도용 차단."
        )


def _validate_routing_leg(leg: dict, *, leg_name: str, allow_server_derived: bool) -> None:
    kind = leg.get("kind")
    if kind not in _ROUTING_KINDS:
        raise InvalidEventRoutingError(
            f"routing.{leg_name}.kind는 {sorted(_ROUTING_KINDS)} 중 하나여야 합니다: {kind!r}"
        )
    if kind == "payload_field":
        if not leg.get("member_id_field"):
            raise InvalidEventRoutingError(
                f"routing.{leg_name}.kind='payload_field'는 member_id_field가 필수입니다."
            )
        return

    # kind == "server_derived"
    if leg.get("member_id_field"):
        raise InvalidEventRoutingError(
            f"routing.{leg_name}.kind='server_derived'는 member_id_field를 가질 수 없습니다 "
            "(payload 필드가 아니라 서버 파생 역할이므로)."
        )
    target = leg.get("target")
    # story #2636 AC2(PO 확定 최소안, 2026-08-14): target="none"은 예외 — server_derived 금지
    # 규약이 막으려는 것은 "서버가 해석 못 하는 파생 역할"인데, "none"은 애초에 아무 것도 해석
    # 안 한다(event_routing_resolver._resolve_none — payload/DB 무관 즉시 빈 집합). org 커스텀이
    # server_derived를 전혀 못 쓰면 «escalation 없음»조차 표현할 방법이 없어지는 쪽이 오히려
    # 결함이었다(payload_field는 반드시 payload의 실 필드를 요구해 "의도적으로 없음"을 못 그림).
    # allow_server_derived=False(org 커스텀 경로)에서도 target="none"만은 통과시킨다.
    if not allow_server_derived and target != "none":
        raise InvalidEventRoutingError(
            f"routing.{leg_name}.kind='server_derived'는 org 커스텀 정의에 등록할 수 없습니다 "
            "— 서버가 모르는 파생 역할은 해석 불가능한 정의를 만듭니다(payload_field 또는 "
            "target='none'만 허용)."
        )
    if target not in SERVER_DERIVED_TARGETS:
        raise InvalidEventRoutingError(
            f"routing.{leg_name}.target={target!r}은 server_derived 닫힌 어휘"
            f"({sorted(SERVER_DERIVED_TARGETS)}) 밖입니다 — #2633 해석기가 풀 수 없는 정의."
        )


def validate_event_routing(routing: dict, *, allow_server_derived: bool = True) -> None:
    """routing.escalation·routing.broadcast 둘 다 두 부류 계약(model.py docstring)을 지키는지
    확인 — 프리셋 시드는 allow_server_derived=True(기본), story #2636의 org 커스텀 등록
    경로는 allow_server_derived=False로 호출해 payload_field만 허용해야 한다."""
    for leg_name in ("escalation", "broadcast"):
        leg = routing.get(leg_name)
        if not isinstance(leg, dict):
            raise InvalidEventRoutingError(f"routing.{leg_name}이 없거나 object가 아닙니다.")
        _validate_routing_leg(leg, leg_name=leg_name, allow_server_derived=allow_server_derived)


def validate_event_payload_schema_shape(payload_schema: dict) -> None:
    """story #2636 AC1: org 커스텀 등록 시점에 payload_schema 자체가 유효한 JSON Schema이고
    top-level `additionalProperties: false`를 명시했는지 강제. 미선언 스키마는 JSON Schema
    기본값(관대 — 모르는 필드를 조용히 통과)이 그대로 새는데, 그 방임을 org 사용자의 저작
    책임으로 돌릴 수 없으므로(플랫폼 프리셋 4종과 달리 리뷰가 없다) 등록 자체를 거부한다
    (자동 주입은 안 한다 — 호출자가 실제로 무엇을 선언했는지와 서버에 저장된 내용이 갈리는
    "조용한 대필"을 만들지 않기 위해, PO 확定: "게이트가 닫는다").

    시드 4종(0245 마이그)과 동일 규약 — 그쪽은 플랫폼 저작이라 이 함수를 안 거치고, 이 함수는
    #2636의 등록 엔드포인트(org 커스텀 경로)에서만 호출된다."""
    validator_cls = jsonschema.validators.validator_for(payload_schema)
    validator_cls.check_schema(payload_schema)
    if payload_schema.get("additionalProperties") is not False:
        raise InvalidPayloadSchemaError(
            "payload_schema는 top-level 'additionalProperties: false'를 명시해야 합니다 — "
            "미선언 스키마는 모르는 필드를 조용히 통과시켜 등록을 거부합니다."
        )


def validate_event_payload(payload_schema: dict, payload: dict) -> None:
    """AC3: payload_schema(JSON Schema) 대조 검증 — 스키마가 additionalProperties: false를
    선언한 한도 내에서 모르는 필드도 거부된다(선언 안 한 스키마는 이 함수가 대신 강제하지
    않는다 — 스키마 저작 시점의 책임, 시드 4종은 전부 선언함)."""
    validator_cls = jsonschema.validators.validator_for(payload_schema)
    validator_cls.check_schema(payload_schema)
    validator = validator_cls(payload_schema)
    errors = [e.message for e in validator.iter_errors(payload)]
    if errors:
        raise InvalidEventPayloadError(
            f"payload가 payload_schema를 위반합니다({len(errors)}건)", errors=errors,
        )
