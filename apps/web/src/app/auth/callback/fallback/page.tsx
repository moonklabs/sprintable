'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function redirectAfterLogin(
  client: ReturnType<typeof createSupabaseBrowserClient>,
  router: ReturnType<typeof useRouter>,
  next: string | null,
) {
  const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') { router.replace('/mfa'); return; }
  if (next) { router.replace(next); return; }
  const { data: { user } } = await client.auth.getUser();
  if (user) {
    const { data: membership } = await client.from('org_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle();
    router.replace(membership ? '/dashboard' : '/onboarding');
    return;
  }
  router.replace('/dashboard');
}

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = searchParams.get('code');
    const next = searchParams.get('next');
    if (!code) { router.replace('/login?error=auth_failed'); return; }

    const ssrClient = createSupabaseBrowserClient();
    const timeout = setTimeout(() => router.replace('/login?error=auth_failed'), 15000);

    (async () => {
      // createBrowserClient._initialize() may have already auto-exchanged the code
      // via detectSessionInUrl. getSession() awaits initializePromise, so if the
      // auto-exchange already succeeded we skip the explicit call entirely.
      const { data: { session: existingSession } } = await ssrClient.auth.getSession();
      if (existingSession) {
        clearTimeout(timeout);
        localStorage.removeItem('__pkce_cv_backup');
        await redirectAfterLogin(ssrClient, router, next);
        return;
      }

      // No session yet (auto-exchange failed, e.g. incognito with no PKCE cookie) →
      // try explicit exchange using the code from URL.
      const { data, error } = await ssrClient.auth.exchangeCodeForSession(code);
      if (!error && data.session) {
        clearTimeout(timeout);
        localStorage.removeItem('__pkce_cv_backup');
        await redirectAfterLogin(ssrClient, router, next);
        return;
      }

      // 2차: PKCE 쿠키 유실 → localStorage 백업으로 REST API 직접 교환
      if (error?.code === 'pkce_code_verifier_not_found') {
        const backup = localStorage.getItem('__pkce_cv_backup');
        if (!backup) { clearTimeout(timeout); router.replace('/login?error=auth_failed'); return; }

        // base64url 디코딩 (base64- prefix 제거)
        let codeVerifier = backup;
        if (codeVerifier.startsWith('base64-')) {
          try {
            const b64 = codeVerifier.substring(7);
            codeVerifier = new TextDecoder().decode(
              Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
            );
          } catch { /* use raw value */ }
        }

        try {
          const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
          });
          const tokenData = await res.json();
          if (!res.ok) { clearTimeout(timeout); router.replace('/login?error=auth_failed'); return; }

          await ssrClient.auth.setSession({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
          });
          clearTimeout(timeout);
          localStorage.removeItem('__pkce_cv_backup');
          await redirectAfterLogin(ssrClient, router, next);
        } catch {
          clearTimeout(timeout);
          router.replace('/login?error=auth_failed');
        }
      } else {
        clearTimeout(timeout);
        router.replace('/login?error=auth_failed');
      }
    })();

    return () => clearTimeout(timeout);
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500">로그인 처리 중...</p>
    </div>
  );
}

export default function AuthCallbackFallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gray-50"><p className="text-sm text-gray-500">로그인 처리 중...</p></div>}>
      <FallbackHandler />
    </Suspense>
  );
}
