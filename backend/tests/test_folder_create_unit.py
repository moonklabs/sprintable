"""story #1939 — POST /api/v2/folders 순수 로직 단위 테스트(DB 무관).

폴더명 정규화(trim/빈값/과도한 길이 거부)만 커버 — authz/DB write 는 realdb 통합 테스트
(test_folder_create_realdb.py)에서 커버.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException


def test_normalize_folder_name_trims_whitespace():
    from app.routers.assets import _normalize_folder_name

    assert _normalize_folder_name("  My Folder  ") == "My Folder"


def test_normalize_folder_name_rejects_empty():
    from app.routers.assets import _normalize_folder_name

    with pytest.raises(HTTPException) as ei:
        _normalize_folder_name("")
    assert ei.value.status_code == 422


def test_normalize_folder_name_rejects_whitespace_only():
    from app.routers.assets import _normalize_folder_name

    with pytest.raises(HTTPException) as ei:
        _normalize_folder_name("   ")
    assert ei.value.status_code == 422


def test_normalize_folder_name_rejects_too_long():
    from app.routers.assets import _normalize_folder_name, _MAX_FOLDER_NAME_LEN

    with pytest.raises(HTTPException) as ei:
        _normalize_folder_name("x" * (_MAX_FOLDER_NAME_LEN + 1))
    assert ei.value.status_code == 422


def test_normalize_folder_name_allows_max_length():
    from app.routers.assets import _normalize_folder_name, _MAX_FOLDER_NAME_LEN

    name = "x" * _MAX_FOLDER_NAME_LEN
    assert _normalize_folder_name(name) == name
