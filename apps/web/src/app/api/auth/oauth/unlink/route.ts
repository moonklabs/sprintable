import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAuthContext } from '@/lib/auth-helpers';
import { SP_AT_COOKIE } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/oauth/unlink — story #3122 AC3, {provider} 연결 해제(최소 1개 로그인
 * 수단 보장은 BE가 매번 재계산해 강제한다 — 이 라우트는 순수 프록시). */
export async function POST(request: Request) {
  const me = await getAuthContext(request);
  if (!me) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  const body = await request.json() as { provider?: string };
  const provider = body.provider;
  if (!provider || !['google', 'apple'].includes(provider)) {
    return NextResponse.json({ error: { code: 'INVALID_PROVIDER', message: 'Unsupported provider' } }, { status: 400 });
  }

  const cookieStore = await cookies();
  const spAt = cookieStore.get(SP_AT_COOKIE)?.value ?? '';

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/oauth/${provider}/unlink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${spAt}` },
  });

  const json = await fastapiRes.json() as Record<string, unknown>;
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Failed to unlink' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] });
}
