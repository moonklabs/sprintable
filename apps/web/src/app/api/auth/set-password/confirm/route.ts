import { NextResponse } from 'next/server';
import { safeJsonParse } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/set-password/confirm — 2단계(이메일 링크 클릭이 연다). 토큰 자체가
 * 증명이라 인증 불요(verify-email 프록시와 동형 패턴). */
export async function POST(request: Request) {
  const body = await request.json() as { token: string };
  const fastapiRes = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/set-password/confirm?token=${encodeURIComponent(body.token)}`, {
    // story #4320 — 한 번 쓰는 확인 토큰 소비 — 끝까지. 시간 제한만.
    timeLimitOnly: true,
    method: 'GET',
  });
  const json = await safeJsonParse(fastapiRes);
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'CONFIRM_FAILED', message: 'Confirmation failed' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] ?? { message: 'ok' } });
}
