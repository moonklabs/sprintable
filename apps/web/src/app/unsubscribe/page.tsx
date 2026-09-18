'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

// story #3159 — verify-email/page.tsx와 동형(pre-auth·raw fetch). 이메일 링크 클릭이
// 진입점이라 세션이 없을 수 있다. story #3923 — next-intl은 root layout이 전역
// 제공 중이라 항상 배선돼 있었다(#2484/#2485류 "미배선" 전제가 반복 오판이었음) —
// unsubscribe.* i18n 키로 전환.
export default function UnsubscribePage() {
  const t = useTranslations('unsubscribe');
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
    () => (token ? 'loading' : 'error')
  );
  const [message, setMessage] = useState(
    () => (token ? '' : t('invalidLink'))
  );

  useEffect(() => {
    if (!token) return;

    fetch(`/api/activation/unsubscribe?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((json: { data?: { unsubscribed: boolean }; error?: { code?: string; message: string } }) => {
        if (json.data?.unsubscribed) {
          setStatus('success');
          setMessage(t('unsubscribed'));
        } else {
          setStatus('error');
          setMessage(t('linkExpired'));
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage(t('processError'));
      });
  }, [token, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
        </div>

        {status === 'loading' && (
          <p className="text-sm text-muted-foreground">{t('processing')}</p>
        )}

        {status === 'success' && (
          <p className="text-sm font-medium text-success" role="status" aria-live="polite" aria-atomic="true">{message}</p>
        )}

        {status === 'error' && (
          <p className="text-sm text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{message}</p>
        )}

        <Link href="/login" className="block text-sm font-medium text-brand hover:text-brand/80">
          {t('backToLogin')}
        </Link>
      </div>
    </div>
  );
}
