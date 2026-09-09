"""story #3745(UI 점검 B·D2 잔존) — 이벤트 정의 name 필수화.

옛 "이름 없는 정의"(name=""·None)가 화면에 코드 키가 그대로 서는 결함의 발생 경로였다
(#4082 D2는 FE 렌더만 고쳤다 — 데이터가 생기는 경로 자체는 그대로였다). 이 파일은 그
경로를 막는 Pydantic 계약만 pin(순수 검증, DB 불요 — destructive_schema 마커 밖).

계약: POST(CreateEventDefinitionRequest)는 name 필수(누락 자체가 422) + 공백뿐인 값도
거부. PATCH(UpdateEventDefinitionRequest)는 name 생략 허용(=이 필드는 안 건드림) — 다만
값을 실어 보내면(빈 문자열·공백뿐인 값 포함) 똑같이 거부한다("이름을 지운다"는 요청은
성립하지 않는다).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.routers.events import CreateEventDefinitionRequest, UpdateEventDefinitionRequest

_VALID_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"widget_id": {"type": "string"}}, "required": ["widget_id"],
}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


def _create_kwargs(**overrides):
    kwargs = {"key": "org.acme.widget.made", "name": "위젯 제작 완료", "payload_schema": _VALID_SCHEMA, "routing": _NONE_ROUTING}
    kwargs.update(overrides)
    return kwargs


class TestCreateEventDefinitionRequestNameRequired:
    def test_valid_name_accepted(self):
        body = CreateEventDefinitionRequest(**_create_kwargs())
        assert body.name == "위젯 제작 완료"

    # ⭐되돌리면 RED① — name 필드 자체를 누락하면(POST body에 name이 아예 없으면) 422.
    def test_omitted_name_rejected(self):
        kwargs = _create_kwargs()
        del kwargs["name"]
        with pytest.raises(ValidationError) as ei:
            CreateEventDefinitionRequest(**kwargs)
        assert any(e["loc"] == ("name",) for e in ei.value.errors())

    def test_empty_string_name_rejected(self):
        with pytest.raises(ValidationError) as ei:
            CreateEventDefinitionRequest(**_create_kwargs(name=""))
        assert any(e["loc"] == ("name",) for e in ei.value.errors())

    # ⭐되돌리면 RED② — 공백뿐인 값(strip하면 빈 문자열)도 거부(빈 문자열과 같은 결함 클래스).
    def test_whitespace_only_name_rejected(self):
        with pytest.raises(ValidationError) as ei:
            CreateEventDefinitionRequest(**_create_kwargs(name="   "))
        assert any(e["loc"] == ("name",) for e in ei.value.errors())

    # ⭐되돌리면 RED④ — name===key(org 커스텀이 코드 키를 그대로 이름 자리에 등록한 옛
    # 데이터와 동형 입력)도 거부. 빈 이름과 같은 결함 클래스(화면 제목 자리에 코드 키가
    # 그대로 서게 만든다) — 페드루 PO 라이브 실측(10:15Z) 4건이 이 갈래.
    def test_name_equals_key_rejected(self):
        with pytest.raises(ValidationError) as ei:
            CreateEventDefinitionRequest(**_create_kwargs(key="org.acme.widget.made", name="org.acme.widget.made"))
        assert any(e["loc"] == ("name",) for e in ei.value.errors())

    # name===key 검증이 strip 前 원문이 아니라 strip 後 값으로 도는지(앞뒤 공백만 다른
    # name="  org.acme.widget.made  "도 사실상 key와 같다) 확認.
    def test_name_equals_key_with_surrounding_whitespace_rejected(self):
        with pytest.raises(ValidationError) as ei:
            CreateEventDefinitionRequest(**_create_kwargs(key="org.acme.widget.made", name="  org.acme.widget.made  "))
        assert any(e["loc"] == ("name",) for e in ei.value.errors())


class TestUpdateEventDefinitionRequestNameOptionalButNotBlank:
    # ⭐되돌리면 RED③ — PATCH는 name 생략(None)이 "이 필드는 안 건드림"이라 유효하다.
    def test_omitted_name_is_valid_none(self):
        body = UpdateEventDefinitionRequest(enabled=False)
        assert body.name is None

    def test_valid_name_accepted(self):
        body = UpdateEventDefinitionRequest(name="새 이름")
        assert body.name == "새 이름"

    def test_empty_string_name_rejected(self):
        with pytest.raises(ValidationError) as ei:
            UpdateEventDefinitionRequest(name="")
        assert any(e["loc"] == ("name",) for e in ei.value.errors())

    def test_whitespace_only_name_rejected(self):
        with pytest.raises(ValidationError) as ei:
            UpdateEventDefinitionRequest(name="  ")
        assert any(e["loc"] == ("name",) for e in ei.value.errors())
