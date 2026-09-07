"""story #3598(BE·중형, PO 確定 2026-09-06) — Graph API 190/OAuthException
error_subcode → 연결 status/reason(expired|revoked|error) 공용 매핑. IG·FB·threads
어댑터가 전부 이 함수 하나를 쓴다(파서 조립점 1곳 — 어댑터별로 각자 판정 로직을
새로 짓지 않는다).

디디 3595 측정 표(4f7f6d33) 발견 — backend/app에 error_subcode·190·OAuthException
파싱이 0건이라 「권한 회수」·「페이지 연결 해제」·「앱 비활성」 3사건이 미감지였고,
401/403이면 무조건 «만료»로 뭉개졌다(threads_publish.classify_threads_error 참고).
이 모듈은 그 자리를 codes==190 세계 안에서 더 정확히 가른다.

subcode 그라운딩(PO 코드 확認 2026-09-06 15:36Z, 스토리 본문 確定①에 그대로 못박힌
목록 — 458 앱 권한 없음/460 비번 변경/463 만료/467 무효/490 등):
- 463(세션/토큰 만료) → expired — 유일하게 "시간이 지나서" 저절로 일어나는 자연
  만료. 갱신하면 풀리는 유일한 부류(FB의 «갱신 대신 무효화 감지» 결론과 이 부류가
  갈리는 지점 — 3598 확定③).
- 458(앱 권한 없음)·460(비밀번호 변경)·467(무효)·490(사용자가 앱 권한 취소) →
  revoked — 전부 "시간"이 아니라 사용자/보안 행동으로 세션이 무효화된 부류. 자동
  갱신으로 풀리지 않고 반드시 재인증이 필요하다는 점에서 463과 다른 부류.
- code==190·type=="OAuthException"은 맞는데 subcode가 위 목록에 없으면(미지
  subcode, 향후 Meta가 새 subcode를 추가하는 경우 포함) → error — "인증 계열
  실패인 건 확실하지만 정확한 사유는 모른다"로 fail-closed(만료·회수를 섣불리
  단정하지 않는다 — AC6 「알 수 없는 오류는 CONNECTION kind로 fail-closed, reason만
  모른다」와 같은 원칙).
- code!=190 이고 type!="OAuthException"이면 이 함수의 관할이 아니다(None) — 호출부가
  429/5xx 등 다른 분류로 넘어간다.

story #3605(3598 AC6 일반화, PO 確定 2026-09-07 · 유나 §22-16류 6-정정 「한 방향
문」) — Graph API 권한/인증 계열 오류 family를 190/OAuthException 밖으로 넓힌다:
- code==10(Meta 문서: "Application does not have permission for this action" —
  앱 자체가 그 액션에 필요한 권한이 없다는 뜻, OAuthException과는 다른 최상위
  error.code지만 같은 「사람이 재연결/재승인해야 풀리는」 계열) → error(사유
  세분화 불가 — 10은 subcode 체계가 190처럼 표준화돼 있지 않아 expired/revoked를
  섣불리 못 가른다, fail-closed).
- code in 200..299(Meta 문서: 이 대역 전체가 "Permission error" 계열 — 페이지
  권한 부족·필요 확장 권한 없음 등 세부 code가 다양해 여기서 전부 개별 매핑하지
  않는다) → error(같은 이유로 세분화 불가, fail-closed).
- ⛔한도 초과(rate limit) 코드는 이 family가 «아니다» — 4(Application request
  limit reached)·17(User request limit reached)·32(Page request limit
  reached)·613(Calls to this api have exceeded the rate limit) 전부 200..299
  밖이라 구조적으로 이 함수에 안 걸린다(우연이 아니라 검증됨 — 아래 테스트).
  「연결 상태 승격은 사람이 고칠 수 있는 원인에만」(재연결) — 한도 초과는 시간이
  지나면 스스로 풀리는 별도 축이라 절대 이 family에 넣지 않는다(한 방향 문 —
  되돌아오는 길이 사람뿐이므로 사람이 못 고치는 원인을 넣으면 조직이 스스로
  잠긴다).
- 알 수 없는(미지) code — 여전히 None(이 함수의 관할 밖). 새 code를 이 family에
  넣는 것은 항상 PO 確定을 거친다(추측으로 넓히지 않는다)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import httpx

_EXPIRED_SUBCODES = frozenset({463})
_REVOKED_SUBCODES = frozenset({458, 460, 467, 490})

_OAUTH_ERROR_TYPE = "OAuthException"
_OAUTH_ERROR_CODE = 190

# story #3605 — code==10(권한 없음)·200~299(permission error 대역)도 이 family에
# 속한다(그라운딩: Meta 문서 인용은 이 모듈 docstring 참고). ⛔rate-limit 코드
# (4·17·32·613)는 이 범위 밖이라는 사실 자체가 이 family를 좁게 유지하는 방어선 —
# 새 코드를 이 상수들에 추가할 때마다 rate-limit 코드와 안 겹치는지 재확認할 것.
_PERMISSION_ERROR_CODE = 10
_PERMISSION_ERROR_RANGE = range(200, 300)
_RATE_LIMIT_CODES = frozenset({4, 17, 32, 613})


def classify_graph_oauth_error(
    *, error_code: int | None, error_subcode: int | None, error_type: str | None,
) -> tuple[str, str] | None:
    """Graph API 오류 응답의 `error.code`·`error.error_subcode`·`error.type`을
    연결 (status, reason) 튜플로 매핑한다 — 둘 다 "expired"|"revoked"|"error" 중
    하나(GA4 커넥션의 status/reason 어휘, story #3583과 같은 축).

    code==190·type=="OAuthException"·code==10·code in 200..299 중 어느 것도
    아니면 이 함수의 관할이 아니라 None을 반환한다 — 이 오류가 아예 이 family가
    아니라는 뜻이므로 호출부가 별도 분류(429 rate limit, 5xx provider 오류 등)로
    넘어가야 한다."""
    is_oauth_family = error_code == _OAUTH_ERROR_CODE or error_type == _OAUTH_ERROR_TYPE
    is_permission_family = (
        error_code == _PERMISSION_ERROR_CODE or error_code in _PERMISSION_ERROR_RANGE
    )
    if not is_oauth_family and not is_permission_family:
        return None
    # story #3605 — permission family(10·200~299)는 subcode 체계가 190처럼
    # 표준화돼 있지 않아 항상 error(사유 불명, fail-closed)로만 떨어진다 — expired/
    # revoked 세분화는 190 전용(아래 subcode 매핑은 여기 안 닿는다).
    if is_oauth_family:
        if error_subcode in _EXPIRED_SUBCODES:
            return "expired", "expired"
        if error_subcode in _REVOKED_SUBCODES:
            return "revoked", "revoked"
    return "error", "error"


def classify_graph_error_code(
    *, status_code: int, provider_error_code: int | None, provider_error_subcode: int | None,
    provider_error_type: str | None,
) -> str:
    """story #3605 — `classify_graph_oauth_error`의 결과를 이 코드베이스의 공유
    error_code 문자열(`publication_command.py::classify_failure_kind`가 아는
    어휘)로 옮기는 단일 지점. IG/FB/Threads 발행(`channel_posts.py::
    _classify_threads_error`)과 댓글 수집(`channel_post_comments.py`, 이전엔 각자
    401/403만 보고 따로 판정하던 걸 이 스토리에서 하나로 합침) 둘 다 이 함수 하나를
    쓴다 — 같은 Graph 오류가 소비처에 따라 다른 kind로 갈리는 드리프트를 원천
    차단한다(story #3405/#3406과 동일 사상, "판정 로직 두 곳에 각자 안 짠다").

    파서가 관할 밖(None)이면 기존 401/403/429 상태코드 휴리스틱으로 폴백 —
    비-Meta 오류·malformed body 대비(회귀 0)."""
    oauth_reason = classify_graph_oauth_error(
        error_code=provider_error_code, error_subcode=provider_error_subcode, error_type=provider_error_type,
    )
    if oauth_reason is not None:
        status, _reason = oauth_reason
        if status == "expired":
            return "CHANNEL_TOKEN_EXPIRED"
        if status == "revoked":
            return "CHANNEL_CONNECTION_REVOKED"
        return "CHANNEL_CONNECTION_AUTH_ERROR"
    if status_code in (401, 403):
        return "CHANNEL_TOKEN_EXPIRED"
    if status_code == 429:
        return "CHANNEL_RATE_LIMITED"
    return "CHANNEL_PUBLISH_PROVIDER_ERROR"


# story #3605 — CONNECTION kind로 승격할 때 ChannelConnection.status(active|expired|
# revoked|error)를 어떤 값으로 남길지. 매핑 밖 코드(CHANNEL_TOKEN_EXPIRED·
# CHANNEL_CONNECTION_NOT_ACTIVE·CHANNEL_PUBLISH_AUTH_REJECTED 등, wordpress/webhook
# 등 Graph 밖 도메인 포함)는 기존 그대로 "expired"(회귀 0) — 이 스토리에서 새로
# 추가한 두 코드만 정확한 값을 갖는다.
CONNECTION_ERROR_CODE_TO_STATUS: dict[str, str] = {
    "CHANNEL_CONNECTION_REVOKED": "revoked",
    "CHANNEL_CONNECTION_AUTH_ERROR": "error",
}


def connection_status_for_error_code(error_code: str | None, *, current_status: str) -> str:
    """story #3605 — connection.status 승격 지점 4곳(publication_command.py::
    apply_command_failure·channel_post_comments.py::_promote_connection_status·
    insight_snapshots.py::_promote_connection_status_for_snapshot·향후 추가될
    자리)이 전부 이 함수 하나로 값을 고른다. 이전엔 4곳 전부 error_code를 무시하고
    항상 "expired"로 하드코딩돼 있어, CHANNEL_CONNECTION_REVOKED/CHANNEL_CONNECTION_
    AUTH_ERROR가 이 분기에 와도 "expired"로 뭉개지는 결함이 반복됐다(3605 실측
    그라운딩 — 등재만 하고 이 매핑을 안 고치면 반쪽 수리라는 교훈).

    ⚠️정밀도 규율(기존 4곳의 `not in ("revoked", "error")` 가드를 일반화한 것,
    새 기전 발명 아님 — 목표 status가 여럿으로 늘어난 이 스토리에서 그 가드를
    그대로 옮기다 처음엔 "error"만 보호하도록 좁게 썼다가, 기존 테스트(연결이
    이미 revoked인데 다른 코드가 "expired"로 매핑되는 경우 그대로 revoked로
    남아야 한다 — test_3597_ig_fb_connection_status_promote.py::test_facebook_
    connection_failure_does_not_downgrade_revoked_or_error)가 그 좁힘이 회귀임을
    실측으로 잡았다):
    - current_status가 "revoked" 또는 "expired"(이미 확정된 구체적 사실)면 새
      값이 무엇이든 절대 안 바꾼다 — 이 둘은 서로도 안 덮는다(기존 프로덕션 코드가
      "expired" 하나만 목표값이던 시절부터 지켜 온 그대로의 sticky 규율).
    - current_status가 "error"(사유 불명)면, 새 값이 "error"가 아닌 한(더 구체적인
      정보) 그 값으로 올린다 — "error"→"error"는 그대로 무해.
    - current_status가 "active"(첫 실패)면 새 값을 그대로 쓴다."""
    new_status = CONNECTION_ERROR_CODE_TO_STATUS.get(error_code, "expired")
    if current_status in ("revoked", "expired"):
        return current_status
    if current_status == "error" and new_status == "error":
        return current_status
    return new_status


def parse_graph_error_envelope(resp: "httpx.Response") -> tuple[int | None, int | None, str | None]:
    """story #3605 — Graph 표준 오류 envelope(`{"error": {"code","error_subcode",
    "type",...}}`)에서 3필드를 뽑는다. threads_publish.py::error_from_response의
    내부 파싱 로직을 그대로 옮긴 것(새 판정 로직 0) — 그 함수는 이제 이 함수를
    호출해 `ThreadsPublishError`를 조립하고, insight_snapshots.py의 3개 fetch
    함수(_fetch_threads·_fetch_instagram·_fetch_facebook — 이전엔 `resp.json()`의
    `error` 키를 아예 안 읽고 status_code만 보던 자리)도 이 함수로 직접 envelope을
    읽는다. envelope이 없거나(malformed body·비-JSON 응답) `error` 키가 dict가
    아니면 3필드 전부 None — 지어내지 않는다(호출부의 기존 status_code 휴리스틱
    폴백이 그 경우를 계속 담당)."""
    code: int | None = None
    subcode: int | None = None
    error_type: str | None = None
    try:
        err: Any = resp.json().get("error")
    except Exception:
        err = None
    if isinstance(err, dict):
        code = err.get("code")
        subcode = err.get("error_subcode")
        error_type = err.get("type")
    return code, subcode, error_type
