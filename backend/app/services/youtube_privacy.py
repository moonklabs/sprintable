"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — YouTube API 감사
미완=강제 비공개(PO 決定②) 판정의 단일 정본. `youtube_publish.py`(실제
videos.insert 요청 바디에 실을 값)와 `channel_posts.py` 오케스트레이션(발행물
행의 `privacy_locked` 열에 못박을 값) 둘 다 이 한 함수를 부른다 — 판정 로직이
두 곳에 따로 있으면 갈라질 수 있어(로직 이중선언은 이 팀 금기, [[behavior_
declared_one_place]]) 여기 하나로 좁힌다. DB 접근 0(순수 함수) — publish-client
모듈의 pure-HTTP-client 원칙을 안 깬다."""
from __future__ import annotations

from app.core.config import settings

_MARKER_PRIVACY_LOCKED = "[sandbox:youtube-privacy-locked]"


def resolve_youtube_privacy_lock(*, requested_privacy_status: str | None, text: str) -> tuple[str, bool]:
    """(privacy_status, privacy_locked). 잠금 조건 둘 — ①플랫폼 감사 미완 설정값
    (`settings.youtube_api_audit_incomplete`, 실 youtube/youtube_sandbox 공통)
    ②sandbox 결정적 마커(`[sandbox:youtube-privacy-locked]`, sandbox 왕복만
    타는 text 안 — 실 youtube 발행에선 이 문자열이 그냥 평범한 description
    내용일 뿐 아무 효과 없다, 마커 축은 sandbox 전용)."""
    if settings.youtube_api_audit_incomplete or _MARKER_PRIVACY_LOCKED in text:
        return "private", True
    return requested_privacy_status or "private", False
