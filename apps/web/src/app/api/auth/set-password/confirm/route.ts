import { NextResponse } from 'next/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/set-password/confirm — 2단계(이메일 링크 클릭이 연다). 토큰 자체가
 * 증명이라 인증 불요(verify-email 프록시와 동형 패턴). */
export async function POST(request: Request) {
  const body = await request.json() as { token: string };
  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/set-password/confirm?token=${encodeURIComponent(body.token)}`, {
    method: 'GET',
  });
  const json = await fastapiRes.json() as Record<string, unknown>;
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'CONFIRM_FAILED', message: 'Confirmation failed' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] ?? { message: 'ok' } });
}
