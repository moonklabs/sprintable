"""story #4182 — 사용자 본문을 잘라 미리보기로 내보내는 자리(알림 summary/body·백링크 스니펫·
활동 content_preview·문서 발췌·게이트 문서 요약)의 공용 평문화.

외부 동기화(Linear 등)가 본문 앞에 심는 비가시 HTML 주석(`<!-- linear-comment-id … -->`)이
절삭된 미리보기에 원문 그대로 새던 결함. 주석 제거를 **절삭보다 먼저** 한다 — 그래야
절삭 지점에 걸린 주석이 `<!-- linear-comm…`처럼 반쯤 남는 일이 없다. 저장 데이터는 안
바꾼다(생성 시점 미리보기에만 적용).
"""

from __future__ import annotations

import re

# 사용자 본문으로 만드는 알림 body 길이(채팅 멘션·새 메시지·코멘트·에이전트 배정) 공용.
NOTIFICATION_BODY_PREVIEW_MAX = 200

# 코드(펜스·인라인) 안의 리터럴 `<!--`는 주석이 아니다 — 먼저 코드를 통째로 매치해 그대로
# 돌려주고, 코드 밖의 주석만 지운다(까디르 QA: 펜스/인라인 코드 속 `<!--`가 뒷본문을 전부
# 삼키던 회귀). 닫히지 않은 `<!--`(원문 자체가 잘려 들어온 경우)는 문자열 끝까지 제거한다.
_CODE_OR_COMMENT_RE = re.compile(r"(```[\s\S]*?```|`[^`\n]*`)|<!--[\s\S]*?(?:-->|$)")


def strip_html_comments(text: str) -> str:
    return _CODE_OR_COMMENT_RE.sub(lambda m: m.group(1) or "", text)


def plain_text_preview(text: str | None, max_len: int) -> str:
    """주석 제거 → 공백/개행 정규화 → max_len 절삭(넘치면 `…`)."""
    normalized = " ".join(strip_html_comments(text or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"


# story #4190(유나 site 초안 카드 · PO 판정 2026-09-23) — 결재 화면 블로그 초안 카드의 본문 앞부분. FE는 파싱하지
# 않고(카드에 `#`·`**`·`[](...)`가 그대로 보이면 안 된다) BE가 기호를 걷은 평문을 준다.
SITE_DRAFT_BODY_PREVIEW_MAX = 300

_MD_FENCE_LINE_RE = re.compile(r"^\s*(```|~~~).*$", re.MULTILINE)
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_REF_LINK_RE = re.compile(r"\[([^\]]*)\]\[[^\]]*\]")
_MD_LINE_PREFIX_RE = re.compile(r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)", re.MULTILINE)
_MD_RULE_LINE_RE = re.compile(r"^\s*(?:[-*_]\s*){3,}$|^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$", re.MULTILINE)
_MD_HTML_TAG_RE = re.compile(r"</?[A-Za-z][^>]*>")
_MD_EMPHASIS_RE = re.compile(r"(\*\*|__|~~|\*|_|`)")


def markdown_plain_text_preview(text: str | None, max_len: int) -> str:
    """마크다운 → 평문 미리보기. 주석 제거(절삭 전) → 펜스 줄·구분선·표 구분 줄 제거 → 이미지·링크는 보이는 글자만 →
    줄머리 기호(제목·인용·목록) 제거 → 인라인 강조·코드 기호·HTML 태그·표 `|` 제거 → `plain_text_preview`와 같은 정규화·절삭.
    낱말 안의 `_`(snake_case)도 걷히지만 미리보기라 무해하다 — 기호가 새는 쪽이 사람 눈엔 더 큰 결함."""
    s = strip_html_comments(text or "")
    s = _MD_FENCE_LINE_RE.sub("", s)
    s = _MD_RULE_LINE_RE.sub("", s)
    s = _MD_IMAGE_RE.sub(r"\1", s)
    s = _MD_LINK_RE.sub(r"\1", s)
    s = _MD_REF_LINK_RE.sub(r"\1", s)
    s = _MD_LINE_PREFIX_RE.sub("", s)
    s = _MD_HTML_TAG_RE.sub("", s)
    s = _MD_EMPHASIS_RE.sub("", s)
    s = s.replace("|", " ")
    return plain_text_preview(s, max_len)
