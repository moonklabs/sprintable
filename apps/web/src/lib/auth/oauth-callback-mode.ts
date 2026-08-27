// story #3121 AC1(BFF/모바일 정합 절반) — 계약 doc e-mobile-oauth-native-handoff-contract §2/§10.7.
//
// iOS 17.4 미만은 ASWebAuthenticationSession의 legacy callbackURLScheme 경로로 가야 하고(모바일
// PR #71/#72), 그 경로가 실제로 https 리다이렉트를 못 잡아 custom scheme(`ai.sprintable`) 폴백
// 홉이 필요하다(apps/web `/native/oauth-return` 페이지·PR #3524). 어느 모드로 갈지는 모바일
// 셸이 OAuth 시작 "전"에 정적으로(OS 버전만 보고) 결정한다 — BFF는 그 선택을 전달만 하고,
// 실제 return_uri 문자열은 **여기서 고정값으로 계산**한다(클라가 임의 URI를 선언하게 두지
// 않는다 — BE `_expected_return_uri()`와 동일한 고정 매핑, byte-exact 유지가 계약).
//
// ⚠️custom_scheme 값은 모바일 App.js `OAUTH_RETURN_SCHEME_URL`·apps/web
// `/native/oauth-return/page.tsx`의 이동 대상과 byte-exact(`ai.sprintable:/oauth-return`,
// 단일 슬래시 — RFC 8252 opaque URI 형식). 세 곳 중 하나만 바뀌면 조용히 깨진다.

export type OAuthCallbackMode = 'https' | 'custom_scheme';

const CUSTOM_SCHEME_RETURN_URI = 'ai.sprintable:/oauth-return';
const NATIVE_RETURN_PATH = '/native/oauth-return';

export function isOAuthCallbackMode(value: string | null | undefined): value is OAuthCallbackMode {
  return value === 'https' || value === 'custom_scheme';
}

// appLinkOrigin: 호출자가 `APP_LINK_ORIGIN()`(callback/[provider]/route.ts 기존 값)을 넘긴다 —
// 새 소스를 안 만든다(이미 App Link 리다이렉트 목적지 계산에 쓰는 값과 동일 출처 유지).
export function expectedReturnUri(mode: OAuthCallbackMode, appLinkOrigin: string): string {
  return mode === 'custom_scheme' ? CUSTOM_SCHEME_RETURN_URI : `${appLinkOrigin}${NATIVE_RETURN_PATH}`;
}
