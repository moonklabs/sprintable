import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/forgot-password */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const body = await request.json() as { email: string };
  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email }),
  });

  const json = await fastapiRes.json() as Record<string, unknown>;
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Request failed' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] ?? { message: 'ok' } });
}
