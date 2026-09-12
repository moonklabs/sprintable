"""story #3816(Phase3·3-6 PR2, 페드루 PO 確定 2026-09-12) — 공용 마크다운→HTML
변환. Ghost Admin API `?source=html`이 HTML 계약이라(마크다운 문법을 그대로
넘기면 글에 문법이 노출된다) 새로 도입했다. 표준 Python-Markdown(`markdown`
PyPI 패키지) 하나만 쓴다(신규 판정 로직 0, 라이브러리 위임) — `fenced_code`
확장으로 코드 블록(```)을 지원하고, 라이브러리 기본 동작이 이미 원본에 섞인
raw HTML 블록을 그대로 통과시킨다(별도 처리 불요, Ghost가 최종적으로 자체
sanitize한다).

이 함수는 BE 공용이라 이름에 채널을 안 붙인다 — 클래스 정정(같은 커밋,
페드루 PO 지적 2026-09-12 14:21Z)으로 wordpress_publish.py도 이 함수를
재사용한다(WordPress REST의 `content`도 같은 HTML 계약 — raw body_md를
그대로 보내던 잔존 결함이었다). webhook_publish.py는 손대지 않는다(그쪽
`content`는 고객이 직접 소비하는 payload 계약 축이라 이 스토리의 "우리
provider가 HTML을 기대한다" 축과 다른 성격)."""
from __future__ import annotations

import markdown

# fenced_code — ``` 코드 블록 지원(기본 markdown은 4-space 들여쓰기 블록만 인식).
_EXTENSIONS = ["fenced_code"]


def render_markdown_html(body_md: str) -> str:
    """마크다운 원문을 HTML로 변환한다. 빈 문자열 입력은 빈 문자열을 그대로
    반환(Python-Markdown 자체가 이미 이렇게 동작 — 특별 분기 불요)."""
    return markdown.markdown(body_md, extensions=_EXTENSIONS)
