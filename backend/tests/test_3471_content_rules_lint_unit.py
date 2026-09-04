"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 저장소
(`org_content_rules`) + 초안 lint. 블루프린트 v3 §2(f)·처분표(3b9960cb) 8행.

주어 가르기: 제품이 기계로 검사하는 것은 금칙어·UTM 필수 둘뿐(단위 테스트) — API
테스트는 GET/PUT 권한 폭·submit 422 거부·org 격리·버전 보존(AC 「과거 evidence
보존」)을 잰다."""
from __future__ import annotations

from app.services.content_rules import lint_content


# ══════════════════════════════════════════════════════════════════════════════
# 단위 테스트 — lint_content() 순수 함수(DB 불요)
# ══════════════════════════════════════════════════════════════════════════════


def test_lint_no_rules_returns_zero_violations():
    """조직이 규칙을 한 번도 PUT 안 함(None) — 위반 0건(강제 안 함, 지어내지 않는다)."""
    assert lint_content(None, text="아무 내용이나 금칙어 포함", link_url=None) == []


def test_lint_empty_rules_dict_returns_zero_violations():
    assert lint_content({}, text="아무 내용", link_url=None) == []


def test_lint_banned_term_case_insensitive_and_substring_match():
    """양성대조 — 규칙+위반 표본이 실제로 ≥1건을 낸다(항상 통과하는 가짜 테스트가
    아님을 증명, 페드루 PO 지시 그대로)."""
    rules = {"banned_terms": ["대출"]}
    violations = lint_content(rules, text="이 상품은 소액 대출 광고입니다", link_url=None)
    assert len(violations) == 1
    assert violations[0]["code"] == "banned_term"
    assert violations[0]["field"] == "text"
    assert violations[0]["value"] == "대출"
    assert violations[0]["settings_path"] == "/settings/content-rules"

    # 대소문자 무시(영문 금칙어).
    rules_en = {"banned_terms": ["GUARANTEED"]}
    assert len(lint_content(rules_en, text="이건 guaranteed 수익입니다", link_url=None)) == 1


def test_lint_banned_term_absent_returns_zero_violations():
    """음성대조 — 금칙어가 실제로 없으면 위반도 없다."""
    rules = {"banned_terms": ["대출"]}
    assert lint_content(rules, text="평범한 안내문입니다", link_url=None) == []


def test_lint_require_utm_missing_one_of_three_params():
    rules = {"require_utm": True}
    violations = lint_content(
        rules, text="본문", link_url="https://example.com/?utm_source=x&utm_medium=y",
    )
    assert len(violations) == 1
    assert violations[0]["code"] == "utm_missing"
    assert violations[0]["field"] == "link_url"
    assert "utm_campaign" in violations[0]["value"]
    assert "utm_source" not in violations[0]["value"]


def test_lint_require_utm_all_three_present_passes():
    rules = {"require_utm": True}
    violations = lint_content(
        rules, text="본문",
        link_url="https://example.com/?utm_source=x&utm_medium=y&utm_campaign=z",
    )
    assert violations == []


def test_lint_require_utm_no_link_url_is_noop():
    """link_url 자체가 없으면(site_post류) UTM 검사가 구조적으로 no-op — 지어내지 않는다."""
    rules = {"require_utm": True}
    assert lint_content(rules, text="본문", link_url=None) == []


def test_lint_declaration_only_keys_never_produce_violations():
    """톤·택소노미·채널 우선순위·브랜드 킷은 제품이 lint 안 함(에이전트가 읽는 선언
    슬롯) — 이 키들만 있어도 위반 0건."""
    rules = {
        "tone": "친근한", "taxonomy": ["블로그", "SNS"],
        "channel_priority": ["threads", "wordpress"],
        "brand_kit": {"logo_url": "https://example.com/logo.png"},
    }
    assert lint_content(rules, text="아무 본문", link_url=None) == []


def test_lint_multiple_violations_all_reported():
    rules = {"banned_terms": ["대출"], "require_utm": True}
    violations = lint_content(rules, text="대출 안내", link_url="https://example.com/no-utm")
    codes = {v["code"] for v in violations}
    assert codes == {"banned_term", "utm_missing"}
