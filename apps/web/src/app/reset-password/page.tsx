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
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center space-y-4">
          <p className="text-sm text-red-600">유효하지 않은 링크입니다.</p>
          <Link href="/forgot-password" className="text-sm text-blue-600 hover:text-blue-700">비밀번호 찾기</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-white p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-gray-900" markClassName="h-14" wordmarkClassName="h-5" />
          <h1 className="text-lg font-semibold text-gray-900">새 비밀번호 설정</h1>
        </div>

        {done ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-gray-600">비밀번호가 변경되었습니다.</p>
            <button
              onClick={() => router.push('/login')}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700"
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
              className={`w-full rounded-lg border px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                touched && !isValid ? 'border-red-400' : 'border-gray-300'
              }`}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setTouched(true); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              disabled={loading}
            />
            {touched && password.length > 0 && (
              <ul className="space-y-1 text-xs">
                <li className={rules.length ? 'text-green-600' : 'text-gray-400'}>
                  {rules.length ? '✓' : '○'} 8자 이상
                </li>
                <li className={categoriesMet >= 3 ? 'text-green-600' : 'text-gray-400'}>
                  {categoriesMet >= 3 ? '✓' : '○'} 대문자/소문자/숫자/특수문자 중 3가지 이상 ({categoriesMet}/3)
                </li>
              </ul>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={handleSubmit}
              disabled={loading || !password}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '변경 중...' : '비밀번호 변경'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
