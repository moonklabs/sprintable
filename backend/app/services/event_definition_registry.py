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


class InvalidEventDefinitionKeyError(ValueError):
    """key 네임스페이스 규칙 위반 — AC2."""


class InvalidEventPayloadError(ValueError):
    """payload가 payload_schema를 위반(모르는 필드 포함) — AC3."""

    def __init__(self, message: str, *, errors: list[str]) -> None:
        super().__init__(message)
        self.errors = errors


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
