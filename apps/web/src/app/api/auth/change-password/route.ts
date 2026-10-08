import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { safeJsonParse } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** PATCH /api/auth/change-password */
export async function PATCH(request: Request) {
  const me = await getOrgProjectAuthContext(request);
  if (!me) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  const body = await request.json() as { current_password: string; new_password: string };
  const spAt = request.headers.get('cookie')?.match(/sp_at=([^;]+)/)?.[1] ?? '';

  const fastapiRes = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/change-password`, {
    request,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spAt}` },
    // story #4630 — this session's refresh token: the backend ends every other session and hands this one a new pair
    body: JSON.stringify({
      current_password: body.current_password, new_password: body.new_password,
      refresh_token: (await cookies()).get(SP_RT_COOKIE)?.value ?? null,
    }),
  });

  const json = await safeJsonParse(fastapiRes);
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Failed' } }, { status: fastapiRes.status });
  }
  const data = (json['data'] ?? { message: 'ok' }) as Record<string, unknown>;
  const { access_token, refresh_token, ...rest } = data;
  const res = NextResponse.json({ data: rest }); // the tokens go into this browser's cookies, never to the page
  if (typeof access_token === 'string' && typeof refresh_token === 'string') {
    res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
    res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  }
  return res;
}
