'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

export default function ForgotPasswordPage() {
  const t = useTranslations('forgotPassword');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo variant="stacked" className="text-foreground" markClassName="h-14" wordmarkClassName="h-5" />
          <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        </div>

        {submitted ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              {t('sentMessage')}
            </p>
            <Link href="/login" className="block text-sm font-medium text-brand-text hover:text-brand-text/85">
              {t('backToLogin')}
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('instructions')}</p>
            <input
              type="email"
              placeholder={t('emailPlaceholder')}
              autoComplete="email"
              className="w-full rounded-lg border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              disabled={loading}
            />
            <button
              onClick={handleSubmit}
              disabled={loading || !email.trim()}
              className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
            >
              {loading ? t('sending') : t('submitButton')}
            </button>
            <p className="text-center text-sm text-muted-foreground">
              <Link href="/login" className="font-medium text-brand-text hover:text-brand-text/85">
                {t('backToLogin')}
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
