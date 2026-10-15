import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_RT_COOKIE, getServerSession } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { safeJsonParse } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/logout-others — story #4630: every other signed-in device of this person ends, this browser stays */
export async function POST(request: Request): Promise<Response> {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const session = await getServerSession();
  if (!session?.access_token) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const fastapiRes = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/logout-others`, {
    // story #4320 — 다른 기기 로그인 끊기 — 보낸 뒤엔 끝까지(logout과 같은 꼴). 시간 제한만.
    timeLimitOnly: true,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    // this session's refresh token: the backend keeps exactly that one (story #4400 · switch-org)
    body: JSON.stringify({ refresh_token: (await cookies()).get(SP_RT_COOKIE)?.value ?? null }),
  });

  const json = await safeJsonParse(fastapiRes) as {
    data?: { sessions_ended?: number; kept_this?: boolean };
    error?: { code: string; message: string };
  };
  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json(
      { error: json.error ?? { code: 'LOGOUT_OTHERS_FAILED', message: `HTTP ${fastapiRes.status}` } },
      { status: fastapiRes.ok ? 502 : fastapiRes.status },
    );
  }
  return NextResponse.json({ data: { sessions_ended: json.data.sessions_ended ?? null, kept_this: json.data.kept_this === true } });
}
