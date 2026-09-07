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
  429/5xx 등 다른 분류로 넘어간다."""
from __future__ import annotations

_EXPIRED_SUBCODES = frozenset({463})
_REVOKED_SUBCODES = frozenset({458, 460, 467, 490})

_OAUTH_ERROR_TYPE = "OAuthException"
_OAUTH_ERROR_CODE = 190


def classify_graph_oauth_error(
    *, error_code: int | None, error_subcode: int | None, error_type: str | None,
) -> tuple[str, str] | None:
    """Graph API 오류 응답의 `error.code`·`error.error_subcode`·`error.type`을
    연결 (status, reason) 튜플로 매핑한다 — 둘 다 "expired"|"revoked"|"error" 중
    하나(GA4 커넥션의 status/reason 어휘, story #3583과 같은 축).

    code==190이 아니고 type도 "OAuthException"이 아니면 이 함수의 관할이 아니라
    None을 반환한다 — 이 오류가 아예 OAuth/권한 계열이 아니라는 뜻이므로 호출부가
    별도 분류(429 rate limit, 5xx provider 오류 등)로 넘어가야 한다."""
    if error_code != _OAUTH_ERROR_CODE and error_type != _OAUTH_ERROR_TYPE:
        return None
    if error_subcode in _EXPIRED_SUBCODES:
        return "expired", "expired"
    if error_subcode in _REVOKED_SUBCODES:
        return "revoked", "revoked"
    return "error", "error"
