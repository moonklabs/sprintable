'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('유효하지 않은 인증 링크입니다.');
      return;
    }

    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => res.json())
      .then((json: { data?: { message: string }; error?: { message: string } }) => {
        if (json.data) {
          setStatus('success');
          setMessage(json.data.message);
        } else {
          setStatus('error');
          setMessage(json.error?.message ?? '인증에 실패했습니다.');
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('인증 중 오류가 발생했습니다.');
      });
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-white p-4 shadow-lg sm:p-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <SprintableLogo variant="stacked" className="text-gray-900" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        {status === 'loading' && (
          <p className="text-sm text-gray-500">이메일 인증 중...</p>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-green-600">{message}</p>
            <button
              onClick={() => router.push('/inbox')}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700"
            >
              시작하기
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <p className="text-sm text-red-600">{message}</p>
            <Link href="/login" className="block text-sm font-medium text-blue-600 hover:text-blue-700">
              로그인으로 돌아가기
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
