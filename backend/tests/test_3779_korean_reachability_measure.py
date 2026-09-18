"""story #3779(2층) — measure_korean_user_string_reachability.py의 6종 휴리스틱 분류
로직을 고정한다. 이 스크립트는 CI 게이트가 아니라 목록 산출물(카드 明示)이지만, 분류
로직 자체가 조용히 깨지면 그 산출물이 틀린 숫자를 낼 수 있어 회귀가드를 둔다.

⛔영구 표본 — 카드에 페드루 PO가 직접 지목한 3건(channel_posts.py:72·gates.py:131-132·
chat_command_catalog.py:183,186)을 합성 소스로 재현해 고정한다. 실물 파일이 나중에
바뀌어도(리팩터 등) 이 표본은 분류 로직 자체를 계속 검증한다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from measure_korean_user_string_reachability import scan_reachable  # noqa: E402


def test_http_exception_detail_is_reachable():
    source = '''
from fastapi import HTTPException

def foo():
    raise HTTPException(status_code=404, detail="찾을 수 없습니다")
'''
    hits = scan_reachable(source, "app/routers/fixture.py")
    assert len(hits) == 1
    assert hits[0].reason == "http_detail"
    assert hits[0].text == "찾을 수 없습니다"


def test_chat_command_outcome_is_reachable():
    """카드 표본 — chat_command_catalog.py:183,186 형."""
    source = '''
def build():
    return CommandOutcome("invalid_args", "'/done' 사용법: /done <스토리#>", None)
'''
    hits = scan_reachable(source, "app/services/chat_command_catalog.py")
    assert len(hits) == 1
    assert hits[0].reason == "chat_command"


def test_custom_exception_super_init_is_reachable():
    """카드 표본 — channel_posts.py:72(ChannelConnectionNotActiveError)."""
    source = '''
class ChannelConnectionNotActiveError(ValueError):
    def __init__(self, *, connection_id):
        self.connection_id = connection_id
        super().__init__(f"연결을 찾을 수 없거나 비활성 상태입니다: {connection_id}")
'''
    hits = scan_reachable(source, "app/services/channel_posts.py")
    assert len(hits) == 1
    assert hits[0].reason == "custom_exception"


def test_pydantic_field_validator_raise_is_reachable():
    """카드 표본 — gates.py:131-132(@field_validator 안 raise ValueError)."""
    source = '''
from pydantic import BaseModel, field_validator

class GateTransition(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def validate_status(cls, v):
        if v not in {"approved", "rejected"}:
            raise ValueError(f"generic transition 은 허용되지 않습니다: {v}")
        return v
'''
    hits = scan_reachable(source, "app/routers/fixture.py")
    assert len(hits) == 1
    assert hits[0].reason == "pydantic_validator"


def test_plain_raise_value_error_outside_validator_is_not_flagged():
    """검증자 데코레이터가 없는 일반 raise ValueError는 6종 밖 — 과다 오탐 방지."""
    source = '''
def foo(x):
    if not x:
        raise ValueError("내부 전용 사유")
'''
    hits = scan_reachable(source, "app/services/fixture.py")
    assert hits == []


def test_response_field_dict_key_is_reachable():
    source = '''
def build_response():
    return {"message": "저장되었습니다"}
'''
    hits = scan_reachable(source, "app/services/fixture.py")
    assert len(hits) == 1
    assert hits[0].reason == "response_field"


def test_response_field_keyword_arg_is_reachable():
    source = '''
def build_response():
    return SomeSchema(detail="저장되었습니다")
'''
    hits = scan_reachable(source, "app/services/fixture.py")
    assert len(hits) == 1
    assert hits[0].reason == "response_field"


def test_non_human_field_name_dict_key_is_not_flagged():
    """HUMAN_FIELD_NAMES 밖 키 이름은 6종 밖(과다 오탐 방지 — 한계 ㉠에 명시된 것)."""
    source = '''
def build_response():
    return {"internal_note": "내부 메모용 한글"}
'''
    hits = scan_reachable(source, "app/services/fixture.py")
    assert hits == []


def test_email_copy_file_counts_whole_file():
    source = '''
"""발송 메일 카피."""

WELCOME_SUBJECT = "환영합니다"
WELCOME_BODY = "가입을 축하합니다"
INTERNAL_CONSTANT = "무관한 한글 상수도"
'''
    hits = scan_reachable(source, "app/services/email_copy.py")
    assert len(hits) == 3
    assert all(h.reason == "email_copy" for h in hits)


def test_english_only_string_is_never_flagged():
    source = '''
def foo():
    raise HTTPException(status_code=404, detail="not found")
'''
    assert scan_reachable(source, "app/routers/fixture.py") == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
