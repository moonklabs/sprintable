"""story #3262 — app/knowledge_fiction_guard.py. 페드루 PO 재실측(2026-08-31 12시, story #3261
done 처리 직후)에서 나온 2차 날조 원문을 그대로 회귀 테스트에 박는다."""
from __future__ import annotations

from app.knowledge_fiction_guard import looks_like_fabricated_product_instructions

# 실사고 재현(페드루 보고 원문 기반 — "설정>사용자 및 권한>사용자 초대" 메뉴 경로 +
# "example.com/invite" 가짜 링크, 확신조, 8.7초, escalated=false, knowledge_search 미호출).
_REAL_INCIDENT_TEXT = (
    "팀원을 초대하시려면 설정 > 사용자 및 권한 > 사용자 초대 메뉴로 이동하신 후, "
    "https://example.com/invite 에서 이메일을 입력해 초대를 보내시면 됩니다."
)


def test_catches_real_incident_text():
    assert looks_like_fabricated_product_instructions(_REAL_INCIDENT_TEXT) is True


def test_catches_bare_domain_without_scheme():
    assert looks_like_fabricated_product_instructions("example.com/invite 에서 초대할 수 있습니다.") is True


def test_catches_menu_breadcrumb_without_url():
    assert looks_like_fabricated_product_instructions("설정>권한>초대 메뉴에서 하시면 됩니다.") is True


def test_does_not_flag_plain_answer_without_url_or_breadcrumb():
    assert (
        looks_like_fabricated_product_instructions("조직 멤버 페이지에서 초대할 수 있습니다.") is False
    )


def test_does_not_flag_no_match_honest_message():
    from app.execution_tasks import NO_MATCH_MESSAGE

    assert looks_like_fabricated_product_instructions(NO_MATCH_MESSAGE) is False


def test_does_not_flag_grounded_citation_style_without_breadcrumb_or_url():
    """실제 지식원 근거가 있는 답은 문서 제목을 괄호로 인용한다(app/execution_tasks.py
    _KNOWLEDGE_SYNTH_SYSTEM_PROMPT) — ">" 브레드크럼이나 URL이 없으면 안 걸려야 한다."""
    grounded = "조직 멤버 페이지(/organization/members)에서 이메일을 입력해 초대할 수 있습니다. (참고: 팀원 초대 방법)"
    # 실 라우트 경로("/organization/members")는 URL 스킴(https?://)도 아니고 도메인 패턴도
    # 아니라(점 뒤에 TLD가 없음) 안 걸린다 — 가드는 "지어낸 외부 링크/메뉴 브레드크럼"만 좁게 잡는다.
    assert looks_like_fabricated_product_instructions(grounded) is False
