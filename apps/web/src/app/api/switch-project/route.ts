import { NextResponse } from 'next/server';
import { SP_AT_COOKIE, SP_RT_COOKIE, getServerSession } from '@/lib/db/server';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';
import { cookieBase } from '@/lib/auth/cookies';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const body = await request.json() as { project_id: string };
  if (!body.project_id) {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'project_id required' } }, { status: 400 });
  }

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/switch-project`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ project_id: body.project_id }),
  });

  const json = await fastapiRes.json() as {
    data?: { access_token: string; refresh_token: string; token_type: string; expires_in?: number };
    error?: { code: string; message: string };
  };

  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json(
      { error: json.error ?? { code: 'SWITCH_FAILED', message: `HTTP ${fastapiRes.status}` } },
      { status: fastapiRes.status },
    );
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: 15 * 60 });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  res.cookies.set(CURRENT_PROJECT_COOKIE, body.project_id, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  return res;
}
