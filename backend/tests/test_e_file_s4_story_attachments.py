"""E-FILE S4: 보드 스토리 첨부 — schema/model/migration 검증.

chat-attach(S1)과 동형. GCS 기록은 FE-proxy, BE는 URL+메타 저장(stories.attachments 0095).
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest
from pydantic import ValidationError

from app.schemas.story import (
    StoryAttachment,
    StoryCreate,
    StoryUpdate,
    StoryResponse,
    _MAX_STORY_ATTACHMENTS,
)

_MIGRATION = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions", "0095_add_attachments_to_stories.py"
)
_GOOD = {"url": "https://storage.googleapis.com/sprintable-memo-attachments/a.png",
         "name": "a.png", "content_type": "image/png", "size": 2048}


# ── payload 검증 (chat과 동형) ────────────────────────────────────────────────

def test_attachment_valid_and_invalid():
    assert StoryAttachment(**_GOOD).size == 2048
    with pytest.raises(ValidationError):
        StoryAttachment(**{**_GOOD, "url": "http://insecure/a"})
    with pytest.raises(ValidationError):
        StoryAttachment(**{**_GOOD, "name": " "})
    with pytest.raises(ValidationError):
        StoryAttachment(**{**_GOOD, "size": -1})
    with pytest.raises(ValidationError):
        StoryAttachment(**{**_GOOD, "size": 200 * 1024 * 1024})


def test_create_update_accept_attachments_with_limit():
    c = StoryCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="t", attachments=[_GOOD])
    assert len(c.attachments) == 1
    assert StoryCreate(project_id=uuid.uuid4(), org_id=uuid.uuid4(), title="t").attachments == []
    assert StoryUpdate().attachments is None  # 미지정 → 변경 안 함
    with pytest.raises(ValidationError):
        StoryUpdate(attachments=[_GOOD] * (_MAX_STORY_ATTACHMENTS + 1))


# ── 직렬화 / 회귀 (column → response, None/mock 안전) ──────────────────────────

def _resp(**over):
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(),
        title="t", status="backlog", priority="medium",
        created_at=__import__("datetime").datetime.now(),
        updated_at=__import__("datetime").datetime.now(),
    )
    base.update(over)
    return StoryResponse(**base)


def test_response_attachments_passthrough_and_coercion():
    assert _resp(attachments=[_GOOD]).attachments == [_GOOD]
    assert _resp(attachments=None).attachments == []   # 레거시 None → []
    assert _resp(attachments="garbage").attachments == []  # 비-list(mock 등) → []
    assert _resp().attachments == []  # 기본값


# ── migration 0095 ────────────────────────────────────────────────────────────

def test_migration_0095_chains_off_0094():
    spec = importlib.util.spec_from_file_location("rev_0095", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.revision == "0095"
    assert mod.down_revision == "0094"
    assert callable(mod.upgrade) and callable(mod.downgrade)
