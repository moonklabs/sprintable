'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type Tab = 'oauth' | 'email';

export default function LoginPage() {
  const supabase = createSupabaseBrowserClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo');
  const urlError = searchParams.get('error');

  const [tab, setTab] = useState<Tab>('oauth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const oauthHref = (provider: string) => {
    const params = new URLSearchParams({ provider });
    if (returnTo && returnTo.startsWith('/')) params.set('returnTo', returnTo);
    return `/auth/login?${params.toString()}`;
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { setError(error.message); return; }
      router.push(returnTo ?? '/');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-white p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-gray-900" markClassName="h-14" wordmarkClassName="h-5" />
          <p className="text-sm text-gray-500">AI-powered sprint management</p>
        </div>

        {/* 탭 */}
        <div className="flex rounded-lg border border-gray-200 p-1 gap-1">
          <button
            onClick={() => setTab('oauth')}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${tab === 'oauth' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'}`}
          >
            소셜 로그인
          </button>
          <button
            onClick={() => setTab('email')}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${tab === 'email' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'}`}
          >
            이메일
          </button>
        </div>

        {(error || urlError) && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            {error ?? '로그인 중 오류가 발생했습니다. 다시 시도해 주세요.'}
          </p>
        )}

        {tab === 'oauth' ? (
          <div className="space-y-3">
            <a
              href={oauthHref('google')}
              className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </a>
            <a
              href={oauthHref('github')}
              className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-gray-300 bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-800"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              Continue with GitHub
            </a>
          </div>
        ) : (
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div className="space-y-2">
              <input
                type="email"
                placeholder="이메일"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
              />
              <input
                type="password"
                placeholder="비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
              />
            </div>
            <div className="flex justify-end">
              <Link href="/forgot-password" className="text-xs text-gray-500 hover:text-gray-700">
                비밀번호를 잊으셨나요?
              </Link>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-gray-900 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-60"
            >
              {loading ? '로그인 중...' : '로그인'}
            </button>
            <p className="text-center text-xs text-gray-500">
              계정이 없으신가요?{' '}
              <Link
                href={(() => {
                  if (returnTo?.includes('/invite?token=')) {
                    const token = new URLSearchParams(returnTo.split('?')[1]).get('token');
                    if (token) return `/signup?token=${encodeURIComponent(token)}`;
                  }
                  return '/signup';
                })()}
                className="font-medium text-gray-900 hover:underline"
              >
                회원가입
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
