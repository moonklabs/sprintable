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
- code!=190이면(아래 3605 정정 뒤로는 type과 무관하게) 이 함수의 관할이 아니다
  (None) — 호출부가 429/5xx 등 다른 분류로 넘어간다.

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
  넣는 것은 항상 PO 確定을 거친다(추측으로 넓히지 않는다).

⛔story #3605 CHANGES-1(유나 코드 리뷰 재확認, 페드루 PO 채택 2026-09-07) —
family 문을 `error_type == "OAuthException"` 단독으로도 열던 자리(원래 #3598
코드 그대로 물려받은 것)가 심각한 자해 잠금이었다. Graph는 한도 초과(4·17·32·
613)·잘못된 파라미터(100)·일시 장애(1·2) 등 **이 family가 전혀 아닌 오류도
전부 `type: "OAuthException"`으로 싣는다**(Meta 오류 응답 형 — code만이 실제로
그 오류의 «종류»를 가른다, type은 그 아래 인증 관련 하위체계 전체의 공통
포장지에 가깝다). type 단독 통과를 열어 두면 한도 초과 한 번이 "error"로
떨어져 CHANNEL_CONNECTION_AUTH_ERROR→CONNECTION kind→connection.status="error"
→ 화면이 "다시 연결"을 요구하는 자해 잠금이 된다(정확히 이 스토리 §37~44가
막으려던 그 시나리오를 이 스토리 자신이 다시 열어 놨던 것).

처방 — family 판정은 **code 소속으로만**(190 / 10 / 200..299), type은 더 이상
문을 여는 조건이 아니다(190 밖에서 type만 보고 통과시키는 경로 삭제). 한도
초과 코드는 판정 맨 앞에서 명시적으로 걸러 그 사실 자체를 코드로 고정한다
(`_RATE_LIMIT_CODES`를 정의만 하고 실제로 읽지 않던 것도 이 정정으로 해소)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import httpx

    from app.models.channel_connection import ChannelConnection

_EXPIRED_SUBCODES = frozenset({463})
_REVOKED_SUBCODES = frozenset({458, 460, 467, 490})

_OAUTH_ERROR_CODE = 190

# story #3605 — code==10(권한 없음)·200~299(permission error 대역)도 이 family에
# 속한다(그라운딩: Meta 문서 인용은 이 모듈 docstring 참고).
_PERMISSION_ERROR_CODE = 10
_PERMISSION_ERROR_RANGE = range(200, 300)
# story #3605 CHANGES-1 — 이 family에서 명시적으로 배제하는 한도 초과 코드.
# classify_graph_oauth_error 맨 앞에서 실제로 읽는다(#3605 원판은 이 상수를
# 정의만 하고 어디서도 참조하지 않아 «검증된 배제»가 아니라 «문서 주장」에
# 불과했다 — 유나 코드 리뷰가 이 갭을 실측으로 잡았다).
_RATE_LIMIT_CODES = frozenset({4, 17, 32, 613})


def classify_graph_oauth_error(
    *, error_code: int | None, error_subcode: int | None, error_type: str | None,
) -> tuple[str, str] | None:
    """Graph API 오류 응답의 `error.code`·`error.error_subcode`를 연결 (status,
    reason) 튜플로 매핑한다 — 둘 다 "expired"|"revoked"|"error" 중 하나(GA4
    커넥션의 status/reason 어휘, story #3583과 같은 축).

    story #3605 CHANGES-1 — family 판정은 **code 소속으로만**(190 / 10 /
    200..299) 이뤄진다. `error_type`은 더 이상 문을 여는 조건이 아니다(파라미터
    자체는 그대로 받되 판정에 안 쓴다 — 호출부 시그니처 무변경, 회귀 0) — Graph가
    한도 초과·파라미터 오류 등 이 family가 전혀 아닌 오류도 전부 `type:
    "OAuthException"`으로 싣기 때문(모듈 docstring ⛔ 참고). 한도 초과 코드는
    맨 앞에서 명시적으로 배제한다.

    code==190·10·200..299 중 어느 것도 아니면(한도 초과 코드 포함) 이 함수의
    관할이 아니라 None을 반환한다 — 호출부가 별도 분류(429 rate limit, 5xx
    provider 오류 등)로 넘어가야 한다."""
    if error_code in _RATE_LIMIT_CODES:
        return None
    if error_code == _OAUTH_ERROR_CODE:
        if error_subcode in _EXPIRED_SUBCODES:
            return "expired", "expired"
        if error_subcode in _REVOKED_SUBCODES:
            return "revoked", "revoked"
        return "error", "error"
    # story #3605 — permission family(10·200~299)는 subcode 체계가 190처럼
    # 표준화돼 있지 않아 항상 error(사유 불명, fail-closed)로만 떨어진다.
    if error_code == _PERMISSION_ERROR_CODE or error_code in _PERMISSION_ERROR_RANGE:
        return "error", "error"
    return None


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


def sticky_connection_status(current: str, new: str) -> str:
    """story #3605 CHANGES-2(유나 §13-9 ④-2, 페드루 PO 채택 2026-09-07) — connection.
    status가 "되돌아가지 않는다"는 사실 하나를 이 함수 하나로 고정한다. 이 규율이
    한때 두 곳에 따로 구현돼 있었다(`connection_status_for_error_code`는 expired·
    revoked를 서로도 안 덮게 sticky했는데, `channel_connection.apply_connection_
    failure`는 `status=="error"`일 때만 막고 expired↔revoked는 서로 덮게 뒀다 —
    같은 사실을 두 규칙으로 말하면 하나는 거짓이다). 이제 두 소비처 다 이 함수만
    쓴다.

    규율(유나 표 그대로 — 「active 아니면 그대로」로 줄이면 error→expired 승급이
    죽는다, 반드시 3구간):
    - current가 "active"(첫 실패)면 new를 그대로 쓴다.
    - current가 "error"(사유 불명)면, new가 "error"가 아닌 한(더 구체적인 정보)
      그 값으로 올린다 — "error"→"error"는 그대로 무해.
    - current가 "expired" 또는 "revoked"(이미 확정된 구체적 사실)면 new가
      무엇이든 절대 안 바꾼다 — 이 둘은 서로도 안 덮는다. status="active"로
      되돌리는 대입(재연결 upsert·자격 교체·apply_refresh_result)이 전부
      `mark_connection_recovered`(아래, story #3633) 하나로 last_error·
      last_error_code·last_error_at 3종까지 같이 지우므로, 이 얼음은 한 실패
      국면 안에서만 서고 "지금도 실패하나"는 그 3종이 진다(#3960)."""
    if current in ("revoked", "expired"):
        return current
    if current == "error" and new == "error":
        return current
    return new


def connection_status_for_error_code(error_code: str | None, *, current_status: str) -> str:
    """story #3605 — connection.status 승격 지점 4곳(publication_command.py::
    apply_command_failure·channel_post_comments.py::_promote_connection_status·
    insight_snapshots.py::_promote_connection_status_for_snapshot·향후 추가될
    자리)이 전부 이 함수 하나로 값을 고른다. 이전엔 4곳 전부 error_code를 무시하고
    항상 "expired"로 하드코딩돼 있어, CHANNEL_CONNECTION_REVOKED/CHANNEL_CONNECTION_
    AUTH_ERROR가 이 분기에 와도 "expired"로 뭉개지는 결함이 반복됐다(3605 실측
    그라운딩 — 등재만 하고 이 매핑을 안 고치면 반쪽 수리라는 교훈). 되돌아가지
    않기 규율 자체는 `sticky_connection_status`(공유 단일 지점, CHANGES-2)."""
    new_status = CONNECTION_ERROR_CODE_TO_STATUS.get(error_code, "expired")
    return sticky_connection_status(current_status, new_status)


def mark_connection_recovered(connection: "ChannelConnection") -> None:
    """story #3633(BE·소형·신뢰, 페드루 PO 確定 2026-09-07) — non-active→active 복귀
    (재연결 upsert·자격 교체·자동 토큰 갱신 성공) 경로 3곳이 각자 `status="active"`·
    `last_error=None`만 대입하고 3603이 더한 `last_error_code`·`last_error_at`은
    안 지웠다(dev 실측: Sandbox Page 1 재연결 뒤에도 API가 옛 CHANNEL_CONNECTION_
    NOT_ACTIVE 코드를 계속 돌려줌 — "활성인데 오류 코드가 붙은" 반쪽 상태, 3605
    sticky·3612 선검사·FE 칩이 그 옛 코드를 "지금도 실패 中"으로 오독할 수 있다).

    `sticky_connection_status`(위)와 짝 — 그쪽은 "실패로 갈 때 어떤 status를
    고르나", 이건 "복귀할 때 실패 흔적 4종을 다 지운다"를 한 자리로 고정한다.
    세 호출부(channel_connection.py::upsert_channel_connection의 재연결 분기·
    replace_channel_connection_credential·apply_refresh_result)가 전부 이
    함수 하나로 통일 — 새 판정자 발명 0, 그냥 "지우는 목록"이 넷으로 늘었을 뿐."""
    connection.status = "active"
    connection.last_error = None
    connection.last_error_code = None
    connection.last_error_at = None


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
