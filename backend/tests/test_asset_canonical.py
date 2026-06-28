"""E-STORAGE-SSOT S2 — canonical_object_path 단위(DB 무관·CI backend-test 실행).

S1 _canonical_object_path 규칙 정합: GCS public prefix 제거 / bare 그대로 / 외부 스킴 None.
"""
from __future__ import annotations

import pytest

from app.services.asset_registry import canonical_object_path

_BUCKET = "sprintable-memo-attachments"
_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"


def test_strips_gcs_public_prefix():
    assert canonical_object_path(_PREFIX + "chat/p/c/u-a.png", _BUCKET) == "chat/p/c/u-a.png"


def test_bare_path_passthrough():
    assert canonical_object_path("story/p/s/u-a.png", _BUCKET) == "story/p/s/u-a.png"


@pytest.mark.parametrize(
    "external",
    [
        "http://evil/a.png",
        "gs://other-bucket/a.png",
        "file:///etc/passwd",
        "https://storage.googleapis.com/other-bucket/a.png",  # 타 버킷
    ],
)
def test_external_or_other_bucket_is_none(external):
    assert canonical_object_path(external, _BUCKET) is None


def test_empty_is_none():
    assert canonical_object_path("", _BUCKET) is None
    assert canonical_object_path(_PREFIX, _BUCKET) is None  # prefix-only → 빈 path


# E-STORAGE-SSOT S7 — path_in_source_scope: legacy + 신 org/project namespace 인식(DB 무관).
import uuid as _uuid  # noqa: E402
from app.services.asset_registry import path_in_source_scope  # noqa: E402

_ORG = _uuid.UUID("11111111-1111-1111-1111-111111111111")
_PROJ = _uuid.UUID("22222222-2222-2222-2222-222222222222")
_CONV = _uuid.UUID("33333333-3333-3333-3333-333333333333")
_STORY = _uuid.UUID("44444444-4444-4444-4444-444444444444")


def test_scope_legacy_namespace():
    assert path_in_source_scope(f"chat/{_PROJ}/{_CONV}/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    assert path_in_source_scope(f"story/{_PROJ}/{_STORY}/u.png", "story", _PROJ, _STORY, _ORG)


def test_scope_s7_org_namespace():
    assert path_in_source_scope(
        f"org/{_ORG}/project/{_PROJ}/chat/{_CONV}/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    assert path_in_source_scope(
        f"org/{_ORG}/project/{_PROJ}/story/{_STORY}/u.png", "story", _PROJ, _STORY, _ORG)


def test_scope_rejects_wrong_source_or_org():
    other = _uuid.uuid4()
    # 타 conv
    assert not path_in_source_scope(
        f"org/{_ORG}/project/{_PROJ}/chat/{other}/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    # 타 org(신 namespace인데 org 불일치)
    assert not path_in_source_scope(
        f"org/{other}/project/{_PROJ}/chat/{_CONV}/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    # org_id 없이 신 namespace → 거부(legacy만 허용)
    assert not path_in_source_scope(
        f"org/{_ORG}/project/{_PROJ}/chat/{_CONV}/u.png", "conversation_message", _PROJ, _CONV, None)


def test_scope_manual_unconstrained():
    assert path_in_source_scope("anything/x.png", "manual", _PROJ, _uuid.uuid4(), _ORG)


def test_scope_segment_robustness():
    """까심 LOW: segment 단위 정확 비교 견고성 — 빈 trailing·prefix 혼동 거부·subdir 허용."""
    # 빈 trailing(파일 segment 없음) → 거부
    assert not path_in_source_scope(f"chat/{_PROJ}/{_CONV}/", "conversation_message", _PROJ, _CONV, _ORG)
    assert not path_in_source_scope(
        f"org/{_ORG}/project/{_PROJ}/chat/{_CONV}/", "conversation_message", _PROJ, _CONV, _ORG)
    # conv segment prefix 혼동(예: <conv>extra) → 정확 segment 불일치로 거부
    assert not path_in_source_scope(
        f"chat/{_PROJ}/{_CONV}extra/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    # 중간 삽입(parts[4]!='chat') → 거부
    assert not path_in_source_scope(
        f"org/{_ORG}/project/{_PROJ}/evil/chat/{_CONV}/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    # 정당한 subdir 깊은 경로는 허용(file segment 비어있지 않음)
    assert path_in_source_scope(
        f"chat/{_PROJ}/{_CONV}/sub/u.png", "conversation_message", _PROJ, _CONV, _ORG)


def test_scope_cross_org_with_correct_proj_conv_rejected():
    """까심 CRITICAL 고정: org segment만 틀려도(proj+conv 정확) 거부 — cross-org IDOR 차단."""
    other_org = _uuid.uuid4()
    assert not path_in_source_scope(
        f"org/{other_org}/project/{_PROJ}/chat/{_CONV}/u.png", "conversation_message", _PROJ, _CONV, _ORG)
    assert not path_in_source_scope(
        f"org/{other_org}/project/{_PROJ}/story/{_STORY}/u.png", "story", _PROJ, _STORY, _ORG)
