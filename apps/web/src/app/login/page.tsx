'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { loginWithPassword } from '@/lib/db/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { safeNextPath, SESSION_EXPIRED_REASON } from '@/lib/auth/session-redirect';

export default function LoginPage() {
  const t = useTranslations('login');
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorCode = searchParams.get('error');
  // AC3: 세션 만료로 튕긴 경우 reason 배너 + next 로 작업 경로 복귀(오픈 리다이렉트 가드).
  const sessionExpired = searchParams.get('reason') === SESSION_EXPIRED_REASON;
  const nextParam = searchParams.get('next');
  const oauthErrors: Record<string, string> = {
    oauth_init_failed: t('oauthInitFailed'),
    oauth_missing_params: t('oauthMissingParams'),
    csrf_mismatch: t('csrfMismatch'),
    oauth_no_token: t('oauthNoToken'),
    invalid_provider: t('invalidProvider'),
  };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [error, setError] = useState<string | null>(
    errorCode ? (oauthErrors[errorCode] ?? t('loginFailed')) : null
  );
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await loginWithPassword(email.trim(), password, showTotp ? totpCode : undefined);
      if (result.error) {
        if (result.error.code === 'TOTP_REQUIRED') {
          setShowTotp(true);
          setError(t('totpRequired'));
          return;
        }
        setError(result.error.message);
        return;
      }
      router.push(safeNextPath(nextParam));
      router.refresh();
    } catch {
      setError(t('loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo
            variant="stacked"
            className="text-brand dark:text-white"
            markClassName="h-14"
            wordmarkClassName="h-5"
          />
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        {sessionExpired && (
          <Alert variant="warning">
            <AlertDescription>{t('sessionExpired')}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          <input
            type="email"
            placeholder={t('email')}
            autoComplete="email"
            className="w-full rounded-lg border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            disabled={loading}
          />
          <input
            type="password"
            placeholder={t('password')}
            autoComplete="current-password"
            className="w-full rounded-lg border border-border px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            disabled={loading}
          />
          {showTotp && (
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder={t('totpPlaceholder')}
              className="w-full rounded-lg border border-border px-4 py-3 text-center text-lg text-foreground font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-brand"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              autoFocus
              disabled={loading}
            />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            onClick={handleLogin}
            disabled={loading || !email.trim() || !password.trim()}
            className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 py-3 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50"
          >
            {loading ? t('signingIn') : t('signIn')}
          </button>
        </div>

        {process.env.NEXT_PUBLIC_OAUTH_ENABLED === 'true' && (
          <div className="space-y-3">
            <div className="relative flex items-center">
              <div className="flex-grow border-t border-border/50" />
              <span className="mx-3 flex-shrink text-xs text-muted-foreground/60">{t('orContinueWith')}</span>
              <div className="flex-grow border-t border-border/50" />
            </div>

            <a href={`/auth/login?provider=google&tos_accepted=true${nextParam ? `&next=${encodeURIComponent(nextParam)}` : ''}`} className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground/80 transition hover:bg-muted/50">
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              {t('google')}
            </a>

            <a href={`/auth/login?provider=github&tos_accepted=true${nextParam ? `&next=${encodeURIComponent(nextParam)}` : ''}`} className="flex w-full min-h-[44px] items-center justify-center gap-3 rounded-lg border border-border bg-foreground px-4 py-3 text-sm font-medium text-background transition hover:bg-foreground/90">
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              {t('github')}
            </a>

            <p className="text-center text-xs text-muted-foreground/60">
              {t('termsPrefix')}{' '}
              <a href="/terms" target="_blank" className="underline hover:text-foreground/60">{t('termsOfService')}</a>
              {' '}{t('and')}{' '}
              <a href="/privacy" target="_blank" className="underline hover:text-foreground/60">{t('privacyPolicy')}</a>
            </p>
          </div>
        )}

        <p className="text-center text-sm text-muted-foreground">
          <Link href="/forgot-password" className="font-medium text-brand hover:text-brand/80">
            {t('forgotPassword')}
          </Link>
        </p>
        <p className="text-center text-sm text-muted-foreground">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-medium text-brand hover:text-brand/80">
            {t('signUp')}
          </Link>
        </p>
      </div>
    </div>
  );
}
