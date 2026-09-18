// story #3376 — OAuth 콜백 라우트(app/api/oauth-channel/*)가 붙이는 `?connect_error=<code>`
// 쿼리를 사람 말로 매핑한다. Phase 0 content/api-error.ts와 동형 패턴(known-error 테이블
// +unknown 폴백, 여러 에러를 한 문구로 뭉치지 않는다).
const KNOWN_CONNECT_ERROR_KEYS: Record<string, string> = {
  CHANNEL_APP_CREDENTIALS_MISSING: 'channelConnectErrorAppCredentialsMissing',
  CHANNEL_OAUTH_STATE_INVALID: 'channelConnectErrorStateInvalid',
  CHANNEL_CONNECTION_OWNER_ONLY: 'channelConnectErrorOwnerOnly',
  OAUTH_MISSING_PARAMS: 'channelConnectErrorGeneric',
  // story #3407 — 사용자가 Meta 권한 화면에서 명시적으로 거부(error=access_denied,
  // error_reason=user_denied)한 경우 전용 문구. OAUTH_MISSING_PARAMS(일반 실패)로
  // 오진단되던 자리를 분리한다.
  OAUTH_PROVIDER_DENIED: 'channelConnectErrorProviderDenied',
  // story #3407 페드루 리뷰 — Meta가 같은 `error` 파라미터로 server_error·
  // temporarily_unavailable류도 보낸다. 그건 "사용자 거부"가 아니라 제공자 쪽 오류라
  // OAUTH_PROVIDER_DENIED로 뭉치면 그 자체가 또 다른 오진단이 된다 — 별도 코드로 가른다.
  OAUTH_PROVIDER_ERROR: 'channelConnectErrorProviderError',
  SESSION_EXPIRED: 'channelConnectErrorSessionExpired',
  INVALID_REQUEST: 'channelConnectErrorGeneric',
  CHANNEL_AUTHORIZE_FAILED: 'channelConnectErrorGeneric',
  CHANNEL_CALLBACK_FAILED: 'channelConnectErrorGeneric',
  // story #3450 FE 후속(3653a18c §2 "②발급해서 붙여넣기") — WordPress·webhook 연결
  // 폼(POST .../channel-connections/{wordpress|webhook})의 422/403 응답.
  WORDPRESS_FIELDS_REQUIRED: 'channelConnectErrorWordpressFieldsRequired',
  WEBHOOK_FIELDS_REQUIRED: 'channelConnectErrorWebhookFieldsRequired',
  // story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — 실 stibee 연결 폼
  // 422 응답 2종(필드 누락·auth-check 실패). 이 표에 없어 둘 다 channelConnectErrorGeneric
  // 으로 뭉개지던 결함(wordpress/webhook 형제는 이미 전용 키가 있었다)도 같은 PR에서 처방.
  STIBEE_FIELDS_REQUIRED: 'channelConnectErrorStibeeFieldsRequired',
  STIBEE_API_KEY_INVALID: 'channelConnectErrorStibeeApiKeyInvalid',
  // story #3813 PR5-a CHANGES(페드루 PO 確定 2026-09-12) — 스티비가 안 닿는 것
  // (네트워크·타임아웃·5xx)과 키가 틀린 것은 사람이 할 일이 다르다.
  STIBEE_AUTH_CHECK_UNAVAILABLE: 'channelConnectErrorStibeeAuthCheckUnavailable',
  // story #3816(Phase3·3-6 PR1, 페드루 PO 確定 2026-09-12) — Ghost 연결 폼 422
  // 응답 2종(필드 누락·site 검증 실패)+별도 코드(네트워크/5xx). stibee 3종과 동형.
  GHOST_FIELDS_REQUIRED: 'channelConnectErrorGhostFieldsRequired',
  GHOST_ADMIN_KEY_INVALID: 'channelConnectErrorGhostAdminKeyInvalid',
  // story #3816 CHANGES 1(페드루 PO 지목 2026-09-12) — site_url 오타·Ghost 아닌
  // 사이트(흔히 404)는 키 오류와 다른 처방(주소를 고쳐야 풀림).
  GHOST_SITE_NOT_FOUND: 'channelConnectErrorGhostSiteNotFound',
  GHOST_SITE_VERIFY_UNAVAILABLE: 'channelConnectErrorGhostSiteVerifyUnavailable',
  // 3653a18c §3-0 "사람 말을 위에, 원문은 접어" — SSRF 목적지 거부는 provider 원문
  // (DestinationURLUnsafeError 메시지, 영문·기술 용어)을 그대로 안 보여준다.
  CHANNEL_CONNECTION_DESTINATION_INSECURE: 'channelConnectErrorDestinationInsecure',
};

// story #3409 — CHANNEL_APP_CREDENTIALS_MISSING은 owner에게도 뜬다(앱 자격이 없으면
// owner도 연결을 시작 못 함). 화면 안(「앱 자격」 카드)을 가리키는 owner용 문구를 member가
// 읽으면 거짓이 된다(그 카드는 owner 전용, AppCredentialsCard) — role로 갈라 "누구에게
// 요청하나"를 정확히 말한다. 나머지 코드는 role 무관(테이블 그대로).
export function connectErrorLabelKey(code: string, isOwner: boolean): string {
  if (code === 'CHANNEL_APP_CREDENTIALS_MISSING' && !isOwner) {
    return 'channelConnectErrorAppCredentialsMissingMember';
  }
  return KNOWN_CONNECT_ERROR_KEYS[code] ?? 'channelConnectErrorGeneric';
}
