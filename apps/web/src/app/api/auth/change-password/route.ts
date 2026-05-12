import { NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth-helpers';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** PATCH /api/auth/change-password */
export async function PATCH(request: Request) {
  const me = await getAuthContext(request);
  if (!me) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  const body = await request.json() as { current_password: string; new_password: string };
  const spAt = request.headers.get('cookie')?.match(/sp_at=([^;]+)/)?.[1] ?? '';

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/change-password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spAt}` },
    body: JSON.stringify({ current_password: body.current_password, new_password: body.new_password }),
  });

  const json = await fastapiRes.json() as Record<string, unknown>;
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Failed' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] ?? { message: 'ok' } });
}
