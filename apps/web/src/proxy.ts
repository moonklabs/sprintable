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

  // OSS_MODE: bypass Supabase auth entirely
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

  // SaaS: Supabase 세션 검증 — @supabase/ssr dynamic import (Edge middleware 호환)
  const isPublicPath =
    PUBLIC_EXACT.includes(pathname) ||
    PUBLIC_PREFIX.some((prefix) => pathname.startsWith(prefix));

  if (isPublicPath) {
    return NextResponse.next({ request });
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return new NextResponse(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Agent API keys cannot access UI routes' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // SaaS overlay에서 provide하는 saas-proxy 모듈로 위임
  // OSS에서는 이 경로에 도달하지 않음 (isOssMode() = true 조건에서 처리)
  try {
    const { createServerClient } = await import('@supabase/ssr');
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

    const { data: claimsData } = await supabase.auth.getClaims();

    if (!claimsData?.claims) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }

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
  } catch {
    return NextResponse.next({ request });
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
