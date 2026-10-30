import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { apiSuccess, safeJsonParse } from '@/lib/api-response';
import { cookieBase, SP_AT_MAX_AGE_SECONDS, markSessionChanged } from '@/lib/auth/cookies';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { backendFetch } from '@/lib/backend-fetch';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { fastapiBaseUrl } from '@/lib/fastapi-url';

type RouteParams = { params: Promise<{ token: string }> };

const FASTAPI_URL = () => fastapiBaseUrl();

/**
 * story 4722 — a token-proven accept makes the membership, but the session the person already holds was issued before it (a sign-up whose address is
 * not proved yet gets no auto-accept, so its access token names no organization and `/me` finds none). Rotate the session here, in the same response,
 * so the next page already sees the organization — the same rotation the client does after the onboarding form (`/api/auth/refresh`). A refresh that
 * fails changes nothing: the accept has already happened, and the next ordinary refresh brings the organization in. A 401 from this refresh (a dead
 * refresh token) is deliberately NOT turned into a cookie wipe here, unlike `/api/auth/refresh`: the person's access token just proved a valid session by
 * making the accept, and the ordinary refresh path clears a dead `sp_rt` itself the next time it runs.
 */
async function rotateSessionInto(res: NextResponse): Promise<void> {
  const refreshToken = (await cookies()).get(SP_RT_COOKIE)?.value;
  if (!refreshToken) return;
  const refreshed = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/refresh`, {
    timeLimitOnly: true, // story #4320 — 리프레시 토큰은 한 번 쓰는 값: 브라우저가 끊어도 끝까지 가야 한다(끊으면 새 토큰을 잃는다) — 시간 제한만.
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }).catch(() => null);
  if (!refreshed?.ok) return;
  const json = await safeJsonParse(refreshed) as { data?: { access_token?: string; refresh_token?: string } };
  const at = json?.data?.access_token;
  const rt = json?.data?.refresh_token;
  if (!at || !rt) return;
  res.cookies.set(SP_AT_COOKIE, at, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, rt, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  markSessionChanged(res); // story 4762 — the page's fetch gate tells the phone shell (the invitation-acceptance road)
}

export async function POST(request: Request, { params }: RouteParams) {
  // story 4722: this route now also rotates the session cookies, so a request from another origin is refused before anything happens (same check as /api/auth/refresh;
  // a request with neither Origin nor Referer — a non-browser caller — passes, as there)
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;
  const { token } = await params;
  // Backend: POST /api/v2/invites/accept with body {token} (not path param)
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token }),
  });
  const _r = await proxyToFastapi(syntheticRequest, '/api/v2/invites/accept', {
    // story #4320(까디르 QA ③) — 초대 토큰을 소비해 가입 · 합류한다(예전엔 합성 Request라 우연히 취소가 안 넘어갔다 — 이제 명시) — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
  });
  if (!_r.ok) return _r;
  if (_r.status === 204) {
    const res = apiSuccess({ ok: true });
    await rotateSessionInto(res);
    return res;
  }
  const res = apiSuccess(await _r.json());
  await rotateSessionInto(res);
  return res;
}
