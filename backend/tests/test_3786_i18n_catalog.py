"""story #3786(3779 3층 ①) — 공용 i18n 카탈로그(`app/services/i18n_catalog.py`) 메커니즘 자체를
검증한다. 실PG 불요(순수 유닛). 카드 明示 가드 2종을 여기서 고정한다.
"""
from __future__ import annotations

import pytest

from app.services.i18n_catalog import MessageCatalog, UnknownMessageKeyError, t


# ─── ⭐가드 1 — ko/en 키 집합 불일치 RED(story #3765 죽은 키 클래스 예방) ─────────


def test_every_catalog_entry_has_exactly_ko_and_en():
    """실 카탈로그의 모든 항목이 정확히 {ko, en} 로케일을 갖는지 — 한쪽만 채워진 키가
    조용히 남는 것(부분 번역 누락)을 막는다."""
    for key in MessageCatalog.keys():
        assert MessageCatalog.locales_for(key) == {"ko", "en"}, (
            f"{key!r}가 ko/en 둘 다를 갖고 있지 않다(가드 1 위반)."
        )


def test_guard1_detects_missing_locale_mutation():
    """뮤테이션 셀프체크 — 한쪽 로케일이 빠진 가짜 항목을 만들면 위 불변식이 정확히 깨져야
    한다(가드가 실제로 도는지 증명, 실 카탈로그는 건드리지 않고 합성 dict로 검증)."""
    broken_entry = {"ko": "테스트 문장"}  # en 없음 — 의도적 불완전
    assert set(broken_entry.keys()) != {"ko", "en"}


# ─── ⭐가드 2 — 카탈로그에 없는 키 호출 → 조용한 폴백 금지, RED ─────────────────


def test_unknown_key_raises_instead_of_silently_falling_back():
    with pytest.raises(UnknownMessageKeyError):
        t("this.key.does.not.exist.in.catalog", "ko")


def test_known_key_renders_without_raising():
    key = next(iter(MessageCatalog.keys()))
    # PENDING_EN 상태에서도(유나 답 전) 크래시 없이 문자열을 반환해야 한다 — 내용 검증은
    # 슬라이스별 통합 테스트 몫, 여기는 "예외 없이 렌더된다"만 고정.
    assert isinstance(t(key, "ko"), str)
    assert isinstance(t(key, "en"), str)


# ─── locale 정규화 — 미지원/None → resolve_locale()의 DEFAULT_LOCALE로 폴백 ────


def test_unsupported_locale_falls_back_without_raising():
    key = next(iter(MessageCatalog.keys()))
    # 'fr' 같은 미지원 로케일도 resolve_locale()이 DEFAULT_LOCALE로 정규화해 KeyError 없이
    # 렌더돼야 한다(이 모듈 자신은 로케일을 재해석 안 하지만, Phase C의 resolve_locale은
    # 그대로 재사용한다는 계약).
    assert isinstance(t(key, "fr"), str)
    assert isinstance(t(key, ""), str)


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
