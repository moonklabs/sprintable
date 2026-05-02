'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export default function InvitePage() {
  const t = useTranslations('invite');
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'checking' | 'accepting' | 'login-required' | 'success' | 'error'>('checking');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg(t('invalidToken'));
      return;
    }

    fetch('/api/me').then((res) => {
      if (res.ok) {
        void acceptInvite(token);
      } else {
        setStatus('login-required');
        const returnUrl = `/invite?token=${token}`;
        router.push(`/login?returnTo=${encodeURIComponent(returnUrl)}`);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const acceptInvite = async (inviteToken: string) => {
    setStatus('accepting');
    const res = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken }),
    });

    if (res.ok) {
      setStatus('success');
      setTimeout(() => router.push('/dashboard'), 2000);
    } else {
      const json = await res.json().catch(() => null);
      setStatus('error');
      setErrorMsg(json?.error?.message ?? t('acceptFailed'));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow-lg">
        {(status === 'checking' || status === 'accepting' || status === 'login-required') && (
          <p className="text-gray-500">{t('loading')}</p>
        )}
        {status === 'success' && (
          <div>
            <div className="mb-3 text-4xl">🎉</div>
            <p className="text-lg font-semibold text-green-600">{t('success')}</p>
            <p className="mt-2 text-sm text-gray-500">{t('redirecting')}</p>
          </div>
        )}
        {status === 'error' && (
          <div>
            <div className="mb-3 text-4xl">❌</div>
            <p className="text-sm text-red-600">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}
