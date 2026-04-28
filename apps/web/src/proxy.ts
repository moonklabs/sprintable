import { createServerClient } from '@supabase/ssr';
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

function isOssMode(): boolean {
  return process.env['OSS_MODE'] === 'true';
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // OSS_MODE: bypass Supabase auth entirely (AC-1, AC-4, AC-5)
  if (isOssMode()) {
    // / → /inbox (AC-4) — operator cockpit first screen (Phase A3)
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/inbox';
      return NextResponse.redirect(url);
    }

    // /login, /auth/callback → /inbox (AC-5)
    if (pathname === '/login' || pathname.startsWith('/auth/callback')) {
      const url = request.nextUrl.clone();
      url.pathname = '/inbox';
      url.search = '';
      return NextResponse.redirect(url);
    }

    // all other paths pass through — no Supabase auth check
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

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options: Record<string, unknown> }>) {
          const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, {
              ...(options as Parameters<typeof supabaseResponse.cookies.set>[2]),
              ...(cookieDomain ? { domain: cookieDomain } : {}),
            });
          }
        },
      },
    },
  );

  // 로컬 JWT 파싱 — 네트워크 zero (JWKS 캐시 활용)
  const { data: claimsData } = await supabase.auth.getClaims();

  if (!claimsData?.claims) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // exp 만료 임박(5분 이내)일 때만 refreshSession() 호출
  const exp = (claimsData.claims as { exp?: number }).exp;
  const now = Math.floor(Date.now() / 1000);
  if (exp !== undefined && exp - now < 300) {
    await supabase.auth.refreshSession();
  }

  if (request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/inbox';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
