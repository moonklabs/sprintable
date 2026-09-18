"""story #3379(에이전트 온보딩·오도, 페드루 PO 確定 2026-09-07) — `_message_signals_
doc_still_being_revised`(순수함수, content → bool) 표본 테스트. DB 접근 0 — realdb 억제
3종 통합 검증은 test_3379_doc_nudge_default_silence.py(destructive_schema) 몫이라 이
파일은 섞지 않는다(destructive_schema shard가 파일 하나=순수 destructive 전제로 돌아
비-destructive 테스트가 섞이면 conftest 가드가 collection 자체를 차단한다 — story
#3186/8236bbc3)."""
from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "content",
    [
        "이거 좀 수정해야 할 것 같아요",
        "이 부분 정정 부탁드리는",
        "v2로 교체하려고 논의 중이에요",
        "이 규약은 이제 폐기 대상 아닌가요",
        "여기 고쳐야 할 곳이 있어요",
        "숫자를 좀 바꿔야 할 것 같은데",
        "이거 업데이트 필요해 보여요",
        "내용 갱신이 먼저일 것 같아요",
    ],
)
def test_content_signal_detects_revision_words(content):
    from app.services.approval_delivery import _message_signals_doc_still_being_revised

    assert _message_signals_doc_still_being_revised(content) is True


def test_content_signal_negative_on_neutral_mention():
    from app.services.approval_delivery import _message_signals_doc_still_being_revised

    assert _message_signals_doc_still_being_revised("이 문서 확인 부탁드립니다") is False
    assert _message_signals_doc_still_being_revised("") is False
    assert _message_signals_doc_still_being_revised(None) is False


def test_content_signal_mutation_empty_word_list_fails(monkeypatch):
    """뮤테이션 — 신호 낱말 목록을 비우면 «수정해야 할 것 같아요» 같은 명백한 신호도
    놓친다(RED 재현, 검출 자체가 실제로 낱말 목록에 의존함을 증명)."""
    import app.services.approval_delivery as mod

    monkeypatch.setattr(mod, "_DOC_REVISION_SIGNAL_WORDS", ())
    assert mod._message_signals_doc_still_being_revised("이거 좀 수정해야 할 것 같아요") is False
