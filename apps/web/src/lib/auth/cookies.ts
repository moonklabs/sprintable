/**
 * sp_at(access) 쿠키 maxAge(초). AC2b(551bbbee): BE access TTL 60분(#1577)과 일치. ⚠️ refresh **빈도를
 * 결정하는 게 이 쿠키 maxAge** — 쿠키가 15분에 만료되면 JWT 가 60분이어도 15분마다 refresh 강제
 * (rotation 레이스 빈도 그대로). sp_at 를 set 하는 **모든 경로(7곳)**가 이 상수를 써야 드리프트
 * (일부만 15분 잔존) 방지. sp_rt(30일)는 별개.
 */
export const SP_AT_MAX_AGE_SECONDS = 60 * 60;

/** APP_BASE_URL 또는 NEXT_PUBLIC_APP_URL 기준으로 Secure 쿠키 여부 결정.
 *  HTTP(localhost, Tailscale, ngrok 등)에서는 false, HTTPS에서는 true.
 */
function isSecureScheme(): boolean {
  const appUrl = process.env['APP_BASE_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'] ?? '';
  return appUrl.startsWith('https://');
}

export function cookieBase(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  domain?: string;
} {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return {
    httpOnly: true,
    secure: isSecureScheme(),
    sameSite: 'lax',
    path: '/',
    ...(domain ? { domain } : {}),
  };
}
