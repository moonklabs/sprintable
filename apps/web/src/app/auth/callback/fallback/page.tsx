'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

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
  // clean existing chunks
  document.cookie.split(';').forEach(c => {
    const name = c.trim().split('=')[0];
    if (name.startsWith(COOKIE_BASE + '.')) {
      document.cookie = `${name}=; Path=/; Max-Age=0${domainAttr}`;
    }
  });
  // write new chunks
  for (let i = 0; i * CHUNK_SIZE < json.length; i++) {
    const chunk = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    document.cookie = `${COOKIE_BASE}.${i}=${encodeURIComponent(chunk)}; Path=/; SameSite=Lax; Secure; Max-Age=604800${domainAttr}`;
  }
}

interface DiagInfo {
  cookieEnabled: boolean;
  cookieNames: string[];
  hasSbCookie: boolean;
  hasCodeVerifier: boolean;
  localStorageSbKeys: string[];
  serverCv: string;
  cvSource: string;
  cvPrefix: string;
  exchangeError?: string;
}

function collectDiag(serverCv: string, cvSource: string, cvPrefix: string): Omit<DiagInfo, 'exchangeError'> {
  const cookieEnabled = navigator.cookieEnabled;
  const allCookies = document.cookie ? document.cookie.split(';').map(c => c.trim()) : [];
  const cookieNames = allCookies.map(c => c.split('=')[0].trim());
  const hasSbCookie = cookieNames.some(n => n.startsWith('sb-'));
  const hasCodeVerifier = cookieNames.some(n => n.includes('code-verifier'));
  const localStorageSbKeys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-')) localStorageSbKeys.push(k);
    }
  } catch {}
  return { cookieEnabled, cookieNames, hasSbCookie, hasCodeVerifier, localStorageSbKeys, serverCv, cvSource, cvPrefix };
}

function FallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState('로그인 처리 중...');
  const [diag, setDiag] = useState<DiagInfo | null>(null);

  useEffect(() => {
    const code = searchParams.get('auth_code');
    const next = searchParams.get('next');
    const serverCv = searchParams.get('server_cv') ?? 'unknown';
    if (!code) { router.replace('/login?error=no_code'); return; }

    let cvSource = 'none';

    (async () => {
      try {
        // 1. code_verifier: SDK sessionStorage 우선, 없으면 쿠키 fallback
        const projectRef = getProjectRef();
        const CV_COOKIE = `sb-${projectRef}-auth-token-code-verifier`;
        let codeVerifier: string | null | undefined;
        let cvPrefix = 'N/A';

        try {
          const ssRaw = sessionStorage.getItem(CV_COOKIE);
          if (ssRaw) {
            try { codeVerifier = JSON.parse(ssRaw); } catch { codeVerifier = ssRaw; }
            cvSource = 'sessionStorage';
            cvPrefix = (codeVerifier ?? '').slice(0, 8);
            sessionStorage.removeItem(CV_COOKIE);
          }
        } catch {}

        if (!codeVerifier) {
          const cookieRaw = getCookieValue(CV_COOKIE);
          if (cookieRaw) {
            try { codeVerifier = JSON.parse(cookieRaw); } catch { codeVerifier = cookieRaw; }
            cvSource = 'cookie';
            cvPrefix = (codeVerifier ?? '').slice(0, 8);
          }
        }

        const diagSnapshot = collectDiag(serverCv, cvSource, cvPrefix);

        if (!codeVerifier) {
          setDiag({ ...diagSnapshot, exchangeError: 'code_verifier not found (cookie + sessionStorage both empty)' });
          setStatus('인증 실패. 아래 정보를 스크린샷으로 캡처해주세요.');
          return;
        }

        // 3. REST API 직접 호출 — SDK Navigator Lock 완전 우회
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
          new Promise<never>((_, r) => setTimeout(() => r(new Error('Exchange timed out (15s)')), 15000)),
        ]);

        if (!res.ok) {
          const errText = await res.text().catch(() => res.status.toString());
          setDiag({ ...diagSnapshot, exchangeError: `REST ${res.status}: ${errText}` });
          setStatus('인증 실패. 아래 정보를 스크린샷으로 캡처해주세요.');
          return;
        }

        const tokenData = await res.json();

        // 4. code_verifier 쿠키 정리
        removeCookie(CV_COOKIE);

        // 5. 싱글톤 setSession (자기 자신만 lock 경합) + 10초 timeout
        try {
          const supabase = createSupabaseBrowserClient();
          await Promise.race([
            supabase.auth.setSession({ access_token: tokenData.access_token, refresh_token: tokenData.refresh_token }),
            new Promise<never>((_, r) => setTimeout(() => r(new Error('setSession timed out')), 10000)),
          ]);
        } catch {
          // setSession 실패 시 수동 chunked cookie fallback
          writeSessionCookies(tokenData);
        }

        // 6. MFA → next → membership redirect
        const supabase = createSupabaseBrowserClient();
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
          router.replace('/mfa'); return;
        }
        if (next && next.startsWith('/')) { router.replace(next); return; }
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: membership } = await supabase
            .from('org_members').select('org_id')
            .eq('user_id', user.id).limit(1).maybeSingle();
          router.replace(membership ? '/dashboard' : '/onboarding');
          return;
        }
        router.replace('/dashboard');
      } catch (err) {
        const diagSnapshot = collectDiag(serverCv, cvSource, 'unknown');
        setDiag({ ...diagSnapshot, exchangeError: `uncaught: ${String(err)}` });
        setStatus('인증 실패. 아래 정보를 스크린샷으로 캡처해주세요.');
      }
    })();
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
      <p className="text-sm text-gray-500">{status}</p>
      {diag && (
        <div className="w-full max-w-lg rounded-lg border border-red-200 bg-red-50 p-4 text-xs font-mono text-red-900 space-y-1">
          <p className="font-bold text-red-700">🔍 Auth Debug Info</p>
          <p>cookieEnabled: {String(diag.cookieEnabled)}</p>
          <p>serverCv: {diag.serverCv}</p>
          <p>cvSource: {diag.cvSource}</p>
          <p>cvPrefix: {diag.cvPrefix}</p>
          <p>hasSbCookie: {String(diag.hasSbCookie)}</p>
          <p>hasCodeVerifier: {String(diag.hasCodeVerifier)}</p>
          <p>cookieNames: [{diag.cookieNames.join(', ') || '(empty)'}]</p>
          <p>localStorageSbKeys: [{diag.localStorageSbKeys.join(', ') || '(empty)'}]</p>
          {diag.exchangeError && <p>exchangeError: {diag.exchangeError}</p>}
        </div>
      )}
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
