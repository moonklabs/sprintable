"""story 4856 — a picture an agent attaches through the MCP is judged by its bytes, not only by the type the agent declared.

Measured on 2026-11-07 (dev, the picture the same 115 bytes each time): declared `image/png` → stored `image/png`, size measured 24×16; declared `application/octet-stream` → stored as
declared, size `null`. The chat bubble draws a thumbnail only for `image/*` and a file card for everything else, so a picture whose type the agent did not know (or got wrong) opened as a
file, not as a preview. The upload handlers (chat · story · doc) now read the first bytes: a PNG · JPEG · GIF · WebP is stored, measured and reported as what it is; anything else keeps
the declared type; SVG is not sniffed (it can carry script).

What these tests hold:
  · the sniff reads exactly the four picture types (and WebP only inside a RIFF container), and nothing else;
  · the resolved type is the bytes' type for a picture (generic, near-miss and wrong declarations alike) and the declared type for everything else;
  · the chat upload handler, end to end on a real database and a real storage: the response, the stored object's content type and the measured size all follow the bytes;
  · the story and doc upload handlers use the same resolver for what they store and report (the three used to copy `body.content_type`).
"""
from __future__ import annotations

import base64
import inspect
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.services import mcp_attachment_upload as m

# real pictures, 24×16 (made once with Pillow; kept as bytes so the test needs no image library)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAOklEQVR42mN0y9vHQA3AxEAlQDWDWOCsnRMdydDvnr8f3SBkUSIBst2DL4xGDRqQBEl2moQA"
    "xuGbaQFZmwqUf7XaawAAAABJRU5ErkJggg=="
)
WEBP = base64.b64decode(
    "UklGRmQAAABXRUJQVlA4IFgAAADwAwCdASoYABAAPzmGulQvKSWjMAgB4CcJaACsACHfGd2xQZHayV8AAPYV5MryTKaUUx+LPKx5T8secCStWboIw1qgChAi"
    "4JUfi8f/P4zTLhiZDCYk0BgA"
)
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+AjIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/"
    "2wBDASstLTw1PHZBQXb4pYyl+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj/wAARCAAQABgDASIAAhEBAxEB/8QA"
    "FQABAQAAAAAAAAAAAAAAAAAAAAH/xAAeEAACAgICAwAAAAAAAAAAAAABAgARA2EhMVKS0f/EABcBAAMBAAAAAAAAAAAAAAAAAAABAwT/xAAVEQEBAAAAAAAA"
    "AAAAAAAAAAAAAf/aAAwDAQACEQMRAD8AAIMQZgxJYjhq6rW5Lw+D+4+SgocQViwIYnhb7repKw+b+g+zQmpCHEWUMCGA5a+71qIJQYiqliSwPK11e9xCE//Z"
)
GIF = b"GIF89a" + bytes(10)
PDF = b"%PDF-1.4\n%fake\n"
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>'


# ───────────────────────────── the sniff ─────────────────────────────

@pytest.mark.parametrize("data, expected", [
    (PNG, "image/png"),
    (JPEG, "image/jpeg"),
    (GIF, "image/gif"),
    (b"GIF87a" + bytes(4), "image/gif"),
    (WEBP, "image/webp"),
])
def test_the_four_picture_types_are_read_from_the_first_bytes(data, expected):
    assert m.sniff_image_content_type(data) == expected


@pytest.mark.parametrize("data", [
    b"",
    b"\x89PNG",                               # a truncated signature
    b"RIFF" + bytes(4) + b"WAVE" + bytes(8),  # RIFF, but a sound
    b"RIFF" + bytes(4) + b"AVI " + bytes(8),  # RIFF, but a video
    PDF,
    SVG,                                      # not sniffed on purpose (script)
    b"just text",
    b"\xff\xd8",                              # two bytes of a JPEG signature
])
def test_everything_else_is_not_a_picture(data):
    assert m.sniff_image_content_type(data) is None


@pytest.mark.parametrize("declared", ["application/octet-stream", "image/jpg", "text/plain", "image/gif", "IMAGE/PNG", "image/png"])
def test_a_picture_is_the_type_its_bytes_say_whatever_was_declared(declared):
    assert m.resolve_attachment_content_type(declared, PNG) == "image/png"


@pytest.mark.parametrize("declared, data", [
    ("application/pdf", PDF),
    ("image/svg+xml", SVG),
    ("text/plain", b"hello"),
    ("application/octet-stream", b"\x00\x01\x02"),
    ("image/png", b"not really a picture"),   # declared a picture, bytes are not one: left as declared (nothing to correct it to)
])
def test_anything_that_is_not_a_picture_keeps_the_declared_type(declared, data):
    assert m.resolve_attachment_content_type(declared, data) == declared


# ───────────────────────────── story and doc use the same resolver ─────────────────────────────

@pytest.mark.parametrize("module, handler", [
    ("app.routers.stories", "upload_story_attachment"),
    ("app.routers.docs", "upload_doc_attachment"),
    ("app.routers.conversations", "upload_conversation_attachment"),
])
def test_each_upload_handler_stores_and_reports_the_resolved_type(module, handler):
    import importlib

    src = inspect.getsource(getattr(importlib.import_module(module), handler))
    assert "resolve_attachment_content_type(body.content_type, data)" in src
    # the declared value is read exactly once — by the resolver; it is no longer what is stored, registered, measured or reported anywhere in the handler
    assert src.count("body.content_type") == 1


# ───────────────────────────── the chat handler, end to end ─────────────────────────────

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
needs_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab560000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab560000-0000-0000-0000-000000000002")
CONV = uuid.UUID("ab560000-0000-0000-0000-000000000003")
AGENT = uuid.UUID("ab560000-0000-0000-0000-0000000000a1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM conversation_participants WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S4856','s4856-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT}','{ORG}','agent','Agent')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT}','granted')",
        f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{CONV}','{ORG}','{PROJ}','group')",
        f"INSERT INTO conversation_participants (conversation_id,member_id) VALUES ('{CONV}','{AGENT}')",
    ]:
        await s.execute(text(sql))
    await s.commit()


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(AGENT), email=None, claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG))


class _SpyStorage:
    """wraps the real (local) storage provider and records the content type each object was stored with"""

    def __init__(self, inner):
        self.inner, self.stored = inner, {}

    async def put_object(self, container, path, data, content_type=None, **kw):
        self.stored[path] = content_type
        return await self.inner.put_object(container, path, data, content_type=content_type, **kw)

    def __getattr__(self, name):
        return getattr(self.inner, name)


@needs_db
@pytest.mark.anyio
@pytest.mark.parametrize("declared, data, name, want, size", [
    ("application/octet-stream", PNG, "shot.png", "image/png", (24, 16)),     # the measured case: a generic type for a real picture
    ("image/jpg", JPEG, "photo.jpg", "image/jpeg", (24, 16)),                 # a near miss
    ("text/plain", WEBP, "x.webp", "image/webp", (24, 16)),                   # a wrong one
    ("image/png", PNG, "ok.png", "image/png", (24, 16)),                      # the correct declaration is unchanged
    ("application/pdf", PDF, "doc.pdf", "application/pdf", (None, None)),     # not a picture: as declared, no size
])
async def test_the_chat_upload_follows_the_bytes(monkeypatch, tmp_path, declared, data, name, want, size):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers import conversations as conv_router
    from app.services.asset_registry import DEFAULT_CONTAINER
    from app.services.storage import get_storage_provider

    spy = _SpyStorage(get_storage_provider())
    monkeypatch.setattr(conv_router, "get_storage_provider", lambda: spy)

    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = conv_router.UploadConversationAttachmentRequest(content_base64=base64.b64encode(data).decode(), name=name, content_type=declared)
            resp = await conv_router.upload_conversation_attachment(CONV, body, db=s, auth=_auth(), org_id=ORG)
        assert resp.content_type == want                          # what the response (and so the stored message attachment) says
        assert spy.stored[resp.url] == want                       # what the object was stored with
        assert (resp.width, resp.height) == size                  # what was measured
        assert await spy.inner.download_object(DEFAULT_CONTAINER, resp.url) == data   # the bytes themselves are untouched
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_participants WHERE conversation_id=:c"), {"c": CONV})
            await s.commit()
        await eng.dispose()
