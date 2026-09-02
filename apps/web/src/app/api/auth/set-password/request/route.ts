import { NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth-helpers';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/set-password/request — OAuth 전용 사용자 최초 비밀번호 설정 1단계
 * (확인 이메일 발송, 아직 DB write 없음 — story #ab2a503f 재인증 게이트). */
export async function POST(request: Request) {
  const me = await getAuthContext(request);
  if (!me) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  const body = await request.json() as { new_password: string };
  const spAt = request.headers.get('cookie')?.match(/sp_at=([^;]+)/)?.[1] ?? '';

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/set-password/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spAt}` },
    body: JSON.stringify({ new_password: body.new_password }),
  });

  const json = await fastapiRes.json() as Record<string, unknown>;
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Failed to send confirmation email' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] ?? { delivered: true } });
}
