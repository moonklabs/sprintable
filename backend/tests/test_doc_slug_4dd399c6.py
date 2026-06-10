"""Part A 4dd399c6: doc slugify(NFC·유니코드 보존) + 유일화 + alias.

slugify 는 FE `generateSlug` 와 parity 가 핵심 — NFC/NFD·한/영/혼합/기호/이모지/빈값 fixture 교차.
"""
from __future__ import annotations

import unicodedata
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.services.doc_slug import MAX_SLUG_LEN, resolve_unique_slug, slugify


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── slugify (pure) ────────────────────────────────────────────────────────────

def test_basic_latin_lowercase_and_spaces():
    assert slugify("Q3 Roadmap") == "q3-roadmap"


def test_symbols_and_underscore_stripped():
    # '_' 와 그 외 기호 제거, 공백→'-'
    assert slugify("Hello, World! _draft_") == "hello-world-draft"


def test_dash_collapse_and_trim():
    assert slugify("  --a   b--  ") == "a-b"


def test_korean_preserved():
    assert slugify("프로젝트 로드맵") == "프로젝트-로드맵"


def test_mixed_korean_latin_number():
    assert slugify("Q3 로드맵 2026") == "q3-로드맵-2026"


def test_emoji_and_punct_dropped():
    assert slugify("회고 🚀 (초안)") == "회고-초안"


def test_empty_and_symbol_only_return_empty():
    assert slugify("") == ""
    assert slugify("!!!@@@ ___") == ""
    assert slugify("   ") == ""


def test_max_length_truncated_no_trailing_dash():
    s = slugify("a" * 250)
    assert len(s) <= MAX_SLUG_LEN
    assert not s.endswith("-")


def test_nfc_nfd_parity_korean():
    """동일 한글 제목의 조합형(NFC)·분해형(NFD) 입력 → 동일 slug (uniqueness/parity 핵심)."""
    title = "한글 제목"
    nfc = unicodedata.normalize("NFC", title)
    nfd = unicodedata.normalize("NFD", title)
    assert nfc != nfd  # 코드포인트는 실제로 다름
    assert slugify(nfd) == slugify(nfc) == "한글-제목"


def test_slugify_is_idempotent():
    once = slugify("Q3 로드맵 2026")
    assert slugify(once) == once


# ── resolve_unique_slug ─────────────────────────────────────────────────────────

ORG = uuid.uuid4()
PROJ = uuid.uuid4()


@pytest.mark.anyio
async def test_resolve_unique_no_conflict_returns_base():
    with patch("app.services.doc_slug.is_slug_taken", new=AsyncMock(return_value=False)):
        out = await resolve_unique_slug(AsyncMock(), ORG, PROJ, "q3-roadmap")
    assert out == "q3-roadmap"


@pytest.mark.anyio
async def test_resolve_unique_suffixes_on_conflict():
    taken = {"q3-roadmap", "q3-roadmap-2"}  # base 와 -2 점유 → -3 기대

    async def _taken(session, org, proj, slug, exclude_doc_id=None):
        return slug in taken

    with patch("app.services.doc_slug.is_slug_taken", new=_taken):
        out = await resolve_unique_slug(AsyncMock(), ORG, PROJ, "q3-roadmap")
    assert out == "q3-roadmap-3"


@pytest.mark.anyio
async def test_resolve_unique_suffix_respects_max_len():
    base = "a" * MAX_SLUG_LEN

    async def _taken(session, org, proj, slug, exclude_doc_id=None):
        return slug == base  # base만 점유 → 첫 suffix 후보가 길이 가드 받아야

    with patch("app.services.doc_slug.is_slug_taken", new=_taken):
        out = await resolve_unique_slug(AsyncMock(), ORG, PROJ, base)
    assert len(out) <= MAX_SLUG_LEN
    assert out.endswith("-2")
