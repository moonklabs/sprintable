"""story #4336(PO 05:24Z 조건 2) — 공급자 호출 전 검사(preflight) 오류의 **한 가지 본문**.

즉시 발행 요청은 이 검사에 걸리면 422로 바로 돌려주고, 요청 때 통과했는데 워커에서 걸리면(그 사이 예산 소진 · 할당량 · 글자 수)
명령 행에 같은 사실을 남긴다(`publication_commands.failure_detail`). 두 길이 같은 본문을 내도록 여기 한 곳에서 짓는다:

- `preflight_error_facts(exc)` — DB에 남기는 사실(코드 · 숫자 · 풀리는 시각 · 시간대). 언어에 묶인 문장은 넣지 않는다.
- `preflight_error_body(facts, locale)` — 요청 응답 · 초안 상세가 내보내는 본문(사실 + 그 언어의 문장). 라우터 422와 초안 상세의
  `command_failure_detail`이 같은 함수를 거쳐 글자까지 같다.
"""
from __future__ import annotations


def preflight_error_facts(exc: Exception) -> dict | None:
    """이 예외가 화면이 숫자 배너를 그리는 preflight 오류면 그 사실(JSON 직렬화 가능), 아니면 None."""
    from app.services.channel_posts import ChannelTextTooLongError
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
    return None


def preflight_error_body(facts: dict | None, locale: str) -> dict | None:
    """사실 → 응답 본문(요청 422 · 초안 상세 공용). YouTube 할당량은 그 언어의 완성 문장을 덧붙인다(화면은 서버 문장 그대로)."""
    if not facts:
        return None
    body = {k: v for k, v in facts.items() if k != "reset_timezone"}
    if facts.get("code") == "YOUTUBE_QUOTA_EXCEEDED":
        from app.services.i18n_catalog import TIMEZONE_DISPLAY_NAMES, t

        tz_display = TIMEZONE_DISPLAY_NAMES[facts["reset_timezone"]][locale]
        body = {
            "code": "YOUTUBE_QUOTA_EXCEEDED",
            "message": t("channel_posts.youtube_usage_exceeded", locale, tz_display=tz_display),
            **{k: v for k, v in body.items() if k != "code"},
        }
    return body

