import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { cookieBase } from '@/lib/auth/cookies';

const PUBLIC_EXACT = [
  '/',
  '/llms.txt',
  '/llms-full.txt',
  '/llms-baos.txt',
];

// Fully public paths — no token check at all
const PUBLIC_PREFIX = [
  // Auth endpoints — open by design
  '/api/auth/',
  '/api/oss/',
  '/api/webhook/',
  // Public doc share (b1574f5a) — unauthenticated token-based viewer + its data proxy
  '/api/public/',
  // UI public routes
  '/share/',
  '/login',
  '/signup',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/auth/callback',
  '/auth/login',
  '/invite',
  '/internal-dogfood',
  '/terms',
  '/privacy',
];

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

function getJwtSecretBytes(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? '';
  return new TextEncoder().encode(secret);
}

async function verifyAccessToken(token: string): Promise<{ exp?: number } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    if (payload['type'] !== 'access') return null;
    return { exp: payload.exp };
  } catch {
    return null;
  }
}

async function tryRefreshViaFastapi(request: NextRequest): Promise<{ accessToken: string; refreshToken: string } | null> {
  const rt = request.cookies.get(SP_RT_COOKIE)?.value;
  if (!rt) return null;

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  try {
    const res = await fetch(`${fastapiUrl}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { access_token: string; refresh_token: string } };
    const tokens = json.data;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  } catch {
    return null;
  }
}

// AC1(551bbbee): single-flight refresh. refresh 는 single-use rotation(첫 건이 RT revoke)이라, 대시보드
// 동시요청이 같은 RT 로 각자 refresh 하면 첫 건만 통과·나머지 401 → 강제 로그아웃("세션 너무 짧음")이던
// 레이스를 제거. RT 기준 in-flight 1개로 dedupe(나머지는 그 결과 await/재사용) — 실제 refresh 호출은 1회라
// single-use 보안 유지. grace(시작 기준 5s) 동안 결과 캐시 — cookie 갱신 전 도착한 burst 꼬리 요청도 옛 RT
// 로 새 refresh 하지 않고 재사용. setTimeout 미사용(edge 런타임서 post-response 실행 불확실) — timestamp
// lazy 만료 + size-cap prune(무한증가 방지).
const REFRESH_GRACE_MS = 5_000;
const inflightRefresh = new Map<string, { p: Promise<{ accessToken: string; refreshToken: string } | null>; expiresAt: number }>();

function singleFlightRefresh(request: NextRequest): Promise<{ accessToken: string; refreshToken: string } | null> {
  const rt = request.cookies.get(SP_RT_COOKIE)?.value;
  if (!rt) return Promise.resolve(null);
  const now = Date.now();
  const existing = inflightRefresh.get(rt);
  if (existing && existing.expiresAt > now) return existing.p; // 진행 중 or 최근 결과 재사용
  const p = tryRefreshViaFastapi(request);
  inflightRefresh.set(rt, { p, expiresAt: now + REFRESH_GRACE_MS });
  if (inflightRefresh.size > 64) { // 만료 항목 lazy prune(무한증가 방지)
    for (const [k, v] of inflightRefresh) if (v.expiresAt <= now) inflightRefresh.delete(k);
  }
  return p;
}

function applyTokenCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string,
): void {
  const base = cookieBase();
  response.cookies.set(SP_AT_COOKIE, accessToken, { ...base, maxAge: 15 * 60 });
  response.cookies.set(SP_RT_COOKIE, refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 });
}

/** Rebuild request headers with updated sp_at/sp_rt so route handlers see fresh tokens */
function buildRefreshedHeaders(
  request: NextRequest,
  tokens: { accessToken: string; refreshToken: string },
): Headers {
  const headers = new Headers(request.headers);
  const existing = headers.get('cookie') ?? '';
  const replace = (str: string, name: string, value: string) =>
    str.includes(`${name}=`)
      ? str.replace(new RegExp(`${name}=[^;]*`), `${name}=${value}`)
      : str ? `${str}; ${name}=${value}` : `${name}=${value}`;
  headers.set('cookie', replace(replace(existing, SP_AT_COOKIE, tokens.accessToken), SP_RT_COOKIE, tokens.refreshToken));
  return headers;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const isPublicPath =
    PUBLIC_EXACT.includes(pathname) ||
    PUBLIC_PREFIX.some((prefix) => pathname.startsWith(prefix));

  if (isPublicPath) {
    return NextResponse.next({ request });
  }

  // Authenticated API routes — try token refresh but never redirect to /login
  const isApiPath = pathname.startsWith('/api/');

  // Agent API keys are for MCP/HTTP API only — block UI route access
  const authHeader = request.headers.get('Authorization');
  if (!isApiPath && authHeader?.startsWith('Bearer ')) {
    return new NextResponse(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Agent API keys cannot access UI routes' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const accessToken = request.cookies.get(SP_AT_COOKIE)?.value;

  if (!accessToken) {
    const tokens = await singleFlightRefresh(request);
    if (!tokens) {
      if (isApiPath) return NextResponse.next({ request }); // let handler return 401
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    const headers = buildRefreshedHeaders(request, tokens);
    const response = NextResponse.next({ request: { headers } });
    applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    return response;
  }

  const claims = await verifyAccessToken(accessToken);

  if (!claims) {
    // access token invalid/expired — try refresh
    const tokens = await singleFlightRefresh(request);
    if (!tokens) {
      if (isApiPath) return NextResponse.next({ request }); // let handler return 401
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    const headers = buildRefreshedHeaders(request, tokens);
    const response = NextResponse.next({ request: { headers } });
    applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    return response;
  }

  // Proactive refresh if expiring within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const response = NextResponse.next({ request });
  if (claims.exp !== undefined && claims.exp - now < 300) {
    const tokens = await singleFlightRefresh(request);
    if (tokens) {
      applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    }
  }

  if (pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/inbox';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
