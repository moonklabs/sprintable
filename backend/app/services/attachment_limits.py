"""첨부 크기 상한 — 한 곳에만 정의한다(story 4646).

사람이 올리는 첨부의 전체 상한. conversations.py가 이 값을 import해 쓰고, 읽기 경로도 같은 객체를 쓴다
(값 복사 금지 — 두 숫자가 어긋나는 사고를 구조로 막는다).
"""

HUMAN_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024  # 100MB (사람 업로드 · 기존 _MAX_ATTACHMENT_SIZE와 같은 값)
