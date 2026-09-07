"""story #3598(BE·중형, PO 確定 2026-09-06) — `_classify_threads_error`(channel_posts.py,
IG·FB·threads가 공유하는 유일한 오류 분류점)가 `classify_graph_oauth_error`(공용 파서)를
먼저 상담해 code==190/OAuthException을 expired|revoked로 세분화하는지 순수 함수 단위
테스트. DB 불요(connection_id는 uuid만 있으면 되고, 함수 자체가 동기·부수효과 없음) —
test_3411_text_preview_pure.py와 동형 관례.

`error_from_response()`(threads_publish.py, 어댑터 3종이 공유)의 Graph 오류 envelope
파싱도 같이 검증한다."""
from __future__ import annotations

import uuid

import httpx

from app.services.channel_posts import (
    ChannelConnectionRevokedError,
    ChannelPublishProviderError,
    ChannelTokenExpiredError,
    _classify_threads_error,
)
from app.services.threads_publish import ThreadsPublishError, error_from_response

_CONN_ID = uuid.uuid4()


def _exc(*, status_code: int, provider_error_code=None, provider_error_subcode=None, provider_error_type=None):
    return ThreadsPublishError(
        "THREADS_CREATE_CONTAINER_FAILED", "provider said no", status_code=status_code,
        provider_error_code=provider_error_code, provider_error_subcode=provider_error_subcode,
        provider_error_type=provider_error_type,
    )


def test_subcode_463_classifies_as_channel_token_expired_not_revoked():
    """자연 만료(463) — 기존 CHANNEL_TOKEN_EXPIRED 그대로(회귀 0, 새 클래스 아님)."""
    exc = _exc(status_code=401, provider_error_code=190, provider_error_subcode=463, provider_error_type="OAuthException")
    error_code, mapped = _classify_threads_error(exc, connection_id=_CONN_ID)
    assert error_code == "CHANNEL_TOKEN_EXPIRED"
    assert type(mapped) is ChannelTokenExpiredError


def test_subcode_490_classifies_as_channel_connection_revoked():
    """490(사용자가 앱 권한 취소) — 신설 CHANNEL_CONNECTION_REVOKED·전용 클래스로."""
    exc = _exc(status_code=401, provider_error_code=190, provider_error_subcode=490, provider_error_type="OAuthException")
    error_code, mapped = _classify_threads_error(exc, connection_id=_CONN_ID)
    assert error_code == "CHANNEL_CONNECTION_REVOKED"
    assert isinstance(mapped, ChannelConnectionRevokedError)


def test_revoked_error_is_still_a_channel_token_expired_error_so_old_except_clauses_catch_it():
    """⭐AC4 핵심 — 화면 문장은 기존 needs_reauth 낱말 재사용(새 낱말 0)이 성립하려면
    라우터·publication_command.py의 기존 `except ChannelTokenExpiredError` 절이 신규
    except 절 없이도 이 예외를 잡아야 한다 — 상속 관계가 그 전제(뮤테이션 표적: 상속을
    끊으면 이 assert가 RED)."""
    exc = _exc(status_code=401, provider_error_code=190, provider_error_subcode=458, provider_error_type="OAuthException")
    _, mapped = _classify_threads_error(exc, connection_id=_CONN_ID)
    assert isinstance(mapped, ChannelTokenExpiredError)


def test_unknown_subcode_under_oauth_exception_falls_through_to_existing_401_heuristic():
    """code==190/OAuthException인데 subcode가 미지(AC6 이전 — error 버킷은 아직 이
    분기에서 직접 처리 안 함, 다음 커밋 몫) → 기존 401 휴리스틱으로 폴스루해
    CHANNEL_TOKEN_EXPIRED(회귀 0, 미분류 revoked/error로 잘못 새지 않는다)."""
    exc = _exc(status_code=401, provider_error_code=190, provider_error_subcode=999, provider_error_type="OAuthException")
    error_code, mapped = _classify_threads_error(exc, connection_id=_CONN_ID)
    assert error_code == "CHANNEL_TOKEN_EXPIRED"
    assert type(mapped) is ChannelTokenExpiredError


def test_non_oauth_5xx_error_is_unchanged_provider_error():
    """code==190도 아니고 OAuthException도 아닌 일반 5xx — 기존 CHANNEL_PUBLISH_
    PROVIDER_ERROR 그대로(회귀 0 — 파서 도입이 무관한 오류까지 건드리면 안 된다)."""
    exc = _exc(status_code=500, provider_error_code=1, provider_error_subcode=None, provider_error_type="GraphMethodException")
    error_code, mapped = _classify_threads_error(exc, connection_id=_CONN_ID)
    assert error_code == "CHANNEL_PUBLISH_PROVIDER_ERROR"
    assert isinstance(mapped, ChannelPublishProviderError)


def test_401_without_parseable_error_envelope_still_falls_back_to_token_expired():
    """provider_error_*가 전부 None(malformed body·비-JSON 응답 등 파싱 실패) — 기존
    401 휴리스틱이 유일한 근거로 계속 동작한다(회귀 0)."""
    exc = _exc(status_code=401)
    error_code, mapped = _classify_threads_error(exc, connection_id=_CONN_ID)
    assert error_code == "CHANNEL_TOKEN_EXPIRED"


def test_error_from_response_parses_graph_error_envelope():
    """error_from_response()가 표준 Graph 오류 envelope에서 code·error_subcode·type을
    정확히 뽑아 ThreadsPublishError에 싣는지(어댑터 3종이 공유하는 유일한 파싱 지점)."""
    resp = httpx.Response(
        400, json={"error": {"message": "Invalid OAuth access token", "type": "OAuthException", "code": 190, "error_subcode": 460}},
        request=httpx.Request("POST", "https://graph.threads.net/v1.0/x/threads"),
    )
    exc = error_from_response("THREADS_CREATE_CONTAINER_FAILED", resp)
    assert exc.provider_error_code == 190
    assert exc.provider_error_subcode == 460
    assert exc.provider_error_type == "OAuthException"
    assert exc.status_code == 400


def test_error_from_response_tolerates_non_json_body_without_crashing():
    """envelope이 없는(비-JSON) 응답 — 3필드 전부 None, message/status_code는 기존
    그대로(지어내지 않는다·크래시 0)."""
    resp = httpx.Response(
        502, text="upstream timeout", request=httpx.Request("POST", "https://graph.threads.net/v1.0/x/threads"),
    )
    exc = error_from_response("THREADS_CREATE_CONTAINER_FAILED", resp)
    assert exc.provider_error_code is None
    assert exc.provider_error_subcode is None
    assert exc.provider_error_type is None
    assert exc.status_code == 502
    assert exc.message == "upstream timeout"
