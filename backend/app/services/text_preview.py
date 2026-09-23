"""story #4182 — 사용자 본문을 잘라 미리보기로 내보내는 자리(알림 summary/body·백링크 스니펫·
활동 content_preview·문서 발췌·게이트 문서 요약)의 공용 평문화.

외부 동기화(Linear 등)가 본문 앞에 심는 비가시 HTML 주석(`<!-- linear-comment-id … -->`)이
절삭된 미리보기에 원문 그대로 새던 결함. 주석 제거를 **절삭보다 먼저** 한다 — 그래야
절삭 지점에 걸린 주석이 `<!-- linear-comm…`처럼 반쯤 남는 일이 없다. 저장 데이터는 안
바꾼다(생성 시점 미리보기에만 적용).
"""

from __future__ import annotations

import re

# 코멘트 알림(comment.created) body 길이 — stories·visual_artifacts 공용.
COMMENT_NOTIFICATION_PREVIEW_MAX = 200

# 닫히지 않은 `<!--`(원문 자체가 잘려 들어온 경우)는 문자열 끝까지 제거한다.
_HTML_COMMENT_RE = re.compile(r"<!--[\s\S]*?(?:-->|$)")


def strip_html_comments(text: str) -> str:
    return _HTML_COMMENT_RE.sub("", text)


def plain_text_preview(text: str | None, max_len: int) -> str:
    """주석 제거 → 공백/개행 정규화 → max_len 절삭(넘치면 `…`)."""
    normalized = " ".join(strip_html_comments(text or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[:max_len].rstrip() + "…"
