// story 4904 — «renew once, then read again» for a document navigation. The authenticated layout (a server component: it cannot write cookies) reads `/api/v2/me` and
// may find a token minted before the person's organization existed (404 `membership_elsewhere` — the same new account in a second window creates/joins the organization
// in the first one). One refresh issues a token with the right organization claim (measured: the same stale token → `/api/me` 404, after one refresh → 200). This road
// does that refresh and sends the browser back to the page; the layout reads again. Only if it is STILL none does the layout call the session expired.
// Loop guard: the road leaves `sp_renew_tried` (60 s) — while it is there the layout does not come back here.
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { decodeJwt } from 'jose';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase, markSessionChanged, SP_AT_MAX_AGE_SECONDS, SP_RENEW_TRIED_COOKIE, SP_RENEW_TRIED_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { buildLoginRedirect, safeNextPath } from '@/lib/auth/session-redirect';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { ACTIVE_ACCOUNT_COOKIE } from '@/lib/auth/account-vault';
import { isRecentlySuperseded } from '@/lib/auth/switch-epoch';
import { safeJsonParse } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';
import { fastapiBaseUrl } from '@/lib/fastapi-url';
import { resolveAppUrl } from '@/services/app-url';

const TOKEN_SUPERSEDED = 'TOKEN_SUPERSEDED';

/**
 * The page to go back to: an internal path (`/x…`, not `//` · `/\\`) that is not an API road. `searchParams.get` has already decoded the value ONCE (the layout encoded it once),
 * so it is used as it is — a second decode (what `safeNextPath` does for the login page's own param) would turn `?story=a%26b` into `?story=a&b`. Anything else is the chat home.
 * An `/api/…` target is refused so `next=/api/auth/renew` can never send the road back to itself.
 */
/** the app's own safe landing (the place the sign-in falls to when it has no usable `next`) — not a literal flat link written here (story #4226 ratchet) */
const landing = (): string => safeNextPath(null, readNavV3FlagsFromEnv());

function internalPage(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/api/') || /[\r\n]/.test(raw)) return landing();
  return raw;
}

/** GET /api/auth/renew?next=<path> — one refresh, then back to `next` (an internal page only; anything else is the chat home) */
export async function GET(request: Request) {
  // the base is the app's own origin, not request.url (on Cloud Run request.url holds the internal bind address — same reason as auth/oauth-handoff)
  const base = resolveAppUrl(null);
  const next = internalPage(new URL(request.url).searchParams.get('next'));
  const toLogin = () => NextResponse.redirect(`${base}${buildLoginRedirect(next)}`, 303);

  const cookieStore = await cookies();
  // the marker means «one renewal was just done for this browser»: the road itself honours it, so a link that points at the road (or a cross-site page that fires it again and again)
  // cannot rotate the refresh token more than once a minute, and the layout↔road pair cannot loop whatever the layout does.
  if (cookieStore.get(SP_RENEW_TRIED_COOKIE)?.value) return toLogin();
  const refreshToken = cookieStore.get(SP_RT_COOKIE)?.value;
  if (!refreshToken) return toLogin();

  let fastapiRes: Response;
  try {
    fastapiRes = await backendFetch(`${fastapiBaseUrl()}/api/v2/auth/refresh`, {
      timeLimitOnly: true, // 시간 제한만 — a refresh token is single-use: do not abandon the call while the new one is on its way (story #4320)
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    return toLogin(); // not confirmed: the cookies stay (same rule as the refresh road · story 4778)
  }

  const json = await safeJsonParse(fastapiRes) as { data?: { access_token?: unknown; refresh_token?: unknown }; error?: { code?: string } } | null;
  const accessToken = typeof json?.data?.access_token === 'string' ? json.data.access_token : '';
  const newRefreshToken = typeof json?.data?.refresh_token === 'string' ? json.data.refresh_token : '';
  if (!fastapiRes.ok || !accessToken || !newRefreshToken) {
    const res = toLogin();
    // only an answer that says the token is DEAD (a 401 that is not «superseded») clears the cookies — the same line as the refresh road
    if (fastapiRes.status === 401 && json?.error?.code !== TOKEN_SUPERSEDED) {
      res.cookies.set(SP_AT_COOKIE, '', { ...cookieBase(), maxAge: 0 });
      res.cookies.set(SP_RT_COOKIE, '', { ...cookieBase(), maxAge: 0 });
      markSessionChanged(res);
    }
    return res;
  }

  // multi-account (the proxy's `refreshMatchesActive`, same two checks): a renewal whose account is not the active one — the person switched accounts while this request was in flight,
  // or the account was just superseded by a switch — must not overwrite the cookies of the account they are on now. The cookies stay; the layout's old answer (the sign-in) applies.
  const sub = (() => { try { return decodeJwt(accessToken).sub; } catch { return undefined; } })();
  const pointer = cookieStore.get(ACTIVE_ACCOUNT_COOKIE)?.value;
  if (!sub || isRecentlySuperseded(sub) || (pointer && pointer !== sub)) return toLogin();

  const res = NextResponse.redirect(`${base}${next}`, 303);
  res.cookies.set(SP_AT_COOKIE, accessToken, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, newRefreshToken, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  res.cookies.set(SP_RENEW_TRIED_COOKIE, '1', { ...cookieBase(), maxAge: SP_RENEW_TRIED_MAX_AGE_SECONDS });
  return markSessionChanged(res);
}
