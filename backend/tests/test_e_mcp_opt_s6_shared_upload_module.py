"""E-MCP-OPT S6: `app/services/mcp_attachment_upload.py` 공용 프리미티브 — chat/story/doc 공유.

S2/S5 당시 chat 전용 로컬 정의였던 것을 3번째 리소스(story) 추가 시점에 추출(DRY). 값/로직은 기존
chat 동작과 100% 동일해야 한다 — kind 파라미터만 리소스별로 다르다.
"""
from __future__ import annotations

import base64
import uuid

import pytest
from fastapi import HTTPException

from app.services import mcp_attachment_upload as m


def test_constants_match_previous_chat_values():
    assert m.MAX_JSON_ATTACHMENT_UPLOAD_SIZE == 2 * 1024 * 1024
    assert m.MCP_MAX_ATTACHMENTS == 5
    assert m.MCP_MAX_TOTAL_ATTACHMENT_BYTES == 6 * 1024 * 1024


def test_safe_attachment_filename_sanitizes_and_truncates():
    assert m.safe_attachment_filename("../../evil/../x.png") == ".._.._evil_.._x.png"
    assert m.safe_attachment_filename("") == "file"
    assert m.safe_attachment_filename("   ") == "file"
    assert len(m.safe_attachment_filename("a" * 300)) <= 128


def test_decode_json_attachment_valid():
    raw = b"hello world"
    data = m.decode_json_attachment(base64.b64encode(raw).decode())
    assert data == raw


def test_decode_json_attachment_invalid_base64_400():
    with pytest.raises(HTTPException) as ei:
        m.decode_json_attachment("not-valid-base64!!!")
    assert ei.value.status_code == 400


def test_decode_json_attachment_empty_400():
    with pytest.raises(HTTPException) as ei:
        m.decode_json_attachment(base64.b64encode(b"").decode())
    assert ei.value.status_code == 400


def test_decode_json_attachment_oversized_413():
    oversized = base64.b64encode(b"a" * (m.MAX_JSON_ATTACHMENT_UPLOAD_SIZE + 1)).decode()
    with pytest.raises(HTTPException) as ei:
        m.decode_json_attachment(oversized)
    assert ei.value.status_code == 413


def test_build_mcp_object_path_shape():
    org = uuid.uuid4()
    proj = uuid.uuid4()
    conv = uuid.uuid4()
    path = m.build_mcp_object_path(org_id=org, project_id=proj, kind="chat", resource_id=conv, safe_name="x.png")
    parts = path.split("/")
    assert parts[0] == "org" and parts[1] == str(org)
    assert parts[2] == "project" and parts[3] == str(proj)
    assert parts[4] == "chat" and parts[5] == str(conv)
    assert parts[6] == "mcp"
    assert parts[7].endswith("-x.png")


@pytest.mark.parametrize("kind", ["chat", "story", "doc"])
def test_is_mcp_upload_object_path_per_kind(kind):
    org, proj, rid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    path = m.build_mcp_object_path(org_id=org, project_id=proj, kind=kind, resource_id=rid, safe_name="a.bin")
    assert m.is_mcp_upload_object_path(path, kind=kind) is True
    # 다른 kind 로는 매칭 안 됨(교차 오염 방지).
    other = "story" if kind != "story" else "doc"
    assert m.is_mcp_upload_object_path(path, kind=other) is False


def test_is_mcp_upload_object_path_rejects_non_mcp_path():
    assert m.is_mcp_upload_object_path("org/o/project/p/story/s/uuid-x.png", kind="story") is False


def test_is_mcp_upload_object_path_handles_gcs_public_url():
    org, proj, rid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    path = m.build_mcp_object_path(org_id=org, project_id=proj, kind="doc", resource_id=rid, safe_name="a.bin")
    gcs_url = f"https://storage.googleapis.com/{m.DEFAULT_CONTAINER if hasattr(m, 'DEFAULT_CONTAINER') else 'sprintable-memo-attachments'}/{path}"
    assert m.is_mcp_upload_object_path(gcs_url, kind="doc") is True
