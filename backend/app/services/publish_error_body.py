"""story #4336(PO 05:24Z 조건 2) — 공급자 호출 전 검사(preflight) 오류의 **한 가지 본문**.

즉시 발행 요청은 이 검사에 걸리면 422로 바로 돌려주고, 요청 때 통과했는데 워커에서 걸리면(그 사이 예산 소진 · 할당량 · 글자 수)
명령 행에 같은 사실을 남긴다(`publication_commands.failure_detail`). 두 길이 같은 본문을 내도록 여기 한 곳에서 짓는다:

- `preflight_error_facts(exc)` — DB에 남기는 사실(코드 · 숫자 · 풀리는 시각 · 시간대). 언어에 묶인 문장은 넣지 않는다.
- `preflight_error_body(facts, locale)` — 요청 응답 · 초안 상세가 내보내는 본문(사실 + 그 언어의 문장). 라우터 422와 초안 상세의
  `command_failure_detail`이 같은 함수를 거쳐 글자까지 같다.
"""
from __future__ import annotations


def preflight_error_facts(exc: Exception) -> dict | None:
    """이 예외가 공급자 호출 전 검사(preflight) 실패면 그 사실(JSON 직렬화 가능), 아니면 None.

    PO P2(09:08Z) — **모든** preflight 실패가 본문을 남긴다(예산 · 할당량 · 글자 수만이 아니라 봉인 · 승인 · 일시 중지 · 연결 · 메타데이터 ·
    이어쓰기 · 초안 없음까지) — 사용자가 왜 안 나갔는지 알 길. 종류 전수는 `test_4336_preflight_error_body_classes.py`가 preflight가 실제로
    던지는 예외 타입(AST)과 대조한다."""
    from app.services.channel_posts import (
        ChannelConnectionNotActiveError,
        ChannelPostDraftNotFoundError,
        ChannelPostReapprovalRequiredError,
        ChannelPostSealMissingError,
        ChannelTextTooLongError,
        ChannelThreadSegmentLimitExceededError,
        ChannelThreadSegmentTooLongError,
        ChannelThreadUnsupportedError,
        ChannelYouTubeMetadataError,
        ExternalPublishGateNotApprovedError,
    )
    from app.services.external_publish_pause import ExternalPublishPausedError
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.x_publish_budget import API_USAGE_BUDGET_RULE_KEY
    from app.services.youtube_quota import YouTubeQuotaExceededError

    if isinstance(exc, GenerationBudgetExceededError):
        return {
            "code": "API_USAGE_BUDGET_EXCEEDED" if exc.rule_key == API_USAGE_BUDGET_RULE_KEY else "GENERATION_BUDGET_EXCEEDED",
            "limit_minor": exc.limit_minor, "spent_minor": exc.spent_minor,
            "estimated_cost_minor": exc.estimated_cost_minor, "remaining_minor": exc.remaining_minor,
        }
    if isinstance(exc, YouTubeQuotaExceededError):
        return {
            "code": "YOUTUBE_QUOTA_EXCEEDED",
            "limit_units": exc.limit_units, "spent_units": exc.spent_units,
            "estimated_units": exc.estimated_units, "remaining_units": exc.remaining_units,
            "reset_at": exc.reset_at.isoformat(), "reset_timezone": exc.reset_timezone,
        }
    if isinstance(exc, ChannelTextTooLongError):
        return {
            "code": "CHANNEL_TEXT_TOO_LONG", "message": str(exc),
            "max_length": exc.max_length, "current_length": exc.current_length,
        }
    if isinstance(exc, ChannelYouTubeMetadataError):
        return {"code": "YOUTUBE_METADATA_INVALID", "field": exc.field, "reason": exc.reason}
    if isinstance(exc, ChannelThreadUnsupportedError):
        return {"code": "CHANNEL_THREAD_UNSUPPORTED", "channel": exc.channel}
    if isinstance(exc, ChannelThreadSegmentLimitExceededError):
        return {
            "code": "CHANNEL_THREAD_SEGMENT_LIMIT_EXCEEDED",
            "max_segments": exc.max_segments, "current_count": exc.current_count,
        }
    if isinstance(exc, ChannelThreadSegmentTooLongError):
        return {
            "code": "CHANNEL_THREAD_SEGMENT_TOO_LONG", "segment_number": exc.segment_number,
            "max_length": exc.max_length, "current_length": exc.current_length,
        }
    # 나머지는 예전 응답 그대로 코드 + 예외 문장(라우터 409 · 403 · 423 · 404 본문과 같은 모양).
    for exc_type, code in (
        (ChannelPostDraftNotFoundError, "CHANNEL_POST_DRAFT_NOT_FOUND"),
        (ExternalPublishGateNotApprovedError, "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"),
        (ExternalPublishPausedError, "EXTERNAL_PUBLISH_PAUSED"),
        (ChannelPostSealMissingError, "SITE_POST_SEAL_MISSING"),
        (ChannelPostReapprovalRequiredError, "SITE_POST_REAPPROVAL_REQUIRED"),
        (ChannelConnectionNotActiveError, "CHANNEL_CONNECTION_NOT_ACTIVE"),
    ):
        if isinstance(exc, exc_type):
            return {"code": code, "message": str(exc)}
    return None


# 사실만으로는 문장이 없는 코드 — 요청의 언어로 짓는 문장 키(화면은 서버 문장 그대로 · `api-error.ts` labelKey 비움).
_LOCALIZED_MESSAGE_KEYS = {
    "YOUTUBE_METADATA_INVALID": "channel_posts.youtube_metadata_invalid",
    "CHANNEL_THREAD_UNSUPPORTED": "channel_posts.thread_unsupported",
    "CHANNEL_THREAD_SEGMENT_LIMIT_EXCEEDED": "channel_posts.thread_over_cap",
    "CHANNEL_THREAD_SEGMENT_TOO_LONG": "channel_posts.thread_segment_too_long",
}


def preflight_error_body(facts: dict | None, locale: str) -> dict | None:
    """사실 → 응답 본문(요청 4xx · 초안 상세 공용). 문장이 언어에 묶인 코드(YouTube 할당량 · 메타데이터 · 이어쓰기)는 그 언어의 완성
    문장을 `message`로 덧붙인다(화면은 서버 문장 그대로)."""
    if not facts:
        return None
    from app.services.i18n_catalog import TIMEZONE_DISPLAY_NAMES, t

    body = {k: v for k, v in facts.items() if k != "reset_timezone"}
    code = facts.get("code")
    if code == "YOUTUBE_QUOTA_EXCEEDED":
        tz_display = TIMEZONE_DISPLAY_NAMES[facts["reset_timezone"]][locale]
        message = t("channel_posts.youtube_usage_exceeded", locale, tz_display=tz_display)
    elif code in _LOCALIZED_MESSAGE_KEYS:
        message = t(
            _LOCALIZED_MESSAGE_KEYS[code], locale,
            max=facts.get("max_segments", facts.get("max_length")),
            segment=facts.get("segment_number"), current=facts.get("current_length"),
        )
    else:
        return body
    return {"code": code, "message": message, **{k: v for k, v in body.items() if k != "code"}}
