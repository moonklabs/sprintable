'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

// story #3159 — verify-email/page.tsx와 동형(pre-auth·raw fetch·미배선 하드코딩 한국어).
// 이메일 링크 클릭이 진입점이라 세션이 없을 수 있다.
export default function UnsubscribePage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
    () => (token ? 'loading' : 'error')
  );
  const [message, setMessage] = useState(
    () => (token ? '' : '유효하지 않은 링크입니다.')
  );

  useEffect(() => {
    if (!token) return;

    fetch(`/api/activation/unsubscribe?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((json: { data?: { unsubscribed: boolean }; error?: { code?: string; message: string } }) => {
        if (json.data?.unsubscribed) {
          setStatus('success');
          setMessage('안내 메일 수신이 해제되었습니다.');
        } else {
          setStatus('error');
          setMessage('링크가 유효하지 않거나 만료되었습니다.');
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('처리 중 오류가 발생했습니다.');
      });
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        {status === 'loading' && (
          <p className="text-sm text-muted-foreground">처리 중...</p>
        )}

        {status === 'success' && (
          <p className="text-sm font-medium text-success" role="status" aria-live="polite" aria-atomic="true">{message}</p>
        )}

        {status === 'error' && (
          <p className="text-sm text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{message}</p>
        )}

        <Link href="/login" className="block text-sm font-medium text-brand hover:text-brand/80">
          로그인으로 돌아가기
        </Link>
      </div>
    </div>
  );
}
