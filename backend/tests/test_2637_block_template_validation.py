"""story #2637 §범위1 — validate_block_template(등록 시점 구조 게이트).

doc event-registry-p2-block-template-detail 0-b 예시가 이 함수의 실 계약 근거. 어휘 4종
(header/text/fields/actions) 밖 거부 + actions v1=publish만 + action_auth 키 화이트리스트
(human_only·role)까지 검증. 렌더링({{payload.field}} 치환)은 FE 몫이라 여기선 안 다룬다.
"""
from __future__ import annotations

import pytest

_VALID_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "작업 상태 변경"},
        {"type": "text", "text": "**{{payload.work_item_type}}** `{{payload.from_status}}` → `{{payload.to_status}}`"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_id}}"},
            {"label": "메모", "value": "{{payload.note}}"},
        ]},
        {"type": "actions", "actions": [
            {"label": "확認", "action": "publish", "definition_key": "preset.work.status_changed",
             "auth": {"human_only": True}},
        ]},
    ],
}


def test_accepts_doc_0b_reference_example():
    from app.services.event_definition_registry import validate_block_template

    validate_block_template(_VALID_TEMPLATE)  # no raise


def test_rejects_non_dict_or_missing_blocks():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"not_blocks": []})
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": "not-a-list"})


def test_rejects_empty_blocks():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": []})


def test_rejects_unknown_block_type():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": [{"type": "image", "url": "x"}]})


@pytest.mark.parametrize("block_type", ["header", "text"])
def test_rejects_header_or_text_without_text_field(block_type):
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": [{"type": block_type}]})
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": [{"type": block_type, "text": ""}]})


def test_rejects_fields_without_label_or_value():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": [{"type": "fields", "fields": [{"label": "x"}]}]})
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template({"blocks": [{"type": "fields", "fields": []}]})


def test_rejects_action_kind_outside_v1_vocabulary():
    """액션 v1 = 이벤트 발행 버튼만 — 웹훅 액션 등은 명시 제외."""
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [
        {"label": "x", "action": "webhook", "definition_key": "k"},
    ]}]}
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template(template)


def test_rejects_action_without_definition_key():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [{"label": "x", "action": "publish"}]}]}
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template(template)


def test_accepts_action_without_auth():
    """auth는 optional — 없으면 통과(v1 human_only/role은 있을 때만 검증)."""
    from app.services.event_definition_registry import validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [
        {"label": "x", "action": "publish", "definition_key": "k"},
    ]}]}
    validate_block_template(template)  # no raise


def test_rejects_auth_with_unknown_key():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [
        {"label": "x", "action": "publish", "definition_key": "k", "auth": {"webhook_secret": "x"}},
    ]}]}
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template(template)


def test_rejects_human_only_wrong_type():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [
        {"label": "x", "action": "publish", "definition_key": "k", "auth": {"human_only": "yes"}},
    ]}]}
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template(template)


def test_rejects_role_wrong_type():
    from app.services.event_definition_registry import InvalidBlockTemplateError, validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [
        {"label": "x", "action": "publish", "definition_key": "k", "auth": {"role": "owner"}},
    ]}]}
    with pytest.raises(InvalidBlockTemplateError):
        validate_block_template(template)


def test_accepts_role_list():
    from app.services.event_definition_registry import validate_block_template

    template = {"blocks": [{"type": "actions", "actions": [
        {"label": "x", "action": "publish", "definition_key": "k", "auth": {"role": ["owner", "admin"]}},
    ]}]}
    validate_block_template(template)  # no raise
