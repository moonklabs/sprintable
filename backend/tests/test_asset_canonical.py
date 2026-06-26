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
