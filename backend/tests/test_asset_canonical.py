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
@pytest.mark.anyio
async def test_local_provider_delete_object(tmp_path, monkeypatch):
    """S8 Phase 2: local provider delete_object — 파일 삭제 + 이미 없으면 멱등(True)."""
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.services.storage.local import LocalStorageProvider

    p = LocalStorageProvider()
    target = tmp_path / "bucket" / "a" / "f.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"x")
    assert target.exists()
    assert await p.delete_object("bucket", "a/f.png") is True
    assert not target.exists()
    # 이미 없음 → 멱등 True
    assert await p.delete_object("bucket", "a/f.png") is True


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_scope_doc_namespace_s4():
    """S4: doc 분기 — org/project/doc exact-prefix 강제(이전 unconstrained). cross-org/project/doc 거부·manual 무제약."""
    doc = _uuid.uuid4()
    assert path_in_source_scope(f"org/{_ORG}/project/{_PROJ}/doc/{doc}/u.png", "doc", _PROJ, doc, _ORG)
    # cross-org / cross-doc / cross-project → 거부
    assert not path_in_source_scope(f"org/{_uuid.uuid4()}/project/{_PROJ}/doc/{doc}/u.png", "doc", _PROJ, doc, _ORG)
    assert not path_in_source_scope(f"org/{_ORG}/project/{_PROJ}/doc/{_uuid.uuid4()}/u.png", "doc", _PROJ, doc, _ORG)
    assert not path_in_source_scope(f"org/{_ORG}/project/{_uuid.uuid4()}/doc/{doc}/u.png", "doc", _PROJ, doc, _ORG)
    # 빈 trailing / 중간삽입 거부
    assert not path_in_source_scope(f"org/{_ORG}/project/{_PROJ}/doc/{doc}/", "doc", _PROJ, doc, _ORG)
    # manual 은 여전히 무제약(신뢰 등록)
    assert path_in_source_scope("anything/x.png", "manual", _PROJ, _uuid.uuid4(), _ORG)
