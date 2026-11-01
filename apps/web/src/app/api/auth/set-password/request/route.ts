import { NextResponse } from 'next/server';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { safeJsonParse } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';
import { fastapiBaseUrl } from '@/lib/fastapi-url';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase, markSessionChanged } from '@/lib/auth/cookies';
import { isEmbeddedServer } from '@/lib/embedded-api-origin';

const FASTAPI_URL = () => fastapiBaseUrl();

/** POST /api/auth/set-password/request — OAuth 전용 사용자 최초 비밀번호 설정 1단계
 * (확인 이메일 발송, 아직 DB write 없음 — story #ab2a503f 재인증 게이트).
 *
 * story 4825 AC6 — 맥 앱의 자체 서버(앱이 켜는 임베디드 스위치, lib/embedded-api-origin.ts)에는 보낼 메일이 없다: 로그인한 주인이 그 자리에서 비밀번호를 정하는
 * `local-set-password`로 간다(백엔드가 모든 세션을 끝냄 → 이 브라우저도 change-password처럼 바로 로그아웃). 다른 배포는 그대로. */
export async function POST(request: Request) {
  const me = await getOrgProjectAuthContext(request);
  if (!me) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });

  const body = await request.json() as { new_password: string };
  const spAt = request.headers.get('cookie')?.match(/sp_at=([^;]+)/)?.[1] ?? '';

  if (isEmbeddedServer()) {
    const localRes = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/local-set-password`, {
      request,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spAt}` },
      body: JSON.stringify({ new_password: body.new_password }),
    });
    const localJson = await safeJsonParse(localRes);
    if (!localRes.ok) {
      return NextResponse.json({ error: localJson['error'] ?? { code: 'FAILED', message: 'Failed to set password' } }, { status: localRes.status });
    }
    const res = NextResponse.json({ data: { set: true } });
    const gone = { ...cookieBase(), maxAge: 0 };
    res.cookies.set(SP_AT_COOKIE, '', gone);
    res.cookies.set(SP_RT_COOKIE, '', gone);
    return markSessionChanged(res);
  }

  const fastapiRes = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/set-password/request`, {
    request,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${spAt}` },
    body: JSON.stringify({ new_password: body.new_password }),
  });

  const json = await safeJsonParse(fastapiRes);
  if (!fastapiRes.ok) {
    return NextResponse.json({ error: json['error'] ?? { code: 'FAILED', message: 'Failed to send confirmation email' } }, { status: fastapiRes.status });
  }
  return NextResponse.json({ data: json['data'] ?? { delivered: true } });
}
