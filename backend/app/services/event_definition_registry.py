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

# story #2666 — _ORG_KEY_RE가 통째로 안 맞으면(m is None) "접두가 틀렸다"는 메시지 하나로
# 뭉뚱그렸는데, 실제로는 두 가지 다른 사고다: ①진짜 접두 모양 자체가 틀림(org.으로 안
# 시작하거나 세그먼트가 아예 없음) ②접두(org.{slug}.)는 맞는데 slug 이후 세그먼트에
# _ORG_KEY_RE가 허용 안 하는 문자(대표적으로 하이픈)가 섞임 — 이 둘을 가르지 않으면 ②
# 사용자에게 "접두를 고치라"는 «틀린 복구 행동»을 유도한다(#2664 라이브 실측, 세그먼트에
# 하이픈을 쓴 사용자가 실제로 그랬다). 아래 느슨한 구조 패턴(세그먼트 charset은 안 가리고
# 개수·마침표 구조만 봄)으로 "접두 자체는 맞았는가"만 먼저 가른다.
_ORG_KEY_STRUCTURE_RE = re.compile(r"^org\.([^.]+)\.([^.]+(?:\.[^.]+)*)$")
_SEGMENT_CHARSET_RE = re.compile(r"^[a-z0-9_]+$")

# routing.{escalation,broadcast}.kind="server_derived"의 닫힌 어휘(model.py docstring 참조,
# 페드루 판정 2026-08-13) — story #2633(해석기)이 실제로 이 target들을 member_id로 풀어야
# 하므로, 여기 없는 target을 server_derived로 등록하면 해석기가 절대 못 푸는 정의가 만들어진다
# — validate_event_routing이 등록 시점에 막는다(발행 시점에야 발견되는 것보다 이르게).
SERVER_DERIVED_TARGETS = frozenset({"none", "work_item_stakeholders", "goal_owner"})
# story #3312(M1→M3·마케팅자동화) — stage_metadata[stage].gate.approver의 닫힌 어휘.
# SERVER_DERIVED_TARGETS와 동형 설계: PO 확定(페드루, 2026-09-02) "approver는 역할 참조로만
# 선언(조직 상수 0) — 다른 org가 같은 정의를 apply해도 그 org 자신의 owner가 승인자". 실제
# member_id 해석은 recipe_gate_hooks.py(발행 시점)의 몫 — 그 모듈이 이 어휘 전체를 커버하는
# resolver를 갖는지 모듈 로드 시점에 assert로 고정한다(event_routing_resolver.py의
# _SERVER_DERIVED_RESOLVERS 완결성 assert와 동일 패턴).
APPROVER_ROLE_REFERENCES = frozenset({"org_owner"})
# story #3288(축2-ⓐ) — "recipe_role_binding": 사이클형 정의의 stage를 recipe_role_bindings
# 테이블(org/project 스코프 role→agent 바인딩)로 조회해 푸는 3번째 kind. payload_field처럼
# payload의 필드를 직접 읽지도, server_derived처럼 고정 닫힌 어휘로 파생하지도 않는다 —
# stage 자체가 payload에 있고(사이클형 정의 표준 필드) 그 stage로 org/project 스코프
# 바인딩 테이블을 찾는 3번째 해석 방식(event_routing_resolver.py가 실 구현).
_ROUTING_KINDS = frozenset({"payload_field", "server_derived", "recipe_role_binding"})


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


class InvalidBlockTemplateError(ValueError):
    """story #2637 §범위1: block_template이 제한 어휘 4종(header/text/fields/actions) 계약을
    위반 — 등록 시점 구조 게이트(치환 렌더링은 FE 몫, 여기는 구조만)."""


class InvalidStageMetadataError(ValueError):
    """story #2792(2790 P1) — stage_metadata 키가 payload_schema.properties.stage.enum의
    부분집합이 아님(페드루 판정 2026-08-19, 가드①). 오타 slug가 조용히 죽는 클래스
    (stage_metadata에는 있는데 실제 stage.enum엔 없어 영원히 안 읽히는 항목) 차단."""


class InvalidActionAuthError(ValueError):
    """story #2637 §범위3(미르코 발견 후속, 2026-08-14): action_auth 어휘(human_only·role)
    위반 — block_template.actions[].auth와 EventDefinition.action_auth 둘 다 이 함수 하나로
    검증(shape 정합·중복 규칙 0)."""


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
        loose = _ORG_KEY_STRUCTURE_RE.match(key)
        if loose is not None and loose.group(1) == org_slug:
            # 접두(org.{org_slug}.)는 정확히 맞다 — org_slug 자신은 이미 유효한 charset으로
            # 검증돼 있는 값이므로, 여기까지 왔는데 strict 정규식이 실패했다는 것은 slug
            # «이후» 세그먼트 중 하나가 허용 문자셋을 벗어났다는 뜻뿐이다(구조는 맞음).
            bad_segments = [
                seg for seg in loose.group(2).split(".") if not _SEGMENT_CHARSET_RE.match(seg)
            ]
            bad_segments_str = ", ".join(repr(s) for s in bad_segments)
            raise InvalidEventDefinitionKeyError(
                f"key의 세그먼트({bad_segments_str})가 허용 문자셋(소문자·숫자·밑줄 "
                f"[a-z0-9_]만, 하이픈·대문자 불가)을 벗어났습니다: {key!r}"
            )
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

    if kind == "recipe_role_binding":
        # story #3288 — member_id_field/target 둘 다 불요(payload의 stage로 org/project
        # 스코프 바인딩 테이블을 조회하는 게 해석 방식 전체). org 커스텀 정의도 등록 가능
        # (자기 org의 바인딩 테이블만 조회하므로 payload_field와 동형 위험도 — server_derived의
        # "서버가 모르는 파생 역할" 우려와 다른 클래스).
        if leg.get("member_id_field") or leg.get("target"):
            raise InvalidEventRoutingError(
                f"routing.{leg_name}.kind='recipe_role_binding'은 member_id_field/target을 "
                "가질 수 없습니다(stage 기반 바인딩 조회이므로 추가 파라미터 불요)."
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


_BLOCK_TYPES = frozenset({"header", "text", "fields", "actions"})
# story #2637 범위3: 액션 v1 = 이벤트 발행 버튼만(다른 액션 종류는 후속 — 웹훅 액션은 명시
# 제외 항목, doc event-registry-p2-block-template-detail §명시 제외).
_ACTION_KINDS = frozenset({"publish"})
_ACTION_AUTH_KEYS = frozenset({"human_only", "role"})


def validate_action_auth(auth: dict) -> None:
    """story #2637 §범위3 — action_auth v1 어휘(human_only·role) 화이트리스트. 두 소비처
    양쪽에서 쓴다: ①block_template.actions[].auth(등록 시점 구조 게이트, validate_block_
    template이 호출) ②EventDefinition.action_auth(발행 시점 실 집행 — publish_registry_
    event가 이 shape을 그대로 신뢰하고 human_only/role을 검사, 미르코 발견 후속: "정의에
    action_auth 있으면 서버가 거부"가 실제로 성립하려면 이 shape이 등록 시점에 이미 검증돼
    있어야 한다)."""
    if not isinstance(auth, dict) or not set(auth.keys()) <= _ACTION_AUTH_KEYS:
        raise InvalidActionAuthError(
            f"{sorted(_ACTION_AUTH_KEYS)} 키만 허용합니다(action_auth v1 어휘 — human_only·role)."
        )
    if "human_only" in auth and not isinstance(auth["human_only"], bool):
        raise InvalidActionAuthError("human_only은 bool이어야 합니다.")
    if "role" in auth and not (
        isinstance(auth["role"], list) and all(isinstance(r, str) for r in auth["role"])
    ):
        raise InvalidActionAuthError("role은 문자열 목록이어야 합니다.")


def validate_block_template(template: dict) -> None:
    """story #2637 §범위1: block_template v1 규격 — 제한 어휘 4종(header/text/fields/actions)
    밖의 type은 등록 거부. 렌더 시 {{payload.field}} 치환 자체는 렌더러(FE) 몫이라 여기서
    안 한다 — 이 함수는 등록 시점 **구조** 게이트만(어휘 4종·필수 필드·actions v1=publish만·
    action_auth 키 화이트리스트). 소비자(렌더러) 없이 스키마+테스트만 먼저 굳히는 #2632
    선례와 동형 — 실제 렌더링은 story #2637 FE 레인이 잇는다.

    doc event-registry-p2-block-template-detail 0-b 예시가 이 함수의 실 계약 근거."""
    if not isinstance(template, dict) or not isinstance(template.get("blocks"), list):
        raise InvalidBlockTemplateError("block_template은 {'blocks': [...]} 형태의 object여야 합니다.")
    blocks = template["blocks"]
    if not blocks:
        raise InvalidBlockTemplateError("block_template.blocks는 최소 1개 블록이 필요합니다.")
    for i, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise InvalidBlockTemplateError(f"blocks[{i}]은 object여야 합니다.")
        block_type = block.get("type")
        if block_type not in _BLOCK_TYPES:
            raise InvalidBlockTemplateError(
                f"blocks[{i}].type={block_type!r}은 제한 어휘 4종({sorted(_BLOCK_TYPES)}) 밖입니다."
            )
        if block_type in ("header", "text"):
            if not isinstance(block.get("text"), str) or not block["text"]:
                raise InvalidBlockTemplateError(f"blocks[{i}](type={block_type})는 비어있지 않은 text가 필요합니다.")
        elif block_type == "fields":
            fields = block.get("fields")
            if not isinstance(fields, list) or not fields:
                raise InvalidBlockTemplateError(f"blocks[{i}](type=fields)는 비어있지 않은 fields 목록이 필요합니다.")
            for j, f in enumerate(fields):
                if not isinstance(f, dict) or not isinstance(f.get("label"), str) or not isinstance(f.get("value"), str):
                    raise InvalidBlockTemplateError(
                        f"blocks[{i}].fields[{j}]는 {{'label': str, 'value': str}} 형태여야 합니다."
                    )
        elif block_type == "actions":
            actions = block.get("actions")
            if not isinstance(actions, list) or not actions:
                raise InvalidBlockTemplateError(f"blocks[{i}](type=actions)는 비어있지 않은 actions 목록이 필요합니다.")
            for j, a in enumerate(actions):
                if not isinstance(a, dict):
                    raise InvalidBlockTemplateError(f"blocks[{i}].actions[{j}]는 object여야 합니다.")
                if a.get("action") not in _ACTION_KINDS:
                    raise InvalidBlockTemplateError(
                        f"blocks[{i}].actions[{j}].action={a.get('action')!r}은 v1 어휘"
                        f"({sorted(_ACTION_KINDS)}) 밖입니다 — 웹훅 액션 등은 후속(명시 제외)."
                    )
                if not isinstance(a.get("label"), str) or not a["label"]:
                    raise InvalidBlockTemplateError(f"blocks[{i}].actions[{j}]는 비어있지 않은 label이 필요합니다.")
                if not isinstance(a.get("definition_key"), str) or not a["definition_key"]:
                    raise InvalidBlockTemplateError(
                        f"blocks[{i}].actions[{j}]는 발행할 definition_key(str)가 필요합니다."
                    )
                auth = a.get("auth")
                if auth is not None:
                    try:
                        validate_action_auth(auth)
                    except InvalidActionAuthError as e:
                        raise InvalidBlockTemplateError(f"blocks[{i}].actions[{j}].auth: {e}") from e


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


def validate_stage_metadata(payload_schema: dict, stage_metadata: dict) -> None:
    """story #2792(2790 P1, 페드루 판정 2026-08-19 가드①) — stage_metadata의 키 집합이
    `payload_schema.properties.stage.enum`의 부분집합인지 강제. 이 검증이 없으면 stage_metadata
    에 오타 slug(예: enum엔 "in_review"인데 메타는 "inreview")를 넣어도 저장은 되고, 그
    항목은 정의상 도달 불가능한 채로 영원히 조용히 죽는다(get_workflow_guide 등 소비처가
    실제 stage 값으로만 조회하므로) — 경계를 넘는 이름이 통과하는 클래스, 등록/수정 시점에
    막는다.

    stage_metadata가 빈 dict({})면 항상 통과(사이클형이 아닌 정의는 이 슬롯을 안 씀 — 신호형/
    측정형 정의도 이 함수를 걸어도 안전). payload_schema에 stage enum 자체가 없는데
    stage_metadata가 비어있지 않으면(가리킬 enum이 없음) 거부."""
    if not stage_metadata:
        return
    stage_prop = (payload_schema.get("properties") or {}).get("stage") or {}
    enum = stage_prop.get("enum")
    if not isinstance(enum, list):
        raise InvalidStageMetadataError(
            "stage_metadata가 있으려면 payload_schema.properties.stage.enum이 먼저 선언돼야 합니다."
        )
    valid = set(enum)
    unknown = sorted(set(stage_metadata.keys()) - valid)
    if unknown:
        raise InvalidStageMetadataError(
            f"stage_metadata에 payload_schema.properties.stage.enum에 없는 키가 있습니다: {unknown} "
            f"(허용된 stage: {sorted(valid)})"
        )
    # ⛔실버그(카디르군 QA, 2026-08-19 — story #2793 재현) — 키⊆enum만 보고 **값의 모양**은
    # 안 봤다. malformed 값(dict가 아니거나 role/action이 없거나 문자열이 아님)이 등록을
    # 통과하면 소비처(온보딩 가이드 렌더러)가 `meta.get('role')`에서 죽는데, 그 렌더러가
    # org 전 정의를 한 루프로 돌아 **커스텀 1건 오염이 그 org 가이드 전체를 죽이는** 폭발
    # 반경이었다 — 쓰기 시점(여기)에서 값 모양 자체를 강제해 근본 차단.
    for slug, meta in stage_metadata.items():
        if not isinstance(meta, dict):
            raise InvalidStageMetadataError(
                f"stage_metadata[{slug!r}]는 object({{role, action}})여야 합니다 — {type(meta).__name__} 아님."
            )
        for field in ("role", "action"):
            if not isinstance(meta.get(field), str) or not meta[field]:
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].{field}는 비어있지 않은 문자열이어야 합니다."
                )
        # story #3312(M1→M3·마케팅자동화, PO 확定 2026-09-02②) — gate는 선택 필드지만, «막지
        # 않는다고 검증 안 하면 오타가 조용히 무시»되는 자리라(recipe_gate_hooks.py가 gate
        # 키가 없으면 그냥 no-op하므로, 오타 난 gate 선언은 "게이트가 영원히 안 생기는" 채로
        # 조용히 죽는다 — story #2793류 실버그와 동일 클래스) 있으면 shape을 명시 강제한다.
        if "gate" in meta:
            gate = meta["gate"]
            if not isinstance(gate, dict):
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].gate는 object({{type, approver}})여야 합니다 — "
                    f"{type(gate).__name__} 아님."
                )
            if not isinstance(gate.get("type"), str) or not gate["type"]:
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].gate.type은 비어있지 않은 문자열이어야 합니다."
                )
            if gate.get("approver") not in APPROVER_ROLE_REFERENCES:
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].gate.approver는 {sorted(APPROVER_ROLE_REFERENCES)} "
                    f"중 하나여야 합니다 — {gate.get('approver')!r}은 닫힌 어휘 밖입니다."
                )
        # story #3317 PR B(마케팅자동화·레시피 결함, PO 확定 2026-09-02) — capability도 gate와
        # 동형: 선택 필드지만 있으면 shape 강제(오타 방치 금지). ⚠️kind는 gate.approver와
        # 달리 **닫힌 어휘가 아니다** — PO 명시("제품은 능력, 규칙/값은 조직" 그라운드룰):
        # 'publish' 외 'collect'/'measure'/'read' 등 조직이 뜻을 정하는 값이라 서버는 "비어
        # 있지 않은 문자열"만 강제하고 뜻은 안 따진다. connector_key는 선택(있으면 그 커넥터
        # 하나를 지정, 없으면 apply 검증이 org_connector_registry.kinds로 느슨 매칭한다 —
        # services/connector_registry.py::find_org_connectors_by_kind 참조).
        if "capability" in meta:
            capability = meta["capability"]
            if not isinstance(capability, dict):
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].capability는 object({{kind, connector_key?}})여야 "
                    f"합니다 — {type(capability).__name__} 아님."
                )
            if not isinstance(capability.get("kind"), str) or not capability["kind"]:
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].capability.kind는 비어있지 않은 문자열이어야 합니다."
                )
            if "connector_key" in capability and (
                not isinstance(capability["connector_key"], str) or not capability["connector_key"]
            ):
                raise InvalidStageMetadataError(
                    f"stage_metadata[{slug!r}].capability.connector_key는 있으면 비어있지 않은 "
                    f"문자열이어야 합니다."
                )


def validate_event_payload(payload_schema: dict, payload: dict) -> None:
    """AC3: payload_schema(JSON Schema) 대조 검증 — 스키마가 additionalProperties: false를
    선언한 한도 내에서 모르는 필드도 거부된다(선언 안 한 스키마는 이 함수가 대신 강제하지
    않는다 — 스키마 저작 시점의 책임, 시드 4종은 전부 선언함).

    story #2675: format_checker 없이 jsonschema Validator를 만들면 `"format": "uuid"` 선언이
    있어도 «검증되지 않고 조용히 통과»한다(jsonschema의 기본 동작 — format은 검증기를 명시로
    줘야 집행된다, 실측 확認). 이 코드베이스 event_definitions는 work_item_id/goal_id/
    notify_member_id 등 거의 모든 payload UUID 필드에 format:uuid를 선언하는데, 그게 안 먹혀서
    "pr-3084" 같은 비-UUID 문자열이 여기를 무사통과해 다운스트림 uuid.UUID() 파싱에서 처리
    안 된 ValueError로 500을 냈다(카디르 2026-08-15 실측, 승격 PR류 gate_cycle 발행). FormatChecker()를
    명시로 넘겨 이 스키마가 이미 선언한 계약을 실제로 집행 — 새 검증을 발명하는 게 아니라
    기존 선언을 마침내 작동시키는 것."""
    validator_cls = jsonschema.validators.validator_for(payload_schema)
    validator_cls.check_schema(payload_schema)
    validator = validator_cls(payload_schema, format_checker=jsonschema.FormatChecker())
    errors = [e.message for e in validator.iter_errors(payload)]
    if errors:
        raise InvalidEventPayloadError(
            f"payload가 payload_schema를 위반합니다({len(errors)}건)", errors=errors,
        )
