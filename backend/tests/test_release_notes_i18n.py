"""E-I18N EN 콘텐츠(story d6e3f407, 문서 `en-content-native-generation-crux` §3) — release_notes
locale 소비 배선(no-DB 유닛). `_to_response`(순수 함수)와 `list_release_notes`(라우트, locale
소스 우선순위)를 검증한다.

까심 QA 근본fix 교훈(#1966): Header() DI는 라우트 경계에서만 — 직접-호출 테스트는 내부 함수
(`_list_release_notes`)를 부른다.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


def _row(**overrides) -> SimpleNamespace:
    defaults = dict(
        note_key="2026-06-v1-5", version="v1.5", display_period="2026년 6월",
        title="파일 첨부와 미리보기가 생겼어요", title_i18n={},
        summary="요약", summary_i18n={},
        items=[{"text": "항목1"}], items_i18n={},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── _to_response — 순수 함수, i18n 폴백 체인 ────────────────────────────────

def test_to_response_ko_locale_uses_legacy_columns():
    from app.routers.release_notes import _to_response

    row = _row(title_i18n={"en": "unused"}, summary_i18n={"en": "unused"})
    out = _to_response(row, "ko")
    assert out.title == "파일 첨부와 미리보기가 생겼어요"
    assert out.summary == "요약"


def test_to_response_en_locale_falls_back_to_ko_when_overlay_empty():
    """오늘 실 DB 상태(전부 빈 {})와 동형 — 무회귀."""
    from app.routers.release_notes import _to_response

    row = _row()
    out = _to_response(row, "en")
    assert out.title == "파일 첨부와 미리보기가 생겼어요"
    assert out.summary == "요약"
    assert out.items[0].text == "항목1"


def test_to_response_en_locale_uses_i18n_overlay_when_present():
    from app.routers.release_notes import _to_response

    row = _row(
        title_i18n={"en": "File attachments and previews are here"},
        summary_i18n={"en": "Summary"},
        items_i18n={"en": [{"text": "Item 1"}]},
    )
    out = _to_response(row, "en")
    assert out.title == "File attachments and previews are here"
    assert out.summary == "Summary"
    assert out.items[0].text == "Item 1"
    assert out.items[0].text != "항목1"


# ── list_release_notes(route) — locale 소스 우선순위(Phase C 동형) ────────────

def _db_returning(rows):
    res = MagicMock()
    res.scalars.return_value.all.return_value = rows
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    return db


@pytest.mark.anyio
async def test_list_release_notes_explicit_locale_wins_over_header():
    from app.routers.release_notes import list_release_notes

    row = _row(title_i18n={"en": "EN title"})
    db = _db_returning([row])
    out = await list_release_notes(
        locale="en", accept_language="ko-KR,ko;q=0.9",
        session=db, _auth=MagicMock(),
    )
    assert out[0].title == "EN title"


@pytest.mark.anyio
async def test_list_release_notes_falls_back_to_accept_language_header():
    from app.routers.release_notes import list_release_notes

    row = _row(title_i18n={"en": "EN title"})
    db = _db_returning([row])
    out = await list_release_notes(
        accept_language="en-US,en;q=0.9", session=db, _auth=MagicMock(),
    )
    assert out[0].title == "EN title"


@pytest.mark.anyio
async def test_list_release_notes_no_locale_signal_stays_korean_backward_compatible():
    from app.routers.release_notes import list_release_notes

    row = _row(title_i18n={"en": "EN title"})
    db = _db_returning([row])
    out = await list_release_notes(accept_language=None, session=db, _auth=MagicMock())
    assert out[0].title == "파일 첨부와 미리보기가 생겼어요"
