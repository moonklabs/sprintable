"""story 4646 — 첨부 읽기 서비스의 판단 순서를 가짜 DB · 가짜 저장소로 고정한다(realdb 시험은 CI 몫)."""
import asyncio
import io
import uuid

import pytest
from fastapi import HTTPException
from PIL import Image

import app.services.chat_attachment_service as svc
from app.services.chat_attachment_read import MAX_IMAGE_READ_BYTES

ORG = uuid.uuid4()
PROJ = uuid.uuid4()
CONV = uuid.uuid4()
MSG = uuid.uuid4()
BUCKET = "sprintable-memo-attachments"


class _Res:
    def __init__(self, v):
        self.v = v

    def scalar_one_or_none(self):
        return self.v


class _DB:
    def __init__(self, msg):
        self.msg = msg

    async def execute(self, _stmt):
        return _Res(self.msg)


class _Msg:
    def __init__(self, attachments, deleted_at=None):
        self.id, self.conversation_id = MSG, CONV
        self.attachments, self.deleted_at = attachments, deleted_at


class _Storage:
    def __init__(self, size, raw=b""):
        self.size, self.raw = size, raw
        self.downloads = 0

    async def head_object(self, container, path):
        return self.size

    async def download_object(self, container, path):
        self.downloads += 1
        return self.raw


def _url(name):
    return f"https://storage.googleapis.com/{BUCKET}/chat/{PROJ}/{CONV}/{name}"


def _jpeg():
    b = io.BytesIO()
    Image.new("RGB", (3000, 4000), (9, 9, 9)).save(b, format="JPEG", quality=60)
    return b.getvalue()


@pytest.fixture
def allow(monkeypatch):
    async def ok(conversation_id, db, auth, org_id):
        return PROJ
    monkeypatch.setattr(svc, "_authorize_message_read", ok)


def _run(monkeypatch, msg, storage, index=0):
    monkeypatch.setattr(svc, "get_storage_provider", lambda: storage)
    return asyncio.run(svc.read_message_attachment(_DB(msg), None, ORG, CONV, MSG, index))


def test_a_phone_photo_is_read_and_downscaled(allow, monkeypatch):
    st = _Storage(8 * 1024 * 1024, _jpeg())
    r = _run(monkeypatch, _Msg([{"name": "p.jpg", "content_type": "image/jpeg", "url": _url("p.jpg")}]), st)
    assert r.kind == "image" and st.downloads == 1 and max(r.width, r.height) <= 1568


def test_over_the_read_limit_is_meta_only_and_never_downloaded(allow, monkeypatch):
    st = _Storage(MAX_IMAGE_READ_BYTES + 1)
    r = _run(monkeypatch, _Msg([{"name": "p.jpg", "content_type": "image/jpeg", "url": _url("p.jpg")}]), st)
    assert r.kind == "meta" and r.reason == "too_large" and st.downloads == 0


def test_unknown_size_is_meta_only_and_never_downloaded(allow, monkeypatch):
    st = _Storage(None)
    r = _run(monkeypatch, _Msg([{"name": "p.jpg", "content_type": "image/jpeg", "url": _url("p.jpg")}]), st)
    assert r.kind == "meta" and r.reason == "unknown_size" and st.downloads == 0


def test_tombstone_message_is_not_found(allow, monkeypatch):
    from datetime import datetime, timezone
    st = _Storage(10)
    with pytest.raises(HTTPException) as e:
        _run(monkeypatch, _Msg([{"name": "a.txt", "url": _url("a.txt")}], deleted_at=datetime.now(timezone.utc)), st)
    assert e.value.status_code == 404 and st.downloads == 0


def test_index_out_of_range_is_the_same_not_found(allow, monkeypatch):
    st = _Storage(10)
    with pytest.raises(HTTPException) as e:
        _run(monkeypatch, _Msg([{"name": "a.txt", "url": _url("a.txt")}]), st, index=3)
    assert e.value.status_code == 404 and e.value.detail == "Attachment not found"


def test_key_outside_this_conversation_is_not_read(allow, monkeypatch):
    other = f"https://storage.googleapis.com/{BUCKET}/chat/{PROJ}/{uuid.uuid4()}/x.txt"  # another conversation's key
    st = _Storage(10)
    with pytest.raises(HTTPException) as e:
        _run(monkeypatch, _Msg([{"name": "x.txt", "url": other}]), st)
    assert e.value.status_code == 404 and st.downloads == 0


def test_text_within_limit_is_returned_as_text(allow, monkeypatch):
    st = _Storage(5, b"hello")
    r = _run(monkeypatch, _Msg([{"name": "n.txt", "content_type": "text/plain", "url": _url("n.txt")}]), st)
    assert r.kind == "text" and r.text == "hello"


def test_unknown_extension_is_meta_only(allow, monkeypatch):
    st = _Storage(5, b"MZ")
    r = _run(monkeypatch, _Msg([{"name": "a.exe", "content_type": "application/octet-stream", "url": _url("a.exe")}]), st)
    assert r.kind == "meta" and r.reason == "unsupported" and st.downloads == 0


def test_message_of_another_conversation_is_not_found(allow, monkeypatch):
    # (e) 내가 참가한 대화 A의 URL + 대화 B의 message_id → 404: 조회가 id AND conversation_id로 맞아야 한다
    st = _Storage(10)
    monkeypatch.setattr(svc, "get_storage_provider", lambda: st)
    with pytest.raises(HTTPException) as e:
        asyncio.run(svc.read_message_attachment(_DB(None), None, ORG, CONV, MSG, 0))
    assert e.value.status_code == 404 and st.downloads == 0
