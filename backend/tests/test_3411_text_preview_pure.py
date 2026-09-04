"""story #3411 — `text_char_count`/`build_text_preview` 순수 함수 단위테스트(DB 불요,
실PG 없이도 항상 돈다). DB 왕복(목록↔단건 parity) 테스트는
`test_3411_channel_post_text_preview.py`(destructive_schema, 실PG 필요) 쪽."""
from __future__ import annotations

from app.services.channel_posts import TEXT_PREVIEW_MAX_LENGTH, build_text_preview, text_char_count


def test_text_char_count_matches_server_and_js_spread_not_utf16_length():
    """⭐페드루/유나 pin 표본 — 순 한글/영문만으론 코드포인트=UTF-16 셈법이 같아서
    아무것도 증명 못 한다. BMP 밖 문자(😀, surrogate pair)+ZWJ 결합 이모지(👩‍💻) 둘 다
    포함한 문장으로: 서버(len()) == JS `[...text].length` == 27. **JS 네이티브
    `.length`(UTF-16 code unit 수)로 세면 30이 나온다 — 그 값과 같으면 결함(회귀)**."""
    text = "에이전트 여섯이 스프린트 하나를 😀 돌린다 👩‍💻"
    assert text_char_count(text) == 27
    utf16_code_unit_count = len(text.encode("utf-16-le")) // 2
    assert utf16_code_unit_count == 30
    assert text_char_count(text) != utf16_code_unit_count, (
        "코드포인트 셈법이 UTF-16 코드단위 셈법과 우연히 같아지면 이 표본 자체가 "
        "두 축을 더는 구별 못 하게 됨(표본 부패) — 절대 같아지면 안 된다."
    )


def test_build_text_preview_plain_ascii_truncates_at_exactly_max_length():
    """결합 문자·ZWJ가 전혀 없는 평문 — 정확히 80 코드포인트에서 자른다(기준선)."""
    text = "x" * 85
    preview = build_text_preview(text)
    assert len(preview) == TEXT_PREVIEW_MAX_LENGTH == 80


def test_build_text_preview_short_text_returned_unchanged():
    text = "짧은 본문"
    assert build_text_preview(text) == text


def test_build_text_preview_does_not_split_zwj_family_emoji_at_boundary():
    """⭐AC2 — 78 filler + 「👩‍💻」(3 코드포인트: 👩=인덱스78·ZWJ=79·💻=80, 총 81자).
    80에서 자르면 정확히 ZWJ 직후라 그 클러스터(👩‍💻 전체)까지 포함해야 한다(쪼개면
    깨진 이모지가 남는다) — 결과는 81자 전체(자를 게 없어짐)."""
    text = "x" * 78 + "👩‍💻"
    assert len(text) == 81
    preview = build_text_preview(text)
    assert preview == text, "ZWJ 시퀀스 중간에서 잘라 가족 이모지가 반토막 나면 안 된다"
    assert preview.endswith("👩‍💻")


def test_build_text_preview_does_not_split_variation_selector():
    """AC2 — VS16(U+FE0F) 직전에서 자르면 그 선택자까지 포함한다. 79 filler(0..78)+
    "❤"(U+2764, 인덱스79)+VS16(U+FE0F, 인덱스80) = 81자. 80에서 자르면 ❤ 바로 뒤(VS16
    직전)라 VS16까지 포함해야 한다."""
    text = "x" * 79 + "❤️"
    assert len(text) == 81
    preview = build_text_preview(text)
    assert preview == text
    assert preview.endswith("❤️")


def test_build_text_preview_declares_scope_regional_indicator_flags_not_covered():
    """범위 밖 선언 확인 — 국기 이모지(regional indicator 쌍, 예: 🇰🇷=U+1F1F0 U+1F1F7)는
    유나가 명시한 3축(결합 문자·VS·ZWJ·한글 자모) 밖이라 이 함수가 쪼갤 수 있다는
    사실을 테스트로도 정직하게 고정(=범위 밖이 실제로 범위 밖임을 증명, 몰래 이미
    커버되고 있었다면 이 assert가 깨져서 알려준다)."""
    text = "x" * 79 + "🇰🇷"  # 79 filler + 2 regional-indicator codepoints = 81
    assert len(text) == 81
    preview = build_text_preview(text)
    # 커버 대상이 아니므로 쪼개질 수 있다(정확히 80에서 잘려 국기 후반부가 유실) — 이
    # assert가 실패하면 오히려 "더 잘 처리하게 됐다"는 뜻이니 그때 이 선언을 갱신할 것.
    assert len(preview) == 80
