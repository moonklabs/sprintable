export const runtime = 'nodejs';

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isEEEnabled } from '@/lib/ee-enabled';

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

/** API path prefixes that require an active EE license. */
const EE_API_PREFIXES = [
  '/api/billing',
  '/api/checkout',
  '/api/subscription/portal',
  '/api/webhooks/polar',
  '/api/webhooks/payment',
  '/api/v1/billing',
  '/api/usage',
] as const;

const EE_DISABLED_RESPONSE = new NextResponse(
  JSON.stringify({ error: { code: 'EE_NOT_ENABLED', message: 'Enterprise Edition not enabled. Set LICENSE_CONSENT=agreed.' } }),
  { status: 403, headers: { 'Content-Type': 'application/json' } },
);

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // EE gate — block SaaS-only API paths when LICENSE_CONSENT is not set
  if (EE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (!isEEEnabled()) return EE_DISABLED_RESPONSE;
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
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
