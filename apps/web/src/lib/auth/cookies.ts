import { SESSION_CHANGED_HEADER } from './session-changed-header';

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

/** story #3204 — 가입 출처 first-touch 쿠키 이름(proxy.ts가 세팅·register/oauth 콜백
 * route.ts가 읽고 BE로 relay). 카디르 QA(PR#3612) — 가입 성공 직후 반드시 지워야 한다
 * (안 지우면 같은 브라우저에서 재가입 시 前 계정의 옛 귀속이 새 계정에 오염된다). 이름을
 * 한 곳에 두어 세팅(proxy.ts)·소비+삭제(register/oauth route.ts) 세 자리가 드리프트하지
 * 않게 한다. */
export const SIGNUP_ATTRIBUTION_COOKIE_NAMES = [
  'sp_attr_src', 'sp_attr_medium', 'sp_attr_campaign', 'sp_attr_ref',
] as const;

/**
 * story #4762 — a response that sets or clears the session cookies (`sp_at` · `sp_rt`) carries this header. The page's global fetch gate
 * (`installProjectHeaderInterceptor`) sees it on any same-origin `/api/` response and tells the phone shell once (`session-changed`), so the shell writes the
 * cookies to disk now: an app killed seconds after a token rotation must not wake up with the old token (measured on an Android phone: the sign-up token,
 * with no organization claim, stayed on disk → `/api/v2/me` 404 `membership_elsewhere` → a Next 404 at `/glance`). The guard test
 * `session-cookie-routes.guard.test.ts` makes every route that writes `sp_at` call `markSessionChanged`, so a new session road cannot forget it.
 * Document navigations that set cookies (the OAuth callback and hand-offs, the proxy's own refresh) are not fetches — the shell writes those out when the page finishes loading.
 */
export { SESSION_CHANGED_HEADER };

export function markSessionChanged<T extends { headers: Headers }>(res: T): T {
  res.headers.set(SESSION_CHANGED_HEADER, '1');
  return res;
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
