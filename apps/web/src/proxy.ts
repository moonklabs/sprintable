import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_EXACT = [
  '/',
  '/llms.txt',
  '/llms-full.txt',
  '/llms-baos.txt',
];

const PUBLIC_PREFIX = [
  '/api/',
  '/login',
  '/signup',
  '/forgot-password',
  '/auth/callback',
  '/auth/login',
  '/invite',
  '/internal-dogfood',
];

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

function isOssMode(): boolean {
  return process.env['OSS_MODE'] === 'true';
}

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

function applyTokenCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string,
): void {
  const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  const base = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  };
  response.cookies.set(SP_AT_COOKIE, accessToken, { ...base, maxAge: 15 * 60 });
  response.cookies.set(SP_RT_COOKIE, refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 });
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isOssMode()) {
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/inbox';
      return NextResponse.redirect(url);
    }
    if (pathname === '/login' || pathname.startsWith('/auth/callback')) {
      const url = request.nextUrl.clone();
      url.pathname = '/inbox';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  const isPublicPath =
    PUBLIC_EXACT.includes(pathname) ||
    PUBLIC_PREFIX.some((prefix) => pathname.startsWith(prefix));

  if (isPublicPath) {
    return NextResponse.next({ request });
  }

  // Agent API keys are for MCP/HTTP API only — block UI route access
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return new NextResponse(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Agent API keys cannot access UI routes' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const accessToken = request.cookies.get(SP_AT_COOKIE)?.value;

  if (!accessToken) {
    const tokens = await tryRefreshViaFastapi(request);
    if (!tokens) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    const response = NextResponse.next({ request });
    applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    return response;
  }

  const claims = await verifyAccessToken(accessToken);

  if (!claims) {
    // access token invalid/expired — try refresh before redirecting
    const tokens = await tryRefreshViaFastapi(request);
    if (!tokens) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    const response = NextResponse.next({ request });
    applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    return response;
  }

  // Proactive refresh if expiring within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const response = NextResponse.next({ request });
  if (claims.exp !== undefined && claims.exp - now < 300) {
    const tokens = await tryRefreshViaFastapi(request);
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
