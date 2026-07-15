import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/refresh */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(SP_RT_COOKIE)?.value;
  if (!refreshToken) {
    return NextResponse.json({ error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token' } }, { status: 401 });
  }

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string }; error?: { code: string; message: string } };
  if (!fastapiRes.ok || !json.data) {
    // story e5225c0a(P0) 재진단: 이 route는 PUBLIC_PREFIX('/api/auth/')라 proxy.ts 미들웨어의
    // stale-cookie cleanup을 안 거친다 — 별도 실패 경로라 여기서도 동일하게 지워야 한다. 안 지우면
    // 클라이언트 401-인터셉터(fetchWithAuth)가 폴링 컴포넌트(예: dashboard-activity-timeline.tsx
    // 60s 간격)가 재요청할 때마다 이 route를 다시 때려 죽은 sp_rt로 무한 재시도(산티아고 prod 실측:
    // b0b55886 배포 후에도 /auth/refresh 401이 09:03~09:13 60s 간격 지속 — proxy.ts fix만으론 갭).
    const res = NextResponse.json(
      { error: json.error ?? { code: 'REFRESH_FAILED', message: 'Token refresh failed' } },
      { status: fastapiRes.status },
    );
    res.cookies.delete(SP_AT_COOKIE);
    res.cookies.delete(SP_RT_COOKIE);
    return res;
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
