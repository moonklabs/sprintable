'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const SUPABASE_URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!;
const SUPABASE_ANON_KEY = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!;

function getProjectRef() {
  try { return new URL(SUPABASE_URL).hostname.split('.')[0]; } catch { return ''; }
}

function getCookieValue(name: string): string | undefined {
  const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

function removeCookie(name: string) {
  const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  document.cookie = `${name}=; Path=/; Max-Age=0${cookieDomain ? `; Domain=${cookieDomain}` : ''}`;
}

function writeSessionCookies(session: Record<string, unknown>) {
  const json = JSON.stringify(session);
  const CHUNK_SIZE = 3180;
  const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  const domainAttr = cookieDomain ? `; Domain=${cookieDomain}` : '';
  const COOKIE_BASE = `sb-${getProjectRef()}-auth-token`;
  document.cookie.split(';').forEach(c => {
    const name = c.trim().split('=')[0];
    if (name.startsWith(COOKIE_BASE + '.')) {
      document.cookie = `${name}=; Path=/; Max-Age=0${domainAttr}`;
    }
  });
  for (let i = 0; i * CHUNK_SIZE < json.length; i++) {
    const chunk = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    document.cookie = `${COOKIE_BASE}.${i}=${encodeURIComponent(chunk)}; Path=/; SameSite=Lax; Secure; Max-Age=604800${domainAttr}`;
  }
}

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = searchParams.get('auth_code');
    const next = searchParams.get('next');
    if (!code) { router.replace('/login?error=no_code'); return; }

    (async () => {
      try {
        const projectRef = getProjectRef();
        const CV_KEY = `sb-${projectRef}-auth-token-code-verifier`;

        let codeVerifier: string | null | undefined;

        try {
          const ssRaw = sessionStorage.getItem(CV_KEY);
          if (ssRaw) {
            try { codeVerifier = JSON.parse(ssRaw); } catch { codeVerifier = ssRaw; }
            sessionStorage.removeItem(CV_KEY);
          }
        } catch {}

        if (!codeVerifier) {
          const cookieRaw = getCookieValue(CV_KEY);
          if (cookieRaw) {
            try { codeVerifier = JSON.parse(cookieRaw); } catch { codeVerifier = cookieRaw; }
          }
        }

        if (!codeVerifier) {
          router.replace('/login?error=auth_failed');
          return;
        }

        const res = await Promise.race([
          fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
          }),
          new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 15000)),
        ]);

        if (!res.ok) {
          router.replace('/login?error=auth_failed');
          return;
        }

        const tokenData = await res.json();
        removeCookie(CV_KEY);
        writeSessionCookies(tokenData);

        const redirectTo = next && next.startsWith('/') ? next : '/dashboard';
        window.location.replace(redirectTo);
      } catch {
        router.replace('/login?error=auth_failed');
      }
    })();
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500">로그인 처리 중...</p>
    </div>
  );
}

export default function AuthCallbackFallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">로그인 처리 중...</p>
      </div>
    }>
      <FallbackHandler />
    </Suspense>
  );
}
