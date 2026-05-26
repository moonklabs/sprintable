'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

function checkPasswordRules(pw: string) {
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /\d/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const rules = checkPasswordRules(password);
  const categoriesMet = [rules.upper, rules.lower, rules.digit, rules.special].filter(Boolean).length;
  const isValid = rules.length && categoriesMet >= 3;

  const handleSubmit = async () => {
    setTouched(true);
    if (!isValid) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: password }),
      });
      const json = await res.json() as { data?: { message: string }; error?: { message: string } };
      if (!res.ok) {
        setError(json.error?.message ?? 'Failed to reset password');
        return;
      }
      setDone(true);
    } catch {
      setError('Failed to reset password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <div className="text-center space-y-4">
          <p className="text-sm text-destructive">유효하지 않은 링크입니다.</p>
          <Link href="/forgot-password" className="text-sm text-brand hover:text-brand/80">비밀번호 찾기</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
          <h1 className="text-lg font-semibold text-foreground">새 비밀번호 설정</h1>
        </div>

        {done ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">비밀번호가 변경되었습니다.</p>
            <button
              onClick={() => router.push('/login')}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90"
            >
              로그인
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              type="password"
              placeholder="새 비밀번호"
              autoComplete="new-password"
              className={`w-full rounded-lg border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand ${
                touched && !isValid ? 'border-destructive' : 'border-border'
              }`}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setTouched(true); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              disabled={loading}
            />
            {touched && password.length > 0 && (
              <ul className="space-y-1 text-xs">
                <li className={rules.length ? 'text-success' : 'text-muted-foreground/60'}>
                  {rules.length ? '✓' : '○'} 8자 이상
                </li>
                <li className={categoriesMet >= 3 ? 'text-success' : 'text-muted-foreground/60'}>
                  {categoriesMet >= 3 ? '✓' : '○'} 대문자/소문자/숫자/특수문자 중 3가지 이상 ({categoriesMet}/3)
                </li>
              </ul>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              onClick={handleSubmit}
              disabled={loading || !password}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
            >
              {loading ? '변경 중...' : '비밀번호 변경'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
