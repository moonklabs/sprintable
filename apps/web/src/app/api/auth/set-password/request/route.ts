import { NextResponse } from 'next/server';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { safeJsonParse } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';
import { fastapiBaseUrl } from '@/lib/fastapi-url';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase, markSessionChanged } from '@/lib/auth/cookies';
import { isEmbeddedServer } from '@/lib/embedded-api-origin';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';

const FASTAPI_URL = () => fastapiBaseUrl();

/** POST /api/auth/set-password/request — OAuth 전용 사용자 최초 비밀번호 설정 1단계
 * (확인 이메일 발송, 아직 DB write 없음 — story #ab2a503f 재인증 게이트).
 *
 * story 4825 AC6 — 맥 앱의 자체 서버(앱이 켜는 임베디드 스위치, lib/embedded-api-origin.ts)에는 보낼 메일이 없다: 로그인한 주인이 그 자리에서 비밀번호를 정하는
 * `local-set-password`로 간다(백엔드가 모든 세션을 끝냄 → 이 브라우저도 change-password처럼 바로 로그아웃). 다른 배포는 그대로. */
/** story 4825 AC6 (lens) — the app's own server sets a password on the strength of the window's cookies alone, and cookies do not tell one 127.0.0.1 port from another:
 * a page served from another port on this machine could post here with them. So the branch asks where the request comes from (same origin only — `verifyCsrfOrigin`, and a
 * `Sec-Fetch-Site` that says the request is not same-origin is refused) and what it is (a JSON body, not the `text/plain` a cross-origin form can send). `null` = go on. */
function sameHost(origin: string, host: string | null): boolean {
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function embeddedRequestRefusal(request: Request): NextResponse | null {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;
  // `verifyCsrfOrigin` also trusts a few fixed dev origins (localhost:3000 / :3108 …); this server answers one origin, its own: an Origin, when sent, must be this very host:port
  const origin = request.headers.get('origin');
  if (origin !== null && !sameHost(origin, request.headers.get('host'))) {
    return NextResponse.json({ error: { code: 'CSRF_FORBIDDEN', message: 'Invalid request origin' } }, { status: 403 });
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: { code: 'CSRF_FORBIDDEN', message: 'Invalid request origin' } }, { status: 403 });
  }
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return NextResponse.json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json' } }, { status: 415 });
  }
  return null;
}

export async function POST(request: Request) {
  if (isEmbeddedServer()) {
    const refusal = embeddedRequestRefusal(request);
    if (refusal) return refusal;
  }
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
