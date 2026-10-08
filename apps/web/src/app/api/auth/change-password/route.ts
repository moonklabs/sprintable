import { NextResponse } from 'next/server';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase } from '@/lib/auth/cookies';
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
    body: JSON.stringify({ current_password: body.current_password, new_password: body.new_password }),
  });

  const json = await safeJsonParse(fastapiRes);
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Failed' } }, { status: fastapiRes.status });
  }
  // story #4630 (PO 10:18Z · option (b)) — the backend ended every session, this one too: this browser signs out now, as at
  // logout, rather than on its next refresh
  const res = NextResponse.json({ data: json['data'] ?? { message: 'ok' } });
  const gone = { ...cookieBase(), maxAge: 0 };
  res.cookies.set(SP_AT_COOKIE, '', gone);
  res.cookies.set(SP_RT_COOKIE, '', gone);
  return res;
}
