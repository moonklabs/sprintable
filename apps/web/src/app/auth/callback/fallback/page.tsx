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

    // 1차: @supabase/ssr 정상 교환 시도
    ssrClient.auth.exchangeCodeForSession(code).then(async ({ data, error }) => {
      if (!error && data.session) {
        localStorage.removeItem('__pkce_cv_backup');
        redirectAfterLogin(ssrClient, router, next);
        return;
      }

      // 2차: localStorage 백업으로 REST API 직접 교환 (쿠키 리다이렉트 중 소실 대응)
      if (error?.code === 'pkce_code_verifier_not_found') {
        const backup = localStorage.getItem('__pkce_cv_backup');
        if (!backup) { router.replace('/login?error=auth_failed'); return; }

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
          if (!res.ok) { router.replace('/login?error=auth_failed'); return; }

          await ssrClient.auth.setSession({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
          });
          localStorage.removeItem('__pkce_cv_backup');
          redirectAfterLogin(ssrClient, router, next);
        } catch {
          router.replace('/login?error=auth_failed');
        }
      } else {
        router.replace('/login?error=auth_failed');
      }
    });

    const timeout = setTimeout(() => router.replace('/login?error=auth_failed'), 15000);
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
