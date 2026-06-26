"""E-STORAGE-SSOT S1 — 첨부 url validator 회귀(까심 cross-model blocker).

provider 추상으로 local/s3 업로드가 canonical bare path를 반환한다. 기존 https-only validator는
default=local 에서 채팅/스토리 첨부 저장을 422로 깨뜨렸다 → bare path + legacy https 둘 다 허용하되
외부 스킴·traversal 은 거부함을 검증한다.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.routers.conversations import MessageAttachment
from app.schemas.attachment import validate_attachment_url
from app.schemas.story import StoryAttachment

_GCS = "https://storage.googleapis.com/sprintable-memo-attachments/chat/p/c/u-a.png"
_BARE_CHAT = "chat/proj/conv/uuid-a.png"
_BARE_STORY = "story/proj/story-1/uuid-a.png"


@pytest.mark.parametrize("good", [_GCS, _BARE_CHAT, _BARE_STORY, "story/p/s/x.pdf"])
def test_validator_accepts_https_and_bare_path(good):
    assert validate_attachment_url(good) == good


@pytest.mark.parametrize(
    "bad",
    [
        "http://insecure/a.png",          # 비-https 스킴
        "gs://bucket/a.png",              # 외부 스킴
        "file:///etc/passwd",             # 외부 스킴
        "/abs/path.png",                  # 절대경로
        "../../etc/passwd",               # traversal
        "chat/../../../etc/passwd",       # traversal 세그먼트
        "   ",                            # 공백
    ],
)
def test_validator_rejects_external_and_traversal(bad):
    with pytest.raises(ValueError):
        validate_attachment_url(bad)


def test_message_attachment_accepts_bare_path_regression():
    # default=local provider 의 bare path 가 message 저장 schema 를 통과해야 함(422 회귀 방지).
    a = MessageAttachment(url=_BARE_CHAT, name="a.png", content_type="image/png", size=10)
    assert a.url == _BARE_CHAT
    # legacy GCS https 도 계속 통과(무회귀).
    assert MessageAttachment(url=_GCS, name="a.png", content_type="image/png", size=10).url == _GCS


def test_message_attachment_still_rejects_external():
    with pytest.raises(ValidationError):
        MessageAttachment(url="http://x/a", name="a", content_type="image/png", size=1)


def test_story_attachment_accepts_bare_path_regression():
    a = StoryAttachment(url=_BARE_STORY, name="a.png", content_type="image/png", size=10)
    assert a.url == _BARE_STORY
    assert StoryAttachment(url=_GCS, name="a.png", content_type="image/png", size=10).url == _GCS


def test_story_attachment_still_rejects_external():
    with pytest.raises(ValidationError):
        StoryAttachment(url="gs://x/a", name="a", content_type="image/png", size=1)
